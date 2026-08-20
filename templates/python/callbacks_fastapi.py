"""
Applink callback (inbound webhook) handlers — FastAPI.

Written for FastAPI, but the logic is framework-agnostic: the same five handlers
port directly to Django, Flask, Starlette or aiohttp. Only the routing decorator
and the background-task mechanism change.

Routes to register in the Applink portal:
    SMS receive (MO)          POST /api/applink/sms/receive
    Delivery status report    POST /api/applink/sms/report
    USSD receive              POST /api/applink/ussd/receive
    Subscriber notification   POST /api/applink/subscription/notify
    Charging notification     POST /api/applink/caas/charging-notification

The contract, for all five:
    - Respond {"statusCode": "S1000", "statusDetail": "Success"}
    - Respond FIRST, work afterwards
    - Always HTTP 200, even for payloads you reject
    - Be idempotent — every callback can arrive more than once
    - Never trust the body; it is unauthenticated JSON from the internet
    - Redact the subscriber notification's `password` field before logging

Full rules: references/07-callbacks.md.
"""

from __future__ import annotations

import logging
import re
import threading
import time
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from fastapi import APIRouter, BackgroundTasks, Request
from fastapi.responses import JSONResponse

from applink_client import mask_address, send_ussd, ApplinkError
from applink_config import config
from ussd_session import end_session, get_session, set_session

logger = logging.getLogger("applink")
router = APIRouter(prefix="/api/applink")

#: The only response Applink expects.
ACK = {"statusCode": "S1000", "statusDetail": "Success"}


def ack() -> JSONResponse:
    return JSONResponse(ACK, status_code=200)


# ── Shared guards ────────────────────────────────────────────────────────────

#: Restrict to Applink's egress IPs. Applink signs nothing, so there is no
#: signature to verify — source IP is the strongest control available. Ask
#: support for the current list. Prefer enforcing it at the firewall or load
#: balancer; this is the fallback for when you cannot.
APPLINK_SOURCE_IPS: set = set()  # e.g. {"203.0.113.10"}


def is_allowed_source(request: Request) -> bool:
    if not APPLINK_SOURCE_IPS:
        return True  # not configured yet
    forwarded = request.headers.get("x-forwarded-for", "")
    ip = forwarded.split(",")[0].strip() or (request.client.host if request.client else "")
    return ip in APPLINK_SOURCE_IPS


def is_our_app(application_id: Any) -> bool:
    """Reject payloads addressed to a different application. Cheap noise filter."""
    return application_id == config.application_id


class _DedupeStore:
    """
    Deduplication. Replace with Redis (SETNX + TTL) or a unique database
    constraint in production — an in-process set does not survive a restart or a
    second worker, which is exactly when duplicates arrive.
    """

    def __init__(self, ttl_seconds: int = 600) -> None:
        self._ttl = ttl_seconds
        self._seen: Dict[str, float] = {}
        self._lock = threading.Lock()

    def is_duplicate(self, key: str) -> bool:
        now = time.monotonic()
        with self._lock:
            for k, expires in list(self._seen.items()):
                if expires <= now:
                    del self._seen[k]
            if key in self._seen:
                return True
            self._seen[key] = now + self._ttl
            return False


_dedupe = _DedupeStore()


async def read_json(request: Request) -> Optional[Dict[str, Any]]:
    """Read the JSON body without raising on malformed input."""
    try:
        body = await request.json()
    except Exception:
        return None
    return body if isinstance(body, dict) else None


def enqueue(background: BackgroundTasks, job: str, payload: Dict[str, Any]) -> None:
    """
    Hand work off so the HTTP response does not wait for it.

    BackgroundTasks runs after the response is sent, which is enough for USSD
    timing. For anything that must survive a crash — charging reconciliation
    above all — use a real queue (Celery, RQ, SQS) instead.
    """
    background.add_task(handle_job, job, payload)


def redact_secrets(body: Dict[str, Any]) -> Dict[str, Any]:
    """
    The subscriber notification carries your API key in its body. Strip it
    before the payload can reach a log, a trace, or an error reporter.
    """
    body.pop("password", None)
    return body


# ── 1. SMS receive (MO) ──────────────────────────────────────────────────────


@router.post("/sms/receive")
async def sms_receive(request: Request, background: BackgroundTasks) -> JSONResponse:
    if not is_allowed_source(request):
        return ack()

    body = await read_json(request)
    if not body or not is_our_app(body.get("applicationId")):
        return ack()
    if not body.get("requestId") or not isinstance(body.get("message"), str):
        return ack()
    if _dedupe.is_duplicate(f"mo:{body['requestId']}"):
        return ack()

    logger.info(
        "sms-receive",
        extra={
            "requestId": body["requestId"],
            "from": mask_address(str(body.get("sourceAddress", ""))),
            # Message content deliberately not logged — it is user communication.
        },
    )
    enqueue(background, "sms.mo", body)
    return ack()


# ── 2. SMS delivery report ───────────────────────────────────────────────────

#: Applink and the SMPP gateway use different spellings. Normalise both.
DELIVERY_STATUS = {
    "DELIVRD": "DELIVERED",
    "UNDELIV": "UNDELIVERABLE",
    "ACCEPTD": "ACCEPTED",
    "REJECTD": "REJECTED",
}


@router.post("/sms/report")
async def delivery_report(request: Request, background: BackgroundTasks) -> JSONResponse:
    if not is_allowed_source(request):
        return ack()

    body = await read_json(request)
    if not body or not body.get("requestId") or not body.get("deliveryStatus"):
        return ack()

    status = DELIVERY_STATUS.get(body["deliveryStatus"], body["deliveryStatus"])
    if _dedupe.is_duplicate(f"dlr:{body['requestId']}:{status}"):
        return ack()

    logger.info(
        "delivery-report",
        extra={
            "requestId": body["requestId"],
            "status": status,
            "to": mask_address(str(body.get("destinationAddress", ""))),
        },
    )
    enqueue(background, "sms.dlr", {**body, "deliveryStatus": status})
    return ack()


def parse_applink_timestamp(raw: str) -> Optional[datetime]:
    """
    Timestamps arrive as either yyMMddHHmm (10) or yyyyMMddHHmmss (14).
    Parse both; return None rather than guessing.
    """
    if re.fullmatch(r"\d{14}", raw):
        return datetime.strptime(raw, "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
    if re.fullmatch(r"\d{10}", raw):
        return datetime.strptime(raw, "%y%m%d%H%M").replace(tzinfo=timezone.utc)
    return None


# ── 3. USSD receive ──────────────────────────────────────────────────────────


@router.post("/ussd")
async def ussd_receive(request: Request, background: BackgroundTasks) -> JSONResponse:
    """
    The response body here is ONLY an acknowledgement. The screen the user sees
    comes from a separate POST /ussd/send — which is why the reply is enqueued
    rather than returned.

    USSD sessions time out in seconds. Do nothing slow before acknowledging.
    """
    if not is_allowed_source(request):
        return ack()

    body = await read_json(request)
    if not body or not is_our_app(body.get("applicationId")):
        return ack()
    if not body.get("sessionId") or not body.get("sourceAddress"):
        return ack()
    if _dedupe.is_duplicate(f"ussd:{body.get('requestId')}"):
        return ack()

    logger.info(
        "ussd",
        extra={
            "sessionId": body["sessionId"],
            "operation": body.get("ussdOperation"),
            "from": mask_address(str(body["sourceAddress"])),
        },
    )
    enqueue(background, "ussd.receive", body)
    return ack()


def handle_ussd_input(payload: Dict[str, Any]) -> None:
    """The menu logic, run out of band. Replies via send_ussd()."""
    session_id = payload["sessionId"]
    source = payload["sourceAddress"]
    operation = payload.get("ussdOperation")
    message = str(payload.get("message", ""))

    if operation == "mo-init":
        set_session(session_id, node="root", source_address=source)
        send_ussd(
            session_id=session_id,
            destination_address=source,
            operation="mt-cont",
            message="Welcome to Acme\n1. Balance\n2. Support\n0. Exit",
        )
        return

    session = get_session(session_id)
    if session is None:
        # Expired or unknown — close cleanly rather than leaving it hanging.
        send_ussd(
            session_id=session_id,
            destination_address=source,
            operation="mt-fin",
            message="Session expired. Please dial again.",
        )
        return

    choice = message.strip()

    # Terminal screens MUST use mt-fin, or the session hangs until the network
    # times it out.
    if choice == "0":
        end_session(session_id)
        send_ussd(
            session_id=session_id,
            destination_address=source,
            operation="mt-fin",
            message="Thank you.",
        )
        return

    if choice == "1":
        end_session(session_id)
        send_ussd(
            session_id=session_id,
            destination_address=source,
            operation="mt-fin",
            message="Your balance is BDT 300.00",
        )
        return

    if choice == "2":
        set_session(session_id, node="support", source_address=source)
        send_ussd(
            session_id=session_id,
            destination_address=source,
            operation="mt-cont",
            message="Support\n1. Call us\n2. SMS us\n0. Exit",
        )
        return

    # Invalid input: reshow rather than dropping the session.
    send_ussd(
        session_id=session_id,
        destination_address=source,
        operation="mt-cont",
        message="Invalid option\n1. Balance\n2. Support\n0. Exit",
    )


# ── 4. Subscription notification ─────────────────────────────────────────────


@router.post("/subscription/notify")
async def subscription_notification(
    request: Request, background: BackgroundTasks
) -> JSONResponse:
    """
    The authoritative source of subscription state — including changes you did
    not initiate (a user texting STOP, an operator removal, a billing failure).
    Consuming this is what lets you keep a local mirror instead of re-querying
    getSubscriberChargingInfo, which is capped at ten MSISDNs per call.

    NOTE: this is the one callback that carries your `password`. It is stripped
    before anything else touches the payload.
    """
    if not is_allowed_source(request):
        return ack()

    raw = await read_json(request)
    if not raw:
        return ack()
    body = redact_secrets(raw)
    if not is_our_app(body.get("applicationId")):
        return ack()
    if not body.get("subscriberId") or not body.get("status"):
        return ack()

    key = f"sub:{body['subscriberId']}:{body['status']}:{body.get('timeStamp')}"
    if _dedupe.is_duplicate(key):
        return ack()

    logger.info(
        "subscription-notify",
        extra={
            "subscriber": mask_address(str(body["subscriberId"])),
            "status": body["status"],
            "frequency": body.get("frequency"),
        },
    )
    enqueue(background, "subscription.notification", body)
    return ack()


# ── 5. Charging notification ─────────────────────────────────────────────────


@router.post("/caas/charging-notification")
async def charging_notification(
    request: Request, background: BackgroundTasks
) -> JSONResponse:
    """
    Your reconciliation channel, and the only place a charge is actually
    settled. Applink charging is two calls plus this callback: neither the
    P1003 from OTP generation nor the response to OTP verification tells you
    what was paid.

    Idempotency is not optional — a duplicate that double-counts revenue is a
    real bug with real consequences.
    """
    if not is_allowed_source(request):
        return ack()

    body = await read_json(request)
    if not body:
        return ack()

    key = body.get("externalTrxId") or body.get("internalTrxId")
    if not key:
        return ack()
    if _dedupe.is_duplicate(f"charge:{key}:{body.get('statusCode')}"):
        return ack()

    logger.info(
        "charging-notification",
        extra={
            "externalTrxId": body.get("externalTrxId"),
            "internalTrxId": body.get("internalTrxId"),
            "statusCode": body.get("statusCode"),
            "paidAmount": body.get("paidAmount"),
            "balanceDue": body.get("balanceDue"),
        },
    )
    enqueue(background, "charging.notification", body)
    return ack()


# ── Job dispatch ─────────────────────────────────────────────────────────────


def handle_job(job: str, payload: Dict[str, Any]) -> None:
    try:
        if job == "ussd.receive":
            handle_ussd_input(payload)
        elif job == "sms.mo":
            # Honour opt-out keywords first, then your own commands:
            #     if re.match(r"^\s*(stop|unsub|off)\b", payload["message"], re.I):
            #         unregister(payload["sourceAddress"])
            pass
        elif job == "sms.dlr":
            # Persist the latest status keyed by requestId.
            pass
        elif job == "subscription.notification":
            # Upsert your local subscription mirror.
            pass
        elif job == "charging.notification":
            # Find the ledger row by externalTrxId, compare paidAmount against
            # what you charged, and mark it CHARGED only when balanceDue is
            # zero. A non-zero balanceDue with a P-prefixed statusCode is a
            # partial payment, not a completed order.
            pass
        else:
            logger.warning("unknown job", extra={"job": job})
    except ApplinkError as exc:
        logger.error(
            "job failed", extra={"job": job, "statusCode": exc.status_code}
        )
        # Send to a dead-letter queue here.
    except Exception:
        logger.exception("job failed", extra={"job": job})


# ── Wiring ───────────────────────────────────────────────────────────────────
#
#     from fastapi import FastAPI
#     from callbacks_fastapi import router
#
#     app = FastAPI()
#     app.include_router(router)
#
# Make sure these routes are exempt from CSRF protection and from any auth
# middleware — then rely on the Applink source-IP allowlist instead, or you
# have left an open endpoint.
#
# Django equivalent: a plain view with @csrf_exempt returning JsonResponse(ACK),
# and django-q / Celery in place of BackgroundTasks.
