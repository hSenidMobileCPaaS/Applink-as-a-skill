<!-- Generated from AGENTS.md by scripts/sync-rules.mjs. Do not edit directly. -->

# Applink Integration — Agent Instructions

> Portable entry point for Cursor, Windsurf, GitHub Copilot, Codex, Cline, Aider, Zed and any
> other agent that reads `AGENTS.md`. Claude Code and the Agent SDK use [SKILL.md](SKILL.md) —
> same content, skill frontmatter.

Applink is hSenid Mobile's telco platform for **Bangladesh**, running on the Banglalink network.
It exposes SMS, USSD, subscription management, OTP verification and mobile-account charging as
JSON-over-HTTPS APIs.

**Apply these instructions whenever the work involves Applink, `api.applink.com.bd`,
`tel:` MSISDN addressing, USSD menus, shortcode/keyword routing, subscriber base size,
direct carrier billing, or telco SMS in Bangladesh.**

The platform is JSON over HTTPS, so **any language builds a complete integration** — write it
in whatever the host project already uses. Every endpoint is written out as a runnable curl,
with its parameters and its response defined, in
[references/13-curl-reference.md](references/13-curl-reference.md): translate the request into
the project's HTTP client and you have the call, whatever the language. There is no code
generator here on purpose — a curl is the same call in every language, where an emitter would
serve six and age with their idioms. [references/11-any-stack.md](references/11-any-stack.md)
specifies the surrounding integration language-neutrally, and reference implementations exist
for TypeScript/Node, Python, Java, Go, PHP and C# as worked examples.

---

## Non-negotiable rules

1. **Never hardcode `applicationId` or `password`.** Environment variables only, read through
   one config module, validated at startup. Not in source, not in a client bundle, not in a
   committed file, not in a log, not in git history.
2. **Never call Applink from client-side code.** Browsers and mobile apps call *your*
   backend; your backend calls Applink. The credentials are a shared secret and the platform
   enforces IP allow-listing.
3. **Never subscribe or charge without explicit, recorded consent**, and never without
   disclosing amount, currency (BDT) and frequency first.
4. **Never assume `subscriberId` is a real phone number.** With masking enabled it is an
   opaque value. Store and send back exactly what you received.
5. **Charging is two calls, and `P1003` is not success.** `POST /caas/direct/debit` only sends
   the subscriber an OTP; the money moves at `POST /caas/otp/verify`, and the outcome is
   settled by the charging notification. Never restart a charge with a fresh `externalTrxId`,
   and never re-run generation to retry a verification — either one bills a real person twice.

---

## Query the API catalog instead of guessing

This repo ships the complete Applink contract as structured data
([`catalog/applink-api.json`](catalog/applink-api.json)) plus a zero-dependency CLI over it.
**Run these instead of recalling parameter names** — they are offline, read-only, need no
install, and never see credentials.

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

Add `--json` to any command for machine-readable output. If you cannot run commands — or Node
is not installed — read `catalog/applink-api.json` directly; it is plain JSON with the same
data. The CLI is a documentation reader, not part of the integration, and constrains nothing
about the stack you build in.

**Use them in this order:** `search` or `list` to find the service → `show` for the exact
contract → the curl reference for the call → `validate` the payload your code builds →
`response` for what comes back and how to handle it → `code` / `diagnose` when something fails.

### Write the call from the contract, not from memory

**[references/13-curl-reference.md](references/13-curl-reference.md) is the source for every
call, in every language.** Each endpoint is written out at the wire: a runnable curl, every
parameter defined with type and requiredness, the exact response, every response field
explained, the status codes that endpoint returns — and the same for all five inbound callbacks,
including a command that replays each one against your handler.

Translate the request into the host project's HTTP client and idiom, keeping the payload and the
`statusCode` branching exactly as specified. Body, headers and branching are identical
everywhere, so no language is second-class. `node tools/applink.mjs curl <id> key=value …`
prints the same thing for one service with your values filled in and validated.

Run the curl by hand when a call fails: it separates a bad payload from bad code in one step,
and proves credentials, provisioning and the egress IP at once.

**There is no code generator in this skill, by design.** An emitter covers only the languages
someone wrote emitters for and ages with those languages' idioms rather than with the Applink
contract. Write the client in the project's own conventions from the contract above; the seven
components it belongs in are in [references/11-any-stack.md](references/11-any-stack.md), and
[templates/](templates/README.md) shows them already built in six languages as worked examples
to read — never a reason to add one of those runtimes to a project.

## Read before writing code

| Task | File |
|---|---|
| Account, provisioning, credentials, first call | [references/01-getting-started.md](references/01-getting-started.md) |
| Send / receive SMS, delivery reports | [references/02-sms.md](references/02-sms.md) |
| USSD sessions and menus | [references/03-ussd.md](references/03-ussd.md) |
| Register, **unregister**, **base size**, charging info, OTP | [references/04-subscription.md](references/04-subscription.md) |
| Charging: the two-step OTP flow, balance query | [references/05-caas.md](references/05-caas.md) |
| What Applink does **not** publish; the extension pattern | [references/06-coverage-and-extensions.md](references/06-coverage-and-extensions.md) |
| Inbound webhooks | [references/07-callbacks.md](references/07-callbacks.md) |
| Status codes and error handling | [references/08-status-codes.md](references/08-status-codes.md) |
| Secrets, TLS, PII, consent | [references/09-security-best-practices.md](references/09-security-best-practices.md) |
| Go-live checklist | [references/10-production-checklist.md](references/10-production-checklist.md) |
| Building in a stack with no template | [references/11-any-stack.md](references/11-any-stack.md) |
| Taking a project from nothing to production, or adding Applink to an existing app | [references/12-implementation-playbook.md](references/12-implementation-playbook.md) |
| **Every endpoint as curl** — request, parameter definitions, response, response fields | [references/13-curl-reference.md](references/13-curl-reference.md) |

Working reference implementations in [templates/](templates/README.md) for TypeScript/Node,
Python, Java, Go, PHP and C#. Read the one matching the project's stack for shape rather than
inventing a different structure; for any other language, build the same seven components from
the curl reference — and never introduce a new runtime to reach Applink.

---

## Service map

Production host `https://api.applink.com.bd` for everything.

**Configure one environment variable per provisioned service**, not one base URL — an
application can only call the APIs it was provisioned for. An unset endpoint means that API is
not enabled, and the client should refuse to call it rather than fail with `E1309` at the
platform. See [templates/.env.example](templates/.env.example).

| Need | Endpoint |
|---|---|
| Send SMS (MT) | `POST /sms/send` |
| Broadcast to base | `POST /sms/send` with `destinationAddresses: ["tel:all"]` |
| Receive SMS (MO) | *your callback URL* |
| Delivery status report | *your callback URL* |
| USSD screen out | `POST /ussd/send` |
| USSD input in | *your callback URL* |
| Register (opt-in) | `POST /subscription/send` with `action: "1"` |
| **Unregister (opt-out)** | `POST /subscription/send` with `action: "0"` |
| **Subscriber base size** | `POST /subscription/query-base` |
| Subscription status + last charge (max 10 MSISDNs) | `POST /subscription/getSubscriberChargingInfo` |
| Subscriber notification | *your callback URL* |
| OTP request / verify (subscription activation) | `POST /otp/request`, `POST /otp/verify` |
| **Start a charge** (sends the subscriber an OTP) | `POST /caas/direct/debit` |
| **Complete the charge** (money moves here) | `POST /caas/otp/verify` |
| Query balance (confirm it is enabled first) | `POST /caas/get/balance` |
| Charging notification | *your callback URL* |
| Location / LBS, voice / IVR, a `getStatus` endpoint | **Not published — do not invent them.** See [06-coverage-and-extensions](references/06-coverage-and-extensions.md) |

Each of these as a runnable request, with every parameter and response field defined:
[references/13-curl-reference.md](references/13-curl-reference.md).

---

## The universal request/response shape

```
POST {baseUrl}/{path}
Content-Type: application/json;charset=utf-8

{ "applicationId": "APP_000375", "password": "…", …that endpoint's fields, all strings… }
```

```json
{ "statusCode": "S1000", "statusDetail": "Success." }
```

So: **one `post()` helper that injects credentials, plus thin wrappers per service.** Do not
write bespoke HTTP calls per endpoint, in any language.

**The request body:**

- Every value is a JSON string — `"action": "1"`, `"amount": "5.00"`, `"version": "1.0"`,
  `"encoding": "440"`. A number type turns a 31-digit `requestCorrelator` into
  `8.80144223314617e+30`. Only `destinationAddresses` / `subscriberIds` are arrays of strings,
  and only `applicationMetaData` is an object of strings.
- Send exactly that endpoint's parameters: `version` is on SMS Send and USSD Send only; names are
  case-sensitive (`Currency` on the charge, `currency` on the balance query).
- Omit optional fields you have no value for — never `null`, `""`, `{}` or `[]`.
- Build a map of strings and let the JSON library serialise it; never concatenate JSON.

**The response:**

- Decide from `statusCode` against that endpoint's expected outcome — `S1000`, except `P1003`
  on CaaS OTP Generation. Each endpoint in the curl reference says what to read, what to
  persist and what comes next.
- On any other code, rely on `statusCode` and `statusDetail` only; other fields may be absent.
- Every value arrives as a string (`baseSize`, `chargeableBalance`): parse at the boundary,
  read fields with defaults, ignore unknown fields, compare `subscriptionStatus` by prefix, and
  check each `destinationResponses` entry.

**Addressing** — always `tel:`-prefixed, no spaces:

```
tel:8801959979376        plain MSISDN — the form subscription, OTP and CaaS publish
tel:+8801959979376       the form the SMS samples publish; normalise to the one above
tel:<masked value>       masking enabled — opaque, never parse
tel:all                  broadcast (SMS only — guard this)
```

Normalise in one helper. Never concatenate `tel:` inline.

---

## Mistakes to avoid

- ❌ Checking the HTTP status as success (`res.ok`, `raise_for_status()`,
  `EnsureSuccessStatusCode()`, `http_errors`) — **Applink returns 200 for errors.** Branch on
  `statusCode`.
- ❌ Treating `P1003` as a completed charge — it means the OTP was **sent**, nothing more.
  Orders fulfilled on it are orders nobody paid for.
- ❌ Re-running `POST /caas/direct/debit` to retry a failed verification — that starts a
  **second charge**.
- ❌ Issuing a fresh `externalTrxId` after a timeout — same result.
- ❌ Passing `externalTrxId` as the `referenceNo` on `/caas/otp/verify` — it is the
  `requestCorrelator` from the generation response (`E1855` otherwise).
- ❌ Inventing an "already registered" success code — Applink publishes none. Read
  `subscriptionStatus` from the register/unregister response instead.
- ❌ Using a status code outside the twenty-nine published ones.
- ❌ `destinationAddresses: "tel:880…"` — it is always an **array**.
- ❌ A number anywhere in a request body — `"amount": 5`, `"action": 1`, `"version": 1.0`.
  Every value is a string.
- ❌ `"version"` on subscription, OTP or CaaS requests — it is an SMS / USSD parameter only.
- ❌ `"currency"` on CaaS OTP Generation (it is `Currency`), or `"Currency"` on Query Balance
  (it is `currency`).
- ❌ Sending `subscriberId` instead of `subscriberIds` to `getSubscriberChargingInfo`, or more
  than ten at a time.
- ❌ Logging the subscriber notification's raw body — **it contains your `password`**.
- ❌ Generating your own USSD `sessionId` — echo the platform's.
- ❌ Ending a USSD flow with `mt-cont` — terminal screens use `mt-fin`.
- ❌ An in-process USSD session store (`Map`, `dict`, `HashMap`, package-level `map`) in
  production — breaks across instances.
- ❌ Doing work before acknowledging a callback — sessions time out in seconds. Use the stack's
  real background mechanism, not a bare `await`.
- ❌ Disabled TLS verification in shipped code — `rejectUnauthorized: false`, `verify=False`,
  `InsecureSkipVerify`, `CURLOPT_SSL_VERIFYPEER => false`, a trust-all `TrustManager`. Supply
  the intermediate CA instead.
- ❌ `NEXT_PUBLIC_` / `VITE_` / `REACT_APP_` / `PUBLIC_` / `EXPO_PUBLIC_` on any Applink
  variable, or serving it through a client-facing config endpoint — that ships the password to
  the browser.
- ❌ Standing up a Node sidecar (or any second runtime) to call Applink from a non-JS project.
- ❌ Logging `password`, the OTP, `referenceNo`, `requestCorrelator`, or an unmasked
  `subscriberId`.
- ❌ Inventing LBS or IVR endpoints — Applink publishes neither.

---

## When you generate code, always

- Put credentials in `.env` (git-ignored) with a placeholder-only `.env.example`.
- Validate config at startup and fail loudly on missing variables — including refusing to boot
  with only one of the two charging URLs set.
- Set an explicit timeout on every call.
- Branch on `statusCode` and map codes to behaviour classes (pending / configuration / client /
  user-state / transient).
- Retry only transient codes and transport errors, with backoff — never anything on the
  charging path with a new identifier.
- Persist `externalTrxId` before the first charging call, and `requestCorrelator` from its
  response.
- Make callback handlers acknowledge first, validate the schema, verify `applicationId` where
  the payload carries it, deduplicate, and strip `password` before logging.
- Log `requestId` / `sessionId` / `externalTrxId` / `internalTrxId` / `statusCode`; mask
  subscriber addresses.
- Mirror subscription state locally from the subscriber notification instead of polling.
- Use a decimal type for money — `BigDecimal`, `decimal.Decimal`, `decimal`, `bcmath`, a
  decimal library, or integer minor units. Never a binary float. Currency is `BDT`.
- Match the host project's existing stack, structure and conventions.
