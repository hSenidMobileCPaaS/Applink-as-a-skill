/**
 * Applink configuration — the ONLY module that reads process.env.
 *
 * Two credentials, plus one URL per service you provisioned. Nothing else is
 * configuration: timeouts and encodings are constants in the client, because
 * they are properties of the protocol rather than of your deployment.
 *
 * An endpoint that is not set means that API is not enabled on your
 * application. The client refuses to call it, so you get a clear local error
 * instead of E1309 from the platform.
 *
 * Validation runs at import time, so a misconfigured deployment fails at boot
 * rather than under load.
 *
 * SERVER-SIDE ONLY. Importing this into client code would bundle the password
 * into something a user can read.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `[applink] Missing required environment variable ${name}.\n` +
        `Copy .env.example to .env and fill in your Applink credentials.\n` +
        `In production, set it in your host's secret manager.`
    );
  }
  return value.trim();
}

/** An endpoint is optional: absent means that API is not provisioned. */
function endpoint(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim().replace(/\/+$/, "") : undefined;
}

export const config = {
  /** Never log these. Never send them to a client. */
  applicationId: requireEnv("APPLINK_APP_ID"),
  password: requireEnv("APPLINK_PASSWORD"),

  /**
   * Only the services enabled on your application. Point any of these at a
   * local mock during development — that is the whole environment switch.
   */
  endpoints: {
    smsSend: endpoint("APPLINK_SMS_SEND_URL"),
    ussdSend: endpoint("APPLINK_USSD_SEND_URL"),
    subscriptionSend: endpoint("APPLINK_SUBSCRIPTION_SEND_URL"),
    subscriptionQueryBase: endpoint("APPLINK_SUBSCRIPTION_QUERY_BASE_URL"),
    subscriptionChargingInfo: endpoint("APPLINK_SUBSCRIPTION_CHARGING_INFO_URL"),
    otpRequest: endpoint("APPLINK_OTP_REQUEST_URL"),
    otpVerify: endpoint("APPLINK_OTP_VERIFY_URL"),
    /** CaaS step 1 — sends the subscriber an OTP. Charges nothing on its own. */
    caasOtpGeneration: endpoint("APPLINK_CAAS_DEBIT_URL"),
    /** CaaS step 2 — this is the call that moves money. */
    caasOtpVerify: endpoint("APPLINK_CAAS_OTP_VERIFY_URL"),
    caasBalance: endpoint("APPLINK_CAAS_BALANCE_URL"),
  },
} as const;

export type ServiceName = keyof typeof config.endpoints;

/**
 * Resolve an endpoint, or fail with a message that names the missing variable.
 *
 * This is the guard that keeps you from calling an API your application was
 * never provisioned for.
 */
export function requireEndpoint(service: ServiceName): string {
  const url = config.endpoints[service];
  if (!url) {
    throw new Error(
      `[applink] ${service} is not configured. Either the API is not enabled on ` +
        `your application in the Applink portal, or its URL is missing from the ` +
        `environment. See .env.example.`
    );
  }
  return url;
}

/** Which services this deployment can actually call. Useful at startup. */
export function enabledServices(): ServiceName[] {
  return (Object.keys(config.endpoints) as ServiceName[]).filter(
    (s) => config.endpoints[s] !== undefined
  );
}

/**
 * Charging needs BOTH steps configured. A deployment with only the generation
 * URL can start charges it can never complete, which leaves subscribers
 * holding an OTP and your ledger holding pending rows.
 */
export function assertChargingConfigured(): void {
  const hasGeneration = config.endpoints.caasOtpGeneration !== undefined;
  const hasVerify = config.endpoints.caasOtpVerify !== undefined;
  if (hasGeneration !== hasVerify) {
    throw new Error(
      "[applink] Charging is a two-step flow: set BOTH APPLINK_CAAS_DEBIT_URL and " +
        "APPLINK_CAAS_OTP_VERIFY_URL, or neither. With only one, a started charge " +
        "can never be completed."
    );
  }
}

/** Redacted view, safe to log at startup to confirm what the process loaded. */
export function describeConfig(): Record<string, unknown> {
  return {
    applicationId: config.applicationId,
    password: "***redacted***",
    enabledServices: enabledServices(),
  };
}
