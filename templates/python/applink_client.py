"""
Applink API client — Python port of templates/typescript/applink-client.ts.

One `_post()` helper injects credentials, applies a timeout, and turns non-S1000
responses into typed errors. Every service is a thin wrapper that resolves its
endpoint through `config.require_endpoint()` — so calling an API your
application was not provisioned for fails locally with a clear message, rather
than as E1309 from the platform.

Standard library only, so it drops into any project without adding a dependency.
Using httpx or requests instead is fine and usually better in an existing
codebase — replace `_request()` and keep everything else:

    resp = httpx.post(url, json=payload, timeout=TIMEOUT_SECONDS)
    data = resp.json()          # note: still do NOT call resp.raise_for_status()
                                # as a success check — see _post().

SERVER-SIDE ONLY.
"""

from __future__ import annotations

import json
import re
import ssl
import urllib.error
import urllib.request
import uuid
from decimal import Decimal, InvalidOperation
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Union

from applink_config import config

#: A single outbound call should never hang. Protocol constant, not config.
TIMEOUT_SECONDS = 15

#: If a handshake ever fails on an incomplete certificate chain, do NOT "fix"
#: it with ssl._create_unverified_context() or verify=False — that lets anyone
#: on the path read the applicationId and password that can charge your
#: subscribers. Supply the intermediate CA instead:
#:
#:     SSL_CONTEXT = ssl.create_default_context(cafile="certs/applink-chain.pem")
#:
#: See references/09-security-best-practices.md.
SSL_CONTEXT = ssl.create_default_context()

# ── Errors ───────────────────────────────────────────────────────────────────

#: Applink's API version. Sent where the contract marks it mandatory.
API_VERSION = "1.0"

#: The only currency Applink accepts.
CURRENCY = "BDT"

#: Platform-side. Worth retrying with backoff.
TRANSIENT = frozenset({"E1318", "E1319", "E1341", "E1601", "E1602", "E1603"})

#: Provisioning or credentials are wrong. Retrying will never help.
CONFIGURATION = frozenset(
    {"E1301", "E1303", "E1309", "E1311", "E1313", "E1315", "E1328", "E1331"}
)

#: Accepted, not settled. P1003 from CaaS OTP generation means the OTP is on
#: its way to the subscriber and NOTHING has been charged. It is returned
#: successfully by start_charge() and must never be treated as a completed
#: charge, nor re-sent.
PENDING_OTP_SENT = "P1003"

#: Applink publishes no benign duplicate-state codes. Register and unregister
#: outcomes come from subscriptionStatus in the response body — see
#: has_subscription_status() below.


class ApplinkError(Exception):
    def __init__(
        self,
        status_code: str,
        status_detail: str,
        service: str,
        raw: Optional[Mapping[str, Any]] = None,
    ) -> None:
        super().__init__(f"[{status_code}] {status_detail} ({service})")
        self.status_code = status_code
        self.status_detail = status_detail
        self.service = service
        self.raw = raw

    @property
    def retryable(self) -> bool:
        return self.status_code in TRANSIENT

    @property
    def is_configuration(self) -> bool:
        return self.status_code in CONFIGURATION


# ── Helpers ──────────────────────────────────────────────────────────────────

_SEPARATORS = re.compile(r"[\s()\-]")


def to_tel_address(msisdn: str) -> str:
    """
    Normalise a subscriber address. The ONLY place `tel:` is added.

    Accepts an already-prefixed address, a masked value, +880…, 00880… or a
    local 01… number. Strips the "+": Applink's SMS samples include one and
    every other API's samples do not, so one form has to win, and the no-"+"
    form is what the subscription, OTP and CaaS endpoints publish.
    """
    trimmed = (msisdn or "").strip()
    if not trimmed:
        raise ValueError("[applink] Empty subscriber address")
    if trimmed.lower().startswith("tel:"):
        return "tel:" + _SEPARATORS.sub("", trimmed[4:]).lstrip("+")

    digits = _SEPARATORS.sub("", trimmed).lstrip("+")
    if digits.startswith("00"):
        digits = digits[2:]
    if digits.startswith("0"):
        digits = "880" + digits[1:]
    return f"tel:{digits}"


def mask_address(address: str) -> str:
    """Mask a subscriber address for logging. Never log the raw value."""
    body = re.sub(r"^tel:", "", address, flags=re.IGNORECASE)
    if len(body) <= 6:
        return "tel:***"
    return f"tel:{body[:3]}{'*' * (len(body) - 6)}{body[-3:]}"


def generate_external_trx_id() -> str:
    """A unique, persistable idempotency key for a charge."""
    return uuid.uuid4().hex


def has_subscription_status(response: Mapping[str, Any], expected: str) -> bool:
    """
    Applink publishes no benign "already registered" code, so the desired state
    is read from subscriptionStatus. The published samples carry a trailing dot
    ("UNREGISTERED."), hence the prefix comparison.
    """
    actual = str(response.get("subscriptionStatus") or "").strip().upper()
    return actual.startswith(expected.upper())


def format_amount(amount: Union[Decimal, str]) -> str:
    """
    Money crosses the wire as a string with two decimal places, as the published
    sample does ("5.00"). Keep it in Decimal in your own code — a float will
    eventually charge someone 99.99999 taka — and note that str() of a Decimal
    can produce "1E+1", which is why this formats explicitly.
    """
    if isinstance(amount, float):  # pragma: no cover - guard against a real bug
        raise TypeError("[applink] Use Decimal or str for money, never float")
    try:
        value = Decimal(str(amount).strip())
    except InvalidOperation as exc:
        raise ValueError(f"[applink] amount is not a decimal: {amount!r}") from exc
    if not value.is_finite() or value <= 0 or value != value.quantize(Decimal("0.01")):
        raise ValueError(
            f"[applink] amount must be positive with at most two decimal places, got {amount!r}"
        )
    return f"{value:.2f}"


# ── Core ─────────────────────────────────────────────────────────────────────


def _request(url: str, body: bytes) -> Dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json;charset=utf-8",
            "Content-Length": str(len(body)),
        },
    )
    try:
        with urllib.request.urlopen(
            request, timeout=TIMEOUT_SECONDS, context=SSL_CONTEXT
        ) as response:
            text = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        # Applink answers 200 even for its own errors, so a non-2xx here is a
        # gateway/proxy problem — but the body may still be the real answer.
        text = exc.read().decode("utf-8", errors="replace")
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"[applink] Non-JSON response: {text[:200]}") from exc


def _post(
    service: str,
    url: str,
    body: Mapping[str, Any],
    accepted_codes: Iterable[str] = (),
) -> Dict[str, Any]:
    payload = {
        "applicationId": config.application_id,
        "password": config.password,
        **body,
    }
    data = _request(url, json.dumps(payload).encode("utf-8"))

    status = data.get("statusCode")
    if status == "S1000" or status in set(accepted_codes):
        return data
    raise ApplinkError(
        str(status), str(data.get("statusDetail", "")), service, data
    )


# ── SMS ──────────────────────────────────────────────────────────────────────


def send_sms(
    to: Union[str, Sequence[str]],
    message: str,
    *,
    source_address: Optional[str] = None,
    delivery_status_request: Optional[str] = None,
    encoding: Optional[str] = None,
    binary_header: Optional[str] = None,
) -> Dict[str, Any]:
    """Send an MT SMS to one or more subscribers."""
    recipients: List[str] = [
        to_tel_address(x) for x in ([to] if isinstance(to, str) else list(to))
    ]
    if "tel:all" in recipients:
        raise ValueError(
            "[applink] Use broadcast_sms() for tel:all — broadcasts must be deliberate."
        )
    body: Dict[str, Any] = {
        "version": API_VERSION,
        "message": message,
        "destinationAddresses": recipients,
    }
    if source_address:
        body["sourceAddress"] = source_address
    if delivery_status_request:
        body["deliveryStatusRequest"] = delivery_status_request
    if encoding:
        body["encoding"] = encoding
    if binary_header:
        body["binaryHeader"] = binary_header
    return _post("sms-send", config.require_endpoint("sms_send"), body)


BROADCAST_CONFIRMATION = "I_HAVE_VERIFIED_THIS_GOES_TO_ALL_SUBSCRIBERS"


def broadcast_sms(message: str, confirmation: str, **options: Any) -> Dict[str, Any]:
    """
    Send to the ENTIRE subscribed base.

    Deliberately separate from send_sms so it can never be reached by accident —
    check the subscriber base size first, and put an authorisation check in
    front of this.
    """
    if confirmation != BROADCAST_CONFIRMATION:
        raise ValueError("[applink] Broadcast confirmation token missing")
    body: Dict[str, Any] = {
        "version": API_VERSION,
        "message": message,
        "destinationAddresses": ["tel:all"],
    }
    body.update({k: v for k, v in options.items() if v is not None})
    return _post("sms-send", config.require_endpoint("sms_send"), body)


# ── USSD ─────────────────────────────────────────────────────────────────────


def send_ussd(
    *, session_id: str, destination_address: str, message: str, operation: str
) -> Dict[str, Any]:
    """
    Send a USSD screen.

    `session_id` MUST be the one the platform sent you. Use "mt-fin" for the
    final screen — anything else leaves the session hanging until the network
    times out.
    """
    if operation not in {"mt-init", "mt-cont", "mt-fin"}:
        raise ValueError(f"[applink] Invalid ussdOperation '{operation}'")
    return _post(
        "ussd-send",
        config.require_endpoint("ussd_send"),
        {
            "message": message,
            "sessionId": session_id,
            "ussdOperation": operation,
            "destinationAddress": to_tel_address(destination_address),
            "encoding": "440",
            "version": API_VERSION,
        },
    )


# ── Subscription ─────────────────────────────────────────────────────────────


def register(subscriber_id: str) -> Dict[str, Any]:
    """
    Opt a subscriber in. Only call this with recorded, explicit consent.

    Applink publishes no "already registered" code: confirm the outcome with
    has_subscription_status(response, "REGISTERED") rather than treating a
    repeat call as an error.
    """
    return _post(
        "subscription-register",
        config.require_endpoint("subscription_send"),
        {"subscriberId": to_tel_address(subscriber_id), "action": "1"},
    )


def unregister(subscriber_id: str) -> Dict[str, Any]:
    """
    Opt a subscriber out.

    The platform's own sample returns S1000 with statusDetail "not registered"
    for a subscriber who was never registered — reaching the desired state is
    the success condition. Confirm with
    has_subscription_status(response, "UNREGISTERED").
    """
    return _post(
        "subscription-unregister",
        config.require_endpoint("subscription_send"),
        {"subscriberId": to_tel_address(subscriber_id), "action": "0"},
    )


def get_subscriber_charging_info(subscriber_ids: Sequence[str]) -> Dict[str, Any]:
    """
    Subscription status and last-charge details for up to ten subscribers.

    This is Applink's status lookup — there is no getStatus endpoint. Use it
    for reconciliation, not as a per-request gate: mirror state from the
    subscriber notification callback instead.
    """
    ids = list(subscriber_ids)
    if not ids:
        raise ValueError("[applink] get_subscriber_charging_info needs at least one subscriber")
    if len(ids) > 10:
        raise ValueError("[applink] get_subscriber_charging_info accepts a maximum of 10 MSISDNs")
    return _post(
        "subscription-charging-info",
        config.require_endpoint("subscription_charging_info"),
        {"subscriberIds": [to_tel_address(x) for x in ids]},
    )


def query_base() -> Dict[str, Any]:
    """
    Subscriber base size. Needs no subscriber and charges nothing, which also
    makes it the best connectivity and credential smoke test.

    `baseSize` comes back as a string, so a parsed integer is added alongside.
    """
    response = _post(
        "subscription-query-base",
        config.require_endpoint("subscription_query_base"),
        {},
    )
    return {**response, "size": int(response.get("baseSize") or 0)}


# ── OTP ──────────────────────────────────────────────────────────────────────


def request_otp(
    *,
    subscriber_id: str,
    meta_data: Optional[Mapping[str, Any]] = None,
    application_hash: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Send an OTP to a plain mobile number to activate a subscription.

    Rate-limit per number AND per IP before calling, or the application becomes
    an SMS-bombing tool. Keep the returned referenceNo server-side; never log it.
    """
    body: Dict[str, Any] = {"subscriberId": to_tel_address(subscriber_id)}
    if meta_data:
        body["applicationMetaData"] = dict(meta_data)
    if application_hash:
        body["applicationHash"] = application_hash
    return _post("otp-request", config.require_endpoint("otp_request"), body)


def verify_otp(*, reference_no: str, otp: str) -> Dict[str, Any]:
    """
    Verify an OTP. Valid five minutes — enforce that on your side too, and cap
    attempts yourself; the platform documents no attempt limit. The returned
    subscriberId is the identifier to use for every subsequent call.
    """
    return _post(
        "otp-verify",
        config.require_endpoint("otp_verify"),
        {"referenceNo": reference_no, "otp": otp},
    )


# ── CaaS ─────────────────────────────────────────────────────────────────────


def start_charge(
    *,
    subscriber_id: str,
    amount: Union[Decimal, str],
    external_trx_id: str,
    payment_instrument_name: str = "Mobile Account",
) -> Dict[str, Any]:
    """
    Step 1 of charging: reserve the charge and send the subscriber an OTP.

    THIS DOES NOT CHARGE ANYONE. It returns P1003 and a requestCorrelator.

    - `external_trx_id` is your idempotency key. Generate it with
      generate_external_trx_id(), PERSIST IT with a PENDING ledger row, then
      call this.
    - Persist `requestCorrelator` from the response. Without it the charge can
      never be completed, and there is no way to recover it.
    - There are deliberately no retries here. A timeout does NOT mean the
      charge did not start; reconcile against the charging notification.
    - P1003 is returned, not raised — it is the expected outcome.
    """
    if not external_trx_id:
        raise ValueError(
            "[applink] external_trx_id is required and must be persisted first"
        )
    return _post(
        "caas-otp-generation",
        config.require_endpoint("caas_otp_generation"),
        {
            "externalTrxId": external_trx_id,
            "amount": format_amount(amount),
            "paymentInstrumentName": payment_instrument_name,
            "subscriberId": to_tel_address(subscriber_id),
            # Capital C, as published. The balance endpoint uses lower case.
            "Currency": CURRENCY,
        },
        [PENDING_OTP_SENT],
    )


def confirm_charge(
    *, request_correlator: str, otp: str, subscriber_id: str
) -> Dict[str, Any]:
    """
    Step 2 of charging: verify the subscriber's OTP and complete the charge.

    THIS MOVES REAL MONEY.

    - `request_correlator` comes from the start_charge() response. It is NOT
      the external_trx_id you generated and NOT the referenceNo from
      request_otp(). Getting that wrong is E1855.
    - On E1850 (wrong OTP), re-prompt against the SAME correlator. On E1851
      (expired), abandon the transaction.
    - NEVER call start_charge() again to retry this — that begins a second
      charge.
    - The authoritative outcome is the charging notification callback, which
      carries paidAmount and balanceDue. Settle the ledger there.
    """
    if not request_correlator:
        raise ValueError(
            "[applink] request_correlator is required — it comes from start_charge()"
        )
    return _post(
        "caas-otp-verify",
        config.require_endpoint("caas_otp_verify"),
        {
            "referenceNo": request_correlator,
            "otp": otp,
            "sourceAddress": to_tel_address(subscriber_id),
        },
    )


def query_balance(
    *, subscriber_id: str, account_id: Optional[str] = None
) -> Dict[str, Any]:
    """
    Query chargeable balance.

    Advisory only: the balance can change between this and the charge. Always
    handle E1326 on the charging path regardless of what this returned.

    This endpoint is in the published specification but not in the rendered
    documentation's navigation. Leaving APPLINK_CAAS_BALANCE_URL unset is how
    you disable it until support confirms it is enabled on your application.
    """
    body: Dict[str, Any] = {
        "subscriberId": to_tel_address(subscriber_id),
        "paymentInstrumentName": "MobileAccount",
        # Lower-case c on this endpoint, capital C on the charging request.
        "currency": CURRENCY,
    }
    if account_id:
        body["accountId"] = account_id
    return _post("caas-query-balance", config.require_endpoint("caas_balance"), body)


# ── Extension point ──────────────────────────────────────────────────────────
#
# Adding a service Applink publishes later:
#
#   1. Add its URL variable to .env.example and to _ENDPOINT_VARS in
#      applink_config.py
#   2. Add one wrapper here:
#
#          def new_thing(**kwargs):
#              return _post("new-thing", config.require_endpoint("new_thing"), kwargs)
#
# It inherits credential injection, the timeout, error mapping and the
# not-provisioned guard for free. Do not build a parallel client.
