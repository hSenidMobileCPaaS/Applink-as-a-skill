<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/applink-logo.png">
    <img src="assets/applink-logo-light-bg.png" width="220" alt="Applink">
  </picture>
</p>

<h1 align="center">Applink Skill for Agents</h1>

<p align="center">
  <em>Telco integrations your AI agent gets right the first time.</em>
</p>

<p align="center">
  <sub>by <strong>hSenid Mobile Solutions</strong> for <strong>Applink</strong></sub>
</p>

<p align="center">
  <a href="https://github.com/hSenidMobileCPaaS/Applink-as-a-Skill/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/hSenidMobileCPaaS/Applink-as-a-Skill/ci.yml?branch=main&style=flat-square&label=CI&color=F16724" alt="CI status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/licence-proprietary-F16724?style=flat-square" alt="Proprietary licence"></a>
  <img src="https://img.shields.io/badge/endpoints-11-F16724?style=flat-square" alt="11 endpoints">
  <img src="https://img.shields.io/badge/callbacks-5-F16724?style=flat-square" alt="5 callbacks">
  <img src="https://img.shields.io/badge/status%20codes-30-F16724?style=flat-square" alt="30 status codes">
  <img src="https://img.shields.io/badge/works%20with-20%2B%20agents-F16724?style=flat-square" alt="Works with 20+ agents">
  <img src="https://img.shields.io/badge/dependencies-0-F16724?style=flat-square" alt="Zero dependencies">
</p>

<p align="center">
  <strong>SMS · USSD · Subscription · OTP · CaaS charging</strong><br>
  <sub>hSenid Mobile's Bangladesh telco platform, on the Banglalink network. Charging in BDT.</sub>
</p>

---

Ask an AI agent to integrate Applink today and it will confidently write
`if (response.ok) return "sent"`. Applink returns **HTTP 200 for failures**, so that line
reports every error as a success.

Then it will find an endpoint called `/caas/direct/debit`, call it once, get `P1003` back, and
mark the order paid. **Nothing has been charged.** That call only sends the subscriber an OTP;
the money moves at a second call the agent never knew existed. And when the verification fails,
it will "retry" by calling `/caas/direct/debit` again — which starts a *second* charge against
a real person.

None of that is the model being careless. It is the model not having the contract.

This repo gives it the contract: every endpoint, every parameter, every response field, every
published status code, all five callbacks, and the handful of rules that separate a working
integration from a suspended one.

**In whatever language you already use.** Applink is JSON over HTTPS, so nothing here is tied
to one runtime:

- [**Every endpoint as a runnable curl**](references/13-curl-reference.md) — the request, every
  parameter defined, the response, every response field explained, and the same for all five
  callbacks. Translate it into the HTTP client you already use and you have the call. No SDK, no
  generated code, no language second-class.
- [**references/11-any-stack.md**](references/11-any-stack.md) specifies the integration around
  the calls language-neutrally — seven components, per-language notes, and an acceptance
  checklist — for Ruby, Rust, Kotlin, Elixir or anything else.
- [**templates/**](templates/README.md) shows the whole thing already built in TypeScript/Node,
  Python, Java, Go, PHP and C# — worked examples to read for shape, not output to paste.

There is deliberately **no code generator**. An emitter serves the languages someone wrote
emitters for and ages with each of their idioms; a curl is the same call everywhere and stays
true as long as the contract does.

---

## Install

Pick your agent. Everything below is the same content behind a different filename.

<details open>
<summary><strong>Claude Code</strong></summary>

```
/plugin marketplace add hSenidMobileCPaaS/Applink-as-a-Skill
```
```
/plugin install applink@applink
```

Or clone it as a skill directly:

```bash
git clone https://github.com/hSenidMobileCPaaS/Applink-as-a-Skill ~/.claude/skills/applink
```
</details>

<details>
<summary><strong>Cursor</strong></summary>

```bash
git clone https://github.com/hSenidMobileCPaaS/Applink-as-a-Skill .applink
cp .applink/.cursor/rules/applink.mdc .cursor/rules/
```
</details>

<details>
<summary><strong>Codex</strong></summary>

```bash
codex plugin marketplace add hSenidMobileCPaaS/Applink-as-a-Skill
codex plugin add applink@applink
```
</details>

<details>
<summary><strong>GitHub Copilot</strong></summary>

CLI:

```bash
copilot plugin marketplace add hSenidMobileCPaaS/Applink-as-a-Skill
```

Editor extension — copy the instructions file:

```bash
cp .applink/.github/copilot-instructions.md .github/
```
</details>

<details>
<summary><strong>Gemini CLI / Antigravity</strong></summary>

```bash
gemini extensions install https://github.com/hSenidMobileCPaaS/Applink-as-a-Skill
```
</details>

<details>
<summary><strong>Windsurf · Cline · Kiro · Qoder</strong></summary>

```bash
git clone https://github.com/hSenidMobileCPaaS/Applink-as-a-Skill .applink
cp .applink/.windsurf/rules/applink.md  .windsurf/rules/     # Windsurf
cp .applink/.clinerules/applink.md      .clinerules/         # Cline
cp .applink/.kiro/steering/applink.md   .kiro/steering/      # Kiro
cp .applink/.qoder/rules/applink.md     .qoder/rules/        # Qoder
```
</details>

<details>
<summary><strong>Aider · Zed · Amp · Jules · Junie · OpenCode · anything reading AGENTS.md</strong></summary>

```bash
git clone https://github.com/hSenidMobileCPaaS/Applink-as-a-Skill .applink
```

Then reference `.applink/AGENTS.md` from your own `AGENTS.md`, or copy it to the project root.
</details>

<details>
<summary><strong>No install — any assistant</strong></summary>

Paste the raw URL and ask it to read the file:

```
https://raw.githubusercontent.com/hSenidMobileCPaaS/Applink-as-a-Skill/main/AGENTS.md
```
</details>

Full matrix of what each agent reads: **[docs/agent-support.md](docs/agent-support.md)**.

---

## The part that makes it precise

Documentation alone still leaves an agent recalling parameter names from memory. So the whole
Applink contract also ships as **structured data** — [`catalog/applink-api.json`](catalog/applink-api.json) —
with a zero-dependency CLI over it that any agent can drive through its shell.

This is the capability an MCP server would give you, without running a server: no install, no
dependencies, no process to keep alive, and it works in every agent that can run a command.

```bash
$ node tools/applink.mjs show subscription-query-base

Base Size  (subscription-query-base)
Return the number of subscribers currently registered to the application.

  Endpoint  POST https://api.applink.com.bd/subscription/query-base

  Request parameters
    applicationId   string   required
      Identifies the application. Unique identifier generated when the application is
      provisioned. Only a single value per request.
    password        string   required
      The API key sent to your registered email address when the application was approved.

  Response fields
    baseSize        Number of registered users. Arrives as a string — coerce it before
                    arithmetic or charting.
    ...
```

| Command | Answers |
|---|---|
| `list [category]` | What services exist? |
| `show <id>` | What exactly does this call take and return? |
| `search "<query>"` | Which service does the thing I want? |
| `curl <id> [k=v]` | **Give me the call** — a runnable request, with the parameters and the response defined. |
| `validate <id> '<json>'` | Is this payload correct — types, field names and all? |
| `response <id> ['<json>']` | What comes back, what do I persist, what happens next — and what did this real response mean? |
| `code <statusCode>` | What does this error mean, and what do I do? |
| `diagnose "<symptom>"` | Why is this not working? |
| `practices [severity]` | What must I not get wrong? |
| `checklist` | Am I ready for production? |
| `reference <doc>` | Show me the full guide. |
| `platform` | Base URL, operator, conventions. |

Add `--json` to any command for machine-readable output. Agents that cannot run commands — or
machines without Node — read the catalog JSON directly; same data, and `jq` or a one-line
Python snippet gets at it. The CLI is a documentation reader: it makes no network calls, never
sees a credential, and puts no constraint on the language your integration is written in.

It catches the real mistakes, not just missing fields:

```bash
$ node tools/applink.mjs validate sms-send '{"message":"hi","destinationAddresses":"tel:8801959979376"}'

  ✗ 4 error(s)  against sms-send
    ✗ Missing required field "version" — API version, numbered 1.0, 2.0 and so on. …
    ✗ Missing required field "applicationId" — Identifies the application. …
    ✗ Missing required field "password" — The API key sent to your registered email address …
    ✗ "destinationAddresses" must be an ARRAY, got string. This is the most common Applink
      integration bug.
```

### Every endpoint as curl — the path for any language

No SDK, no code generation, no Node: [references/13-curl-reference.md](references/13-curl-reference.md)
writes out all 11 endpoints and all 5 callbacks at the wire — the request, every parameter
defined, the response, every response field explained, and the status codes that endpoint can
return.

```bash
curl -sS -X POST "$APPLINK_CAAS_DEBIT_URL" \
  -H 'Content-Type: application/json;charset=utf-8' \
  --max-time 15 \
  -d @- <<REQUEST
{
  "applicationId": "$APPLINK_APP_ID",
  "password": "$APPLINK_PASSWORD",
  "externalTrxId": "256091232",
  "amount": "5.00",
  "paymentInstrumentName": "Mobile Account",
  "subscriberId": "tel:8801973579363",
  "Currency": "BDT"
}
REQUEST
```

| `externalTrxId` | **Required** | Your transaction ID. Persist it BEFORE calling — it is the idempotency key. |
|---|---|---|
| `subscriberId` | **Required** | MSISDN of the subscriber to charge. |
| `amount` | **Required** | Amount to reserve, sent as a string. Hold it as a decimal type in your own code. |
| `Currency` | **Required** | Capital C, as published. Only `BDT`. |

That call returns `P1003` and a `requestCorrelator`, and **charges nobody**. The money moves at
`POST /caas/otp/verify` with that correlator, and the outcome arrives on the charging
notification. The curl reference spells out all three steps.

Credentials come from the environment, so nothing on the page is a secret and nothing you copy
can commit one. The document is generated from the catalog and CI fails if it drifts, so a
Ruby, Rust, Kotlin or Elixir integration works from exactly the same contract as a TypeScript
one — and running a call by hand is the fastest way to tell a bad payload from bad code.

### Why there is no code generator

A generator encodes *idiom*, not contract: the Applink contract barely moves, but framework
versions, HTTP-client conventions and language idioms move constantly, so the emitter carries
most of the maintenance while the contract carries most of the value. It also draws an
arbitrary line — the seventh language is a second-class citizen forever.

The curl reference has neither problem. It is generated from the catalog, verified in CI, and
equally correct for Kotlin, Elixir and Rust as for TypeScript. Modern coding agents write better
client code from a precise contract and a set of rules than any template can, because they write
in the host project's actual conventions.

What is kept current instead: the catalog, the curl reference, the status-code semantics, the
practices, and the diagnostics.

And it turns a symptom into a fix:

```bash
$ node tools/applink.mjs diagnose "we charged the customer twice"

  Likely cause
  CaaS OTP Generation was re-run to retry a charge, or a fresh externalTrxId was issued
  after a timeout. Each one starts a second transaction.

  Fix
  Persist externalTrxId before the first call and reuse it. To retry a failed verification,
  re-prompt for the OTP against the SAME requestCorrelator — never re-run generation. E1337
  means the platform already has that transaction; settle it from the charging notification.
```

---

## Configuration is two credentials and your enabled endpoints

An Applink application can only call the APIs it was provisioned for, so the configuration
mirrors that exactly — nothing else is environment-dependent:

```bash
APPLINK_APP_ID=APP_XXXXXX
APPLINK_PASSWORD=replace-me

# Uncomment only what is enabled on your application:
#APPLINK_SMS_SEND_URL=https://api.applink.com.bd/sms/send
#APPLINK_SUBSCRIPTION_SEND_URL=https://api.applink.com.bd/subscription/send
#APPLINK_CAAS_DEBIT_URL=https://api.applink.com.bd/caas/direct/debit
#APPLINK_CAAS_OTP_VERIFY_URL=https://api.applink.com.bd/caas/otp/verify
```

An unset endpoint is meaningful: the client refuses the call locally, so you get a clear error
naming the missing variable instead of `E1309` from the platform after a round trip. Pointing
one at a mock is the whole local-development switch.

The two CaaS URLs are a pair — the templates refuse to boot with only one of them set, because
a charge you can start but never complete leaves subscribers holding an OTP and your ledger
holding pending rows.

Timeouts, encodings and retry policy are **not** configuration — they are constants in the
client, because they are properties of the protocol rather than of your deployment.

These variable names are identical across every language template, so a polyglot estate has one
deployment story.

## Architecture it steers agents toward

<p align="center">
  <img src="assets/architecture.svg" width="860" alt="A browser or mobile client calls your backend; your backend holds the credentials and calls Applink over HTTPS from a static allow-listed IP; Applink reaches subscribers on Banglalink and posts five callbacks back to your backend, including the charging notification that settles every charge. Credentials never cross the trust boundary to the client.">
</p>

---

## Coverage

| Service | Operations |
|---|---|
| **SMS** | Send (MT), broadcast to base, receive (MO), delivery status reports |
| **USSD** | Send screens, receive input, the `mo-init`/`mo-cont`/`mt-init`/`mt-cont`/`mt-fin` state machine |
| **Subscription** | Register (opt-in), **unregister (opt-out)**, **base size**, subscriber charging info (status + last charge, ≤10 MSISDNs), notifications |
| **OTP** | Request, verify — five-minute validity, subscription activation |
| **CaaS** | The two-step OTP charge (generation → verification), query balance, charging notifications, reconciliation |
| **Not published** | Location/LBS, voice/IVR and a standalone `getStatus` endpoint do not exist on Applink. Documented as such, so an agent does not invent them |

### Languages

| Stack | What ships |
|---|---|
| TypeScript / Node | config, client, types, Next.js callback routes, USSD session store |
| Python | config, client, FastAPI callbacks, USSD session store (standard library only) |
| Java | config, client, Spring callback controller |
| Go | config, client, `net/http` callbacks (standard library only) |
| PHP | config, client, framework-neutral callbacks with Laravel notes |
| C# / .NET | options, typed client, ASP.NET Core callbacks + background worker |
| Anything else | [references/13-curl-reference.md](references/13-curl-reference.md) — every endpoint as curl, with definitions — plus [references/11-any-stack.md](references/11-any-stack.md) for the seven components, per-language notes and an acceptance checklist |

Plus the complete published status-code table, all five callback contracts, and the operational
practices that keep an application approved.

### Skills

| Skill | Use it for |
|---|---|
| `applink` | General Applink work; the rules and the service map |
| `applink-scaffold` | Starting a new integration |
| `applink-callbacks` | Inbound webhooks |
| `applink-review` | Auditing existing code |
| `applink-debug` | A failing call or callback |
| `applink-golive` | The pre-production checklist |
| `applink-help` | Quick reference |

On plugin-tier hosts these are also slash commands: `/applink`, `/applink-review`, and so on.

---

## What it actually changes

Ten mistakes agents make on this platform, and what each one costs:

| Mistake | Consequence |
|---|---|
| Deciding on the HTTP status (`res.ok`, `raise_for_status()`, `EnsureSuccessStatusCode()`) | Applink returns **HTTP 200 for errors**. Every failure reported as a success. |
| Treating `P1003` as a completed charge | `/caas/direct/debit` only sends an OTP. **Orders fulfilled that nobody paid for.** |
| Re-running OTP generation to retry a failed verification | **A second charge against a real person.** |
| Passing `externalTrxId` as `referenceNo` to `/caas/otp/verify` | Every charge confirmation fails with `E1855`. |
| Inventing an "already registered" success code | Applink publishes none. Working flows reported as broken. |
| `destinationAddresses: "tel:880…"` | It is always an **array**. Sends fail. |
| Hardcoded `applicationId` / `password` | A credential that can charge your subscribers, committed to git. |
| Logging the subscriber notification body | **It contains your password.** Your API key, in your log aggregator, on every subscription change. |
| USSD sessions in an in-process map, whatever the language | Works in dev, breaks the moment you scale. |
| TLS verification switched off (`rejectUnauthorized: false`, `verify=False`, `InsecureSkipVerify`, …) | Your credentials become interceptable. |

---

## Quick start

```bash
# 1. Configure
cp templates/.env.example .env
$EDITOR .env                       # credentials, then uncomment ONLY the endpoints
                                   # for the APIs enabled on your application

# 2. Confirm your egress IP is allow-listed — run this ON THE SERVER
curl -4 https://api.ipify.org      # add the result to the application's allowed host addresses

# 3. Verify connectivity and credentials
./scripts/smoke-test.sh            # Windows: .\scripts\smoke-test.ps1

# 4. Test your callback handlers — no Applink account needed
./scripts/test-callbacks.sh http://localhost:3000
```

Then ask your agent:

> Add Applink subscription and SMS to this app — users opt in by SMS keyword, get a welcome
> message, and can text STOP to unsubscribe.

Starting from nothing, mid-build, or bolting Applink onto an app that already has users? The
A-to-Z route for each is [references/12-implementation-playbook.md](references/12-implementation-playbook.md).

---

## What's inside

```
SKILL.md · AGENTS.md              Entry points (Claude Code / everyone else)
catalog/applink-api.json          The whole contract as structured data
tools/applink.mjs                 Offline CLI over the catalog
references/                       13 guides: per-service, callbacks, codes, security, go-live,
                                  what the platform does NOT offer, the language-neutral spec,
                                  the A-to-Z playbook, and every endpoint as curl
templates/                        .env.example + working config, client and callback handlers
                                  in TypeScript/Node, Python, Java, Go, PHP and C#
skills/ · commands/               7 task skills and their slash commands
scripts/                          Smoke tests (bash + PowerShell), callback tests, rule sync,
                                  curl-reference build
docs/agent-support.md             Which agent reads which file
```

---

## Development

```bash
npm test                                     # catalog + tooling tests
npm run check                                # tests + everything generated is in sync
node scripts/sync-rules.mjs                  # regenerate the agent rule copies
node scripts/build-curl-reference.mjs        # regenerate the curl reference
```

Two things are generated and CI fails if they drift: the seven agent rule files, from
`AGENTS.md`, and `references/13-curl-reference.md`, from `catalog/applink-api.json`. The test
suite verifies that every referenced status code exists, every parameter is fully specified,
every documented sample validates against its own schema, every endpoint and parameter appears
in the curl reference, and no credential-shaped string is committed.

See [CONTRIBUTING.md](CONTRIBUTING.md). Corrections to the API contract are the most valuable
contribution — cite the docs page or paste the observed response.

---

## Sources

Everything derives from the official Applink developer documentation —
[the TAP API reference](https://dev.applink.com.bd/API_Documentation/docs/hSenidMobile_tap_api.html)
and its published OpenAPI specification, plus the API overview and provisioning walkthroughs on
[dev.applink.com.bd](https://dev.applink.com.bd) — reconciled field by field.

**No endpoint, parameter or status code in this repo was invented.** Eleven outbound endpoints,
five callbacks, twenty-nine error codes plus `S1000`: that is the published surface, and
[references/06-coverage-and-extensions.md](references/06-coverage-and-extensions.md) records
what Applink does *not* offer so an agent cannot fill the gap with a plausible guess.

Where the published documentation is internally inconsistent — and in several places it is, from
the `+` in SMS addresses to the capital `C` in `Currency` — the skill states the inconsistency
and recommends one form rather than silently picking a side. All of them are listed in that same
file.

Applink evolves. Confirm with support what your application is actually provisioned for before
go-live, and open an issue if the platform's behaviour moves.

## Support

- **Email** — `support@applink.com.bd`
- **Developer portal** — <https://dev.applink.com.bd>

Quote your `requestId` / `externalTrxId` / `internalTrxId` / `sessionId` and the `statusCode` —
that is what support traces with.

## Security

No secrets in this repo; every credential is a placeholder and CI enforces it. The CLI makes
no network calls and never reads your credentials. See [SECURITY.md](SECURITY.md), and read
`scripts/smoke-test.*` before running it — `--with-charge` starts a real charge.

## Licence

**Proprietary.** Copyright © 2026 hSenid Mobile Solutions (Pvt) Ltd. All rights reserved.

This skill is the sole property of hSenid Mobile Solutions and is licensed for **use only**.
See [LICENSE](LICENSE) for the full terms.

| | |
|---|---|
| ✅ You may | Install it into your AI coding assistant and use it, unmodified, to build and operate your own Applink integrations. The integration code you produce is yours. |
| ❌ You may not | Copy it beyond what installation requires, modify it, publish or redistribute it, mirror or fork it, sublicense it, sell it, or bundle it into anything you sell. |

**Applink**, **hSenid Mobile** and their logos are trademarks of hSenid Mobile Solutions (Pvt)
Ltd. You may refer to Applink by name when describing an integration you have built; you may
not use the marks in your own product, service or marketing.

For any permission beyond this — including modifying, redistributing or embedding the
skill — contact `support@applink.com.bd`.

---

<p align="center">
  <a href="https://www.hsenidmobile.com">
    <img src="assets/hsenid-logo.png" width="240" alt="hSenid Mobile — co-creating the future">
  </a>
</p>

<p align="center">
  <sub>Built by <a href="https://www.hsenidmobile.com">hSenid Mobile Solutions</a> for
  <a href="https://dev.applink.com.bd">Applink</a>.</sub><br>
  <sub>The platform evolves — verify anything security- or billing-critical against
  <a href="https://dev.applink.com.bd/API_Documentation/docs/hSenidMobile_tap_api.html">the official API documentation</a>
  before going live.</sub>
</p>
