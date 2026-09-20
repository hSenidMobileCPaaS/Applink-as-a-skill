# Subscription and OTP APIs

The Subscription API manages the lifecycle that binds a user to your service, and — critically
— records their **consent**. Registering users without it can get your application suspended.

| Operation | Endpoint |
|---|---|
| **Register** (opt-in) | `POST /subscription/send` with `action: "1"` |
| **Unregister** (opt-out / unsub) | `POST /subscription/send` with `action: "0"` |
| **Base Size** (subscriber count) | `POST /subscription/query-base` |
| **Get Subscriber Charging Info** (status + last charge) | `POST /subscription/getSubscriberChargingInfo` |
| **Subscriber Notification** | Your callback URL (inbound) |

Plus **OTP**, the activation flow for web and app users, on its own `/otp/*` paths — documented
at the end of this file.

---

## Register / Unregister

```
POST /subscription/send
Content-Type: application/json;charset=utf-8
```

### Register (opt-in)

```json
{
  "applicationId": "APP_999999",
  "password": "…",
  "subscriberId": "tel:8801959979376",
  "action": "1"
}
```

```json
{
  "version": "1.0",
  "statusCode": "S1000",
  "statusDetail": "Success.",
  "subscriptionStatus": "REGISTERED"
}
```

### Unregister (opt-out)

Identical, with `action: "0"`:

```json
{
  "applicationId": "APP_999999",
  "password": "…",
  "subscriberId": "tel:8801959979376",
  "action": "0"
}
```

```json
{
  "version": "1.0",
  "statusCode": "S1000",
  "statusDetail": "not registered",
  "subscriptionStatus": "UNREGISTERED."
}
```

That is the published sample verbatim, and it is worth reading closely: `S1000` with
`statusDetail: "not registered"`. **Success here means the request was processed, not that a
change occurred.** `subscriptionStatus` is the field that tells you the actual state.

### Request parameters

| Parameter | Description | Type | Mandatory |
|---|---|---|---|
| `applicationId` | Application ID from provisioning | String | **Mandatory** |
| `password` | The API key emailed to you on approval | String | **Mandatory** |
| `subscriberId` | `tel:`-prefixed subscriber MSISDN; may be a masked value | String | **Mandatory** |
| `action` | `"1"` = opt in, `"0"` = opt out | Enum | **Mandatory** |

`action` is documented as a **string**. Use the string form.

### Response parameters

| Parameter | Description |
|---|---|
| `version` | API version |
| `statusCode` / `statusDetail` | Outcome for the request |
| `subscriptionStatus` | Resulting state, e.g. `REGISTERED` / `UNREGISTERED` |

### Rules that matter

- **Consent before Register, always.** A user tapping "Subscribe", replying to a USSD prompt,
  or verifying an OTP is consent. Importing a list of numbers is not. Store *what* the user
  agreed to, *when*, and *through which channel* — you may be asked to produce it.
- **Disclose the charge before registering** — amount, currency (BDT), frequency. This is a
  provisioning-level obligation, not a nicety.
- **Unregister must be as easy as register.** Provide it in every channel the user can reach:
  an `UNSUB` / `STOP` keyword over MO SMS, a USSD menu option, and a button in-app. Honour it
  immediately, including cancelling messages already queued for that subscriber.
- **Applink publishes no "already registered" or "not registered" error code.** There is
  nothing here corresponding to a benign duplicate-state code on other platforms. Make both
  operations idempotent by **reading `subscriptionStatus` from the response** — a repeat
  register that comes back `REGISTERED` is the state you wanted, and the unregister sample
  above shows the platform returning `S1000` for a subscriber who was never registered.
- **Registration may not be usable immediately.** If initial charging is involved the
  subscriber can sit in `REG_PENDING`. Do not start delivering the service until the status is
  `REGISTERED` or `TRIAL` — wait for the subscriber notification.
- **Mirror subscription state in your own database.** Do not call Get Subscriber Charging Info
  per request — it is capped at ten MSISDNs and is meant for reconciliation.

---

## Base Size — subscriber base size

Returns how many subscribers are currently registered to the application. Needs no subscriber
and costs nothing, which also makes it the ideal connectivity smoke test.

```
POST /subscription/query-base
Content-Type: application/json;charset=utf-8
```

```json
{
  "applicationId": "APP_000201",
  "password": "…"
}
```

```json
{
  "baseSize": "0",
  "version": "1.0",
  "statusCode": "S1000",
  "statusDetail": "Success."
}
```

| Request parameter | Description | Mandatory |
|---|---|---|
| `applicationId` | Application ID | **Mandatory** |
| `password` | API key | **Mandatory** |

| Response parameter | Description | Mandatory |
|---|---|---|
| `baseSize` | Number of registered users — **a string, parse it** | Mandatory |
| `version` | API version | Mandatory |
| `statusCode` / `statusDetail` | Outcome | Mandatory |

Notes:

- `baseSize` comes back as a **string**. Coerce before arithmetic or charting.
- It is a point-in-time count for the whole application, not a per-operator or per-segment
  figure.
- Poll it on a schedule (hourly/daily) into your own metrics store rather than calling it per
  page load. Use it to sanity-check a broadcast before sending to `tel:all` — if `baseSize` is
  far larger than you expect, stop.

---

## Get Subscriber Charging Info

Applink's subscription-status lookup. **There is no separate `getStatus` endpoint** — this is
where subscription state lives, alongside the last-charge details, for up to **ten** subscribers
per request.

```
POST /subscription/getSubscriberChargingInfo
Content-Type: application/json;charset=utf-8
```

```json
{
  "applicationId": "APP_102672",
  "password": "…",
  "subscriberIds": ["tel:8801973579363"]
}
```

```json
{
  "version": "1.0",
  "destinationResponses": [
    {
      "subscriberId": "tel:8801973579363",
      "subscriptionStatus": "REGISTERED",
      "lastChargedDate": "2020-01-23 22:03:22",
      "lastChargedAmount": "30.00 BDT",
      "numberType": "postpaid",
      "statusCode": "S1000",
      "statusDetail": "Request was successfully processed"
    }
  ],
  "statusCode": "S1000",
  "statusDetail": "Success."
}
```

| Request parameter | Description | Mandatory |
|---|---|---|
| `applicationId` | Application ID | **Mandatory** |
| `password` | API key | **Mandatory** |
| `subscriberIds` | Array of `tel:`-prefixed MSISDNs. Masked values if the application uses masking. **Maximum 10 per request** | **Mandatory** |

Two quirks in the published specification, both worth knowing before you debug a `E1312`:

- The schema's `required` list names `subscriberId` while the property it documents and samples
  is `subscriberIds`. **Send `subscriberIds`**, the array, as the sample does.
- The sample array entries are written with a stray space (`"tel: 8801973579363"`). Send
  `tel:8801973579363` with no space, or you risk `E1325`.

### Per-subscriber response fields

| Field | Description |
|---|---|
| `subscriberId` | MSISDN, masked if the application uses masked numbers |
| `subscriptionStatus` | See the table below |
| `lastChargedDate` | Last successful charge, `YYYY-MM-DD hh:mm:ss`. Omitted for a free application |
| `lastChargedAmount` | Last successful charge amount with its currency code. `0.00` for a free application |
| `numberType` | `prepaid` or `postpaid` |
| `statusCode` / `statusDetail` | Outcome for this subscriber alone |

### Subscription statuses

| Status | Meaning | Fields returned |
|---|---|---|
| `INITIAL` | The subscription request reached the system but did not complete — possibly a system error. No charging call was made | `subscriberId`, `subscriptionStatus`, `numberType`, `statusCode`, `statusDetail` |
| `REG_PENDING` | Subscription requested and the charging request sent, but charging has not succeeded yet (no response from the IN, or insufficient balance) | as above |
| `TRIAL` | Subscribed and using the service without charging, on a free trial period | as above |
| `REGISTERED` | Subscribed, charging succeeded, the subscriber can receive the service | plus `lastChargedDate` and `lastChargedAmount` |
| `UNREGISTERED` | The subscriber unsubscribed from the service | plus `lastChargedDate` and `lastChargedAmount` |
| `TEMPORARY_BLOCKED` | Was registered, but recursive charging has since failed (for example insufficient balance), so the service is temporarily blocked for this subscriber | plus `lastChargedDate` and `lastChargedAmount` |

**Only `REGISTERED` and `TRIAL` mean the subscriber can use the service.** Branch on each
entry's own `statusCode`, not just the top-level one, and treat this as a reconciliation tool
(a nightly sweep, or when a user disputes their state) rather than a per-request gate.

---

## Subscriber Notification (inbound)

The platform `POST`s to the **subscriber notification URL** configured during provisioning
whenever a subscription changes — including changes you did not initiate (a user texting
`STOP`, an operator-side removal, a billing failure).

```json
{
  "timeStamp": "20120113082110",
  "version": "1.0",
  "applicationId": "APP_999999",
  "password": "…",
  "subscriberId": "tel:8801973579363",
  "frequency": "monthly",
  "status": "REGISTERED"
}
```

| Field | Meaning |
|---|---|
| `timeStamp` | When it happened. Documented as `yyMMddHHmm`, sample is 14 digits — parse on length |
| `version` | API version |
| `applicationId` | Your application ID |
| `password` | **Your API key.** The platform sends it in the notification body |
| `subscriberId` | Subscriber address, possibly masked |
| `frequency` | Charging frequency: `daily`, `weekly`, `monthly` or `yearly` |
| `status` | Subscription status, e.g. `REGISTERED` / `UNREGISTERED` |

Respond `{"statusCode":"S1000","statusDetail":"Success"}`.

> **This callback contains your password.** Redact that field before the payload reaches any
> log, trace, error report or analytics sink. If you use it to authenticate the caller, compare
> it in constant time — and treat it as one signal among several, not as proof.

**This callback is the authoritative source of subscription state.** Consuming it is what lets
you keep a local mirror instead of polling. Handle it idempotently — duplicates happen; the
dedupe key is `subscriberId` + `status` + `timeStamp`. Full contract:
[07-callbacks.md](07-callbacks.md).

---

## OTP — activating subscriptions from web and mobile apps

When the user starts on a screen rather than on the network (a website form, an app sign-up),
you cannot get their MSISDN from the carrier. OTP solves that: the user types their number,
the platform SMSes a PIN, and on successful verification the Applink subscription is activated
and you receive the `subscriberId` to use with every other API.

These are their own top-level paths — `/otp/request` and `/otp/verify` — not sub-paths of
`/subscription`.

### Flow

1. Collect the mobile number in your UI.
2. `POST /otp/request` → the platform SMSes a PIN.
3. Store the returned `referenceNo` server-side against the user's session.
4. Collect the PIN in your UI.
5. `POST /otp/verify` with `referenceNo` + `otp`.
6. Store the returned `subscriberId` — this is what you use for SMS, Subscription and Charging.

**Always call these from a backend with a static IP**, never from the browser or the app.

### OTP Request

```
POST /otp/request
```

```json
{
  "applicationId": "APP_000375",
  "password": "…",
  "subscriberId": "tel:8801416177301",
  "applicationHash": "abcdefgh",
  "applicationMetaData": {
    "client": "MOBILEAPP",
    "device": "Samsung S10",
    "os": "android 8",
    "appCode": "https://play.google.com/store/apps/details?id=example"
  }
}
```

| Field | Mandatory | What to put in it |
|---|---|---|
| `applicationId` | **Mandatory** | Application ID from provisioning |
| `password` | **Mandatory** | The API key emailed to you on approval |
| `subscriberId` | **Mandatory** | Mobile number, in the format `tel:8801416177301` |
| `applicationHash` | Optional | Hash string determining which verification messages to send to your app |
| `applicationMetaData` | Optional | `client` (web browser or mobile app), `device`, `os`, `appCode` — the store identifier for an app, or the web link for a browser |

Success:

```json
{
  "version": "1.0",
  "statusCode": "S1000",
  "referenceNo": "213561321321613",
  "statusDetail": "Success"
}
```

Documented failures: `E1301` (application not allowed for the operator), `E1312` (missing
mandatory field), `E1313` (authentication failure), `E1603` (temporary system error), `E1856`
(invalid request).

### OTP Verify

```
POST /otp/verify
```

```json
{
  "applicationId": "APP_000375",
  "password": "…",
  "referenceNo": "213561321321613",
  "otp": "123564"
}
```

Success:

```json
{
  "version": "1.0",
  "statusCode": "S1000",
  "subscriptionStatus": "REGISTERED",
  "statusDetail": "Success",
  "subscriberId": "tel:8801416177301"
}
```

Documented failures:

| Code | Meaning |
|---|---|
| `E1850` | Invalid OTP |
| `E1851` | OTP request has expired |
| `E1855` | Invalid reference number |
| `E1603` | Temporary system error |
| `E1856` | Invalid request |

### OTP rules

- **An Applink OTP is valid for five minutes.** Expire it on your side too rather than relying
  on the platform.
- **`referenceNo` lives server-side, in the session.** Never send it to the client, never put
  it in a URL, and never let the client choose it — that would let an attacker verify against
  someone else's OTP request.
- **Cap verification attempts yourself**, per `referenceNo`, and force a fresh request after
  that. The platform documents no attempt limit for this endpoint.
- **Rate-limit OTP requests yourself**, per number and per IP. Without it your application
  becomes an SMS-bombing tool aimed at arbitrary Bangladeshi phone numbers, at your expense.
- **The `subscriberId` you get back is the identity for every later call.** It may be plain or
  masked depending on the application's setting. Store it as-is and treat it as opaque.
- Never log the OTP or the `referenceNo`.
- The OTP under `/otp/*` **activates a subscription**. The OTP under `/caas/*` **authorises a
  charge**. They are different flows with different reference values — see
  [05-caas.md](05-caas.md).

---

## Identity and sessions — subscribe once, then trust your own session

**This is the flow developers most often get wrong.** Register, OTP and CaaS all prove that a
user controls a phone number, so they look like authentication. They are not authentication
APIs — each one is a **transaction**. Register can trigger the initial charge, `/otp/request`
sends a real SMS that costs money and is rate-limited, and CaaS moves money. Calling one of
them to answer "who is this?" or "may this user in?" bills the subscriber, floods them with
PINs, burns your transaction quota (`E1318` / `E1319`), and takes your login path down
whenever the platform is slow.

What the subscription flow gives you is a **one-time verified binding**: this account owns
this `subscriberId`, and this user consented, at this moment, to this charge. Establish it
once. Everything after that is answered locally.

### Two questions, two different sources

| Question | Where the answer comes from | Never |
|---|---|---|
| **Who is this user?** | Your own session and auth — cookie session, JWT, Django session, Spring Security, a Laravel guard, whatever the project already has | A fresh `/otp/request` + `/otp/verify` on every login |
| **May they use the service right now?** | Your local subscription mirror, keyed by `subscriberId` | `getSubscriberChargingInfo` on the request path |
| **Has their state changed?** | The subscriber notification callback, plus a scheduled reconciliation sweep | Polling per request or per page load |
| **May I take this payment?** | A fresh CaaS charge, authorised per payment | Treating a live session — or an earlier OTP — as authorisation |

### The flow

```
FIRST TIME ONLY — the binding
  user opts in  (SMS keyword, USSD menu, or OTP request + verify)
    → record consent: who, when, channel, wording shown, amount disclosed
    → subscriberId comes back (opaque — store exactly as given)
    → create or link the local account and store subscriberId on it
    → mirror subscriptionStatus on that row, with the time it was confirmed
    → ISSUE YOUR OWN SESSION. From here the user is logged in, by your system.

EVERY REQUEST AFTER THAT — the entitlement check, zero Applink calls
  session → account → the mirrored subscriptionStatus
    REGISTERED / TRIAL      → serve the service
    REG_PENDING             → "activation in progress"; wait for the callback, do not re-register
    TEMPORARY_BLOCKED       → a billing failure, not a logout: show the fix-payment path
    UNREGISTERED / INITIAL  → the re-subscribe screen (a fresh opt-in, with disclosure)

STATE CHANGES — out of band, never in the request path
  subscriber notification callback → update the mirror; this is the authority
  scheduled sweep of getSubscriberChargingInfo (≤10 subscriberIds per call)
                                   → reconcile rows whose mirror has gone stale
```

### Rules

- **Nothing on the login or page-load path calls Applink.** If a user signing in causes an
  outbound request to `api.applink.com.bd`, the design is wrong. Sign-in reads your session
  store; entitlement reads your own database.
- **Re-verify only on a genuine re-verification event** — a new device, a changed number, a
  long-dormant account, or a step-up before something sensitive. That is what a fresh OTP is
  for. Not every login, and never every request.
- **A live session is not permission to charge.** Authentication and authorisation of money
  are separate: every charge is its own CaaS flow with its own `externalTrxId` and its own
  OTP, whatever the user's session says. See [05-caas.md](05-caas.md).
- **Store when the mirror was last confirmed, and by what** — the notification or a sweep.
  That timestamp is what makes reconciliation targetable and support answerable.
- **When the mirror is stale or a lookup fails, serve the last known good state** and
  reconcile in the background. Never block a request on a live Applink call, and never log a
  user out because a lookup failed.
- **`subscriberId` is a join key, not a session token.** Keep it on the account row. Do not
  put it in a cookie or a JWT claim the client can replay — anyone who can set it would then
  be able to act as that subscriber.
- **Count the calls before you design a per-request check.** `getSubscriberChargingInfo` takes
  ten MSISDNs per call and is meant for reconciliation; one OTP per login is one paid SMS per
  login. Both hit the per-second and per-day transaction limits long before they hit your
  traffic peak.

Recipe E in [12-implementation-playbook.md](12-implementation-playbook.md#4-flow-recipes)
writes this out as a sequence, and [07-callbacks.md](07-callbacks.md) is the contract for the
notification that keeps the mirror honest.

---

Register, unregister, base size, charging info, OTP request and OTP verify as runnable curls —
every parameter, response and response field defined:
[13-curl-reference.md](13-curl-reference.md).
