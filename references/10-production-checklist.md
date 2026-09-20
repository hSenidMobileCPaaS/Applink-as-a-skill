# Production Checklist

Work through this before requesting full production approval. Each item has cost a service
provider something real.

## Credentials and configuration

- [ ] No `applicationId` or `password` anywhere in source, tests, fixtures, or git history
- [ ] `.env` is git-ignored; `.env.example` contains **only placeholders**
- [ ] Secrets stored in the host's secret manager, not in plaintext config
- [ ] Separate credentials for development and production
- [ ] Startup validation fails loudly on any missing variable
- [ ] No `NEXT_PUBLIC_` / `VITE_` / `REACT_APP_` prefix on any Applink variable
- [ ] Base URL and endpoint paths read from config, not inlined
- [ ] Secret scanning enabled in CI
- [ ] Credential rotation procedure written down and tested at least once

## Network

- [ ] Production egress IP confirmed with `curl -4 https://api.ipify.org` **on the
      production server**
- [ ] That IP added to *Allowed Host Addresses* in the portal
- [ ] Egress IP is static and will survive scaling, redeploys, and restarts
- [ ] Callback URLs are HTTPS with a valid, complete certificate chain
- [ ] Callback URLs are stable — not a preview or tunnel URL
- [ ] Callback endpoints restricted to Applink source IPs
- [ ] Callback endpoints exempt from CSRF and auth middleware, but IP-restricted
- [ ] Bot protection / WAF does not challenge the callback paths
- [ ] TLS verification is **on**; any chain problem solved with an explicit CA bundle, not by
      disabling validation

## Correctness

- [ ] All responses branch on `statusCode`, never on the HTTP status alone
- [ ] `P1003` treated as pending, never as a completed charge
- [ ] Register and unregister decided on `subscriptionStatus`, not on an error code — Applink
      publishes no benign duplicate-state codes
- [ ] No status code outside the twenty-nine published ones appears in the error handling
- [ ] All subscriber addresses normalised through one `tel:` helper
- [ ] `destinationAddresses` is always an array
- [ ] `subscriberId` treated as opaque — masking-safe
- [ ] USSD `sessionId` echoed, never regenerated
- [ ] USSD sessions terminated with `mt-fin`
- [ ] USSD session store is shared across instances (not an in-process `Map`) and has a TTL
- [ ] USSD screens are plain ASCII and under ~160 characters
- [ ] Returning users are authenticated by the application's own session, not by re-running
      OTP, Register or any other Applink call
- [ ] Entitlement is read from the local subscription mirror — no Applink call on a login,
      session-check or page-load path
- [ ] The mirror records when each row was last confirmed, is updated from the subscriber
      notification, and is reconciled on a schedule rather than per request
- [ ] Explicit timeout on every outbound call
- [ ] Retries only on transport errors and transient codes, with backoff and a cap

## Callbacks

- [ ] All five relevant callbacks implemented: MO SMS, delivery report, USSD, subscription
      notification, charging notification
- [ ] Every handler returns `{"statusCode":"S1000","statusDetail":"Success"}`
- [ ] Every handler acknowledges **before** doing real work
- [ ] Every handler is idempotent, with a dedupe key
- [ ] Every handler validates the payload schema
- [ ] Every handler verifies `applicationId` matches, where the payload carries it
- [ ] The subscriber notification's `password` field is redacted before anything is logged
- [ ] Malformed payloads acknowledged and discarded, not 500'd
- [ ] Duplicate-delivery test exists and passes

## Charging (if using CaaS)

- [ ] `externalTrxId` unique and persisted **before** the OTP-generation call
- [ ] Transaction row written before the call, updated after
- [ ] `requestCorrelator` persisted from the generation response — the charge cannot be
      completed without it
- [ ] `P1003` recorded as PENDING, and the flow continues to CaaS OTP Verification
- [ ] A failed verification never re-runs CaaS OTP Generation
- [ ] `E1337` (duplicate request) resolved from the charging notification, never with a new
      `externalTrxId`
- [ ] `E1851` (OTP expired) abandons the transaction rather than silently restarting it
- [ ] Timeouts resolved by reconciliation, never by re-charging
- [ ] `internalTrxId` stored for support
- [ ] Amounts use a decimal type; currency is `BDT`
- [ ] Amount and currency sourced server-side, never from client input
- [ ] Charged amount matches exactly what was disclosed before subscription
- [ ] `paidAmount` and `balanceDue` from the charging notification compared against the ledger
      before an order is treated as fulfilled
- [ ] Balance query left unconfigured unless support has confirmed it is enabled
- [ ] Reconciliation job compares your ledger against charging notifications

## Consent and compliance

- [ ] Explicit opt-in captured before every Register
- [ ] Charge amount, currency and frequency disclosed before subscribing
- [ ] Consent evidence stored: user, timestamp, channel, wording shown
- [ ] Opt-out available in every channel the user can reach
- [ ] `STOP` / `UNSUB` / `OFF` handled in MO SMS
- [ ] Opt-out stops queued and scheduled messages, not just new ones
- [ ] Opted-out users are never re-subscribed without fresh consent
- [ ] `tel:all` broadcast behind a deliberate, separately-authorised path
- [ ] Broadcast volume sanity-checked against Base Size before sending

## Privacy

- [ ] Number masking enabled if the real MSISDN is not needed
- [ ] `subscriberId` masked in all logs
- [ ] Message bodies not logged, or logged with a stated reason and retention period
- [ ] OTP, `referenceNo`, `requestCorrelator` and password never logged
- [ ] MSISDNs encrypted at rest if stored
- [ ] Retention policy defined and enforced
- [ ] Subscriber data deleted or anonymised on unsubscribe

## Operations

- [ ] `requestId` / `sessionId` / `externalTrxId` / `internalTrxId` / `statusCode` logged on
      every operation
- [ ] Alert on configuration-class errors (`E1303`, `E1313`, `E1309`) — the integration is down
- [ ] Dashboard for send volume, delivery rate, charge success rate, base size
- [ ] Base Size polled on a schedule into metrics, not per request
- [ ] Dead-letter queue for failed callback processing
- [ ] Operator TPS/TPD limits known and respected by a throttle
- [ ] Runbook: what to do on `E1303`, on `E1313`, on a charge stuck at `P1003`, on a charging
      dispute
- [ ] Someone owns the Applink account and can log in to rotate credentials

## Testing

- [ ] Every endpoint smoke-tested against Limited Production with whitelisted numbers
- [ ] Full end-to-end tested: register → receive SMS → USSD session → charge (generate, verify,
      notification) → unregister
- [ ] Opt-out path tested end to end
- [ ] Callback handlers tested with valid, malformed, wrong-app, and duplicate payloads
- [ ] Failure paths tested: `E1313`, `E1303`, `E1326`, `E1850`, `E1851`, timeout
- [ ] Load tested to the per-second transaction ceiling (`E1318`)
- [ ] Tested from the production egress IP, not from a laptop

## Before requesting approval

- [ ] Application description in the portal accurately states what the app does
- [ ] Charging amounts are defensible — obviously unfair rates are questioned before approval
- [ ] Terms of service and privacy policy exist and are reachable by users
- [ ] Support contact published to end users
- [ ] Limited Production testing completed with whitelisted numbers
- [ ] Content governance and advertisement settings match expectations

---

## Common failure signatures

| Symptom | Almost always |
|---|---|
| Everything returns `E1303` | Calling from an IP not on the allowed-host list — a laptop, a CI runner, or a serverless function with rotating egress |
| Everything returns `E1313` | Wrong credentials, wrong environment's credentials, or the application is not active |
| One API returns `E1309`, others work | That API was not provisioned |
| Test number gets nothing, no errors | Number not whitelisted while in Limited Production (`E1343`) |
| USSD session dies mid-flow | Session store not shared across instances, no `mt-fin`, or a slow handler |
| Callbacks never arrive | URL not publicly reachable, wrong URL in the portal, a bot-protection challenge, or auth middleware in front |
| Orders fulfilled but no money taken | `P1003` treated as a completed charge — the OTP was never verified |
| Duplicate charges | CaaS OTP Generation re-run to "retry", or a fresh `externalTrxId` issued after a timeout |
| `E1855` on every charge verification | `externalTrxId` passed as `referenceNo` instead of `requestCorrelator` |
| Works locally, fails deployed | Egress IP changed, or secrets not set in the host's environment |
