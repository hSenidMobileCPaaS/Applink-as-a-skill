---
name: applink-golive
description: Run the Applink pre-production checklist before requesting full production approval — credentials, network, correctness, callbacks, charging, consent, privacy, operations and testing. Use before going live, or when asked whether an Applink integration is production-ready.
---

# Applink go-live check

```bash
node tools/applink.mjs checklist          # the full list
node tools/applink.mjs checklist --json   # machine-readable, for automation
```

Work through every item against the actual project. For each, state **PASS**, **FAIL** or
**CANNOT VERIFY**, with the evidence — a file path, a config value, a test run. Never mark
PASS on the assumption that something is probably fine; on this platform the cost of a wrong
assumption is charged to a real person's phone bill.

## The nine sections

1. **Credentials and configuration** — nothing in source or git history, secrets in the host's
   secret manager, startup validation that fails loudly, separate dev and production
   credentials, secret scanning in CI.
2. **Network** — production egress IP confirmed *on the production server*
   (`curl -4 https://api.ipify.org`) and added to the application's allowed host addresses,
   callback URLs stable and publicly reachable over HTTPS with a complete chain, TLS
   verification on.
3. **Correctness** — branch on `statusCode`; `P1003` handled as pending, never as charged;
   register/unregister decided on `subscriptionStatus` rather than an error code; no status
   code outside the twenty-nine published ones; `tel:` normalised in one helper;
   `destinationAddresses` an array; USSD `sessionId` echoed and flows terminated with `mt-fin`;
   explicit timeouts.
4. **Callbacks** — all five implemented, acknowledging before doing work, idempotent with a
   dedupe key, schema-validated, the subscriber notification's `password` redacted before any
   logging, and tested with a duplicate payload.
5. **Charging** — `externalTrxId` persisted before the first call, `requestCorrelator`
   persisted from the generation response, a failed verification never re-runs generation,
   `E1337` resolved from the notification, `E1851` abandons rather than silently restarting,
   timeouts resolved by reconciliation, decimal money in BDT, `paidAmount` and `balanceDue`
   compared against the ledger before fulfilment, and a reconciliation job.
6. **Consent and compliance** — opt-in recorded with evidence, the charge disclosed before
   subscribing, opt-out available in every channel and honoured immediately including queued
   messages, `tel:all` behind a deliberate path.
7. **Privacy** — masking enabled where the real MSISDN is not needed, `subscriberId` masked in
   logs, message bodies not logged, OTP / `referenceNo` / `requestCorrelator` never logged,
   retention defined and enforced.
8. **Operations** — identifiers logged on every operation, alerting on configuration-class
   errors (`E1303`/`E1313`/`E1309`), a throttle for the per-second (`E1318`) and per-day
   (`E1319`) limits, a dead-letter queue, a runbook that covers a charge stuck at `P1003`, and
   a named owner who can log in to rotate credentials.
9. **Testing** — end-to-end against Limited Production with whitelisted numbers, the whole
   charging path exercised (generate → verify → notification), failure paths included
   (`E1313`, `E1303`, `E1326`, `E1850`, `E1851`, timeout), and tested **from the production
   egress IP**.

## Verdict

Finish with the FAIL items ordered by risk, and a plain statement: is this safe to put in
front of real subscribers who can be charged real money?

Full list: `references/10-production-checklist.md`.
