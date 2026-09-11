# SMS API

Three distinct services, two directions:

| Service | Direction | Who initiates | Where it happens |
|---|---|---|---|
| **Send** (MT — Mobile Terminated) | App → user | You | `POST /sms/send` |
| **Receive** (MO — Mobile Originated) | User → app | Subscriber | Your MO callback URL |
| **Delivery Status Report** | Platform → app | Platform | Your report callback URL |

Endpoint from `APPLINK_SMS_SEND_URL` (production `https://api.applink.com.bd/sms/send`). If that
variable is unset, the SMS API is not enabled on your application.

---

## Send Service (MT)

```
POST /sms/send
Content-Type: application/json;charset=utf-8
```

### Minimal request

```json
{
  "version": "1.0",
  "applicationId": "APP_999999",
  "password": "…",
  "message": "Hello",
  "destinationAddresses": ["tel:8801959979376"]
}
```

### Response

```json
{
  "version": "1.0",
  "requestId": "101901031657410007",
  "destinationResponses": [
    {
      "timeStamp": "20190103165801",
      "address": "tel:8801959979376",
      "messageId": "101901031657410007",
      "statusCode": "S1000",
      "statusDetail": "Success"
    }
  ],
  "statusCode": "S1000",
  "statusDetail": "Success."
}
```

`destinationResponses` carries one entry per address, each with its own `statusCode`. A
multi-recipient send can partially succeed, so read per-recipient results from there rather
than trusting the top-level code alone.

### Request parameters

| Parameter | Description | Type | Mandatory |
|---|---|---|---|
| `version` | API version, numbered `1.0`, `2.0`… If you send it, the same version comes back | String | **Mandatory** |
| `applicationId` | Application ID from provisioning | String | **Mandatory** |
| `password` | The API key emailed to you on approval | String | **Mandatory** |
| `message` | Message body. Over-length messages are broken up by the platform before sending | String | **Mandatory** |
| `destinationAddresses` | **Array** of `tel:`-prefixed addresses. `["tel:all"]` sends to the subscribed base. May be masked values | String[] | **Mandatory** — at least one |
| `sourceAddress` | Address the message appears to come from — a provisioned alias such as a shortcode (`77000`), or a `tel:` address | String | Optional |
| `deliveryStatusRequest` | `0` = no delivery report, `1` = request a delivery report | Enum | Optional |
| `encoding` | `0` = Text, `240` = Flash SMS, `245` = Binary (message hex-encoded). Defaults to Text | Enum | Optional |
| `binaryHeader` | Hex-encoded binary header for advanced message types. Only meaningful with `encoding: "245"` | String | Optional |

### Response parameters

| Parameter | Description |
|---|---|
| `version` | API version |
| `requestId` | Uniquely identifies the request within the platform. Persist it — delivery reports carry it, and support traces on it |
| `destinationResponses` | Per-recipient results: `timeStamp`, `address`, `messageId`, `statusCode`, `statusDetail` |
| `statusCode` / `statusDetail` | Outcome for the whole request — check this, not the HTTP status |

### Rules

- **`destinationAddresses` is an array, always** — even for one recipient. Sending a bare
  string is the single most common SMS integration bug.
- **`tel:all` is a broadcast to your whole subscriber base.** Guard it. It should never be
  reachable from an ordinary code path; require an explicit, separately-authorised call, and
  check [Base Size](04-subscription.md#base-size--subscriber-base-size) first.
- **`sourceAddress` must be a provisioned alias.** An arbitrary value fails with `E1331`. Omit
  it entirely and the platform uses your default sender address.
- **Set `deliveryStatusRequest: "1"` only if you actually consume delivery reports.** Otherwise
  you generate callback traffic you ignore.
- **Long messages are split and charged per part.** Keep under 160 GSM-7 characters to stay at
  one part. **Bangla text is UCS-2 — budget 70 characters per part.**
- `E1334` / `E1335` mean the message exceeded the configured maximum length (normal /
  advertisement).
- **Never put a password, an OTP the user did not request, or full PII in an SMS body.**

### The `+` in the published samples

The Applink SMS documentation writes destination and source addresses as `tel:+8801959979376`.
Every other Applink API — subscription, OTP, CaaS — writes the same kind of address as
`tel:8801973579363`, with no `+`.

Both forms appear in the platform's own documentation. Send the **no-`+` form**, so one
normalising helper serves every endpoint. If an SMS send comes back `E1325` (invalid address
format), try the `+` form for that endpoint and report the inconsistency to support.

### Broadcast example

```json
{
  "version": "1.0",
  "applicationId": "APP_999999",
  "password": "…",
  "destinationAddresses": ["tel:all"],
  "message": "Service update: …",
  "deliveryStatusRequest": "0"
}
```

---

## Receive Service (MO)

The platform `POST`s to **your** MO callback URL when a subscriber sends an SMS to your
shortcode with your keyword. You do not call anything.

### What you receive

```json
{
  "version": "1.0",
  "applicationId": "APP_000029",
  "sourceAddress": "tel:8801959979376",
  "message": "JOIN",
  "requestId": "22607072011552911",
  "encoding": "0"
}
```

| Parameter | Description | Type | Mandatory |
|---|---|---|---|
| `version` | API version | String | Mandatory |
| `applicationId` | Your application ID — verify it matches | String | Mandatory |
| `sourceAddress` | Sender address, masked if masking is enabled | String | Mandatory |
| `message` | Message as sent by the user, keyword included | String | Mandatory |
| `requestId` | Unique request identifier within the platform. **Deduplicate on this** | String | Mandatory |
| `encoding` | `0` Text / `240` Flash / `245` Binary (hex-encoded) | Enum | Mandatory |

### What you must respond

```json
{ "statusCode": "S1000", "statusDetail": "Success" }
```

Respond **immediately**, before doing any real work. Full callback contract:
[07-callbacks.md](07-callbacks.md).

### Handling MO content

The user's message arrives with the keyword included — a user texting `WEATHER Dhaka` to
your shortcode gives you a `message` containing the keyword and the argument. Parse
defensively:

- Trim, collapse whitespace, and compare the keyword case-insensitively.
- Treat anything after the keyword as free text; users send typos, emoji and empty strings.
- Recognise standard opt-out words (`STOP`, `UNSUB`, `OFF`) and honour them by calling
  Unregister — see [04-subscription.md](04-subscription.md). Ignoring an opt-out word in an
  MO message is both a compliance problem and a support-cost problem.
- MO messages are **not** authenticated beyond the source address. Do not perform a
  destructive or chargeable action purely on the content of one MO SMS.

---

## Delivery Status Report Service

If you sent with `deliveryStatusRequest: "1"`, the platform `POST`s the outcome to your report
callback URL once the message centre reaches a final state. Match it to the original send via
`requestId`.

### What you receive

```json
{
  "destinationAddress": "tel:8801959979376",
  "timeStamp": "20120113082110",
  "requestId": "MSG_000111",
  "deliveryStatus": "DELIVERED"
}
```

| Parameter | Description | Mandatory |
|---|---|---|
| `destinationAddress` | Subscriber address | Mandatory |
| `timeStamp` | Time of the delivery event. Documented as `yyMMddHHmm`, but the published sample is 14 digits — **parse on length** | Mandatory |
| `requestId` | Ties the report back to the original send | Mandatory |
| `deliveryStatus` | See enum below | Mandatory |

### `deliveryStatus` values

Platform → your application:

`DELIVERED`, `EXPIRED`, `DELETED`, `UNDELIVERABLE`, `ACCEPTED`, `UNKNOWN`, `REJECTED`

The underlying SMPP layer uses the abbreviated forms `DELIVRD`, `EXPIRED`, `DELETED`,
`UNDELIV`, `ACCEPTD`, `UNKNOWN`, `REJECTD`. **Accept both spellings** — normalise on the way
in rather than assuming one set.

### Respond

```json
{ "statusCode": "S1000", "statusDetail": "Success" }
```

### Using delivery reports well

- `ACCEPTED` is not `DELIVERED` — it means the network took the message, nothing more.
- Repeated `UNDELIVERABLE` for one subscriber usually means a dead number; stop messaging it
  and consider unregistering to avoid paying for nothing.
- Reports can arrive out of order, late, more than once, or never. Store the latest status
  keyed by `requestId` and make the handler idempotent.

---

## Implementation notes

- One `sendSms(to, message, opts)` function; never build the payload at call sites.
- Normalise recipients through a single `toTelAddress()` helper.
- Persist `requestId` at send time if you want delivery reports to be matchable.
- Rate-limit your own sending. `E1318` is the per-second limit and `E1319` the per-day limit;
  exceeding them gets requests rejected rather than queued.

Working `sendSms` and MO/report handlers in six languages: [templates/](../templates/README.md).
Any other stack: [11-any-stack.md](11-any-stack.md), with all three endpoints as runnable curls
— parameters, response and response fields defined — in
[13-curl-reference.md](13-curl-reference.md).
