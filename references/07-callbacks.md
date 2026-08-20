# Callbacks (Inbound Webhooks)

Half of Applink is inbound. The platform `POST`s JSON to URLs you register during
provisioning. If you only build outbound calls, MO SMS never arrives, USSD never works, and
you never learn that a subscriber left or a charge completed.

## The callbacks

| Callback | Fires when | Configured under | Spec |
|---|---|---|---|
| **SMS Receive (MO)** | A user texts your shortcode+keyword | SMS API settings | [02-sms.md](02-sms.md) |
| **SMS Delivery Status Report** | An MT SMS sent with `deliveryStatusRequest: "1"` reaches a final state | SMS API settings | [02-sms.md](02-sms.md) |
| **USSD Receive** | A user dials your code or presses a key | USSD API settings | [03-ussd.md](03-ussd.md) |
| **Subscriber Notification** | A subscription is created or removed, by anyone | Subscription API settings | [04-subscription.md](04-subscription.md) |
| **Charging Notification** | A charging transaction completes | CaaS *charging notification URL* | [05-caas.md](05-caas.md) |

All five have a fully published payload, field by field, in
[13-curl-reference.md](13-curl-reference.md) — including a command that replays each one against
your own route.

## The contract — same for all of them

**In:** `POST`, `Content-Type: application/json;charset=utf-8`, a flat JSON object.

**Out:** HTTP 200 with

```json
{ "statusCode": "S1000", "statusDetail": "Success" }
```

That is the whole contract. There is no other response shape, and — importantly — **the
response body is an acknowledgement, not a reply**. For USSD in particular, the screen the
user sees comes from a separate `POST /ussd/send`, not from what you return here.

---

## Rules

### 1. Acknowledge first, work second

Respond `S1000` immediately, then process asynchronously. Never do a database write chain, a
third-party call, or an Applink call *before* responding.

USSD sessions time out in seconds. Delivery reports arrive in bursts. A slow handler causes
retries, duplicates, and dropped sessions.

```
handler(request):
    body = parse_json(request)          # malformed → still acknowledge
    enqueue(body)                       # hand off; do NOT wait for the work
    return 200, { "statusCode": "S1000", "statusDetail": "Success" }
```

"Enqueue" means the stack's real background mechanism — a queue or broker, `BackgroundTasks`
in FastAPI, `@Async` in Spring, a worker goroutine, a hosted service in .NET, a queued job in
Laravel. Not a bare `await`, and not "it's fast enough". The per-stack table is in
[11-any-stack.md](11-any-stack.md#6-callback-endpoints).

### 2. Be idempotent

Every callback can arrive more than once. Deduplicate on the natural key:

| Callback | Dedupe key |
|---|---|
| SMS Receive (MO) | `requestId` |
| Delivery report | `requestId` + `deliveryStatus` |
| USSD Receive | `requestId` |
| Subscriber notification | `subscriberId` + `status` + `timeStamp` |
| Charging notification | `externalTrxId` + `statusCode` |

A duplicate charging notification that double-counts revenue is a real bug with real
consequences. Design for redelivery from the start.

### 3. Never trust the body

The payload is unauthenticated JSON from the public internet. Anyone who learns your URL can
post to it.

- **Validate the schema** — types, required fields, enum values. Reject anything else with
  `S1000` (acknowledge, discard) rather than crashing.
- **Verify `applicationId` matches yours** where the payload carries it — MO SMS, USSD receive
  and the subscriber notification all do. The delivery report and the charging notification do
  **not** carry it in their published payloads, so lean on source-IP restriction and on
  matching `requestId` / `externalTrxId` against something you actually sent.
- **Restrict by source IP** at the firewall, load balancer or middleware, to the Applink
  platform's egress ranges — ask `support@applink.com.bd` for the current list. This is the
  strongest control available, because Applink signs nothing and there is no signature to
  verify.
- **Never treat a callback as authorisation.** A subscriber notification claiming a user
  registered must not, by itself, unlock a paid feature — reconcile against your own state.
- **Never echo request content back** into an SMS or USSD screen without sanitising. That is
  how you become a spam relay.
- **Rate-limit the endpoint.** An unprotected callback URL is a free amplification target.

### 4. The subscriber notification contains your password

Applink posts `applicationId` **and `password`** in the subscriber notification body. Two
consequences:

- **Redact `password` before the payload reaches any log, trace, error report or analytics
  sink.** A handler that logs the raw body writes your API key into your log aggregator on
  every subscription change. Redact by key name in the logger, not at each call site.
- If you use it to authenticate the caller, **compare it in constant time**, and treat it as
  one signal among several rather than proof — the same value is on the wire in every
  outbound request you make.

### 5. Always return 200

Return `S1000` even for payloads you reject. A 4xx/5xx makes the platform retry, and you get
the same bad payload again. Log it, alert on the pattern, and acknowledge.

The exception: if your handler is genuinely broken (database down) and you *want* redelivery,
a 5xx is correct — but only if you have verified the platform actually retries for that
callback type. Do not assume it does.

### 6. Log for traceability, not for surveillance

Log `requestId`, `sessionId`, `externalTrxId`, `internalTrxId`, `statusCode`, and a timestamp.
**Mask `subscriberId` / `sourceAddress`** to last-3-digits. **Never log message bodies
containing user content** unless you have a stated reason and a retention policy — MO SMS
content is user communication. Never log the `password` field the subscriber notification
carries.

---

## URL design

Choose paths before provisioning; changing them later means editing the provisioning record
in the portal, which needs re-approval in some states.

```
POST /api/applink/sms/receive
POST /api/applink/sms/report
POST /api/applink/ussd/receive
POST /api/applink/subscription/notify
POST /api/applink/caas/charging-notification
```

The paths are yours — those are the ones this skill's templates and test scripts use, so they
line up out of the box. What matters is that whatever you choose is registered in the portal
and stays stable.

Requirements:

- **HTTPS with a valid, complete certificate chain.** Self-signed will not work.
- **Publicly reachable** — no VPN, no basic auth prompt, no bot-protection challenge page.
  Protection that interrogates the client will silently break these; allowlist the callback
  paths.
- **Stable.** Do not put them behind a preview URL that rotates per deployment.
- Add an unguessable path segment (`/api/applink/x7f3k9/ussd/receive`) as defence in depth — it
  is not authentication, but it stops opportunistic scanning.
- Exempt them from CSRF protection (they are machine-to-machine `POST`s with no cookie).
- Exempt them from any auth middleware — but then apply the IP restriction, or you have an
  open endpoint.

### Local development

Callbacks cannot reach `localhost`. Use a tunnel for development only:

```bash
cloudflared tunnel --url http://localhost:3000
# or
ngrok http 3000
```

Register the tunnel URL in the portal while testing, and remember it changes on restart with
free tiers. **Never leave a tunnel URL configured in a production application record.**

---

## Reference handler

The same steps in every language and framework:

```
ACK = { "statusCode": "S1000", "statusDetail": "Success" }

handler(request):
    if not from_applink_ip(request):      return 200, ACK   # allowlist, if configured
    body = try_parse_json(request)
    if body is null:                      return 200, ACK   # malformed — acknowledge, discard
    redact(body, "password")                                # before it can reach a log
    if not schema_valid(body):            return 200, ACK   # log the pattern, do not crash
    if body.applicationId and body.applicationId != config.applicationId:
                                          return 200, ACK   # someone else's payload
    if seen_before(dedupe_key(body)):     return 200, ACK   # redelivery
    enqueue("sms.mo", body)                                 # process out of band
    return 200, ACK
```

Note what never happens: no 4xx, no 5xx, no work before the response, no trust in the body,
and nothing logged before the password is stripped.

Complete working routes for all five callbacks, per stack:

| Stack | File |
|---|---|
| TypeScript / Next.js | [templates/typescript/callbacks-nextjs.ts](../templates/typescript/callbacks-nextjs.ts) |
| Python / FastAPI | [templates/python/callbacks_fastapi.py](../templates/python/callbacks_fastapi.py) |
| Java / Spring | [templates/java/ApplinkCallbackController.java](../templates/java/ApplinkCallbackController.java) |
| Go / net/http | [templates/go/callbacks.go](../templates/go/callbacks.go) |
| PHP (framework-neutral, Laravel notes) | [templates/php/callbacks.php](../templates/php/callbacks.php) |
| C# / ASP.NET Core | [templates/csharp/ApplinkCallbacks.cs](../templates/csharp/ApplinkCallbacks.cs) |

Any other stack: [11-any-stack.md](11-any-stack.md).

---

## Testing callbacks

You do not need the platform to test a handler — the payloads are fully specified. Post them
yourself:

```bash
curl -X POST http://localhost:3000/api/applink/ussd/receive \
  -H 'Content-Type: application/json' \
  -d '{"version":"1.0","applicationId":"APP_000029","message":"*141#",
       "requestId":"1330933229901","sessionId":"1330929317043",
       "ussdOperation":"mo-init","sourceAddress":"tel:8801959979376","encoding":"440"}'
```

Build a test for each of: valid payload, malformed JSON, wrong `applicationId`, missing
required field, and **the same payload twice** (the idempotency test — the one people skip).

Ready-made payloads for every callback: [scripts/test-callbacks.sh](../scripts/test-callbacks.sh),
and all five written out field by field — what arrives, what you must respond, the dedupe key,
and a command that replays the exact payload against your route — in
[13-curl-reference.md](13-curl-reference.md).
