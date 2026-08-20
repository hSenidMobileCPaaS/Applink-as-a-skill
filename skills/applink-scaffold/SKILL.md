---
name: applink-scaffold
description: Scaffold a new Applink integration from scratch — environment config, credential handling, the API client, and typed request/response models. Use when adding Applink to a project for the first time, or when the user asks to set up, bootstrap, or start an Applink integration.
---

# Scaffold an Applink integration

Build in this order. The order matters: config first means no credential ever has a chance
to land in a source file.

## 1. Establish what exists

Ask, or find in the code:

- Provisioned application? (`APP_00XXXX` + the API key emailed on approval) — if not, they are
  pre-provisioning; read `references/01-getting-started.md` and walk them through it. You can
  still build against a local mock.
- Which APIs were provisioned? Calling an unprovisioned service fails `E1309` no matter how
  correct the payload.
- A public HTTPS URL for callbacks? Required for MO SMS, delivery reports, USSD and both
  notifications — and for charging it is not optional, because the charging notification is
  the only place a charge is settled.
- A **static egress IP**? Required. Applink publishes no IP-echo endpoint, so run
  `curl -4 https://api.ipify.org` on the server that will make the calls.

## 2. Pick the stack — the host project's, not the template's

Applink is JSON over HTTPS, so build in whatever the project already uses. `templates/` ships
config + client + callbacks for **TypeScript/Node, Python, Java, Go, PHP and C#**
(`templates/README.md` indexes them); for anything else, take the calls from
`references/13-curl-reference.md` and follow the seven components and the acceptance checklist
in `references/11-any-stack.md`. Never add a second runtime for this.

## 3. Config before code

Copy `templates/.env.example` — the variable names are identical in every language — and the
config file from your language's directory. Requirements:

- One module reads the environment; nothing else does.
- Validate at startup and **fail loudly** on anything missing.
- Fail at startup if only one of `APPLINK_CAAS_DEBIT_URL` / `APPLINK_CAAS_OTP_VERIFY_URL` is
  set: a charge you can start but not complete leaves subscribers holding an OTP and your
  ledger holding pending rows.
- `.env` git-ignored; `.env.example` placeholders only.

## 4. One client, one `post()` helper

Every Applink call is the same HTTPS POST, so the client is one `post()` that injects
credentials, sets a timeout and raises a typed error on anything that is not `S1000` (or an
explicitly accepted code), plus a thin wrapper per service.

Write it from `references/13-curl-reference.md`. Each endpoint is there as a runnable curl with
every parameter defined and every response field explained: translate the request into the
project's own HTTP client, one wrapper per service, and put the seven components from
`references/11-any-stack.md` around them. Run the curl first — a payload proven by hand is one
you cannot get wrong in code.

Three things the wrappers must get right, and that a naive port gets wrong:

- **Charging is two wrappers.** `startCharge()` → `/caas/direct/debit`, returning `P1003` and a
  `requestCorrelator` the caller persists. `confirmCharge()` → `/caas/otp/verify`, with that
  correlator as `referenceNo`. Neither retries internally, and neither calls the other.
- **`P1003` is accepted, not thrown, and not success.** The ledger row stays open until the
  charging notification settles it.
- **Register and unregister read `subscriptionStatus`.** Applink publishes no benign
  duplicate-state code, so the response body — not an error code — is what tells you the
  desired state holds.

The error module is `references/08-status-codes.md`: all twenty-nine published codes with their
handling class, and the five classes including `pending`. Build the sets from the Class column,
or straight from `catalog/applink-api.json`. Do not add codes that are not on that list.

If the project is in TypeScript/Node, Python, Java, Go, PHP or C#, read the matching
`templates/` implementation for shape and port its structure — but write in this project's
conventions, with its HTTP client, logger and config loader.

Never recall parameter names; `show <id>` and the curl reference have the exact contract.

## 5. Callbacks

Half the integration is inbound, and for charging it is where the outcome lives. Use the
`applink-callbacks` skill.

## 6. Verify

```bash
node tools/applink.mjs validate <id> '<payload you generated>'
./scripts/smoke-test.sh          # or .\scripts\smoke-test.ps1
```

Both scripts are plain curl, so they verify a handler in any language. For a port into a stack
with no template, finish with the acceptance checklist in `references/11-any-stack.md`.

No provisioned application yet? Everything above still works except the live calls. If — and
only if — the developer asks for one, build a local mock server that answers every endpoint
from the catalog's sample responses and can return `E1303` / `E1313` / `E1326` / `P1003` / a
timeout on demand; point the `APPLINK_*_URL` variables at it. Do not create one unprompted.

Match the host project's stack and conventions. The templates are a specification, not a
framework to impose.
