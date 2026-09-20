# Implementation Playbook — A to Z

Everything from "we have an idea" to "real subscribers are being charged", for **any**
language and **any** starting point. Work top to bottom on a new project; jump to
[§2](#2-entry-point-b--mid-build) or [§3](#3-entry-point-c--retrofit-into-a-live-application)
if code already exists.

Every step below that says *write the call* means: take the endpoint from
[13-curl-reference.md](13-curl-reference.md) — a runnable curl with every parameter defined and
every response field explained — and translate the request into the project's own HTTP client.
That is the same instruction whatever the language is; nothing in this playbook assumes one.

```bash
node tools/applink.mjs curl <id> [key=value ...]   # one endpoint, your values, validated
node tools/applink.mjs reference 13-curl-reference # all of them
```

---

## 0. Establish the ground truth (all entry points)

Ask these five questions before writing anything. Each answer changes the plan, and guessing
wastes days.

| Question | If yes | If no |
|---|---|---|
| Provisioned app? (`APP_00XXXX` + password) | Note which APIs were enabled | Start at [01-getting-started](01-getting-started.md); you can still build everything against a local mock |
| Which APIs are enabled? | Configure exactly those URLs | An unprovisioned call fails `E1309` no matter how perfect the payload |
| Static egress IP? | Whitelist it in the portal | Decide the hosting story now — NAT gateway, static-IP proxy or a fixed host. Retrofitting this is painful |
| Public HTTPS URL for callbacks? | Register the five paths | MO SMS, USSD and every notification cannot work at all until there is one |
| Limited Production or full? | Only whitelisted numbers work | Full production means real subscribers and real money on every call |

Run `node tools/applink.mjs platform` for base URLs and operators, and
`node tools/applink.mjs list` for what exists.

---

## 1. Entry point A — greenfield

You are building the application around Applink.

**1. Choose the stack.** Whatever you would use anyway — Applink is JSON over HTTPS. See
[11-any-stack](11-any-stack.md).

**2. Config first, so no credential can ever land in source.**

```bash
cp templates/.env.example .env          # then fill in APP_ID + password
```

One module reads those variables, validates at startup and fails loudly — see
[11-any-stack §1](11-any-stack.md#1-config). Nothing else in the codebase touches the
environment.

**3. Write the client and the error module.**

The client is one `post()` — credential injection, a 15-second timeout, `statusCode` branching —
plus a thin wrapper per service, each built from its entry in
[13-curl-reference.md](13-curl-reference.md). The error module is the handling classes from
[08-status-codes](08-status-codes.md), whose complete table carries a class per code — including
`pending` for `P1003`, which is the one an ordinary success check gets wrong. Both are specified language-neutrally in [11-any-stack](11-any-stack.md), and
[templates/](../templates/README.md) shows them already built in six languages if one matches
your stack.

**4. Prove the credentials before building features.** Base Size needs no subscriber and
charges nothing:

```bash
./scripts/smoke-test.sh    # or: node tools/applink.mjs curl subscription-query-base
```

`S1000` means credentials, whitelisting and connectivity are all correct. `E1313` is
credentials, `E1303` is the egress IP, `E1309` is provisioning. Fix before continuing.

**5. Build the flow you actually need** — [§4](#4-flow-recipes).

**6. Callbacks** — [§5](#5-callbacks-half-the-integration).

**7. Error handling** — [§6](#6-error-handling-that-survives-production).

**8. Go live** — [§8](#8-go-live).

---

## 2. Entry point B — mid-build

An application exists; Applink is a feature you are adding now.

1. **Find the seam.** Applink is an outbound integration plus five inbound routes. It belongs
   beside your other third-party clients — `services/`, `integrations/`, `infrastructure/`,
   whatever this codebase already calls that layer. Do not scatter calls through controllers.
2. **Audit what exists first** if any Applink code is already there:
   `node tools/applink.mjs practices` and the `applink-review` skill. Half-built integrations
   usually have a hardcoded credential and an `if (res.ok)`.
3. **Build into your own module** rather than pasting endpoint URLs into existing services —
   one client, one `post()`, one wrapper per service.
4. **Reuse what the project already has** — its HTTP client, its logger, its queue, its
   secret manager. Only the `statusCode` branching and the benign codes are non-negotiable;
   everything around them follows the project's conventions.
5. Continue at [§4](#4-flow-recipes).

---

## 3. Entry point C — retrofit into a live application

Users already depend on this application. The integration must land without disturbing them.

1. **Ship it dark.** Put every Applink path behind a flag that defaults to off. Telco calls
   cost money and messages reach real phones; a half-finished flow that goes live by accident
   is a support incident.
2. **Callbacks are additive** — five new routes that return `S1000`. They can be deployed and
   registered before any user-facing feature exists, and they will simply log until you use
   them. Deploy them first: registering the URLs in the portal often needs a re-approval cycle,
   so start that clock early.
3. **The egress IP is the usual blocker.** A running production app may sit behind autoscaling
   or serverless egress. Check it on the real server (`curl -4 https://api.ipify.org`) before
   promising a date.
4. **Do not retrofit charging first.** Land SMS or subscription, watch it for a week, then add
   CaaS. Charging failure modes are the expensive ones, and Applink's two-step OTP charge has
   more states to get wrong than a single call does.
5. **Map existing users to subscribers deliberately.** An existing account is not consent. You
   need a fresh opt-in, recorded, before Register or any charge — see
   [09-security-best-practices](09-security-best-practices.md#5-consent).
6. **Keep the blast radius visible:** log `statusCode` from day one and alert on the
   configuration class (`E1303`, `E1313`, `E1309`) before you enable anything for users.

---

## 4. Flow recipes

The five flows that cover almost every Applink application. Each is a sequence of calls plus
the state you must keep.

### A. Keyword opt-in over SMS

```
user texts JOIN to your shortcode
  → SMS receive callback fires        (sms-mo)
  → you record consent + timestamp
  → register(subscriberId)            (subscription-register, action "1")
       read subscriptionStatus from the response — REGISTERED is the state you wanted,
       whether or not this call is the one that changed it
  → sendSms(subscriberId, welcome)    (sms-send)
user texts STOP
  → SMS receive callback fires
  → unregister(subscriberId)          (subscription-unregister, action "0")
       S1000 with statusDetail "not registered" is a success — the desired state holds
  → stop every queued message for that subscriber
```

State to keep: subscription mirror keyed by `subscriberId`, consent record, dedupe on
`requestId`. Mirror from the subscriber notification callback, not by polling.

### B. Web or app sign-up without SMS

```
user types their number
  → requestOtp(subscriberId, metaData)   (otp-request) → referenceNo (server-side only)
user types the PIN
  → verifyOtp(referenceNo, otp)          (otp-verify)  → subscriberId + subscriptionStatus
  → store the returned subscriberId; it is the identifier for every later call, plain or
    masked depending on the application's setting, and opaque either way
```

Rate-limit per number **and** per IP before `requestOtp`, or the application is an SMS-bombing
tool. **An Applink OTP lasts five minutes**, and the platform documents no attempt limit — cap
attempts yourself. `E1850` invalid, `E1851` expired, `E1855` wrong reference number.

### C. USSD menu

```
user dials *xxx#
  → USSD receive callback, ussdOperation "mo-init"   (ussd-receive)
  → acknowledge S1000 immediately
  → create session keyed by the platform's sessionId
  → sendUssd(sessionId, address, screen, "mt-cont")  (ussd-send)
user presses a key
  → USSD receive callback, "mo-cont" → look up session → next screen
last screen
  → sendUssd(..., "mt-fin") and delete the session
```

The session store must be shared across instances and expire in ~2 minutes. Screens are plain
ASCII, ~160 characters. Never generate your own `sessionId`.

### D. Charging — two steps, not one

```
before the first call
  → externalTrxId = generate();  PERSIST IT with status PENDING

step 1  startCharge(subscriberId, amount, externalTrxId)   (caas-otp-generation)
        P1003   → OTP dispatched. NOTHING CHARGED YET.
                  Persist requestCorrelator and internalTrxId on the pending row.
        E13xx   → never started. Mark FAILED.
        timeout → mark UNKNOWN. Do NOT re-send. Reconcile.

step 2  subscriber types the OTP into your application
        confirmCharge(referenceNo = requestCorrelator, otp, sourceAddress)   (caas-otp-verify)
        E1850   → wrong OTP: re-prompt against the SAME referenceNo
        E1851   → expired: abandon the transaction, do not restart it silently
        E1326   → insufficient balance: tell the user
        E1337   → duplicate: settle from the notification, never a new externalTrxId

step 3  charging notification callback   (charging-notification)
        match on externalTrxId → compare paidAmount and balanceDue to your ledger
        → mark CHARGED (or PARTIALLY_PAID if balanceDue is non-zero)
```

Money is a decimal type end to end, and the currency is `BDT`. `queryBalance` is advisory only
— handle `E1326` on the charging path regardless of what it said. **Never re-run step 1 to
retry step 2**: that starts a second charge against a real person.

### E. The returning user — your session, not another OTP

Recipes A, B and C each end with a verified `subscriberId`. That is a **one-time binding**,
not a login mechanism. Register, `/otp/request` and CaaS are transactional and cost money;
re-running one to find out who a user is, or whether they may use the service, charges the
subscriber, SMS-bombs them, and puts your sign-in path at the mercy of the platform.

```
once, at the end of A, B or C
  → record consent, store subscriberId on the account
  → mirror subscriptionStatus on that row + when it was last confirmed
  → issue YOUR OWN session (cookie session, JWT, Django, Spring Security, a Laravel guard)

every request afterwards — no Applink call at all
  session → account → mirrored subscriptionStatus
      REGISTERED / TRIAL     → serve
      REG_PENDING            → "activating"; wait for the callback, do not re-register
      TEMPORARY_BLOCKED      → billing failure: fix-payment path, not a logout
      UNREGISTERED / INITIAL → fresh opt-in, with disclosure

keeping the mirror true — out of band
  subscriber notification callback → update it; this is the authoritative source
  scheduled sweep (getSubscriberChargingInfo, ≤10 subscriberIds per call) → reconcile drift
```

A fresh OTP belongs to a genuine re-verification event — a new device, a changed number, a
dormant account, a step-up before something sensitive — not to every login. And a live
session is never authorisation to charge: every payment is its own CaaS flow, with its own
`externalTrxId` and its own OTP. Full rules:
[04-subscription §Identity and sessions](04-subscription.md#identity-and-sessions--subscribe-once-then-trust-your-own-session).

---

## 5. Callbacks: half the integration

Five inbound routes, one contract. Write them from
[13-curl-reference.md](13-curl-reference.md), which gives each payload field by field, the
response you must return, the dedupe key, and a curl that replays the exact payload against your
route.

| Callback | Fires when | Without it |
|---|---|---|
| SMS receive (MO) | user texts your shortcode | keyword opt-in and STOP silently do nothing |
| Delivery report | an MT SMS reaches a final state | you cannot prove delivery |
| USSD receive | user dials or presses a key | USSD does not work at all |
| Subscriber notification | anyone subscribes or unsubscribes | your local state drifts from the platform's |
| Charging notification | a charge reaches a final state | **charges never settle** — this is the only place `paidAmount` appears |

Rules that are not negotiable: acknowledge `S1000` **before** doing work, always HTTP 200,
deduplicate on the documented key, never trust the body — and redact the `password` field the
subscriber notification carries before anything is logged. Full detail in
[07-callbacks](07-callbacks.md).

Register the paths in the portal once and keep them stable — changing a path later means
editing the provisioning record.

---

## 6. Error handling that survives production

Build one error module: every published code, its handling class, and the benign codes per
operation. The complete table in [08-status-codes](08-status-codes.md) carries a class per code,
and the same data is in `catalog/applink-api.json` if you would rather generate the sets than
retype them. Wire it in like this:

| Class | Your behaviour |
|---|---|
| `success` | Proceed. |
| `pending` | Accepted, not settled. Keep the row open and finish the flow. Never re-send. |
| `configuration` | **Page someone.** The integration is down, not one request. Never retry. |
| `client` | Fix the payload or prompt the user. Never retry unchanged. |
| `user-state` | Communicate. Retry only after the user acts. |
| `transient` | Exponential backoff with jitter, capped attempts, then dead-letter. |

Two things an ordinary success check gets wrong on this platform: `P1003` is **pending**, not
charged; and register/unregister outcomes come from `subscriptionStatus` in the body, because
Applink publishes no benign duplicate-state codes. Do not add codes outside the twenty-nine
published ones.

Log `requestId` / `sessionId` / `externalTrxId` / `internalTrxId` / `statusCode` on every
operation — those are what Applink support traces with. Never log the password, the OTP,
`referenceNo`, `requestCorrelator`, or an unmasked subscriber address.

---

## 7. Testing before — and after — provisioning

| What | How |
|---|---|
| Callback handlers | `./scripts/test-callbacks.sh http://localhost:3000` — valid, malformed, wrong-app, missing-field, oversized and duplicate payloads. Plain curl, so it works against any language |
| Outbound payloads and response handling | `node scripts/mock-applink.mjs`, with the `APPLINK_*_URL` variables pointed at it — every body your code sends is checked against the contract, in any language. See [11-any-stack](11-any-stack.md#proving-the-bodies-in-any-language) |
| Credentials + network | `./scripts/smoke-test.sh` from the server that will make the calls |
| Failure paths | Against the mock: `/fail/…` (or `/fail-E1326/…`, `/fail-E1850/…`) for failure bodies, `/variant/…` for minimal ones with an unknown field, `/timeout/…` for a hang. Against the platform: `E1313` (wrong password) and `E1303` (call from an unlisted IP). Handling code that has never run is not handling code |

**No account yet?** Everything above except the smoke test runs against the mock, so the whole
integration can be built and exercised before provisioning completes. The mock reads
`catalog/applink-api.json` at runtime — the same data the curl reference is generated from — so
it cannot drift from the contract the rest of this skill describes.

---

## 8. Go live

```bash
node tools/applink.mjs checklist          # every item, with evidence required
```

Run it against the real project and mark each item PASS / FAIL / CANNOT VERIFY with the
evidence — a file path, a config value, a test run. The full list is in
[10-production-checklist](10-production-checklist.md); the nine sections are credentials,
network, correctness, callbacks, charging, consent, privacy, operations and testing.

The last question is the only one that matters: **is this safe to put in front of real
subscribers who can be charged real money?**

---

## Quick command map

| You want to | Run |
|---|---|
| See what exists | `applink list` |
| Get one contract exactly | `applink show <service>` |
| Write a call, in any language | [13-curl-reference.md](13-curl-reference.md), or `applink curl <service> key=value …` |
| Write the whole client | [11-any-stack](11-any-stack.md), the seven components |
| Wire up error codes | [08-status-codes](08-status-codes.md), the Class column |
| Write the webhooks | [13-curl-reference.md](13-curl-reference.md), the callbacks half |
| Check a payload | `applink validate <service> '<json>'` |
| Decode a failure | `applink code <statusCode>` |
| Diagnose a symptom | `applink diagnose "<symptom>"` |
| Ship it | `applink checklist` |
