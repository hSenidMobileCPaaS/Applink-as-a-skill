/**
 * Applink API client.
 *
 * One `post()` helper injects credentials, applies a timeout, and turns
 * non-S1000 responses into typed errors. Every service is a thin wrapper that
 * resolves its endpoint through `requireEndpoint()` — so calling an API your
 * application was not provisioned for fails locally with a clear message,
 * rather than as E1309 from the platform.
 *
 * The request bodies below match the published contract at
 * https://dev.applink.com.bd/API_Documentation/docs/hSenidMobile_tap_api.html
 * field for field.
 *
 * SERVER-SIDE ONLY.
 */

import https from "node:https";
import { randomUUID } from "node:crypto";
import { config, requireEndpoint } from "./applink-config";
import type {
  ApplinkBaseResponse,
  BalanceQueryResponse,
  CaasOtpGenerationResponse,
  CaasOtpVerifyResponse,
  OtpApplicationMetaData,
  OtpRequestResponse,
  OtpVerifyResponse,
  QueryBaseResponse,
  SmsEncoding,
  SmsSendResponse,
  SubscriberChargingInfoResponse,
  SubscriptionSendResponse,
  UssdSendResponse,
} from "./applink-types";

/** A single outbound call should never hang. Protocol constant, not config. */
const TIMEOUT_MS = 15_000;

/** Applink's API version. Sent where the contract marks it mandatory. */
const API_VERSION = "1.0";

/** The only currency Applink accepts. */
const CURRENCY = "BDT";

/**
 * If a handshake ever fails on an incomplete certificate chain, supply the
 * missing intermediate CA:
 *
 *   const agent = new https.Agent({ ca: fs.readFileSync("applink-chain.pem") });
 *
 * Do NOT disable verification. That lets anyone on the path present their own
 * certificate and read the applicationId and password that can charge your
 * subscribers. See references/09-security-best-practices.md.
 */
const agent = new https.Agent({ keepAlive: true });

/* ── Errors ──────────────────────────────────────────────────────────────── */

/** Platform-side. Worth retrying with backoff. */
const TRANSIENT = new Set(["E1318", "E1319", "E1341", "E1601", "E1602", "E1603"]);

/** Provisioning or credentials are wrong. Retrying will never help. */
const CONFIGURATION = new Set([
  "E1301", "E1303", "E1309", "E1311", "E1313", "E1315", "E1328", "E1331",
]);

/**
 * Accepted, not settled. `P1003` from CaaS OTP Generation means the OTP is on
 * its way to the subscriber and NOTHING has been charged. It is returned
 * successfully by startCharge() and must never be treated as a completed
 * charge, nor re-sent.
 */
const PENDING = new Set(["P1003"]);

export class ApplinkError extends Error {
  constructor(
    readonly statusCode: string,
    readonly statusDetail: string,
    readonly service: string,
    readonly raw?: unknown
  ) {
    super(`[${statusCode}] ${statusDetail} (${service})`);
    this.name = "ApplinkError";
  }
  get retryable() { return TRANSIENT.has(this.statusCode); }
  get isConfiguration() { return CONFIGURATION.has(this.statusCode); }
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/**
 * Normalise a subscriber address. The ONLY place `tel:` is added.
 *
 * Accepts an already-prefixed address, a masked value, `+880…`, `00880…` or a
 * local `01…` number. Strips the `+`: Applink's SMS samples include one and
 * every other API's samples do not, so one form has to win, and the no-`+`
 * form is the one the subscription, OTP and CaaS endpoints publish.
 */
export function toTelAddress(msisdn: string): string {
  const trimmed = (msisdn ?? "").trim();
  if (!trimmed) throw new Error("[applink] Empty subscriber address");
  if (trimmed.toLowerCase().startsWith("tel:")) {
    return `tel:${trimmed.slice(4).replace(/[\s+]/g, "")}`;
  }

  let digits = trimmed.replace(/[\s()-]/g, "").replace(/^\+/, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = `880${digits.slice(1)}`;

  return `tel:${digits}`;
}

/** Mask a subscriber address for logging. Never log the raw value. */
export function maskAddress(address: string): string {
  const body = address.replace(/^tel:/i, "");
  if (body.length <= 6) return "tel:***";
  return `tel:${body.slice(0, 3)}${"*".repeat(body.length - 6)}${body.slice(-3)}`;
}

/** A unique, persistable idempotency key for a charge. */
export function generateExternalTrxId(): string {
  return randomUUID().replace(/-/g, "");
}

/**
 * Applink publishes no benign "already registered" code, so the desired state
 * is read from subscriptionStatus. The published samples include a trailing
 * dot ("UNREGISTERED."), hence the prefix comparison.
 */
export function hasSubscriptionStatus(
  response: SubscriptionSendResponse,
  expected: "REGISTERED" | "UNREGISTERED"
): boolean {
  const actual = (response.subscriptionStatus ?? "").trim().toUpperCase();
  return actual.startsWith(expected);
}

/* ── Core ────────────────────────────────────────────────────────────────── */

async function post<T extends ApplinkBaseResponse>(
  service: string,
  url: string,
  body: Record<string, unknown>,
  acceptedCodes: readonly string[] = []
): Promise<T> {
  const payload = JSON.stringify({
    applicationId: config.applicationId,
    password: config.password,
    ...body,
  });

  const data = await request<T>(url, payload);

  if (data.statusCode === "S1000") return data;
  if (acceptedCodes.includes(data.statusCode)) return data;

  throw new ApplinkError(data.statusCode, data.statusDetail, service, data);
}

function request<T>(url: string, body: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: "POST",
        agent,
        timeout: TIMEOUT_MS,
        headers: {
          "Content-Type": "application/json;charset=utf-8",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(text) as T);
          } catch {
            reject(
              new Error(`Non-JSON response (HTTP ${res.statusCode}): ${text.slice(0, 200)}`)
            );
          }
        });
      }
    );

    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Applink request timed out after ${TIMEOUT_MS}ms`));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/* ── SMS ─────────────────────────────────────────────────────────────────── */

export interface SendSmsOptions {
  /** Optional. Must be a provisioned alias, or the send fails with E1331. */
  sourceAddress?: string;
  /** Optional. "1" requests a delivery report to your report callback URL. */
  deliveryStatusRequest?: "0" | "1";
  /** Optional. 0 Text (default) / 240 Flash / 245 Binary, hex-encoded. */
  encoding?: SmsEncoding;
  /** Optional. Hex-encoded UDH. Only meaningful with encoding "245". */
  binaryHeader?: string;
}

/** Send an MT SMS to one or more subscribers. */
export function sendSms(
  to: string | string[],
  message: string,
  options: SendSmsOptions = {}
): Promise<SmsSendResponse> {
  const recipients = (Array.isArray(to) ? to : [to]).map(toTelAddress);
  if (recipients.includes("tel:all")) {
    throw new Error("[applink] Use broadcastSms() for tel:all — broadcasts must be deliberate.");
  }
  return post<SmsSendResponse>("sms-send", requireEndpoint("smsSend"), {
    version: API_VERSION,
    message,
    destinationAddresses: recipients,
    ...options,
  });
}

/**
 * Send to the ENTIRE subscribed base.
 *
 * `tel:all` is documented, and it does exactly what it says. Deliberately
 * separate from sendSms so it can never be reached by accident — check the
 * subscriber base size first, and put an authorisation check in front of this.
 */
export function broadcastSms(
  message: string,
  confirmation: "I_HAVE_VERIFIED_THIS_GOES_TO_ALL_SUBSCRIBERS",
  options: SendSmsOptions = {}
): Promise<SmsSendResponse> {
  if (confirmation !== "I_HAVE_VERIFIED_THIS_GOES_TO_ALL_SUBSCRIBERS") {
    throw new Error("[applink] Broadcast confirmation token missing");
  }
  return post<SmsSendResponse>("sms-send", requireEndpoint("smsSend"), {
    version: API_VERSION,
    message,
    destinationAddresses: ["tel:all"],
    ...options,
  });
}

/* ── USSD ────────────────────────────────────────────────────────────────── */

/**
 * Send a USSD screen.
 *
 * `sessionId` MUST be the one the platform sent you. Use "mt-fin" for the final
 * screen — anything else leaves the session hanging until the network times out.
 */
export function sendUssd(input: {
  sessionId: string;
  destinationAddress: string;
  message: string;
  operation: "mt-init" | "mt-cont" | "mt-fin";
}): Promise<UssdSendResponse> {
  return post<UssdSendResponse>("ussd-send", requireEndpoint("ussdSend"), {
    version: API_VERSION,
    message: input.message,
    sessionId: input.sessionId,
    ussdOperation: input.operation,
    destinationAddress: toTelAddress(input.destinationAddress),
    encoding: "440",
  });
}

/* ── Subscription ────────────────────────────────────────────────────────── */

/**
 * Opt a subscriber in. Only call this with recorded, explicit consent.
 *
 * Applink publishes no "already registered" code: check the returned
 * subscriptionStatus with hasSubscriptionStatus(res, "REGISTERED") rather than
 * treating a repeat call as an error.
 */
export function register(subscriberId: string): Promise<SubscriptionSendResponse> {
  return post<SubscriptionSendResponse>(
    "subscription-register",
    requireEndpoint("subscriptionSend"),
    { subscriberId: toTelAddress(subscriberId), action: "1" }
  );
}

/**
 * Opt a subscriber out.
 *
 * The platform's own sample returns S1000 with statusDetail "not registered"
 * for a subscriber who was never registered — reaching the desired state is
 * the success condition. Confirm with hasSubscriptionStatus(res, "UNREGISTERED").
 */
export function unregister(subscriberId: string): Promise<SubscriptionSendResponse> {
  return post<SubscriptionSendResponse>(
    "subscription-unregister",
    requireEndpoint("subscriptionSend"),
    { subscriberId: toTelAddress(subscriberId), action: "0" }
  );
}

/**
 * Subscriber base size. Needs no subscriber and charges nothing, which also
 * makes it the best connectivity and credential smoke test.
 *
 * `baseSize` comes back as a string, so a parsed number is returned alongside.
 */
export async function queryBase(): Promise<QueryBaseResponse & { size: number }> {
  const res = await post<QueryBaseResponse>(
    "subscription-query-base",
    requireEndpoint("subscriptionQueryBase"),
    {}
  );
  return { ...res, size: Number.parseInt(res.baseSize ?? "0", 10) };
}

/**
 * Subscription status and last-charge details for up to ten subscribers.
 *
 * This is Applink's status lookup — there is no getStatus endpoint. Use it for
 * reconciliation, not as a per-request gate: mirror state from the subscriber
 * notification callback instead.
 */
export function getSubscriberChargingInfo(
  subscriberIds: string[]
): Promise<SubscriberChargingInfoResponse> {
  if (subscriberIds.length === 0) {
    throw new Error("[applink] getSubscriberChargingInfo needs at least one subscriber");
  }
  if (subscriberIds.length > 10) {
    throw new Error("[applink] getSubscriberChargingInfo accepts a maximum of 10 MSISDNs");
  }
  return post<SubscriberChargingInfoResponse>(
    "subscription-charging-info",
    requireEndpoint("subscriptionChargingInfo"),
    { subscriberIds: subscriberIds.map(toTelAddress) }
  );
}

/* ── OTP (subscription activation) ───────────────────────────────────────── */

/**
 * Send an OTP to a plain mobile number to activate a subscription.
 *
 * Rate-limit per number AND per IP before calling, or the application becomes
 * an SMS-bombing tool. Keep the returned referenceNo server-side.
 */
export function requestOtp(input: {
  subscriberId: string;
  metaData?: OtpApplicationMetaData;
  /** Optional. Hash determining which verification messages go to your app. */
  applicationHash?: string;
}): Promise<OtpRequestResponse> {
  return post<OtpRequestResponse>("otp-request", requireEndpoint("otpRequest"), {
    subscriberId: toTelAddress(input.subscriberId),
    ...(input.applicationHash ? { applicationHash: input.applicationHash } : {}),
    ...(input.metaData ? { applicationMetaData: input.metaData } : {}),
  });
}

/**
 * Verify an OTP. Valid five minutes — enforce that on your side too, and cap
 * attempts yourself; the platform documents no attempt limit. The returned
 * subscriberId is the identifier to use for every subsequent call.
 */
export function verifyOtp(input: {
  referenceNo: string;
  otp: string;
}): Promise<OtpVerifyResponse> {
  return post<OtpVerifyResponse>("otp-verify", requireEndpoint("otpVerify"), {
    referenceNo: input.referenceNo,
    otp: input.otp,
  });
}

/* ── CaaS — charging is TWO calls ────────────────────────────────────────── */

/**
 * Step 1 of charging: reserve the charge and send the subscriber an OTP.
 *
 * THIS DOES NOT CHARGE ANYONE. It returns P1003 and a `requestCorrelator`.
 *
 * - `externalTrxId` is your idempotency key. Generate it with
 *   generateExternalTrxId(), PERSIST IT with a PENDING ledger row, then call
 *   this.
 * - Persist `requestCorrelator` from the response. Without it the charge can
 *   never be completed, and there is no way to recover it.
 * - There are deliberately no retries here. A timeout does NOT mean the charge
 *   did not start. Reconcile against the charging notification instead.
 * - P1003 is returned successfully, not thrown — it is the expected outcome.
 */
export function startCharge(input: {
  subscriberId: string;
  amount: string;
  externalTrxId: string;
  paymentInstrumentName?: string;
}): Promise<CaasOtpGenerationResponse> {
  if (!input.externalTrxId) {
    throw new Error("[applink] externalTrxId is required and must be persisted first");
  }
  return post<CaasOtpGenerationResponse>(
    "caas-otp-generation",
    requireEndpoint("caasOtpGeneration"),
    {
      externalTrxId: input.externalTrxId,
      amount: input.amount,
      paymentInstrumentName: input.paymentInstrumentName ?? "Mobile Account",
      subscriberId: toTelAddress(input.subscriberId),
      // Capital C, as published. Lower-case is a different parameter on the
      // balance endpoint.
      Currency: CURRENCY,
    },
    [...PENDING]
  );
}

/**
 * Step 2 of charging: verify the subscriber's OTP and complete the charge.
 *
 * THIS MOVES REAL MONEY.
 *
 * - `referenceNo` is the `requestCorrelator` from startCharge(), NOT the
 *   externalTrxId you generated and NOT the referenceNo from requestOtp().
 *   Getting that wrong is E1855.
 * - On E1850 (wrong OTP), re-prompt the subscriber against the SAME
 *   referenceNo. On E1851 (expired), abandon the transaction.
 * - NEVER call startCharge() again to retry this. That begins a second charge.
 * - The authoritative outcome is the charging notification callback, which
 *   carries paidAmount and balanceDue. Settle the ledger there.
 */
export function confirmCharge(input: {
  requestCorrelator: string;
  otp: string;
  subscriberId: string;
}): Promise<CaasOtpVerifyResponse> {
  if (!input.requestCorrelator) {
    throw new Error(
      "[applink] requestCorrelator is required — it comes from the startCharge() response"
    );
  }
  return post<CaasOtpVerifyResponse>("caas-otp-verify", requireEndpoint("caasOtpVerify"), {
    referenceNo: input.requestCorrelator,
    otp: input.otp,
    sourceAddress: toTelAddress(input.subscriberId),
  });
}

/**
 * Query chargeable balance.
 *
 * Advisory only: the balance can change between this and the charge. Always
 * handle E1326 on the charging path regardless of what this returned.
 *
 * This endpoint is in the published specification but not in the rendered
 * documentation's navigation. Leaving APPLINK_CAAS_BALANCE_URL unset is how
 * you disable it until support confirms it is enabled on your application.
 */
export function queryBalance(input: {
  subscriberId: string;
  /** Optional. The account of the payment instrument. */
  accountId?: string;
}): Promise<BalanceQueryResponse> {
  return post<BalanceQueryResponse>("caas-query-balance", requireEndpoint("caasBalance"), {
    subscriberId: toTelAddress(input.subscriberId),
    paymentInstrumentName: "MobileAccount",
    // Lower-case c on this endpoint, capital C on the charging request.
    currency: CURRENCY,
    ...(input.accountId ? { accountId: input.accountId } : {}),
  });
}

/* ── Extension point ─────────────────────────────────────────────────────── */

/**
 * Adding a service Applink publishes later:
 *
 *   1. Add its URL variable to .env.example and to `endpoints` in
 *      applink-config.ts
 *   2. Add request/response interfaces to applink-types.ts
 *   3. Add one wrapper here:
 *
 *        export function newThing(input: NewThingInput): Promise<NewThingResponse> {
 *          return post<NewThingResponse>("new-thing", requireEndpoint("newThing"), { ...input });
 *        }
 *
 * It inherits credential injection, the timeout, error mapping and the
 * not-provisioned guard for free. Do not build a parallel client.
 */
