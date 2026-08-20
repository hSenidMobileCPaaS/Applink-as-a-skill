# Coverage: what Applink publishes, what it does not, and how to extend

Half of getting a telco integration right is knowing where the contract stops. An agent that
invents a plausible-looking endpoint costs a developer a day of debugging a 404 that was never
going to work.

This page is the boundary.

---

## What Applink publishes

Five API families, listed at <https://dev.applink.com.bd/applink-api.php> and specified at
<https://dev.applink.com.bd/API_Documentation/docs/hSenidMobile_tap_api.html>:

| Family | Outbound | Inbound |
|---|---|---|
| **SMS** | `POST /sms/send` | `/sms/receive`, `/sms/report` |
| **USSD** | `POST /ussd/send` | `/ussd/receive` |
| **Subscription** | `POST /subscription/send`, `/subscription/query-base`, `/subscription/getSubscriberChargingInfo` | `/subscription/notify` |
| **OTP** | `POST /otp/request`, `/otp/verify` | — |
| **CaaS** | `POST /caas/direct/debit`, `/caas/otp/verify`, `/caas/get/balance` | `/caas/chargingNotification` |

Eleven outbound endpoints and five callbacks. That is the whole surface. All of them are
written out as runnable requests in [13-curl-reference.md](13-curl-reference.md), and as
structured data in [`catalog/applink-api.json`](../catalog/applink-api.json).

---

## What Applink does not publish

Do not invent endpoints, parameter names or status codes for any of these. If a user asks,
say it is not in the developer documentation and point them at `support@applink.com.bd`.

### Location / LBS

There is **no location API** in the Applink developer documentation. Nothing returns a
subscriber's cell or handset position, and there is no `serviceType` / `horizontalAccuracy` /
`freshness` contract to work from.

If the requirement is "where is this user", the honest answers are: ask the user in your own
app (browser geolocation, handset GPS), or ask Applink support whether location is available
for your account. Do not synthesise an endpoint.

### Voice / IVR

There is **no voice or IVR API** in the Applink developer documentation.

The requirement behind an IVR request is usually one of two things Applink *does* cover:

- **An interactive menu on any handset, no data connection** — that is USSD
  ([03-ussd.md](03-ussd.md)). It works on feature phones and needs no app.
- **Delivering a message to a subscriber** — that is SMS ([02-sms.md](02-sms.md)).

Offer those, and point at support for anything genuinely voice-shaped.

### A standalone subscription-status endpoint

There is no `getStatus`. Subscription status comes from **Get Subscriber Charging Info**
(`POST /subscription/getSubscriberChargingInfo`, up to ten MSISDNs per request) and,
authoritatively and in real time, from the **subscriber notification** callback. See
[04-subscription.md](04-subscription.md).

### A single-step direct debit

`/caas/direct/debit` is named as though it were one, but it is step one of a two-step OTP
flow: it dispatches an OTP and returns `P1003`, and the money moves at `/caas/otp/verify`.
There is no endpoint that charges a subscriber without their OTP. See
[05-caas.md](05-caas.md).

### An IP-echo endpoint

Applink publishes no equivalent of a "what is my IP" service. Use any public one — run it
**on the server that will make the calls**:

```bash
curl -4 https://api.ipify.org
```

### Benign duplicate-state codes

Some telco platforms publish codes meaning "already registered" or "transaction already
completed" that you treat as success. **Applink publishes none.** The thirty documented codes
are in [08-status-codes.md](08-status-codes.md), and nothing outside that list should appear in
your error handling.

Make register and unregister idempotent by reading `subscriptionStatus` from the response.
Make charging idempotent with a persisted `externalTrxId` and the charging notification —
`E1337` ("Duplicate request") tells you the platform already has the transaction, but it does
**not** tell you the charge succeeded, so it is not a success code.

---

## Documented but not surfaced

`POST /caas/get/balance` is in the published OpenAPI specification but is **not listed in the
rendered documentation's navigation**, and its description there is a placeholder.

The skill carries it because it is in the official specification, with its parameters and
response as published. Treat it as provisional: confirm with `support@applink.com.bd` that it
is enabled on your application before building a flow that depends on it, and leave
`APPLINK_CAAS_BALANCE_URL` unset until you have. An unset endpoint makes the client refuse the
call locally, which is the behaviour you want for something unconfirmed.

---

## Inconsistencies in the published contract

The skill reports these rather than silently picking a side. Each one has bitten someone.

| Where | What the documentation says | What to do |
|---|---|---|
| SMS addresses | Samples write `tel:+8801959979376`; every other API writes `tel:8801973579363` | Send the no-`+` form so one helper serves every endpoint. If SMS returns `E1325`, try the `+` form and tell support |
| `getSubscriberChargingInfo` required list | Names `subscriberId`; the documented property and sample are `subscriberIds` | Send `subscriberIds`, the array |
| `getSubscriberChargingInfo` sample | Array entries written as `"tel: 8801973579363"`, with a space | Send no space |
| CaaS currency | `Currency` (capital C) on OTP generation, `currency` (lower case) on balance query | Bind both spellings exactly as published |
| Charging notification | `TotalAmount` capitalised; `paidAmount` and `balanceDue` are not | Bind exactly |
| `/caas/otp/verify` response sample | Repeats the request fields instead of showing a response | Read `statusCode` / `statusDetail`, log the real body once in Limited Production, and settle from the charging notification |
| Timestamp formats | `yyMMddHHmm` documented, 14-digit samples given, and the charging notification uses `15-Nov-2023 11:55` | Parse defensively, on length and format |

---

## Extension pattern — adding a service without restructuring

This skill is built so a new service drops in without touching existing code. When Applink
publishes one:

1. **Add it to the catalog** — a new entry in `services` (or `callbacks`) in
   [`catalog/applink-api.json`](../catalog/applink-api.json), with its `id`, `envVar`, `path`,
   every parameter, every response field, its status codes and its rules.
2. **Regenerate the curl reference:**
   ```bash
   node scripts/build-curl-reference.mjs
   ```
   That is where the runnable request, the parameter definitions and the response tables come
   from — never hand-edit `13-curl-reference.md`.
3. **Add a reference file** if the service needs more than the contract — the session model,
   the money rules, the compliance obligations.
4. **Add the endpoint variable to config**, not to code — `APPLINK_<SERVICE>_URL` in
   `.env.example` and in the endpoint map of whichever config module your stack uses
   (`endpoints` in TypeScript, `_ENDPOINT_VARS` in Python, `ENDPOINT_VARS` in Java/PHP,
   `endpointVars` in Go, `EndpointVariables` in C#).
5. **Add one wrapper function** to the client. It reuses the same `post()` helper, so it
   inherits credential injection, timeouts, error mapping and logging for free:
   ```
   function newThing(input):
       return post("new-thing", requireEndpoint("newThing"), input)
   ```
6. **Add a callback route** if the service pushes notifications, following the shape in
   [07-callbacks.md](07-callbacks.md).
7. **Add a row to the service map** in [SKILL.md](../SKILL.md) and [AGENTS.md](../AGENTS.md),
   and a case in `scripts/smoke-test.sh`.

Every Applink API shares one envelope — `applicationId` + `password` in, `statusCode` +
`statusDetail` out. Any new service will too. Do not build a parallel client for it.
