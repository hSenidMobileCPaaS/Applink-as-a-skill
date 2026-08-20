/**
 * Applink callback (inbound webhook) handlers.
 *
 * Written for the Next.js App Router — split each exported handler into its own
 * `app/api/applink/<name>/route.ts`. The logic is framework-agnostic: the same
 * five handlers port directly to Express, Fastify, Hono, NestJS or anything
 * else that gives you a JSON body and a JSON response.
 *
 * Routes to register in the Applink portal:
 *   SMS receive (MO)          POST /api/applink/sms/receive
 *   Delivery status report    POST /api/applink/sms/report
 *   USSD receive              POST /api/applink/ussd/receive
 *   Subscriber notification   POST /api/applink/subscription/notify
 *   Charging notification     POST /api/applink/caas/charging-notification
 *
 * The contract, for all five:
 *   - Respond { "statusCode": "S1000", "statusDetail": "Success" }
 *   - Respond FIRST, work afterwards
 *   - Always HTTP 200, even for payloads you reject
 *   - Be idempotent — every callback can arrive more than once
 *   - Never trust the body; it is unauthenticated JSON from the internet
 *   - Redact the subscriber notification's `password` field before logging
 */

import { NextRequest, NextResponse } from "next/server";
import { config } from "./applink-config";
import { maskAddress, sendUssd } from "./applink-client";
import { getSession, setSession, endSession } from "./ussd-session";
import type {
  ChargingNotificationCallback,
  SmsReceiveCallback,
  SmsReportCallback,
  SubscriptionNotificationCallback,
  UssdReceiveCallback,
} from "./applink-types";

/** The only response Applink expects. */
const ACK = { statusCode: "S1000", statusDetail: "Success" } as const;
const ack = () => NextResponse.json(ACK);

/* ── Shared guards ───────────────────────────────────────────────────────── */

/**
 * Restrict to Applink's egress IPs. Applink signs nothing, so there is no
 * signature to verify — source IP is the strongest control available.
 *
 * Ask support@applink.com.bd for the current list and fill this in. Prefer
 * enforcing it at the firewall or load balancer if you can; this is the
 * fallback for when you cannot.
 */
const APPLINK_SOURCE_IPS: string[] = [
  // "203.0.113.10",
];

function isAllowedSource(req: NextRequest): boolean {
  if (APPLINK_SOURCE_IPS.length === 0) return true; // not configured yet
  const forwarded = req.headers.get("x-forwarded-for") ?? "";
  const ip = forwarded.split(",")[0]?.trim();
  return Boolean(ip) && APPLINK_SOURCE_IPS.includes(ip);
}

/**
 * Reject payloads addressed to a different application. Cheap noise filter.
 *
 * Only three of the five callbacks carry `applicationId`: SMS receive, USSD
 * receive and the subscriber notification. The delivery report and the
 * charging notification do not, so those lean on the source-IP allowlist and
 * on matching an identifier you actually issued.
 */
function isOurApp(applicationId: unknown): boolean {
  return applicationId === config.applicationId;
}

/**
 * The subscriber notification carries your API key in its body. Strip it
 * before the payload can reach a log, a trace, or an error reporter.
 */
function redactSecrets<T extends Record<string, unknown>>(body: T): T {
  if ("password" in body) delete (body as Record<string, unknown>).password;
  return body;
}

/**
 * Deduplication. Replace with Redis (SETNX + TTL) or a unique DB constraint in
 * production — an in-process Set does not survive a restart or a second
 * instance, which is exactly when duplicates arrive.
 */
const seen = new Set<string>();
function isDuplicate(key: string): boolean {
  if (seen.has(key)) return true;
  seen.add(key);
  setTimeout(() => seen.delete(key), 10 * 60_000).unref?.();
  return false;
}

/** Read the JSON body without throwing on malformed input. */
async function readJson(req: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Hand work to a queue. Replace with your real queue (BullMQ, SQS, Pub/Sub).
 * The point is that the HTTP response does not wait for it.
 */
function enqueue(job: string, payload: unknown): void {
  void Promise.resolve().then(async () => {
    try {
      await handleJob(job, payload);
    } catch (err) {
      console.error("[applink] job failed", { job, err });
      // Send to a dead-letter queue here.
    }
  });
}

/* ── 1. SMS receive (MO) ─────────────────────────────────────────────────── */
// app/api/applink/sms/receive/route.ts

export async function smsReceiveHandler(req: NextRequest) {
  if (!isAllowedSource(req)) return ack();

  const body = await readJson(req);
  if (!body || !isOurApp(body.applicationId)) return ack();

  const payload = body as unknown as SmsReceiveCallback;
  if (!payload.requestId || typeof payload.message !== "string") return ack();
  if (isDuplicate(`mo:${payload.requestId}`)) return ack();

  console.info("[applink] sms-receive", {
    requestId: payload.requestId,
    from: maskAddress(payload.sourceAddress),
    // Message content deliberately not logged — it is user communication.
  });

  enqueue("sms.mo", payload);
  return ack();
}

/* ── 2. SMS delivery status report ───────────────────────────────────────── */
// app/api/applink/sms/report/route.ts

/** Applink and the SMPP layer use different spellings. Normalise both. */
const DELIVERY_STATUS: Record<string, string> = {
  DELIVRD: "DELIVERED", UNDELIV: "UNDELIVERABLE",
  ACCEPTD: "ACCEPTED", REJECTD: "REJECTED",
};

export async function smsReportHandler(req: NextRequest) {
  if (!isAllowedSource(req)) return ack();

  const body = await readJson(req);
  if (!body) return ack();

  const payload = body as unknown as SmsReportCallback;
  if (!payload.requestId || !payload.deliveryStatus) return ack();

  const status = DELIVERY_STATUS[payload.deliveryStatus] ?? payload.deliveryStatus;
  if (isDuplicate(`dlr:${payload.requestId}:${status}`)) return ack();

  console.info("[applink] sms-report", {
    requestId: payload.requestId,
    status,
    to: maskAddress(payload.destinationAddress),
  });

  enqueue("sms.dlr", { ...payload, deliveryStatus: status });
  return ack();
}

/**
 * Timestamps are documented as yyMMddHHmm (10 digits), but the published
 * samples are 14 (yyyyMMddHHmmss) and the charging notification uses
 * "15-Nov-2023 11:55". Parse all three; return null rather than an Invalid Date.
 */
export function parseApplinkTimestamp(raw: string): Date | null {
  if (/^\d{14}$/.test(raw)) {
    const [, y, mo, d, h, mi, s] =
      raw.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/)!;
    return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  }
  if (/^\d{10}$/.test(raw)) {
    const [, y, mo, d, h, mi] = raw.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/)!;
    return new Date(Date.UTC(2000 + +y, +mo - 1, +d, +h, +mi));
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/* ── 3. USSD receive ─────────────────────────────────────────────────────── */
// app/api/applink/ussd/receive/route.ts

/**
 * The response body here is ONLY an acknowledgement. The screen the user sees
 * comes from a separate POST /ussd/send — which is why the reply is enqueued
 * rather than returned.
 *
 * USSD sessions time out in seconds. Do nothing slow before acking.
 */
export async function ussdHandler(req: NextRequest) {
  if (!isAllowedSource(req)) return ack();

  const body = await readJson(req);
  if (!body || !isOurApp(body.applicationId)) return ack();

  const payload = body as unknown as UssdReceiveCallback;
  if (!payload.sessionId || !payload.sourceAddress) return ack();
  if (isDuplicate(`ussd:${payload.requestId}`)) return ack();

  console.info("[applink] ussd-receive", {
    sessionId: payload.sessionId,
    operation: payload.ussdOperation,
    from: maskAddress(payload.sourceAddress),
  });

  enqueue("ussd.receive", payload);
  return ack();
}

/** The menu logic, run out of band. Replies via sendUssd(). */
async function handleUssdInput(payload: UssdReceiveCallback): Promise<void> {
  const { sessionId, sourceAddress, message, ussdOperation } = payload;

  if (ussdOperation === "mo-init") {
    setSession(sessionId, { node: "root", sourceAddress });
    await sendUssd({
      sessionId,
      destinationAddress: sourceAddress,
      operation: "mt-cont",
      message: "Welcome to Acme\n1. Balance\n2. Support\n0. Exit",
    });
    return;
  }

  const session = getSession(sessionId);
  if (!session) {
    // Expired or unknown — close cleanly rather than leaving it hanging.
    await sendUssd({
      sessionId,
      destinationAddress: sourceAddress,
      operation: "mt-fin",
      message: "Session expired. Please dial again.",
    });
    return;
  }

  const input = message.trim();

  // Terminal screens MUST use mt-fin, or the session hangs until the network
  // times it out.
  if (input === "0") {
    endSession(sessionId);
    await sendUssd({
      sessionId,
      destinationAddress: sourceAddress,
      operation: "mt-fin",
      message: "Thank you.",
    });
    return;
  }

  if (input === "1") {
    endSession(sessionId);
    await sendUssd({
      sessionId,
      destinationAddress: sourceAddress,
      operation: "mt-fin",
      message: "Your balance is BDT 300.00",
    });
    return;
  }

  if (input === "2") {
    setSession(sessionId, { ...session, node: "support" });
    await sendUssd({
      sessionId,
      destinationAddress: sourceAddress,
      operation: "mt-cont",
      message: "Support\n1. Call us\n2. SMS us\n0. Exit",
    });
    return;
  }

  // Invalid input: reshow rather than dropping the session.
  await sendUssd({
    sessionId,
    destinationAddress: sourceAddress,
    operation: "mt-cont",
    message: "Invalid option\n1. Balance\n2. Support\n0. Exit",
  });
}

/* ── 4. Subscriber notification ──────────────────────────────────────────── */
// app/api/applink/subscription/notify/route.ts

/**
 * The authoritative source of subscription state — including changes you did
 * not initiate (a user texting STOP, an operator removal, a billing failure).
 * Consuming this is what lets you keep a local mirror instead of re-querying
 * getSubscriberChargingInfo, which is capped at ten MSISDNs per call.
 *
 * NOTE: this is the one callback that carries your `password`. It is stripped
 * before anything else touches the payload.
 */
export async function subscriptionNotificationHandler(req: NextRequest) {
  if (!isAllowedSource(req)) return ack();

  const raw = await readJson(req);
  if (!raw) return ack();
  const body = redactSecrets(raw);
  if (!isOurApp(body.applicationId)) return ack();

  const payload = body as unknown as SubscriptionNotificationCallback;
  if (!payload.subscriberId || !payload.status) return ack();
  if (isDuplicate(`sub:${payload.subscriberId}:${payload.status}:${payload.timeStamp}`)) {
    return ack();
  }

  console.info("[applink] subscription-notify", {
    subscriber: maskAddress(payload.subscriberId),
    status: payload.status,
    frequency: payload.frequency,
  });

  enqueue("subscription.notification", payload);
  return ack();
}

/* ── 5. Charging notification ────────────────────────────────────────────── */
// app/api/applink/caas/charging-notification/route.ts

/**
 * Your reconciliation channel, and the only place a charge is actually
 * settled. Applink charging is two calls plus this callback: neither the
 * P1003 from OTP generation nor the response to OTP verification tells you
 * what was paid.
 *
 * Idempotency is not optional — a duplicate that double-counts revenue is a
 * real bug with real consequences.
 */
export async function chargingNotificationHandler(req: NextRequest) {
  if (!isAllowedSource(req)) return ack();

  const body = await readJson(req);
  if (!body) return ack();

  const payload = body as unknown as ChargingNotificationCallback;
  const key = payload.externalTrxId ?? payload.internalTrxId;
  if (!key) return ack();
  if (isDuplicate(`charge:${key}:${payload.statusCode}`)) return ack();

  console.info("[applink] charging-notification", {
    externalTrxId: payload.externalTrxId,
    internalTrxId: payload.internalTrxId,
    statusCode: payload.statusCode,
    paidAmount: payload.paidAmount,
    balanceDue: payload.balanceDue,
  });

  enqueue("charging.notification", payload);
  return ack();
}

/* ── Job dispatch ────────────────────────────────────────────────────────── */

async function handleJob(job: string, payload: unknown): Promise<void> {
  switch (job) {
    case "ussd.receive":
      return handleUssdInput(payload as UssdReceiveCallback);

    case "sms.mo":
      // Honour opt-out keywords, then handle your own commands.
      // const { message, sourceAddress } = payload as SmsReceiveCallback;
      // if (/^\s*(stop|unsub|off)\b/i.test(message)) await unregister(sourceAddress);
      return;

    case "sms.dlr":
      // Persist the latest status keyed by requestId.
      return;

    case "subscription.notification":
      // Upsert your local subscription mirror.
      return;

    case "charging.notification":
      // Find the ledger row by externalTrxId, compare paidAmount against what
      // you charged, and mark it CHARGED only when balanceDue is zero. A
      // non-zero balanceDue with a P-prefixed statusCode is a partial payment,
      // not a completed order.
      return;

    default:
      console.warn("[applink] unknown job", { job });
  }
}

/* ── Wiring ──────────────────────────────────────────────────────────────── */

/**
 * app/api/applink/ussd/receive/route.ts
 *
 *   import { ussdHandler } from "@/lib/applink/callbacks";
 *   export const POST = ussdHandler;
 *   export const runtime = "nodejs";     // needs node:https for the client
 *   export const dynamic = "force-dynamic";
 *
 * Also make sure these routes are exempt from CSRF protection and from any
 * auth middleware — then rely on the Applink source-IP allowlist instead, or
 * you have left an open endpoint.
 */
