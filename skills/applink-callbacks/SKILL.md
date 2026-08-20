---
name: applink-callbacks
description: Implement Applink inbound webhooks — SMS receive (MO), SMS delivery status reports, USSD receive, subscriber notifications and charging notifications. Use when building or debugging Applink callback handlers, notification URLs, or webhook endpoints.
---

# Applink callbacks

Applink POSTs to URLs you register during provisioning. Skip these and MO SMS never arrives,
USSD does not work, you never learn that a subscriber left — and, worst of all, **charges never
settle**, because the charging notification is the only place `paidAmount` appears.

```bash
node tools/applink.mjs list --direction=inbound             # all five
node tools/applink.mjs show ussd-receive                    # payload + rules
node tools/applink.mjs curl sms-mo                          # fields, plus a command that
                                                            # replays it against your handler
```

All five are written out in `references/13-curl-reference.md`: what arrives, every field
defined, what you must respond, the dedupe key, and a curl that replays the exact payload
against your own route. Write the handlers from that, in the project's own framework.

## The contract — identical for all five

**In:** `POST`, JSON.
**Out:** HTTP 200 with `{"statusCode":"S1000","statusDetail":"Success"}`.

The response is an **acknowledgement, not a reply**. For USSD, the screen the user sees comes
from a separate `POST /ussd/send`.

## Six rules

1. **Acknowledge first, work second.** Queue the payload, return `S1000`, process out of band —
   through the stack's real background mechanism (a queue, `BackgroundTasks`, `@Async`, a worker
   goroutine, a hosted service), never a bare `await`. USSD sessions time out in seconds.
2. **Be idempotent.** Every callback can arrive twice. Dedupe on the documented key —
   `node tools/applink.mjs show <id>` gives it.
3. **Never trust the body.** Unauthenticated JSON from the internet. Validate the schema,
   verify `applicationId` where the payload carries it, restrict by Applink source IP,
   rate-limit. Note that the delivery report and the charging notification do **not** carry
   `applicationId`, so those lean on the IP allowlist and on matching an identifier you issued.
4. **Strip the password.** The subscriber notification carries your `password` in its body.
   Remove it before the payload reaches any log, trace, error report or queue.
5. **Always return 200**, even for payloads you reject — a 4xx/5xx just triggers redelivery.
6. **Log for tracing, not surveillance.** `requestId`/`sessionId`/`externalTrxId`/
   `internalTrxId` yes; message bodies, OTPs and unmasked `subscriberId` no.

## The charging notification is not optional

Applink charging is `/caas/direct/debit` (returns `P1003`, sends an OTP) → `/caas/otp/verify`
(moves the money) → **this callback** (says what was actually paid). Without it you have no
`paidAmount`, no `balanceDue`, and no way to resolve a charge that timed out. Match on
`externalTrxId`, dedupe on `externalTrxId` + `statusCode`, and treat a non-zero `balanceDue`
as a partial payment rather than a fulfilled order.

## Test without an Applink account

The payloads are fully specified, so post them yourself:

```bash
./scripts/test-callbacks.sh http://localhost:3000
```

It covers valid, malformed, wrong-app, missing-field, oversized, **partial-payment** and
**duplicate** payloads — the last two are the ones people skip. It is plain curl, so it tests a
handler written in any language.

Every payload, field by field, with its replay command: `references/13-curl-reference.md`.

Working handlers, in the language of the host project:
`templates/typescript/callbacks-nextjs.ts` (Next.js), `templates/python/callbacks_fastapi.py`,
`templates/java/ApplinkCallbackController.java` (Spring), `templates/go/callbacks.go`,
`templates/php/callbacks.php`, `templates/csharp/ApplinkCallbacks.cs` (ASP.NET Core). For any
other stack, the per-language acknowledge-first table is in `references/11-any-stack.md`.

Full contract: `references/07-callbacks.md`.
