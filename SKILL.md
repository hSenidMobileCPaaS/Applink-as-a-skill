---
name: applink
description: Build and integrate Applink (hSenid Mobile's Bangladesh telco platform, on the Banglalink network) services into any application — SMS, USSD, Subscription (register, unregister, base size, subscriber charging info), OTP, and CaaS charging (a two-step OTP flow with a charging-notification callback). Use this whenever the user mentions Applink, api.applink.com.bd, MSISDN/`tel:` addressing, shortcode/keyword, USSD menus, subscriber base size, direct carrier billing, mobile-account charging, or telco SMS in Bangladesh. Covers request/response contracts, callback (webhook) handlers, status codes, credential handling, and go-live requirements.
---

# Applink Integration Skill

Applink is hSenid Mobile's telco service platform for **Bangladesh**, running on the
Banglalink network. It exposes carrier capabilities — SMS, USSD, subscription lifecycle, OTP
verification, mobile-account charging — as JSON-over-HTTPS APIs that any application can call.
Charging is in **BDT** only.

This skill makes you able to build a correct, production-shaped Applink integration from
scratch, or add Applink to an existing product, **in any language**. The platform is JSON over
HTTPS with a shared-secret credential pair; nothing about it privileges a particular runtime or
framework. Build in whatever the host project already uses.

**Every call comes from one place: [references/13-curl-reference.md](references/13-curl-reference.md).**
It writes out every endpoint as a runnable curl, with every parameter defined, the response it
returns and every response field explained — plus all five inbound callbacks. Translate the
request into the host project's own HTTP client and idiom, and that is the call. There is no
code generator here on purpose: a generator would serve a handful of languages and go stale as
their idioms move, while a curl is the same call in every language and never expires.

[references/11-any-stack.md](references/11-any-stack.md) specifies what surrounds those calls —
the seven components — language-neutrally. [templates/](templates/README.md) shows the whole
thing already built in TypeScript/Node, Python, Java, Go, PHP and C#: worked examples to read
for shape when one matches the project, never a reason to introduce one of those runtimes.

---

## The six rules you must never break

These are the mistakes that cost service providers their app approval, their subscribers,
or real money. Apply them without being asked.

1. **Never hardcode `applicationId` or `password`.** They go in environment variables, read
   through one config module that validates at startup. Never in source, never in a client
   bundle, never in a committed file, never in a log line, never in git history. See
   [references/09-security-best-practices.md](references/09-security-best-practices.md).

2. **Never call Applink from client-side code.** Browser JS, mobile apps, and Flutter/React
   Native code must call *your* backend, which calls Applink. The credentials are a
   symmetric secret; anything that ships to a device leaks them. The platform also enforces
   IP allow-listing, which a mobile client cannot satisfy.

3. **Never charge or subscribe a user without explicit consent, and never without telling
   them the amount and frequency first.** Consent must be captured and stored with a
   timestamp.

4. **Never assume the MSISDN is real.** Applications provisioned with number masking receive
   an opaque value instead of `tel:8801959979376`. Treat `subscriberId` as an opaque string,
   store it as given, and send back exactly what you received.

5. **A charge is two calls, and `P1003` is not success.** `POST /caas/direct/debit` reserves
   the charge and sends the subscriber an OTP; `POST /caas/otp/verify` is where the money
   moves; the **charging notification** callback is the authoritative outcome. Code that
   treats the first response as a completed charge fulfils orders nobody paid for.

6. **Always make charging idempotent.** Generate a unique `externalTrxId` per charge, persist
   it *before* the call, and never restart with a fresh one — and never re-run OTP generation
   to retry a failed verification. Either one double-charges a real person.

---

## Query the contract, do not recall it

The complete Applink contract ships as structured data
([`catalog/applink-api.json`](catalog/applink-api.json)) with a zero-dependency CLI over it.
Run it instead of reconstructing parameter names from memory — it is offline, read-only, needs
no install, and never sees credentials.

```bash
node tools/applink.mjs list [category]              # every service and callback
node tools/applink.mjs show <id>                    # full contract: params, response, rules
node tools/applink.mjs search "<query>"             # find by intent, e.g. "base size"
node tools/applink.mjs curl <id> [key=value ...]    # runnable request + param/response defs
node tools/applink.mjs validate <id> '<json>'       # check a payload against the spec
node tools/applink.mjs response <id> ['<json>']     # expected response + handling; check a real one
node tools/applink.mjs code <statusCode>            # decode a status code + the fix
node tools/applink.mjs diagnose "<symptom>"         # cause and fix from a symptom
node tools/applink.mjs practices [severity]         # security and reliability rules
node tools/applink.mjs checklist                    # go-live checklist
node tools/applink.mjs reference <doc>              # print a reference document
node tools/applink.mjs platform                     # base URL, operator, conventions
```

`--json` on any command for machine-readable output. If you cannot run commands — or Node is
not available — read `catalog/applink-api.json` directly; it is plain JSON and holds the same
data, and [references/13-curl-reference.md](references/13-curl-reference.md) is the same
contract in prose. The CLI is a documentation reader, not part of the integration: it makes no
network calls, never sees a credential, and puts no constraint on the stack you build in.

## Write the call, do not hand-roll it

**[references/13-curl-reference.md](references/13-curl-reference.md) is where every call comes
from.** Each endpoint is written out at the wire: the request as a runnable curl, every
parameter defined with its type and whether it is required, the exact response, every response
field explained, and that endpoint's status codes with their handling class — plus the same for
all five inbound callbacks, each with a command that replays it against your own handler.

Translate the request into the host project's HTTP client and idiom. That is the whole job for
the call itself: the body, the headers and the branching are identical in every language, so
Ruby, Rust, Kotlin and Elixir are exactly as well served as TypeScript. What surrounds the call
differs by stack, and that is [references/11-any-stack.md](references/11-any-stack.md).

`node tools/applink.mjs curl <id> key=value …` prints the same thing for one service, filled
in with your values and validated as it builds.

Run the curl by hand before writing code, and again first thing when a call fails — it
separates "my payload is wrong" from "my code is wrong" in one step, and it is the fastest way
to prove credentials, provisioning and the egress IP at the same time.

**This skill deliberately has no code generator.** An emitter can only cover the languages
someone wrote emitters for, and it ages with each of those languages' idioms rather than with
the Applink contract — which is why the contract, the curl reference and the templates are the
things kept current. Write the code in the project's own conventions, from the contract.

**Working order:** `search`/`list` to find the service → `show` for the exact contract → the
curl reference for the call → `validate` the payload your code builds → `response` for what
comes back and how to handle it → `code`/`diagnose` when something fails.

**Prove it before it touches the platform, whatever the language.** Run
`node scripts/mock-applink.mjs` and point the project's `APPLINK_*_URL` variables at it
(`http://127.0.0.1:8089/<service-path>`). It validates every body the code sends and answers
like Applink; prefix the path with `/fail/` for a failure body and `/variant/` for a
minimal-and-unexpected one, and the code must handle both. Zero `BAD` lines, and the right
behaviour on all three, is the bar — the six shipped templates are held to it in CI. The
serializer defaults that most often break it, per language, are in
[references/11-any-stack.md](references/11-any-stack.md#serialising-the-request-and-parsing-the-response-per-stack).

### Getting the body right the first time

The mistakes that turn a correct-looking call into `E1312`, `E1855` or a silently ignored field:

- **Every value is a JSON string.** `"action": "1"`, `"amount": "5.00"`, `"version": "1.0"`,
  `"encoding": "440"` — never `1`, `5`, `1.0` or `440`. Identifiers such as `requestCorrelator`
  are 31 digits long; a number type turns them into `8.80144223314617e+30`. Only
  `destinationAddresses` and `subscriberIds` are arrays (of strings), and only
  `applicationMetaData` is an object (of strings).
- **Send exactly that endpoint's parameters.** `version` belongs to SMS Send and USSD Send only.
  Names are case-sensitive and differ on purpose: `Currency` (charge) vs `currency` (balance),
  `destinationAddresses` (SMS, array) vs `destinationAddress` (USSD), `subscriberIds` (charging
  info) vs `subscriberId`, and CaaS OTP Verification names the subscriber `sourceAddress`.
- **Omit an optional field you have no value for** — never send it as `null`, `""`, `{}` or `[]`
  (PHP's `json_encode([])` is `[]`, an array where an object belongs).
- **Build the body as a map of strings and let the JSON library serialise it.** Never assemble
  JSON by string concatenation. Check the library's defaults: Jackson and System.Text.Json
  write `null`s, System.Text.Json's web defaults turn a `Currency` property into `currency`,
  kotlinx.serialization silently drops properties left at their default, Go writes a nil map
  as `null` and an untagged field under its Go name.

### Reading the response

- Decide from `statusCode` against **that endpoint's expected outcome** — `S1000` everywhere
  except CaaS OTP Generation, where it is `P1003`. Each endpoint in the curl reference has a
  *Handling the response* section: what to read, what to persist, and the next step.
- On any other code, rely on `statusCode` and `statusDetail` only; the endpoint's own fields may
  be absent.
- Every response value is a string, numbers included — parse `baseSize` to an integer and money
  to a decimal type at the boundary. Read every field except `statusCode` with a default, and
  ignore unknown fields (Jackson and kotlinx.serialization reject them unless told not to).
- `subscriptionStatus` carries a trailing dot in the samples (`"UNREGISTERED."`): compare by
  prefix. `destinationResponses` can partially fail under a top-level `S1000`: check each entry.

**Whole-integration order:** [references/12-implementation-playbook.md](references/12-implementation-playbook.md)
takes a project from nothing to production, and covers the three starting points — greenfield,
mid-build, and retrofitting Applink into a live application.

## How to approach an Applink task

**Step 1 — Establish what already exists.** Ask (or check the code for) which of these the
user has:

- An Applink account and a provisioned app (`APP_00XXXX` + the API key emailed on approval)?
- Which APIs were provisioned? An app can only call services it was provisioned for —
  otherwise you get `E1309`.
- A publicly reachable HTTPS URL for callbacks? Required for MO SMS, delivery reports, USSD,
  subscriber notifications, and charging notifications. Without one, inbound flows cannot
  work at all — and without the charging notification, charges never settle.
- A static egress IP? Required — see rule below.

If they have none of this, they are pre-provisioning. Read
[references/01-getting-started.md](references/01-getting-started.md) and walk them through
it; you can still build and test the whole integration against a local mock first.

**Step 2 — Pick the services.** Map the product requirement to APIs using the table below.
Most real applications need *Subscription + SMS* at minimum; charging apps add *CaaS*;
feature-phone reach adds *USSD*.

**Step 3 — Pick the stack, then scaffold config before code.** The stack is the host project's,
not the template's: a Django codebase gets Python, a Spring service gets Java, a Laravel app
gets PHP. Create `.env` / `.env.example` and the config module first, so no credential ever has
a chance to land in a source file. Copy from [templates/.env.example](templates/.env.example)
— the variable names are identical in every language — and the config file from the matching
directory in [templates/](templates/README.md).

**Step 4 — Build the client, then the callbacks.** Outbound calls and inbound callbacks are two
separate halves. Both are required for most services, and for charging the callback is not
optional at all. See [references/07-callbacks.md](references/07-callbacks.md) — the callback
contract has hard rules (respond `S1000` fast, be idempotent, never trust the body, and strip
the `password` the subscriber notification carries).

**Step 5 — Handle status codes properly.** Applink returns HTTP 200 with an application-level
`statusCode` in the body. `S1000` is success, `P1003` is pending, everything else is a failure
you must branch on. Checking only the HTTP status is a bug. See
[references/08-status-codes.md](references/08-status-codes.md).

**Step 6 — Run the go-live checklist** in
[references/10-production-checklist.md](references/10-production-checklist.md) before the
user requests production approval.

---

## Service map

| Need | Service | Endpoint | Reference |
|---|---|---|---|
| Send an SMS to a subscriber (MT) | SMS Send | `POST /sms/send` | [02-sms](references/02-sms.md) |
| Broadcast to the whole subscriber base | SMS Send with `tel:all` | `POST /sms/send` | [02-sms](references/02-sms.md) |
| Receive an SMS from a user (MO) | SMS Receive | *your callback URL* | [02-sms](references/02-sms.md) |
| Know whether an SMS was delivered | Delivery Status Report | *your callback URL* | [02-sms](references/02-sms.md) |
| Interactive menu on any phone | USSD Send | `POST /ussd/send` | [03-ussd](references/03-ussd.md) |
| React to a user dialling your code | USSD Receive | *your callback URL* | [03-ussd](references/03-ussd.md) |
| Opt a user in | Subscription Register | `POST /subscription/send` (`action:"1"`) | [04-subscription](references/04-subscription.md) |
| Opt a user out (**unsub**) | Subscription Unregister | `POST /subscription/send` (`action:"0"`) | [04-subscription](references/04-subscription.md) |
| **Subscriber base size** | Base Size | `POST /subscription/query-base` | [04-subscription](references/04-subscription.md) |
| Check status + last charge (≤10 MSISDNs) | Get Subscriber Charging Info | `POST /subscription/getSubscriberChargingInfo` | [04-subscription](references/04-subscription.md) |
| Be told when a user subs/unsubs | Subscriber Notification | *your callback URL* | [04-subscription](references/04-subscription.md), [07-callbacks](references/07-callbacks.md) |
| Activate a subscription from a web/app form | OTP Request → Verify | `POST /otp/request`, `POST /otp/verify` | [04-subscription](references/04-subscription.md) |
| Know whether a **returning** user may use the service | Your own session + your local subscription mirror | **no call** — never re-run OTP or charging to log someone in | [04-subscription](references/04-subscription.md#identity-and-sessions--subscribe-once-then-trust-your-own-session) |
| **Start** a mobile-account charge (sends an OTP) | CaaS OTP Generation | `POST /caas/direct/debit` | [05-caas](references/05-caas.md) |
| **Complete** the charge (money moves) | CaaS OTP Verification | `POST /caas/otp/verify` | [05-caas](references/05-caas.md) |
| Check a user can afford a charge | Query Balance | `POST /caas/get/balance` | [05-caas](references/05-caas.md) |
| Be told the outcome of a charge | Charging Notification | *your callback URL* | [05-caas](references/05-caas.md), [07-callbacks](references/07-callbacks.md) |
| Locate a subscriber, voice/IVR, a `getStatus` endpoint | **Not published** | — | [06-coverage-and-extensions](references/06-coverage-and-extensions.md) |

Production host for everything: `https://api.applink.com.bd`. Every row above as a runnable
request with its parameters and response defined:
[references/13-curl-reference.md](references/13-curl-reference.md).

**Configure one environment variable per provisioned service** — `APPLINK_SMS_SEND_URL`,
`APPLINK_USSD_SEND_URL`, and so on — never one shared base URL. An application can only call
the APIs it was provisioned for, so an unset endpoint means that service is not enabled and
the client should refuse to call it rather than fail with `E1309` at the platform. Never
inline a URL. See [templates/.env.example](templates/.env.example).

---

## The shape of every Applink call

Every outbound API is the same shape. Learn it once:

```
POST https://api.applink.com.bd/<service-path>
Content-Type: application/json;charset=utf-8

{ "applicationId": "APP_000375", "password": "…", …that endpoint's fields, all strings… }
```

(`"version": "1.0"` is one of those fields on SMS Send and USSD Send only.) Every response is
HTTP 200 with:

```json
{ "statusCode": "S1000", "statusDetail": "Success.", … }
```

So the correct client, in every language, is one `post(path, payload)` helper that injects
credentials from config, plus per-service wrappers. Do not write bespoke HTTP calls per
endpoint. [templates/](templates/README.md) has complete working implementations of exactly
this in six languages — read the closest one for shape rather than inventing a new structure —
and [references/11-any-stack.md](references/11-any-stack.md) specifies the same thing
language-neutrally when the project's stack is not among them.

### Addressing

Subscriber addresses are **always** prefixed `tel:` with no spaces:

```
tel:8801959979376        plain MSISDN — the form subscription, OTP and CaaS publish
tel:+8801959979376       the form the SMS samples publish
tel:<masked value>       masking enabled — opaque, use as-is
tel:all                  broadcast to the subscribed base (SMS send only)
```

The platform's own samples disagree about the `+`. Send the no-`+` form so one helper serves
every endpoint; if SMS returns `E1325`, try the `+` form there and report it to support.
Normalise once, in one function, at the boundary. Never string-concatenate `tel:` inline.

---

## Non-obvious things that will bite you

- **`/caas/direct/debit` does not debit.** It sends the subscriber an OTP and returns `P1003`.
  This is the single biggest trap on the platform, and the name is why.
- **`referenceNo` means two different things.** On `/otp/verify` it is the `referenceNo` from
  `/otp/request`. On `/caas/otp/verify` it is the `requestCorrelator` from
  `/caas/direct/debit`. Mixing them up is `E1855`.
- **The subscriber notification callback contains your `password`.** Redact it before the
  payload reaches any log or error reporter.
- **IP allow-listing is mandatory.** The platform rejects calls from any IP not on the
  application's allowed host addresses with `E1303`. Applink publishes no IP-echo endpoint, so
  get the egress IP with `curl -4 https://api.ipify.org` **from the server that will make the
  calls** — not from a laptop. Serverless/autoscaling platforms with rotating egress IPs need a
  static NAT or a fixed-IP proxy; decide this before choosing a host.
- **Limited Production is the first approval state.** Only whitelisted numbers can use the app
  (`E1343` otherwise). If a test number "does nothing", check that list before debugging code.
- **HTTP 200 ≠ success.** Branch on `statusCode`, always.
- **`E1309` means not provisioned, not a code bug.** Calling a service the app was not
  provisioned for fails no matter how correct the payload is.
- **Subscription, OTP and CaaS are transactions, not a login API.** They prove once that a
  user controls a number; they charge money, send real SMS and count against the rate limits
  every time they run. After the subscription flow completes, issue **your own** session and
  answer "may this user in?" from your local subscription mirror — not by re-running OTP or
  polling `getSubscriberChargingInfo` per request. See
  [references/04-subscription.md](references/04-subscription.md#identity-and-sessions--subscribe-once-then-trust-your-own-session).
- **There are no benign duplicate-state codes.** Applink publishes nothing meaning "already
  registered" or "transaction already completed". Read `subscriptionStatus` for subscription
  outcomes, and settle charges from the charging notification.
- **Callback URLs are configured in the portal, not in code.** Changing your route path means
  updating the provisioning record too.
- **`Currency` is capitalised on the charging request and lower-case on the balance query.**
  `TotalAmount` is capitalised on the charging notification while `paidAmount` is not. Bind the
  field names exactly as published.
- **TLS:** if a handshake fails on an incomplete certificate chain, supply the intermediate CA
  explicitly. Disabling verification (`rejectUnauthorized: false`, `verify=False`,
  `InsecureSkipVerify`, `CURLOPT_SSL_VERIFYPEER => false`, a trust-all `TrustManager`) is
  **not** an acceptable production fix in any language — it opens you to interception of your
  own credentials. See
  [references/09-security-best-practices.md](references/09-security-best-practices.md#3-tls-verification).

---

## Reference files

Read the one that matches the task. Do not guess parameter names — they are all here.

| File | Contents |
|---|---|
| [01-getting-started.md](references/01-getting-started.md) | Account, provisioning, credentials, environments, first call |
| [02-sms.md](references/02-sms.md) | Send / receive / delivery report, full parameter tables |
| [03-ussd.md](references/03-ussd.md) | Session model, `ussdOperation` state machine, menu building |
| [04-subscription.md](references/04-subscription.md) | Register, **unregister**, **base size**, subscriber charging info, notifications, OTP |
| [05-caas.md](references/05-caas.md) | The two-step OTP charge, balance query, idempotency, notifications |
| [06-coverage-and-extensions.md](references/06-coverage-and-extensions.md) | What Applink does **not** publish, the documented inconsistencies, and the extension pattern |
| [07-callbacks.md](references/07-callbacks.md) | All five inbound webhooks, contract, security, idempotency |
| [08-status-codes.md](references/08-status-codes.md) | The complete published code list + how to handle each class |
| [09-security-best-practices.md](references/09-security-best-practices.md) | Secrets, TLS, PII, logging, consent, rate limits |
| [10-production-checklist.md](references/10-production-checklist.md) | Pre-go-live verification |
| [11-any-stack.md](references/11-any-stack.md) | The integration specified language-neutrally: the seven components, per-language notes, port acceptance checklist |
| [12-implementation-playbook.md](references/12-implementation-playbook.md) | A to Z: greenfield / mid-build / retrofit, the four flow recipes, testing without an account, go-live |
| [13-curl-reference.md](references/13-curl-reference.md) | **Every endpoint as a runnable curl** — request, parameter definitions, response, response-field definitions, per-endpoint status codes, and the same for all five callbacks |

Templates in [templates/](templates/README.md) are working reference implementations of the
same integration — config, client, callback handlers and session store — in **TypeScript/Node,
Python, Java, Go, PHP and C#**, plus a shared `.env.example`. Each is built and run against the
validating mock in CI ([tests/conformance/](tests/conformance/run.mjs)). Scripts in
[scripts/](scripts/) — the mock and the curl smoke tests — work with an integration written in
any language.

---

## When generating code

- **Write it in the host project's language and idiom.** Never introduce a new runtime, a
  Node sidecar, or a second service just to reach Applink — a plain HTTPS POST is all it takes,
  and every stack can make one.
- Put every Applink call behind a service module. No endpoint URLs or credentials scattered
  through controllers.
- Type or schema-validate both directions with whatever the stack uses (types, pydantic, Bean
  Validation, struct tags, data annotations). Inbound callback bodies come from outside your
  trust boundary.
- Log `requestId` / `externalTrxId` / `internalTrxId` / `sessionId` on every operation — they
  are how Applink support traces an issue. Log the `statusCode`. **Never** log `password`, the
  OTP, `referenceNo` or `requestCorrelator`, and mask `subscriberId` in logs.
- Persist subscription state locally from the subscriber notification; do not re-query per
  request. Authenticate returning users with the project's own session mechanism and gate
  access on that mirror — a login or a page load must make no Applink call at all.
- Make outbound calls retry-safe: retry only on transport errors and `E1601`/`E1602`/`E1603`,
  never on a definitive `E13xx`, and never anything on the charging path with a new identifier.
- Match the host project's stack and conventions. These templates are a specification, not
  a framework to impose.
