---
name: applink-help
description: Quick reference for the Applink skill — available commands, services, and which reference document covers what. Use when the user asks what the Applink skill can do.
---

# Applink skill — quick reference

## Tooling

```bash
node tools/applink.mjs help        # every command
node tools/applink.mjs list        # every service and callback
node tools/applink.mjs platform    # base URL, operator, conventions
```

Offline, zero-dependency, read-only, and it never sees your credentials. Add `--json` to any
command for machine-readable output.

| Command | Answers |
|---|---|
| `list [category]` | What services exist? |
| `show <id>` | What exactly does this call take and return? |
| `search "<query>"` | Which service does the thing I want? |
| `curl <id> [k=v]` | Give me a runnable request, with the parameters and response defined. |
| `validate <id> '<json>'` | Is this payload correct? |
| `code <statusCode>` | What does this error mean and what do I do? |
| `diagnose "<symptom>"` | Why is this not working? |
| `practices [severity]` | What must I not get wrong? |
| `checklist` | Am I ready for production? |
| `reference <doc>` | Show me the full guide. |

## Skills

| Skill | Use it for |
|---|---|
| `applink` | General Applink work; the rules and the service map |
| `applink-scaffold` | Starting a new integration |
| `applink-callbacks` | Inbound webhooks |
| `applink-review` | Auditing existing code |
| `applink-debug` | A failing call or callback |
| `applink-golive` | The pre-production checklist |

## Services covered

**SMS** — send (MT), broadcast, receive (MO), delivery status reports
**USSD** — send screens, receive input, session handling
**Subscription** — register, unregister, base size, subscriber charging info, notifications
**OTP** — request, verify (subscription activation; five-minute validity)
**CaaS** — the two-step OTP charge (generation → verification), balance query, charging
notifications

**Not published by Applink** — location/LBS, voice/IVR, and a standalone `getStatus` endpoint.
Do not invent them; see `references/06-coverage-and-extensions.md`.

## References

`01-getting-started` · `02-sms` · `03-ussd` · `04-subscription` · `05-caas` ·
`06-coverage-and-extensions` · `07-callbacks` · `08-status-codes` ·
`09-security-best-practices` · `10-production-checklist` · `11-any-stack` ·
`12-implementation-playbook` · `13-curl-reference`

## Writing the call

**`references/13-curl-reference.md`** is where every call comes from: each endpoint at the wire
— a runnable curl, every parameter defined, the response, every response field explained, that
endpoint's status codes — and all five callbacks with a replay command. Translate the request
into the project's own HTTP client; that is the integration.

```bash
node tools/applink.mjs curl subscription-query-base            # the cheapest call to prove setup
node tools/applink.mjs curl sms-send message="Hi" \
  destinationAddresses='["tel:8801959979376"]'                 # filled in and validated
node tools/applink.mjs reference 13-curl-reference             # the whole page
```

There is no code generator: an emitter would cover a few languages and age with their idioms,
where a curl is the same call in all of them and stays true.

## Languages

The integration can be written in **any** language — Applink is JSON over HTTPS. The curl
reference covers every endpoint with no tooling at all; worked implementations ship for
TypeScript/Node, Python, Java, Go, PHP and C# (`templates/README.md`) to read for shape; and
`references/11-any-stack.md` specifies the same seven components language-neutrally for
anything else. The CLI above needs Node, but it is only a documentation reader.

## The three things to remember

1. **HTTP 200 does not mean success** — branch on `statusCode`. And **`P1003` does not mean
   success either**: it means an OTP was sent and nothing has been charged.
2. **Credentials live in environment variables**, and Applink is called from the backend only.
3. **Charging is two calls plus a callback**, idempotent on `externalTrxId`, or you
   double-charge a real person.

Support: `support@applink.com.bd` ·
<https://dev.applink.com.bd/API_Documentation/docs/hSenidMobile_tap_api.html>
