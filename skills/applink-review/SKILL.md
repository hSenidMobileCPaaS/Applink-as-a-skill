---
name: applink-review
description: Review Applink integration code for the mistakes that cost money, leak credentials, or get an application suspended. Use when asked to review, audit, or check Applink code, or before merging a pull request that touches Applink.
---

# Review an Applink integration

Run `node tools/applink.mjs practices` first, then check each one against the code. Report
findings with `file:line`, most severe first. Do not report style opinions — only these.

## Critical — stop the merge

| Check | How it looks in code |
|---|---|
| Hardcoded credentials | An `APP_` id or a long unbroken alphanumeric key in source, tests, fixtures, a config file (`application.yml`, `appsettings.json`, `settings.py`) or git history |
| Credentials in a client bundle | A browser-exposed prefix (`NEXT_PUBLIC_`/`VITE_`/`REACT_APP_`/`PUBLIC_`/`EXPO_PUBLIC_`) on an Applink variable, a config endpoint that serves them, or any Applink call in browser or mobile code |
| HTTP status treated as success | `res.ok`, `res.status === 200`, `raise_for_status()`, `EnsureSuccessStatusCode()`, `response.IsSuccessStatusCode`, Guzzle `http_errors` — with no `statusCode` check |
| **`P1003` treated as a completed charge** | Anything that fulfils an order, grants entitlement or marks a ledger row CHARGED on the response to `/caas/direct/debit`. That call only sends an OTP |
| **OTP generation re-run to retry a verification** | A retry wrapper, a catch block, or a "resend" button that calls `/caas/direct/debit` again instead of re-prompting against the same `requestCorrelator` |
| Non-idempotent charging | `externalTrxId` generated inside a retry, or after the API call rather than before |
| `requestCorrelator` not persisted | The generation response read for `statusCode` only. Without it the charge can never be completed and cannot be recovered |
| Charging without consent evidence | No stored record of who agreed, when, and to what amount |
| Subscriber notification body logged | The payload carries your `password`. A `logger.info(body)` writes your API key into the log aggregator on every subscription change |
| Disabled TLS verification | `rejectUnauthorized: false`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, `verify=False`, `InsecureSkipVerify: true`, `CURLOPT_SSL_VERIFYPEER => false`, a trust-all `TrustManager`, or a certificate callback returning `true` — outside a gated dev path |

## High

- `destinationAddresses` passed as a string rather than an array.
- A request value typed as a number or boolean — `amount`, `action`, `version`, `encoding`,
  `deliveryStatusRequest`, `otp`, `sessionId`, or an identifier such as `requestCorrelator`
  held in a numeric column or type. Every value on the wire is a string.
- An optional field sent as `null`, `""`, `{}` or `[]` instead of omitted (PHP `json_encode([])`,
  Go nil maps, Java `Map.of` with a null value, C# nullable properties without an ignore rule).
- A field that belongs to another endpoint: `version` outside SMS/USSD, `currency` on the
  charge, `Currency` on the balance query, `destinationAddress` on SMS, `subscriberId` on
  CaaS OTP Verification (it is `sourceAddress`).
- A response model that makes endpoint fields required, or parses `baseSize` /
  `chargeableBalance` as numbers without accepting the string they arrive as — a failure body
  carries only `statusCode` and `statusDetail`.
- A status code outside the twenty-nine published ones in the error handling — most often an
  invented "already registered" or "already completed" code carried over from another platform.
- Register/unregister success decided on an error code instead of `subscriptionStatus`.
- `externalTrxId` passed as `referenceNo` to `/caas/otp/verify` — it is the `requestCorrelator`.
- `E1337` (duplicate request) handled by generating a fresh `externalTrxId`.
- `subscriberId` (singular) sent to `getSubscriberChargingInfo`, or more than ten MSISDNs.
- `tel:` concatenated inline instead of through one normalising helper, or two helpers
  disagreeing about the `+`.
- `subscriberId` parsed, trimmed, or assumed to be a phone number.
- Callback handler doing work before returning `S1000` — including an inline `await`/blocking
  call where the stack has a real background mechanism.
- Callback handler with no deduplication key.
- Callback handler that trusts the body, or has no schema validation.
- A callback returning non-200 on a malformed payload, which just triggers redelivery.
- `tel:all` reachable from an ordinary code path.
- Secrets, OTPs, `referenceNo`, `requestCorrelator` or unmasked `subscriberId` in logs.

## Medium

- No explicit timeout on outbound calls.
- Retries on definitive `E13xx` codes, or retries without backoff.
- Only one of the two charging URLs configured — a charge that can be started but never
  completed.
- `balanceDue` ignored on the charging notification, so a partial payment is treated as a
  completed order.
- USSD `sessionId` generated locally instead of echoed from the platform.
- USSD flow ending in `mt-cont` instead of `mt-fin`.
- An in-process USSD session store (`Map`, `dict`, `HashMap`, package-level `map`, `MemoryCache`)
  where more than one instance or worker runs.
- `getSubscriberChargingInfo` polled per request instead of mirroring subscriber notifications.
- Money held in a binary float (`number`, `float`, `double`) rather than a decimal type, or a
  currency other than `BDT`.
- `Currency` / `currency` capitalisation not matching the endpoint, or `TotalAmount` bound as
  `totalAmount`.
- A new runtime or sidecar introduced purely to call Applink from a non-JS project.
- Amount or currency taken from client input.
- An invented LBS, IVR or `getStatus` endpoint — Applink publishes none of them.

## Output

For each finding give the rule, the evidence, and the specific fix. Finish with a plain verdict
on whether this is safe to put in front of real subscribers who can be charged real money.
