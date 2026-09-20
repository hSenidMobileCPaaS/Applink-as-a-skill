# CaaS — Charging as a Service

CaaS charges money from an end user's mobile account — prepaid balance is reduced, postpaid is
added to the monthly bill. No cards, no wallet, no cash. Only **BDT**.

**This API moves real money belonging to real people.** Every rule in this file exists because
breaking it costs someone money.

| Service | Endpoint | Notes |
|---|---|---|
| **CaaS OTP Generation** | `POST /caas/direct/debit` | Step 1 — reserves the charge and SMSes an OTP to the subscriber |
| **CaaS OTP Verification** | `POST /caas/otp/verify` | Step 2 — the OTP is checked and the money is deducted |
| **Query Balance** | `POST /caas/get/balance` | In the published specification, not in the rendered docs' navigation — confirm it is enabled |
| **Charging Notification** | Your callback URL | The authoritative outcome of every charging request |

---

## Applink charging is a two-step OTP flow

This is the single most important thing on the page, and the thing most likely to be got wrong
by anyone porting a single-step direct-debit integration:

```
1. POST /caas/direct/debit      → statusCode P1003, requestCorrelator, internalTrxId
                                  Applink SMSes an OTP to the subscriber.
                                  NOTHING HAS BEEN CHARGED.

2. subscriber types the OTP into your application

3. POST /caas/otp/verify        → referenceNo = requestCorrelator from step 1
                                  This is where the money moves.

4. charging notification        → paidAmount, balanceDue, final statusCode
                                  This is the authoritative outcome. Settle your ledger here.
```

Code that treats step 1's response as a completed charge fulfils orders nobody paid for. The
endpoint is called `/caas/direct/debit` and the response says "Request successfully proceed. OTP
will send to user." — read the second half.

---

## The five charging rules

1. **The amount must be pre-agreed and disclosed to the user before they are charged.**
   Arbitrary or surprise amounts are a compliance failure.
2. **`externalTrxId` is your idempotency key.** Generate it once, persist it *before* the HTTP
   call, and reuse the same value for any resolution attempt on that same logical charge.
3. **Never start the charge again to "retry".** A timeout does not mean the charge did not
   happen, and re-running OTP generation creates a *second* transaction. Resolve unknown
   outcomes through the charging notification.
4. **Never charge from a request you did not authenticate.** A webhook body, an MO SMS, or a
   USSD keypress is not authorisation on its own.
5. **A charge must be traceable to a user action.** Log who, what, when, how much, which
   `externalTrxId`, and what the user saw before they agreed.

**The CaaS OTP is not a login.** It authorises *one* charge, and nothing else. An
authenticated session says who the user is; it never says a payment may be taken, and a
verified charge never stands in for a session. Bind the subscriber once through the
subscription flow, log the user in with your own session, and start a fresh CaaS flow —
new `externalTrxId`, new OTP — for every payment. See
[04-subscription §Identity and sessions](04-subscription.md#identity-and-sessions--subscribe-once-then-trust-your-own-session).

---

## Step 1 — CaaS OTP Generation

```
POST /caas/direct/debit
Content-Type: application/json;charset=utf-8
```

### Request

```json
{
  "applicationId": "APP_000XXX",
  "password": "…",
  "externalTrxId": "256091232",
  "amount": "5.00",
  "paymentInstrumentName": "Mobile Account",
  "subscriberId": "tel:8801973579363",
  "Currency": "BDT"
}
```

| Parameter | Description | Type | M/O |
|---|---|---|---|
| `applicationId` | Application ID from provisioning | String | **M** |
| `password` | The API key emailed to you on approval | String | **M** |
| `externalTrxId` | **Your** transaction ID, mapping the request to the response. What support and reconciliation trace on | String | **M** |
| `amount` | Amount to be reserved for charging, sent as a **string** | String | **M** |
| `paymentInstrumentName` | Name of the payment instrument, e.g. `Mobile Account` | String | **M** |
| `subscriberId` | `tel:`-prefixed MSISDN of the subscriber to be charged; may be masked | String | **M** |
| `Currency` | Currency of the amount. Only `BDT` is allowed | String | **M** |

> **`Currency` is capitalised here** — capital `C`. On Query Balance the same concept is spelled
> `currency`, lower case. That is how both are published. Bind the field names exactly.

### Response

```json
{
  "timeStamp": "2023-11-08T08:02:16.913Z",
  "externalTrxId": "256091232",
  "statusDetail": "Request successfully proceed. OTP will send to user.",
  "requestCorrelator": "8801442233146169943053700500040",
  "internalTrxId": "9110808020001876",
  "statusCode": "P1003"
}
```

| Parameter | Description | M/O |
|---|---|---|
| `timeStamp` | The time the request was sent | M |
| `externalTrxId` | Echo of your ID — **assert it matches what you sent** | M |
| `statusDetail` | Detailed description of the status | M |
| `requestCorrelator` | The platform's internal identifier for this transaction. **This is the `referenceNo` step 2 needs — persist it or the charge cannot be completed** | M |
| `internalTrxId` | Service-provider transaction ID used to track the transaction. Persist it for support | M |
| `statusCode` | `P` prefix = partial, `E` = error, `S` = success | M |

**`P1003` is not success.** It means the OTP is on its way. Store the pending charge with both
`externalTrxId` and `requestCorrelator`, then collect the OTP.

### `externalTrxId` rules

- Unique per logical charge, across all time. UUIDv4 or ULID.
- **Persist before you send.** The correct order is: write a `PENDING` charge row → call the
  API → update the row from the response. If you crash between, you can reconcile; if you never
  wrote the row, the money moves with no record on your side.
- Never regenerate it. `E1337` ("Duplicate request") is the platform telling you it already has
  a transaction under that identifier — resolve the original from the charging notification
  rather than starting a new one.

---

## Step 2 — CaaS OTP Verification

```
POST /caas/otp/verify
Content-Type: application/json;charset=utf-8
```

### Request

```json
{
  "applicationId": "APP_000XXX",
  "password": "…",
  "referenceNo": "8801442233146169943053700500040",
  "otp": "123456",
  "sourceAddress": "tel:8801973579363"
}
```

| Parameter | Description | Type | M/O |
|---|---|---|---|
| `applicationId` | Application ID from provisioning | String | **M** |
| `password` | The API key emailed to you on approval | String | **M** |
| `referenceNo` | The `requestCorrelator` returned by CaaS OTP Generation — the reference of the transaction | String | **M** |
| `otp` | The OTP the subscriber entered into your application | String | **M** |
| `sourceAddress` | The MSISDN that requested the OTP — the subscriber being charged | String | **M** |

`referenceNo` is the `requestCorrelator`, **not** the `externalTrxId` you generated, and **not**
the `referenceNo` from `/otp/request`. Getting that wrong is `E1855`.

### Response

The published response sample for this endpoint repeats the request fields rather than showing a
response envelope. Read `statusCode` and `statusDetail`, and **log the whole body once during
Limited Production** so you know exactly what your account returns.

Whatever it returns, the authoritative outcome is the **charging notification** — it is the only
place `paidAmount` and `balanceDue` appear.

### Failure handling

| Situation | What to do |
|---|---|
| `E1850` invalid OTP | Prompt the subscriber to re-enter it, against the **same** `referenceNo` |
| `E1851` OTP expired | The transaction is dead. Abandon it, mark your row failed, and start a genuinely new charge only if the user asks again |
| `E1855` invalid reference number | You passed the wrong identifier. It is `requestCorrelator` |
| `E1326` insufficient balance | Tell the subscriber. Do not loop |
| `E1308` permanent charging error | Read `statusDetail`, do not blind-retry, settle from the notification |
| Timeout / no response | Mark the row `UNKNOWN`. **Do not re-run step 1.** Wait for the charging notification, or contact support with `externalTrxId` and `internalTrxId` |

**Never re-run CaaS OTP Generation to retry a failed verification.** That starts a second
charge against the same person.

---

## Charging state machine

```
                    persist externalTrxId, status PENDING
                                  │
                       POST /caas/direct/debit
                                  │
        ┌─────────────────────────┼──────────────────────────┐
        │                         │                          │
      P1003                E13xx / E16xx                 timeout
   OTP dispatched          not started                   UNKNOWN
   store requestCorrelator  mark FAILED             reconcile — never re-send
        │
   subscriber enters OTP
        │
        POST /caas/otp/verify ──── E1850 ──► re-prompt, SAME referenceNo
        │                     ──── E1851 ──► expired, abandon the transaction
        │                     ──── E1326 ──► insufficient balance, tell the user
        │                     ──── E1337 ──► duplicate; settle from the notification
        ▼
   charging notification ──► CHARGED   (compare paidAmount and balanceDue to your ledger)
```

---

## Charging-related status codes

| Code | Meaning | What to do |
|---|---|---|
| `P1003` | Request processed, OTP will be sent to the user | Not charged yet. Collect the OTP and verify |
| `E1303` | Source IP not provisioned | Portal fix. Add the real egress IP |
| `E1308` | Permanent charging error — the platform names the reason | Do not blind-retry; read `statusDetail` |
| `E1313` | Authentication failure | Credentials or application state |
| `E1317` | MSISDN invalid or not allowed | Validate the number |
| `E1318` / `E1319` | Per-second / per-day transaction limit exceeded | Throttle; the daily one will not clear today |
| `E1326` | **Insufficient balance** | Tell the user; retry later, not immediately |
| `E1328` | Charging operation not allowed — check the NCS configuration | Provisioning fix |
| `E1337` | **Duplicate request** | The platform already has this transaction. Do **not** issue a new `externalTrxId` — settle from the charging notification |
| `E1343` | MSISDN not whitelisted | Limited Production. Add the number in the portal |
| `E1850` / `E1851` / `E1855` | Invalid OTP / expired / invalid reference number | See the table above |
| `E1601` / `E1602` / `E1603` | Platform-side errors | Backoff, capped attempts, then dead-letter |
| `E1856` | Invalid request | Check every mandatory field before retrying |

---

## Query Balance

Check available balance before attempting a charge.

> This endpoint is present in the published API specification but is **not listed in the
> rendered documentation's navigation**. Confirm with `support@applink.com.bd` that it is
> enabled on your application before you build a flow that depends on it. Leaving
> `APPLINK_CAAS_BALANCE_URL` unset is how your client refuses the call locally instead of
> failing at the platform.

```
POST /caas/get/balance
Content-Type: application/json;charset=utf-8
```

```json
{
  "applicationId": "APP_999999",
  "password": "…",
  "subscriberId": "tel:8801959979376",
  "paymentInstrumentName": "MobileAccount",
  "accountId": "12345",
  "currency": "BDT"
}
```

| Parameter | Description | M/O |
|---|---|---|
| `applicationId` | Application ID | **M** |
| `password` | API key | **M** |
| `subscriberId` | MSISDN or username of the subscriber being queried; may be masked | **M** |
| `paymentInstrumentName` | Payment instrument. `MobileAccount` | **M** |
| `accountId` | Account of the payment instrument | O |
| `currency` | Only `BDT` is allowed. Note the lower-case `c` here | O |

```json
{
  "accountType": "Pre Paid",
  "accountStatus": "Active",
  "chargeableBalance": "300.0",
  "statusCode": "S1000",
  "statusDetail": "Success."
}
```

| Parameter | Description | M/O |
|---|---|---|
| `accountType` | `Pre Paid` / `Post Paid` | M |
| `accountStatus` | Account status, e.g. `Active` | M |
| `chargeableBalance` | Remaining balance (prepaid) or credit limit minus outstanding bill (postpaid), rounded to two decimal points | M |
| `statusCode` / `statusDetail` | Outcome | M |

Notes:

- `chargeableBalance` is a **string** — parse as a decimal, never as a float you then compare
  for equality. Use a decimal type for money.
- A balance check is **advisory, not a reservation**. The balance can change between the query
  and the charge. Always handle `E1326` on the charging path regardless of what the query said.

---

## Charging Notification (inbound)

Configured during provisioning as the **charging notification URL**. There is nothing to call:
the platform posts a report automatically once a charging transaction completes.

### Payload

```json
{
  "timeStamp": "15-Nov-2023 11:55",
  "TotalAmount": "5.00",
  "externalTrxId": "256091234",
  "balanceDue": "0",
  "statusDetail": "Request was Successfully processed, Due amount fully paid.",
  "currency": "BDT",
  "version": "1.0",
  "internalTrxId": "9111511550014764",
  "paidAmount": "5.00",
  "referenceId": "8801422222550170004932307900016",
  "statusCode": "S1000"
}
```

| Field | Meaning |
|---|---|
| `timeStamp` | Time the request was sent. The sample format `15-Nov-2023 11:55` matches nothing else in the API — parse defensively |
| `TotalAmount` | Amount deducted as the one-time charge. **Capital `T`** |
| `externalTrxId` | Your transaction ID. This is how you match the notification to your ledger row |
| `balanceDue` | Amount still due, `0` when nothing is outstanding |
| `statusDetail` | Detailed description of the status |
| `currency` | `BDT` |
| `version` | API version |
| `internalTrxId` | Identifier used to track the request at your end |
| `paidAmount` | What the subscriber actually paid |
| `referenceId` | The platform's reference for the transaction |
| `statusCode` | `P` partial / `E` error / `S` success |

Respond `{"statusCode":"S1000","statusDetail":"Success"}` promptly, as with every callback.

This is your **reconciliation channel**:

- Use it to resolve every charge your code left in `UNKNOWN` after a timeout.
- Match on `externalTrxId` — the key you generated and persisted before step 1.
- Deduplicate on `externalTrxId` + `statusCode`. A repeat notification for an already-charged
  transaction must not double-count revenue.
- **Compare `paidAmount` and `balanceDue` against your ledger before treating an order as
  fulfilled.** A partial payment with a non-zero `balanceDue` is a real outcome, and the
  `statusCode` prefix `P` exists precisely for it.

See [07-callbacks.md](07-callbacks.md).

---

## Operational limits

- **Per-second (`E1318`) and per-day (`E1319`) transaction limits are fixed** per agreement.
  Queue and throttle on your side; do not fire charges in an unbounded loop.
- **Charging cannot happen inside a USSD session.** The subscriber has to receive an SMS and
  type a code back. Acknowledge with `mt-fin`, charge asynchronously, and SMS the result.
- **Recurring charging is a subscription property**, configured through the subscription's
  frequency (`daily` / `weekly` / `monthly` / `yearly` — see the subscriber notification).
  Do not simulate a recurring charge with a cron job hitting the one-time charging flow.

---

## Money-handling checklist for the charging path

- [ ] Amounts use a decimal type, never a binary float
- [ ] `externalTrxId` persisted **before** the OTP-generation call
- [ ] `requestCorrelator` persisted from the generation response
- [ ] `P1003` treated as pending, never as charged
- [ ] Verification failures never trigger a fresh OTP generation
- [ ] `E1337` resolved through the notification, never with a new `externalTrxId`
- [ ] Timeouts resolved via reconciliation, not by re-charging
- [ ] `internalTrxId` stored for support
- [ ] `paidAmount` and `balanceDue` compared against the ledger before fulfilment
- [ ] Every charge traceable to a logged user action and consent record
- [ ] Amount and currency come from server-side config or a server-side price lookup — **never
      from client input**
- [ ] The OTP and `referenceNo` never reach a log
