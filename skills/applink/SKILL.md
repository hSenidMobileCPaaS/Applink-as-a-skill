---
name: applink
description: Build and integrate Applink (hSenid Mobile's Bangladesh telco platform, on the Banglalink network) services — SMS, USSD, Subscription (register, unregister, base size, subscriber charging info), OTP, and CaaS charging (a two-step OTP flow settled by a charging-notification callback). Use whenever the user mentions Applink, api.applink.com.bd, MSISDN/`tel:` addressing, shortcode/keyword, USSD menus, subscriber base size, direct carrier billing, mobile-account charging, or telco SMS in Bangladesh.
---

# Applink

Applink is hSenid Mobile's telco platform for Bangladesh, on the Banglalink network. It exposes
SMS, USSD, subscription lifecycle, OTP verification and mobile-account charging as
JSON-over-HTTPS APIs. Charging is in **BDT** only.

## Do this first — do not recall parameter names, query them

```bash
node tools/applink.mjs list                          # what exists
node tools/applink.mjs show <id>                     # exact contract
node tools/applink.mjs curl <id> [key=value ...]     # runnable request + param/response defs
node tools/applink.mjs validate <id> '<json>'       # the body your code builds
node tools/applink.mjs response <id> ['<json>']     # what comes back, and what to do with it
node tools/applink.mjs code <statusCode>
```

**Every request value is a JSON string** (`"amount": "5.00"`, `"action": "1"`), send only that
endpoint's parameters (`version` is SMS/USSD only), and omit optional fields rather than sending
`null`. **Decide the outcome from `statusCode`** against that endpoint's expected code — `S1000`,
or `P1003` for CaaS OTP Generation — and read every other response field with a default.

**`references/13-curl-reference.md` is where every call comes from** — every endpoint as a
runnable curl, every parameter defined, the response and every response field, the status codes
that endpoint returns, and all five callbacks with a command that replays each against your
handler. Translate the request into the host project's HTTP client and idiom; that is the call,
in any language. It is also the first thing to run by hand when a call fails.

There is no code generator in this skill by design: an emitter would cover a handful of
languages and age with their idioms, while the contract and the curl above stay true for all of
them. Write the code in the project's own conventions.

Full command list: `node tools/applink.mjs help`. Add `--json` for machine-readable output.
If you cannot run commands, or Node is not installed, read `catalog/applink-api.json` — same
data, plain JSON. The CLI is a documentation reader; the integration itself can be in **any
language**.

## Six rules that are never negotiable

1. **Credentials come from environment variables.** Never hardcoded, never in a client
   bundle, never logged, never committed. Never a browser-exposed prefix
   (`NEXT_PUBLIC_`/`VITE_`/`REACT_APP_`/`PUBLIC_`/`EXPO_PUBLIC_`).
2. **Applink is called from the backend only.** IP allow-listing is enforced; a client cannot
   satisfy it, and the credentials are a shared secret.
3. **Explicit, recorded consent before any Register or charge**, with the amount, currency
   and frequency disclosed first.
4. **`subscriberId` is opaque** — with masking it is not a phone number.
5. **A charge is two calls.** `/caas/direct/debit` sends an OTP and returns `P1003`;
   `/caas/otp/verify` moves the money; the charging notification settles it.
6. **Charging is idempotent** on `externalTrxId`, persisted before the call, never re-rolled —
   and OTP generation is never re-run to retry a verification.

## The four things agents get wrong

1. **HTTP 200 is not success.** Applink returns 200 for application-level failures. Branch on
   `statusCode`.
2. **`P1003` is not success either.** It means the OTP was dispatched. Nothing has been
   charged, and an order fulfilled on it is an order nobody paid for.
3. **Applink is not a login API.** Register, `/otp/request` and CaaS are transactions: they
   charge money, send paid SMS and count against the rate limits every time. Bind the
   subscriber once, then issue the application's **own** session and decide entitlement from a
   local subscription mirror fed by the subscriber notification. Nothing on a login or
   page-load path calls Applink. `references/04-subscription.md` has the flow.
4. **There are no benign duplicate-state codes.** Applink publishes nothing meaning "already
   registered" or "transaction already completed". Read `subscriptionStatus` from the
   register/unregister response, and settle charges from the charging notification. Do not
   invent codes outside the twenty-nine published ones.

## Build it in the project's own stack

Applink is JSON over HTTPS: no runtime is privileged, and a Node sidecar for a Python, Java,
Go, PHP or .NET project is the wrong answer. Every call is one HTTPS POST with a JSON body —
`references/13-curl-reference.md` has all of them, so Ruby, Rust, Kotlin, Elixir or anything
else is a first-class target. Working implementations for six languages ship in `templates/`
(see `templates/README.md`); `references/11-any-stack.md` specifies the same seven components
language-neutrally, with an acceptance checklist for stacks with no template.

## Where the detail lives

`references/01-getting-started.md` through `13-curl-reference.md`, and the per-language
implementations in `templates/`. Read the reference for the service you are building before
writing code. What Applink does **not** publish — there is no LBS, no IVR and no `getStatus`
endpoint — is `references/06-coverage-and-extensions.md`; do not invent any of them.

Taking a project from nothing to production — or adding Applink to an app that already has
users — is `references/12-implementation-playbook.md`.

Related skills: `applink-scaffold`, `applink-callbacks`, `applink-review`,
`applink-debug`, `applink-golive`.
