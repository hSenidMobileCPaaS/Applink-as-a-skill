/**
 * Applink request/response types.
 *
 * Field names and optionality follow the official documentation at
 * https://dev.applink.com.bd/API_Documentation/docs/hSenidMobile_tap_api.html.
 * Applink sends numbers as strings (baseSize, amount, chargeableBalance,
 * paidAmount) — the types reflect the wire format, not what you wish it were.
 * Parse at the boundary.
 *
 * Two field names are capitalised exactly as the platform publishes them:
 * `Currency` on the charging request, `TotalAmount` on the charging
 * notification. They are not typos here.
 */

/* ── Common ──────────────────────────────────────────────────────────────── */

/** Every Applink response carries at least these. */
export interface ApplinkBaseResponse {
  statusCode: string;
  statusDetail: string;
  version?: string;
  requestId?: string;
}

/** Credentials injected by the client — never build these at a call site. */
export interface ApplinkCredentials {
  applicationId: string;
  password: string;
}

/**
 * A subscriber address. Always `tel:`-prefixed. May be a plain MSISDN
 * (`tel:8801959979376`) or, when number masking is enabled for the
 * application, an opaque value. Treat it as opaque either way.
 */
export type TelAddress = `tel:${string}`;

/** SMS broadcast to the entire subscribed base. Guard its use. */
export const BROADCAST_ADDRESS = "tel:all" as const;

/** The only currency Applink accepts. */
export const CURRENCY = "BDT" as const;

/* ── SMS ─────────────────────────────────────────────────────────────────── */

export type SmsEncoding = "0" | "240" | "245"; // Text | Flash | Binary (hex)

export interface SmsSendRequest extends ApplinkCredentials {
  version: string;
  message: string;
  /** Always an array, even for a single recipient. */
  destinationAddresses: string[];
  /** Must be a provisioned alias (e.g. a shortcode), or the send fails E1331. */
  sourceAddress?: string;
  /** "0" = not required, "1" = required. */
  deliveryStatusRequest?: "0" | "1";
  encoding?: SmsEncoding;
  /** Hex-encoded UDH. Only meaningful with encoding "245". */
  binaryHeader?: string;
}

export interface SmsDestinationResponse {
  timeStamp?: string;
  address?: string;
  messageId?: string;
  /** Outcome for this recipient alone. Branch on it, not only the top level. */
  statusCode?: string;
  statusDetail?: string;
}

export interface SmsSendResponse extends ApplinkBaseResponse {
  /** Per-recipient results. A multi-recipient send can partially succeed. */
  destinationResponses?: SmsDestinationResponse[];
}

/** Inbound: MO SMS — what the platform POSTs to your callback URL. */
export interface SmsReceiveCallback {
  version: string;
  applicationId: string;
  sourceAddress: string;
  message: string;
  requestId: string;
  encoding: SmsEncoding;
}

/**
 * Delivery status. The platform sends the long forms; the underlying SMPP
 * layer uses the abbreviated ones. Accept both and normalise on the way in.
 */
export type DeliveryStatus =
  | "DELIVERED" | "EXPIRED" | "DELETED" | "UNDELIVERABLE"
  | "ACCEPTED" | "UNKNOWN" | "REJECTED"
  | "DELIVRD" | "UNDELIV" | "ACCEPTD" | "REJECTD";

/** Inbound: delivery status report. */
export interface SmsReportCallback {
  destinationAddress: string;
  /** Documented as yyMMddHHmm; the published sample is 14 digits. Parse on length. */
  timeStamp: string;
  /** Matches the requestId from the original send. */
  requestId: string;
  deliveryStatus: DeliveryStatus;
}

/* ── USSD ────────────────────────────────────────────────────────────────── */

/** Set by the platform on inbound; set by your app on outbound. */
export type UssdOperation =
  | "mo-init"  // platform: subscriber started a session
  | "mo-cont"  // platform: subscriber replied
  | "mt-init"  // app: app-initiated session
  | "mt-cont"  // app: next screen, session stays open
  | "mt-fin";  // app: final screen, session closes

export interface UssdSendRequest extends ApplinkCredentials {
  version: string;
  message: string;
  /** Echo the sessionId the platform gave you. Never generate your own. */
  sessionId: string;
  ussdOperation: Extract<UssdOperation, "mt-init" | "mt-cont" | "mt-fin">;
  destinationAddress: string;
  /** "440" = plain ASCII. */
  encoding?: "440";
}

export interface UssdSendResponse extends ApplinkBaseResponse {
  timeStamp?: string;
}

/** Inbound: USSD keypress or session start. */
export interface UssdReceiveCallback {
  version: string;
  applicationId: string;
  message: string;
  requestId: string;
  sessionId: string;
  ussdOperation: Extract<UssdOperation, "mo-init" | "mo-cont">;
  sourceAddress: string;
  vlrAddress?: string;
  encoding: string;
}

/* ── Subscription ────────────────────────────────────────────────────────── */

/** "1" = opt in (register), "0" = opt out (unregister). */
export type SubscriptionAction = "1" | "0";

/**
 * The statuses getSubscriberChargingInfo documents. Only REGISTERED and TRIAL
 * mean the subscriber can use the service.
 */
export type SubscriptionStatus =
  | "INITIAL"
  | "REG_PENDING"
  | "TRIAL"
  | "REGISTERED"
  | "UNREGISTERED"
  | "TEMPORARY_BLOCKED";

export interface SubscriptionSendRequest extends ApplinkCredentials {
  subscriberId: string;
  action: SubscriptionAction;
}

export interface SubscriptionSendResponse extends ApplinkBaseResponse {
  /**
   * The field that tells you the outcome. Applink publishes no benign
   * "already registered" code, so this — not statusCode — is how you know the
   * desired state holds. Note the published samples include a trailing dot
   * ("UNREGISTERED."), so compare with startsWith rather than equality.
   */
  subscriptionStatus?: string;
}

export interface QueryBaseRequest extends ApplinkCredentials {}

export interface QueryBaseResponse extends ApplinkBaseResponse {
  /** Subscriber base size — arrives as a string. Coerce before arithmetic. */
  baseSize?: string;
}

export interface SubscriberChargingInfoRequest extends ApplinkCredentials {
  /** Maximum 10 per request. Note the plural — the schema's required list says otherwise. */
  subscriberIds: string[];
}

export interface SubscriberChargingInfo {
  subscriberId: string;
  subscriptionStatus?: SubscriptionStatus;
  /** YYYY-MM-DD hh:mm:ss. Omitted for a free application. */
  lastChargedDate?: string;
  /** Amount with currency code, e.g. "30.00 BDT". Omitted for a free application. */
  lastChargedAmount?: string;
  /** "prepaid" | "postpaid" */
  numberType?: string;
  statusCode?: string;
  statusDetail?: string;
}

export interface SubscriberChargingInfoResponse extends ApplinkBaseResponse {
  destinationResponses?: SubscriberChargingInfo[];
}

/** Inbound: subscriber notification. The authoritative source of state. */
export interface SubscriptionNotificationCallback {
  timeStamp: string;
  version: string;
  applicationId: string;
  /**
   * The platform sends your API key back to you here. Redact it before
   * anything is logged — see references/07-callbacks.md.
   */
  password: string;
  subscriberId: string;
  frequency: "daily" | "weekly" | "monthly" | "yearly";
  status: string;
}

/* ── OTP (subscription activation) ───────────────────────────────────────── */

export interface OtpApplicationMetaData {
  /** Web browser or mobile app. */
  client: string;
  device: string;
  os: string;
  /** App: store identifier. Web: page URL. */
  appCode: string;
}

export interface OtpRequestInput extends ApplinkCredentials {
  subscriberId: string;
  /** Hash determining which verification messages go to your app. */
  applicationHash?: string;
  applicationMetaData?: OtpApplicationMetaData;
}

export interface OtpRequestResponse extends ApplinkBaseResponse {
  /** Keep server-side, in the session. Never send it to the client. */
  referenceNo?: string;
}

export interface OtpVerifyInput extends ApplinkCredentials {
  referenceNo: string;
  otp: string;
}

export interface OtpVerifyResponse extends ApplinkBaseResponse {
  subscriptionStatus?: string;
  /** The subscriberId to use for every subsequent API call. Opaque. */
  subscriberId?: string;
}

/* ── CaaS ────────────────────────────────────────────────────────────────── */

/**
 * Step 1 of charging. Despite the /caas/direct/debit path, this only reserves
 * the charge and sends the subscriber an OTP.
 */
export interface CaasOtpGenerationRequest extends ApplinkCredentials {
  /** Your idempotency key. Persist BEFORE calling. */
  externalTrxId: string;
  /** Sent as a string. Hold it as a decimal type in your own code. */
  amount: string;
  paymentInstrumentName: string;
  subscriberId: string;
  /** Capital C, as published. Only "BDT" is accepted. */
  Currency: string;
}

export interface CaasOtpGenerationResponse extends ApplinkBaseResponse {
  timeStamp?: string;
  externalTrxId?: string;
  /**
   * The platform's identifier for this transaction, and the value step 2
   * needs as referenceNo. Persist it — the charge cannot be completed
   * without it.
   */
  requestCorrelator?: string;
  /** Service-provider transaction ID. Persist it for support. */
  internalTrxId?: string;
}

/** Step 2 of charging. This is where the money moves. */
export interface CaasOtpVerifyRequest extends ApplinkCredentials {
  /** The requestCorrelator from step 1 — not your externalTrxId. */
  referenceNo: string;
  otp: string;
  /** The MSISDN that requested the OTP. */
  sourceAddress: string;
}

/**
 * The published response sample for /caas/otp/verify echoes the request rather
 * than showing a response envelope. Read statusCode and statusDetail, log the
 * real body once in Limited Production, and settle from the charging
 * notification.
 */
export interface CaasOtpVerifyResponse extends ApplinkBaseResponse {
  [key: string]: unknown;
}

export interface BalanceQueryRequest extends ApplinkCredentials {
  subscriberId: string;
  paymentInstrumentName: "MobileAccount";
  accountId?: string;
  /** Lower-case c here, unlike the charging request. Only "BDT". */
  currency?: string;
}

export interface BalanceQueryResponse extends ApplinkBaseResponse {
  /** String. Parse as decimal, never as a float you compare for equality. */
  chargeableBalance?: string;
  accountType?: string;
  accountStatus?: string;
}

/** Inbound: charging notification — your reconciliation channel. */
export interface ChargingNotificationCallback {
  /** Sample format "15-Nov-2023 11:55" — unlike anything else. Parse defensively. */
  timeStamp?: string;
  /** Capital T, as published. */
  TotalAmount?: string;
  /** Match this against your ledger row. */
  externalTrxId?: string;
  balanceDue?: string;
  statusDetail?: string;
  currency?: string;
  version?: string;
  internalTrxId?: string;
  /** Compare against what you charged before treating an order as fulfilled. */
  paidAmount?: string;
  referenceId?: string;
  /** P = partial, E = error, S = success. */
  statusCode?: string;
}
