<!-- Generated from catalog/applink-api.json by scripts/build-curl-reference.mjs. Do not edit directly. -->

# Every Endpoint as curl

The whole Applink contract at the wire: each endpoint, each parameter defined, a request you
can run, and the response it returns. No SDK, no generated code, no tooling of any kind between
you and the platform.

**Write the integration from this page, in whatever language the project already uses.** There
is deliberately no code generator in this skill: a generator would privilege a handful of
languages and rot as their idioms move, while the request below is the same call in all of
them. The body, the headers and the branching are identical whether it goes out through
`requests` in Python, `HttpClient` in Java or .NET, `net/http` in Go, Guzzle in PHP,
`Net::HTTP` in Ruby, `reqwest` in Rust, `HTTPoison` in Elixir or `fetch` in Node. Translate the
curl into the project's own HTTP client and idiom; keep everything else exactly as specified.

Run these against a real application to confirm provisioning and credentials before writing a
line of code — a working curl removes half the possible causes when the integration then fails.

---

## The shape of every call

```
POST  https://api.applink.com.bd/<service-path>
Content-Type: application/json;charset=utf-8
```

- **Credentials travel in the JSON body**, as `applicationId` and `password`. There are no
  headers, no tokens, no signatures and no OAuth on this platform.
- **Every value is a JSON string** — amount, action, version, encoding, deliveryStatusRequest, otp, sessionId and every identifier included. destinationAddresses and subscriberIds are arrays of strings; applicationMetaData is an object of strings. Never send a number, a boolean or null, and omit an optional field rather than sending it empty.
- **Send exactly the parameters listed for that endpoint** — no more, no fewer, spelt exactly as
  shown. version is a parameter of SMS Send and USSD Send only. The subscription, OTP and CaaS requests do not carry it — follow each endpoint's parameter list, not a shared template.
- **Every response is HTTP 200**, including failures. Applink returns HTTP 200 for application-level failures. Branch on statusCode, never on the HTTP status alone. S1000 is success; P1003 on CaaS OTP generation means the OTP was dispatched and the charge is not complete yet.
- Every response carries `statusCode` and `statusDetail`; most also carry
  `version` and `requestId`.
- Subscriber addresses are always `tel:<msisdn>`, with no spaces. Send
  `tel:8801959979376` — the form the subscription, OTP and CaaS samples use. The published SMS
  samples write the same address with a `+`; both forms appear in the platform's own
  documentation, so normalise to one in a single helper.
- A masked application receives an opaque value instead of a number. Do not parse it — send back
  exactly what you received.
- **Charging takes two calls.** CaaS OTP Generation returns `P1003` and sends the subscriber an
  OTP; the money moves at CaaS OTP Verification, and the outcome is settled by the charging
  notification callback.

### Getting the body exactly right

Field names are case-sensitive and differ between endpoints on purpose: Currency (CaaS OTP Generation) vs currency (Query Balance), destinationAddresses (SMS, array) vs destinationAddress (USSD, string), subscriberIds (charging info, array) vs subscriberId (everything else), and sourceAddress for the subscriber on CaaS OTP Verification.

| Send | Never |
|---|---|
| `"action": "1"` | `"action": 1` |
| `"amount": "5.00"` | `"amount": 5` |
| `"version": "1.0"` | `"version": 1` |
| `"encoding": "440"` | `"encoding": 440` |
| `"referenceNo": "8801442233146169943053700500040"` | `"referenceNo": 8.80144223314617e+30` |
| `"destinationAddresses": ["tel:8801959979376"]` | `"destinationAddresses": "tel:8801959979376"` |

In code, build the body as a map or object of strings and let the JSON library serialise it;
never assemble JSON by string concatenation. `node tools/applink.mjs validate <id> '<json>'`
catches every mistake in the table above, and names the field an endpoint expects when you send
one that belongs to another.

### Reading the response

- Decide the outcome from statusCode alone, against the outcome that endpoint is expected to return — S1000 for most, P1003 for CaaS OTP Generation.
- When statusCode is anything else, rely on statusCode and statusDetail only. The endpoint's own fields (requestCorrelator, referenceNo, baseSize, destinationResponses, subscriptionStatus …) may be absent from a failure.
- Every response value is a string, numbers included (baseSize, chargeableBalance, amounts). Parse at the boundary — an integer for baseSize, a decimal type for money — and accept a bare number too, so a platform-side change cannot break the parser.
- Read every field other than statusCode with a default, and ignore fields you do not recognise rather than failing on them.

Each endpoint below spells out its expected `statusCode`, what to read and persist from the
body, and the next step. `node tools/applink.mjs response <id> '<body>'` checks a real response
against the same rules.

## Before you run anything

Export your credentials and the endpoints your application is provisioned for. Every command on
this page reads them from the environment, so nothing here contains a credential and nothing you
copy can commit one.

```bash
export APPLINK_APP_ID='APP_XXXXXX'
export APPLINK_PASSWORD='…'                 # from the portal — never commit it
export APPLINK_SMS_SEND_URL='https://api.applink.com.bd/sms/send'
export APPLINK_USSD_SEND_URL='https://api.applink.com.bd/ussd/send'
export APPLINK_SUBSCRIPTION_SEND_URL='https://api.applink.com.bd/subscription/send'
export APPLINK_SUBSCRIPTION_QUERY_BASE_URL='https://api.applink.com.bd/subscription/query-base'
export APPLINK_SUBSCRIPTION_CHARGING_INFO_URL='https://api.applink.com.bd/subscription/getSubscriberChargingInfo'
export APPLINK_OTP_REQUEST_URL='https://api.applink.com.bd/otp/request'
export APPLINK_OTP_VERIFY_URL='https://api.applink.com.bd/otp/verify'
export APPLINK_CAAS_DEBIT_URL='https://api.applink.com.bd/caas/direct/debit'
export APPLINK_CAAS_OTP_VERIFY_URL='https://api.applink.com.bd/caas/otp/verify'
export APPLINK_CAAS_BALANCE_URL='https://api.applink.com.bd/caas/get/balance'

: "${APPLINK_APP_ID:?not set}" "${APPLINK_PASSWORD:?not set}"   # fail here, not as E1313
```

One variable per provisioned service, never one shared base URL: an application can only call
the APIs it was provisioned for, so an endpoint you have no variable for is one you must not
call.

The requests below splice the password into JSON text. If it contains a `"` or a `\`, build
the body with `jq` instead so it is escaped:

```bash
jq -n --arg id "$APPLINK_APP_ID" --arg pw "$APPLINK_PASSWORD" '{applicationId: $id, password: $pw}' |
  curl -sS -X POST "$APPLINK_SUBSCRIPTION_QUERY_BASE_URL" \
    -H 'Content-Type: application/json;charset=utf-8' --max-time 15 -d @-
```

Windows PowerShell, where `curl` is an alias for `Invoke-WebRequest` and the syntax differs:

```powershell
$body = @{ applicationId = $env:APPLINK_APP_ID; password = $env:APPLINK_PASSWORD } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri $env:APPLINK_SUBSCRIPTION_QUERY_BASE_URL `
  -ContentType 'application/json;charset=utf-8' -Body $body
```

Three flags in every request below, all deliberate: `-sS` prints errors but not a progress bar,
`--max-time 15` stops a hung call holding a request thread, and `-d @- <<REQUEST` reads the body
from a heredoc so the credential variables expand and the JSON stays readable.

**Start with Base Size.** It needs no subscriber, costs nothing and touches no one, so it is
the safest way to prove that your credentials, your provisioning and your egress IP all work.

---

## Endpoint index

| Service | Endpoint | Environment variable |
|---|---|---|
| [SMS Send](#sms-send) | `POST https://api.applink.com.bd/sms/send` | `APPLINK_SMS_SEND_URL` |
| [USSD Send](#ussd-send) | `POST https://api.applink.com.bd/ussd/send` | `APPLINK_USSD_SEND_URL` |
| [Subscription Register](#subscription-register) | `POST https://api.applink.com.bd/subscription/send` | `APPLINK_SUBSCRIPTION_SEND_URL` |
| [Subscription Unregister](#subscription-unregister) | `POST https://api.applink.com.bd/subscription/send` | `APPLINK_SUBSCRIPTION_SEND_URL` |
| [Base Size](#base-size) | `POST https://api.applink.com.bd/subscription/query-base` | `APPLINK_SUBSCRIPTION_QUERY_BASE_URL` |
| [Get Subscriber Charging Info](#get-subscriber-charging-info) | `POST https://api.applink.com.bd/subscription/getSubscriberChargingInfo` | `APPLINK_SUBSCRIPTION_CHARGING_INFO_URL` |
| [Request OTP](#request-otp) | `POST https://api.applink.com.bd/otp/request` | `APPLINK_OTP_REQUEST_URL` |
| [Verify OTP](#verify-otp) | `POST https://api.applink.com.bd/otp/verify` | `APPLINK_OTP_VERIFY_URL` |
| [CaaS OTP Generation](#caas-otp-generation) | `POST https://api.applink.com.bd/caas/direct/debit` | `APPLINK_CAAS_DEBIT_URL` |
| [CaaS OTP Verification](#caas-otp-verification) | `POST https://api.applink.com.bd/caas/otp/verify` | `APPLINK_CAAS_OTP_VERIFY_URL` |
| [Query Balance](#query-balance) | `POST https://api.applink.com.bd/caas/get/balance` | `APPLINK_CAAS_BALANCE_URL` |

| Callback | Applink calls | Configured in |
|---|---|---|
| [SMS Receive (MO)](#sms-receive-mo) | `POST <your-host>/api/applink/sms/receive` | SMS API settings — the MO / receive URL |
| [SMS Delivery Status Report](#sms-delivery-status-report) | `POST <your-host>/api/applink/sms/report` | SMS API settings — the delivery report URL |
| [USSD Receive](#ussd-receive) | `POST <your-host>/api/applink/ussd/receive` | USSD API settings — the receive URL |
| [Subscriber Notification](#subscriber-notification) | `POST <your-host>/api/applink/subscription/notify` | Subscription API settings — the notification URL |
| [Charging Notification](#charging-notification) | `POST <your-host>/api/applink/caas/charging-notification` | CaaS API settings — the charging notification URL |

---

# Outbound services — you call Applink

---

## SMS Send

Send an MT (Mobile Terminated) SMS to one or more subscribers.

| | |
|---|---|
| **Endpoint** | `POST https://api.applink.com.bd/sms/send` |
| **Environment variable** | `APPLINK_SMS_SEND_URL` |
| **Content type** | `application/json;charset=utf-8` |
| **Full guide** | [02-sms.md](02-sms.md) |

### Request parameters

| Parameter | Type | | Definition |
|---|---|---|---|
| `version` | string | **Required** | API version, numbered 1.0, 2.0 and so on. If specified in the request the same version is returned in the response; if omitted the latest version is used. |
| `applicationId` | string | **Required** | Identifies the application. Unique identifier generated when the application is provisioned. Only a single value per request. |
| `password` | string | **Required** | The API key sent to your registered email address when the application was approved. |
| `message` | string | **Required** | Content of the message to send. Messages over the limit are broken up by the platform before sending. |
| `destinationAddresses` | string[] | **Required** | Array of tel:-prefixed destination addresses. Always an array, even for one recipient. tel:all sends to the subscribed base of the application. May be a masked value depending on the application type. |
| `sourceAddress` | string | Optional | Address the message appears to come from — a provisioned alias such as a shortcode, or a tel:-prefixed address. |
| `deliveryStatusRequest` | string (enum) | Optional | 0 = delivery report not required, 1 = delivery report required. A delivery report arrives at your SMS report callback URL. One of `"0"`, `"1"`. |
| `encoding` | string (enum) | Optional | Encoding scheme used in the message. 0 = Text, 240 = Flash SMS, 245 = Binary. Defaults to Text. With Binary the message content must be hex encoded. One of `"0"`, `"240"`, `"245"`. |
| `binaryHeader` | string | Optional | Hex-encoded binary header, for advanced message types where the header is supplied by the application. Only meaningful with encoding 245. |

### Request

```bash
curl -sS -X POST "$APPLINK_SMS_SEND_URL" \
  -H 'Content-Type: application/json;charset=utf-8' \
  --max-time 15 \
  -d @- <<REQUEST
{
  "applicationId": "$APPLINK_APP_ID",
  "password": "$APPLINK_PASSWORD",
  "version": "1.0",
  "message": "Hello",
  "destinationAddresses": [
    "tel:8801959979376"
  ],
  "encoding": "0"
}
REQUEST
```

Optional, and left out above because the value is yours to supply:

- `sourceAddress`: must be an alias provisioned on your application — any other value is E1331 — published sample `"77000"`
- `deliveryStatusRequest`: set "1" only once your SMS delivery-report callback URL is configured — published sample `"1"`

Fields that do not belong in this body:

- ✗ `destinationAddress` — SMS Send takes destinationAddresses — plural, and always an array. The singular string form belongs to USSD Send.
- ✗ `to` — The recipients go in destinationAddresses, an array of tel: addresses.
- ✗ `text` — The message body goes in message.

### Response

HTTP 200. The expected outcome is `statusCode: "S1000"`.

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

### Response fields

| Field | Type | Meaning |
|---|---|---|
| `version` | string | API version echoed from the request. |
| `requestId` | string | Uniquely identifies this request within the platform. Persist it — support traces on it, and delivery reports carry it. |
| `destinationResponses` | object[] | One entry per address in the request. A multi-recipient send can partially succeed, so branch on each entry's statusCode, not only the top-level one. |
| `statusCode` | string | The status code for the entire request. S1000 on success. |
| `statusDetail` | string | Description of the status for the entire request. |

### Handling the response

1. **Decide from `statusCode`**, never from the HTTP status. Expected: `S1000`. The platform accepted the send. Delivery is a separate event, reported on the delivery-status callback if you asked for one.
2. **On `S1000`, read** `requestId`, `destinationResponses` — present on the expected outcome; read them with a default anyway.
3. **Persist** requestId — delivery reports and support trace on it; destinationResponses[].messageId per recipient.
4. **Then:** Branch on every destinationResponses entry's statusCode as well: a top-level S1000 with a failed entry is a partial send, and only that recipient should be retried or dropped.
5. **Any other `statusCode`:** rely on `statusCode` and `statusDetail` only — the fields above may be absent — and handle it by class from the table below.

### Status codes for this endpoint

| Code | Class | Meaning |
|---|---|---|
| `S1000` | success | Process completed successfully for all the available destination numbers. |
| `E1303` | configuration | The IP address this request originated from is not provisioned to send requests to the application. Use a provisioned system, or ask the administrator to provision the new IP. → Find the real egress IP by running curl -4 https://api.ipify.org on the calling server, then add it to the application's allowed host addresses in the portal. |
| `E1308` | client | Permanent charging error — the platform supplies the reason, for example insufficient balance. → Permanent for this attempt. Do not blind-retry; read statusDetail, tell the subscriber, and settle the ledger row from the charging notification. |
| `E1309` | configuration | The requested service is not allowed for this application. → That API was not provisioned for this application. A portal fix, not a code fix. |
| `E1311` | configuration | Mobile terminated SMS messages are not enabled. Check the NCS configuration in provisioning. |
| `E1312` | client | The request is invalid — typically a missing mandatory field or a malformed value. → Compare the payload against the parameter table for that endpoint. `applink validate <id> '<json>'` catches most causes. |
| `E1313` | configuration | Authentication failed. There is no active application with that applicationId, no active service provider, or the password in the request is invalid. → Check APPLINK_APP_ID and APPLINK_PASSWORD, and that the application is active in the portal. |
| `E1315` | configuration | Cannot find the requested service, or it is not active. |
| `E1317` | user-state | The MSISDN in the request is invalid or not allowed. → Validate the number before sending. Do not retry the same value. |
| `E1318` | transient | The transaction limit per second has been exceeded. Throttle requests, or ask the administrator to raise the traffic limit. → Add a client-side rate limiter. Backoff will clear it; more concurrency will not. |
| `E1319` | transient | The transaction limit for today has been exceeded. Try again tomorrow, or ask the administrator to raise the per-day limit. → Retrying today will not help. Queue the work and alert — this is a capacity problem, not a request problem. |
| `E1325` | client | The format of the address is invalid. The expected format is a tel:-prefixed MSISDN. → A missing tel: prefix, or a stray space. Normalise every address through one helper. |
| `E1331` | configuration | The source address is not allowed. Use one of the values configured in the alias configuration in the SLAs, or send the request without a sourceAddress so the platform uses the default sender address. → sourceAddress must be a provisioned alias, or omitted entirely. |
| `E1334` | client | The message could not be processed because its length is too long. The platform supplies the maximum. → Shorten or split the message. Bangla text is UCS-2, so the per-part budget is 70 characters, not 160. |
| `E1335` | client | The message could not be processed because the advertisement message length is too long. The platform supplies the maximum. |
| `E1341` | transient | The request failed. Errors occurred while sending the request for all the destinations. |
| `E1342` | user-state | The MSISDN is blacklisted and is not authorised to use this application. → Stop messaging this subscriber. Nothing in your code will change the outcome. |
| `E1343` | user-state | The MSISDN is not whitelisted. Only whitelisted numbers are allowed to send messages at this stage. → While the application is in Limited Production only numbers on the whitelist can use it. Add the test number in the portal. |
| `E1601` | transient | The system experienced an unexpected error. |
| `E1603` | transient | A temporary system error occurred while delivering your request. |

`configuration` fix the portal, not the code — the integration is down, not one request · `client` fix the payload or the user's input · `user-state` the user is not eligible right now; tell them, do not loop · `transient` retry with capped exponential backoff. Full table: [08-status-codes.md](08-status-codes.md).

### Rules

- destinationAddresses is always an array, even for a single recipient.
- Guard tel:all behind a deliberate, separately-authorised code path, and check the base size first.
- sourceAddress must be a provisioned alias — an arbitrary value fails with E1331.
- Only set deliveryStatusRequest to 1 if you consume the SMS report callback.
- Keep under 160 GSM-7 characters for a single part. Bangla text is UCS-2, so budget 70 characters per part; the platform splits longer messages and each part is charged.
- The published sample writes the destination as tel:+8801959979376. Send tel:8801959979376 for consistency with every other Applink API, and normalise in one helper.

---

## USSD Send

Send a USSD screen to a handset inside an open session.

| | |
|---|---|
| **Endpoint** | `POST https://api.applink.com.bd/ussd/send` |
| **Environment variable** | `APPLINK_USSD_SEND_URL` |
| **Content type** | `application/json;charset=utf-8` |
| **Full guide** | [03-ussd.md](03-ussd.md) |

### Request parameters

| Parameter | Type | | Definition |
|---|---|---|---|
| `version` | string | **Required** | API version, numbered 1.0, 2.0 and so on. If specified in the request the same version is returned in the response. |
| `applicationId` | string | **Required** | Identifies the application. Unique identifier generated when the application is provisioned. Only a single value per request. |
| `password` | string | **Required** | The API key sent to your registered email address when the application was approved. |
| `message` | string | **Required** | Content of the message sent by the application — the screen text the subscriber sees. |
| `sessionId` | string | **Required** | Unique number the USSD gateway assigns to the application for the duration of the session. It is maintained across every message in a single session — echo the one you were given, never generate your own. |
| `ussdOperation` | string (enum) | **Required** | USSD operation. The application assigns mt-init when it initiates a session, mt-cont for any message that follows an init, and mt-fin when the session ends on a final message. mo-init and mo-cont are assigned by the platform on inbound messages. One of `"mo-init"`, `"mo-cont"`, `"mt-init"`, `"mt-cont"`, `"mt-fin"`. |
| `destinationAddress` | string | **Required** | Destination address — a tel:-prefixed telephone number, which may be a masked value depending on the application type. |
| `encoding` | string (enum) | Optional | Encoding scheme used in the message. 440 = plain ASCII characters. One of `"440"`. |

### Request

```bash
curl -sS -X POST "$APPLINK_USSD_SEND_URL" \
  -H 'Content-Type: application/json;charset=utf-8' \
  --max-time 15 \
  -d @- <<REQUEST
{
  "applicationId": "$APPLINK_APP_ID",
  "password": "$APPLINK_PASSWORD",
  "version": "1.0",
  "message": "1. Press One\n2. Press two\n3. Press three\n4. Exit",
  "sessionId": "1330929317043",
  "ussdOperation": "mt-cont",
  "destinationAddress": "tel:8801959979376",
  "encoding": "440"
}
REQUEST
```

Fields that do not belong in this body:

- ✗ `destinationAddresses` — USSD Send takes destinationAddress — one tel: address as a string. The plural array form belongs to SMS Send.
- ✗ `operation` — The field is ussdOperation.
- ✗ `sourceAddress` — Address the screen to the subscriber with destinationAddress — the sourceAddress you received on the USSD receive callback, sent back unchanged.

### Response

HTTP 200. The expected outcome is `statusCode: "S1000"`.

```json
{
  "version": "1.0",
  "requestId": "101901031657410007",
  "timeStamp": "20190103165801",
  "statusCode": "S1000",
  "statusDetail": "Success."
}
```

### Response fields

| Field | Type | Meaning |
|---|---|---|
| `version` | string | API version echoed from the request. |
| `requestId` | string | Uniquely identifies this request within the platform. |
| `timeStamp` | string | Processed timestamp. |
| `statusCode` | string | The status code for the entire request. S1000 on success. |
| `statusDetail` | string | Description of the status for the entire request. |

### Handling the response

1. **Decide from `statusCode`**, never from the HTTP status. Expected: `S1000`. The screen was handed to the USSD gateway for this session.
2. **Persist** requestId — for the log line, alongside sessionId.
3. **Then:** After mt-cont, the subscriber's reply arrives on the USSD receive callback as mo-cont. After mt-fin the session is over and nothing more arrives.
4. **Any other `statusCode`:** rely on `statusCode` and `statusDetail` only — the fields above may be absent — and handle it by class from the table below.

### Status codes for this endpoint

| Code | Class | Meaning |
|---|---|---|
| `S1000` | success | Process completed successfully for all the available destination numbers. |
| `E1303` | configuration | The IP address this request originated from is not provisioned to send requests to the application. Use a provisioned system, or ask the administrator to provision the new IP. → Find the real egress IP by running curl -4 https://api.ipify.org on the calling server, then add it to the application's allowed host addresses in the portal. |
| `E1308` | client | Permanent charging error — the platform supplies the reason, for example insufficient balance. → Permanent for this attempt. Do not blind-retry; read statusDetail, tell the subscriber, and settle the ledger row from the charging notification. |
| `E1309` | configuration | The requested service is not allowed for this application. → That API was not provisioned for this application. A portal fix, not a code fix. |
| `E1312` | client | The request is invalid — typically a missing mandatory field or a malformed value. → Compare the payload against the parameter table for that endpoint. `applink validate <id> '<json>'` catches most causes. |
| `E1313` | configuration | Authentication failed. There is no active application with that applicationId, no active service provider, or the password in the request is invalid. → Check APPLINK_APP_ID and APPLINK_PASSWORD, and that the application is active in the portal. |
| `E1315` | configuration | Cannot find the requested service, or it is not active. |
| `E1317` | user-state | The MSISDN in the request is invalid or not allowed. → Validate the number before sending. Do not retry the same value. |
| `E1318` | transient | The transaction limit per second has been exceeded. Throttle requests, or ask the administrator to raise the traffic limit. → Add a client-side rate limiter. Backoff will clear it; more concurrency will not. |
| `E1319` | transient | The transaction limit for today has been exceeded. Try again tomorrow, or ask the administrator to raise the per-day limit. → Retrying today will not help. Queue the work and alert — this is a capacity problem, not a request problem. |
| `E1325` | client | The format of the address is invalid. The expected format is a tel:-prefixed MSISDN. → A missing tel: prefix, or a stray space. Normalise every address through one helper. |
| `E1334` | client | The message could not be processed because its length is too long. The platform supplies the maximum. → Shorten or split the message. Bangla text is UCS-2, so the per-part budget is 70 characters, not 160. |
| `E1341` | transient | The request failed. Errors occurred while sending the request for all the destinations. |
| `E1342` | user-state | The MSISDN is blacklisted and is not authorised to use this application. → Stop messaging this subscriber. Nothing in your code will change the outcome. |
| `E1343` | user-state | The MSISDN is not whitelisted. Only whitelisted numbers are allowed to send messages at this stage. → While the application is in Limited Production only numbers on the whitelist can use it. Add the test number in the portal. |
| `E1601` | transient | The system experienced an unexpected error. |
| `E1603` | transient | A temporary system error occurred while delivering your request. |

`configuration` fix the portal, not the code — the integration is down, not one request · `client` fix the payload or the user's input · `user-state` the user is not eligible right now; tell them, do not loop · `transient` retry with capped exponential backoff. Full table: [08-status-codes.md](08-status-codes.md).

### Rules

- Echo the sessionId the platform sent you. A sessionId you invented orphans the session and the subscriber sees nothing.
- End terminal screens with mt-fin. Continuing to send mt-cont leaves the session hanging until the network times it out.
- Screens are plain ASCII (encoding 440) — no emoji, no Bangla script, no smart quotes. Sanitise generated text before sending.
- Keep each screen under about 160 characters and the tree two or three levels deep. Sessions time out in seconds.
- Never charge inline inside a USSD session. Acknowledge with mt-fin, charge asynchronously, and SMS the result.

---

## Subscription Register

Opt a subscriber in to the application. Same endpoint as unregister, with action "1".

| | |
|---|---|
| **Endpoint** | `POST https://api.applink.com.bd/subscription/send` |
| **Environment variable** | `APPLINK_SUBSCRIPTION_SEND_URL` |
| **Content type** | `application/json;charset=utf-8` |
| **Full guide** | [04-subscription.md](04-subscription.md) |

### Request parameters

| Parameter | Type | | Definition |
|---|---|---|---|
| `applicationId` | string | **Required** | Identifies the application. Unique identifier generated when the application is provisioned. Only a single value per request. |
| `password` | string | **Required** | The API key sent to your registered email address when the application was approved. |
| `subscriberId` | string | **Required** | The subscriber's tel:-prefixed MSISDN, a unique identifier. May be a masked value depending on the application type. Only a single value per request. |
| `action` | string (enum) | **Required** | 0 = user unsubscription, 1 = user subscription. Sent as a string. One of `"0"`, `"1"`. |

### Request

```bash
curl -sS -X POST "$APPLINK_SUBSCRIPTION_SEND_URL" \
  -H 'Content-Type: application/json;charset=utf-8' \
  --max-time 15 \
  -d @- <<REQUEST
{
  "applicationId": "$APPLINK_APP_ID",
  "password": "$APPLINK_PASSWORD",
  "subscriberId": "tel:8801959979376",
  "action": "1"
}
REQUEST
```

Fields that do not belong in this body:

- ✗ `subscriberIds` — Register takes one subscriber, as subscriberId — a single tel: string, not an array.
- ✗ `msisdn` — The subscriber goes in subscriberId, as tel:880….

### Response

HTTP 200. The expected outcome is `statusCode: "S1000"`.

```json
{
  "version": "1.0",
  "statusCode": "S1000",
  "statusDetail": "Success.",
  "subscriptionStatus": "REGISTERED"
}
```

### Response fields

| Field | Type | Meaning |
|---|---|---|
| `version` | string | API version. |
| `statusCode` | string | The status code for the entire request. |
| `statusDetail` | string | Description of the status for the entire request. |
| `subscriptionStatus` | string | Resulting subscription state, for example REGISTERED or UNREGISTERED. This — not an error code — is how you confirm the outcome, so read it on every response. |

### Handling the response

1. **Decide from `statusCode`**, never from the HTTP status. Expected: `S1000`. The request was processed. Whether the subscriber is now opted in is in subscriptionStatus, not in statusCode.
2. **On `S1000`, read** `subscriptionStatus` — present on the expected outcome; read them with a default anyway.
3. **Persist** subscriptionStatus, with the consent record that authorised the call.
4. **Then:** Compare subscriptionStatus by prefix, trimmed and upper-cased — the published samples carry a trailing dot. REGISTERED means opted in, including on a repeat call. Any other value, such as REG_PENDING or INITIAL, is not active yet: do not deliver the service until the subscriber notification reports REGISTERED.
5. **Any other `statusCode`:** rely on `statusCode` and `statusDetail` only — the fields above may be absent — and handle it by class from the table below.

### Status codes for this endpoint

| Code | Class | Meaning |
|---|---|---|
| `S1000` | success | Process completed successfully for all the available destination numbers. |
| `E1303` | configuration | The IP address this request originated from is not provisioned to send requests to the application. Use a provisioned system, or ask the administrator to provision the new IP. → Find the real egress IP by running curl -4 https://api.ipify.org on the calling server, then add it to the application's allowed host addresses in the portal. |
| `E1312` | client | The request is invalid — typically a missing mandatory field or a malformed value. → Compare the payload against the parameter table for that endpoint. `applink validate <id> '<json>'` catches most causes. |
| `E1313` | configuration | Authentication failed. There is no active application with that applicationId, no active service provider, or the password in the request is invalid. → Check APPLINK_APP_ID and APPLINK_PASSWORD, and that the application is active in the portal. |
| `E1317` | user-state | The MSISDN in the request is invalid or not allowed. → Validate the number before sending. Do not retry the same value. |
| `E1325` | client | The format of the address is invalid. The expected format is a tel:-prefixed MSISDN. → A missing tel: prefix, or a stray space. Normalise every address through one helper. |
| `E1601` | transient | The system experienced an unexpected error. |
| `E1603` | transient | A temporary system error occurred while delivering your request. |

`configuration` fix the portal, not the code — the integration is down, not one request · `client` fix the payload or the user's input · `user-state` the user is not eligible right now; tell them, do not loop · `transient` retry with capped exponential backoff. Full table: [08-status-codes.md](08-status-codes.md).

### Rules

- Capture explicit consent before every register, and store who consented, when, through which channel, and the exact wording shown.
- Disclose the amount, currency and frequency before subscribing anyone.
- Applink publishes no 'already registered' benign code. Make register idempotent by reading subscriptionStatus in the response instead of special-casing an error code — a repeat register that comes back REGISTERED is the state you wanted.
- Mirror subscription state in your own database from the subscription notification callback rather than re-querying per request.

---

## Subscription Unregister

Opt a subscriber out of the application. Same endpoint as register, with action "0".

| | |
|---|---|
| **Endpoint** | `POST https://api.applink.com.bd/subscription/send` |
| **Environment variable** | `APPLINK_SUBSCRIPTION_SEND_URL` |
| **Content type** | `application/json;charset=utf-8` |
| **Full guide** | [04-subscription.md](04-subscription.md) |

### Request parameters

| Parameter | Type | | Definition |
|---|---|---|---|
| `applicationId` | string | **Required** | Identifies the application. Unique identifier generated when the application is provisioned. Only a single value per request. |
| `password` | string | **Required** | The API key sent to your registered email address when the application was approved. |
| `subscriberId` | string | **Required** | The subscriber's tel:-prefixed MSISDN, a unique identifier. May be a masked value depending on the application type. Only a single value per request. |
| `action` | string (enum) | **Required** | 0 = user unsubscription, 1 = user subscription. Sent as a string. One of `"0"`, `"1"`. |

### Request

```bash
curl -sS -X POST "$APPLINK_SUBSCRIPTION_SEND_URL" \
  -H 'Content-Type: application/json;charset=utf-8' \
  --max-time 15 \
  -d @- <<REQUEST
{
  "applicationId": "$APPLINK_APP_ID",
  "password": "$APPLINK_PASSWORD",
  "subscriberId": "tel:8801959979376",
  "action": "0"
}
REQUEST
```

Fields that do not belong in this body:

- ✗ `subscriberIds` — Unregister takes one subscriber, as subscriberId — a single tel: string, not an array.
- ✗ `msisdn` — The subscriber goes in subscriberId, as tel:880….

### Response

HTTP 200. The expected outcome is `statusCode: "S1000"`.

```json
{
  "version": "1.0",
  "statusCode": "S1000",
  "statusDetail": "not registered",
  "subscriptionStatus": "UNREGISTERED."
}
```

### Response fields

| Field | Type | Meaning |
|---|---|---|
| `version` | string | API version. |
| `statusCode` | string | The status code for the entire request. |
| `statusDetail` | string | Description of the status for the entire request. The documented sample carries "not registered" alongside S1000 — success here means the request was processed, not that a change occurred. |
| `subscriptionStatus` | string | Resulting subscription state, for example UNREGISTERED. Read it to confirm the outcome. |

### Handling the response

1. **Decide from `statusCode`**, never from the HTTP status. Expected: `S1000`. The request was processed. Whether the subscriber is now opted out is in subscriptionStatus, not in statusCode or statusDetail.
2. **On `S1000`, read** `subscriptionStatus` — present on the expected outcome; read them with a default anyway.
3. **Persist** subscriptionStatus, and cancel anything queued for this subscriber.
4. **Then:** Compare subscriptionStatus by prefix, trimmed and upper-cased — the published sample is "UNREGISTERED." with a trailing dot. UNREGISTERED is the desired state whether or not the subscriber was registered before, so statusDetail "not registered" alongside it is still success.
5. **Any other `statusCode`:** rely on `statusCode` and `statusDetail` only — the fields above may be absent — and handle it by class from the table below.

### Status codes for this endpoint

| Code | Class | Meaning |
|---|---|---|
| `S1000` | success | Process completed successfully for all the available destination numbers. |
| `E1303` | configuration | The IP address this request originated from is not provisioned to send requests to the application. Use a provisioned system, or ask the administrator to provision the new IP. → Find the real egress IP by running curl -4 https://api.ipify.org on the calling server, then add it to the application's allowed host addresses in the portal. |
| `E1312` | client | The request is invalid — typically a missing mandatory field or a malformed value. → Compare the payload against the parameter table for that endpoint. `applink validate <id> '<json>'` catches most causes. |
| `E1313` | configuration | Authentication failed. There is no active application with that applicationId, no active service provider, or the password in the request is invalid. → Check APPLINK_APP_ID and APPLINK_PASSWORD, and that the application is active in the portal. |
| `E1317` | user-state | The MSISDN in the request is invalid or not allowed. → Validate the number before sending. Do not retry the same value. |
| `E1325` | client | The format of the address is invalid. The expected format is a tel:-prefixed MSISDN. → A missing tel: prefix, or a stray space. Normalise every address through one helper. |
| `E1601` | transient | The system experienced an unexpected error. |
| `E1603` | transient | A temporary system error occurred while delivering your request. |

`configuration` fix the portal, not the code — the integration is down, not one request · `client` fix the payload or the user's input · `user-state` the user is not eligible right now; tell them, do not loop · `transient` retry with capped exponential backoff. Full table: [08-status-codes.md](08-status-codes.md).

### Rules

- Opting out must be as easy as opting in — offer it over MO SMS keywords (STOP, UNSUB, OFF), in a USSD menu option, and in-app.
- Honour an opt-out immediately, including cancelling messages already queued or scheduled for that subscriber.
- Unregistering someone who was never registered is not an error: the documented sample returns S1000 with subscriptionStatus UNREGISTERED. Treat reaching the desired state as success.
- Never re-subscribe a subscriber who opted out without a fresh, separately recorded opt-in.

---

## Base Size

Return the number of subscribers currently registered to the application.

| | |
|---|---|
| **Endpoint** | `POST https://api.applink.com.bd/subscription/query-base` |
| **Environment variable** | `APPLINK_SUBSCRIPTION_QUERY_BASE_URL` |
| **Content type** | `application/json;charset=utf-8` |
| **Full guide** | [04-subscription.md](04-subscription.md) |

### Request parameters

| Parameter | Type | | Definition |
|---|---|---|---|
| `applicationId` | string | **Required** | Identifies the application. Unique identifier generated when the application is provisioned. Only a single value per request. |
| `password` | string | **Required** | The API key sent to your registered email address when the application was approved. |

### Request

```bash
curl -sS -X POST "$APPLINK_SUBSCRIPTION_QUERY_BASE_URL" \
  -H 'Content-Type: application/json;charset=utf-8' \
  --max-time 15 \
  -d @- <<REQUEST
{
  "applicationId": "$APPLINK_APP_ID",
  "password": "$APPLINK_PASSWORD"
}
REQUEST
```

Fields that do not belong in this body:

- ✗ `subscriberId` — Base Size takes no subscriber. The body is only applicationId and password.

### Response

HTTP 200. The expected outcome is `statusCode: "S1000"`.

```json
{
  "baseSize": "0",
  "version": "1.0",
  "statusCode": "S1000",
  "statusDetail": "Success."
}
```

### Response fields

| Field | Type | Meaning |
|---|---|---|
| `baseSize` | string | Number of registered users. Arrives as a string — coerce it before arithmetic or charting. |
| `version` | string | API version. |
| `statusCode` | string | The status code for the entire request. |
| `statusDetail` | string | Description of the status for the entire request. |

### Handling the response

1. **Decide from `statusCode`**, never from the HTTP status. Expected: `S1000`. Credentials, provisioning and the egress IP all work, and baseSize is the current count of registered subscribers.
2. **On `S1000`, read** `baseSize` — present on the expected outcome; read them with a default anyway.
3. **Persist** baseSize, parsed to an integer, into your metrics store.
4. **Then:** Parse baseSize as an integer — it arrives as a string. A base of "0" is a valid answer for a new application, not an error.
5. **Any other `statusCode`:** rely on `statusCode` and `statusDetail` only — the fields above may be absent — and handle it by class from the table below.

### Status codes for this endpoint

| Code | Class | Meaning |
|---|---|---|
| `S1000` | success | Process completed successfully for all the available destination numbers. |
| `E1303` | configuration | The IP address this request originated from is not provisioned to send requests to the application. Use a provisioned system, or ask the administrator to provision the new IP. → Find the real egress IP by running curl -4 https://api.ipify.org on the calling server, then add it to the application's allowed host addresses in the portal. |
| `E1312` | client | The request is invalid — typically a missing mandatory field or a malformed value. → Compare the payload against the parameter table for that endpoint. `applink validate <id> '<json>'` catches most causes. |
| `E1313` | configuration | Authentication failed. There is no active application with that applicationId, no active service provider, or the password in the request is invalid. → Check APPLINK_APP_ID and APPLINK_PASSWORD, and that the application is active in the portal. |
| `E1601` | transient | The system experienced an unexpected error. |
| `E1603` | transient | A temporary system error occurred while delivering your request. |

`configuration` fix the portal, not the code — the integration is down, not one request · `client` fix the payload or the user's input · `user-state` the user is not eligible right now; tell them, do not loop · `transient` retry with capped exponential backoff. Full table: [08-status-codes.md](08-status-codes.md).

### Rules

- This is the cheapest call on the platform — no subscriber, no charge, no side effect. Use it as the connectivity, credential and IP-whitelist smoke test.
- baseSize is a string. Parse it.
- It is a point-in-time count for the whole application, not a per-operator or per-segment figure.
- Poll it on a schedule into your own metrics store rather than per page load, and sanity-check it before any tel:all broadcast.

---

## Get Subscriber Charging Info

Look up subscription status and last-charge details for up to ten subscribers in one request.

| | |
|---|---|
| **Endpoint** | `POST https://api.applink.com.bd/subscription/getSubscriberChargingInfo` |
| **Environment variable** | `APPLINK_SUBSCRIPTION_CHARGING_INFO_URL` |
| **Content type** | `application/json;charset=utf-8` |
| **Full guide** | [04-subscription.md](04-subscription.md) |

### Request parameters

| Parameter | Type | | Definition |
|---|---|---|---|
| `applicationId` | string | **Required** | Identifies the application. Unique identifier generated when the application is provisioned. Only a single value per request. |
| `password` | string | **Required** | The API key sent to your registered email address when the application was approved. |
| `subscriberIds` | string[] | **Required** | MSISDNs of the subscribers to look up, as tel:-prefixed values. If the application accepts masked numbers, the masked values go here. Maximum ten per request. |

### Request

```bash
curl -sS -X POST "$APPLINK_SUBSCRIPTION_CHARGING_INFO_URL" \
  -H 'Content-Type: application/json;charset=utf-8' \
  --max-time 15 \
  -d @- <<REQUEST
{
  "applicationId": "$APPLINK_APP_ID",
  "password": "$APPLINK_PASSWORD",
  "subscriberIds": [
    "tel:8801973579363"
  ]
}
REQUEST
```

Fields that do not belong in this body:

- ✗ `subscriberId` — Get Subscriber Charging Info takes subscriberIds — plural, an array of up to ten tel: addresses — even for one subscriber.

### Response

HTTP 200. The expected outcome is `statusCode: "S1000"`.

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

### Response fields

| Field | Type | Meaning |
|---|---|---|
| `version` | string | API version. |
| `destinationResponses` | object[] | One entry per subscriber in the request. Which fields are present depends on the subscription status — INITIAL and REG_PENDING omit the charge fields. |
| `statusCode` | string | The status code for the entire request. |
| `statusDetail` | string | Description of the status for the entire request. |

### Handling the response

1. **Decide from `statusCode`**, never from the HTTP status. Expected: `S1000`. The lookup ran. The answer for each subscriber is in its own destinationResponses entry.
2. **On `S1000`, read** `destinationResponses` — present on the expected outcome; read them with a default anyway.
3. **Persist** each entry's subscriptionStatus into your local mirror, keyed by subscriberId.
4. **Then:** Iterate destinationResponses and branch on each entry's statusCode. REGISTERED or TRIAL means the subscription is usable; INITIAL and REG_PENDING are not yet, and carry no lastCharged fields — read those with a default.
5. **Any other `statusCode`:** rely on `statusCode` and `statusDetail` only — the fields above may be absent — and handle it by class from the table below.

### Status codes for this endpoint

| Code | Class | Meaning |
|---|---|---|
| `S1000` | success | Process completed successfully for all the available destination numbers. |
| `E1303` | configuration | The IP address this request originated from is not provisioned to send requests to the application. Use a provisioned system, or ask the administrator to provision the new IP. → Find the real egress IP by running curl -4 https://api.ipify.org on the calling server, then add it to the application's allowed host addresses in the portal. |
| `E1312` | client | The request is invalid — typically a missing mandatory field or a malformed value. → Compare the payload against the parameter table for that endpoint. `applink validate <id> '<json>'` catches most causes. |
| `E1313` | configuration | Authentication failed. There is no active application with that applicationId, no active service provider, or the password in the request is invalid. → Check APPLINK_APP_ID and APPLINK_PASSWORD, and that the application is active in the portal. |
| `E1317` | user-state | The MSISDN in the request is invalid or not allowed. → Validate the number before sending. Do not retry the same value. |
| `E1325` | client | The format of the address is invalid. The expected format is a tel:-prefixed MSISDN. → A missing tel: prefix, or a stray space. Normalise every address through one helper. |
| `E1601` | transient | The system experienced an unexpected error. |
| `E1603` | transient | A temporary system error occurred while delivering your request. |

`configuration` fix the portal, not the code — the integration is down, not one request · `client` fix the payload or the user's input · `user-state` the user is not eligible right now; tell them, do not loop · `transient` retry with capped exponential backoff. Full table: [08-status-codes.md](08-status-codes.md).

### Rules

- This is Applink's subscription-status lookup — there is no separate getStatus endpoint. Use it for reconciliation, not as a per-request gate.
- Maximum ten MSISDNs per request. Batch larger sets with your own throttle.
- The published request schema names the required field subscriberId while the property it documents is subscriberIds. Send subscriberIds — the array — as the sample does.
- The published sample writes the array entries with a stray space after tel:. Send tel:8801973579363 with no space.
- Branch on each entry's statusCode, not only the top-level one.
- REG_PENDING and INITIAL mean the subscription is not usable yet. Do not start delivering the service until the status is REGISTERED or TRIAL.

---

## Request OTP

Send a one-time password to a subscriber's MSISDN so they can activate a subscription from a web or mobile app.

| | |
|---|---|
| **Endpoint** | `POST https://api.applink.com.bd/otp/request` |
| **Environment variable** | `APPLINK_OTP_REQUEST_URL` |
| **Content type** | `application/json;charset=utf-8` |
| **Full guide** | [04-subscription.md](04-subscription.md) |

### Request parameters

| Parameter | Type | | Definition |
|---|---|---|---|
| `applicationId` | string | **Required** | Identifies the application. Unique identifier generated when the application is provisioned. Only a single value per request. |
| `password` | string | **Required** | The API key sent to your registered email address when the application was approved. |
| `subscriberId` | string | **Required** | Mobile number of the subscriber, in the format tel:8801416177301. |
| `applicationHash` | string | Optional | Hash string that determines which verification messages to send to your app. |
| `applicationMetaData` | object | Optional | Client context for the request: client (web browser or mobile app), device (iPhone 6, Galaxy S5, PC…), os (Android 6, iOS 5, Windows 10…) and appCode (the store identifier for an app, or the web link for a browser). |

### Request

```bash
curl -sS -X POST "$APPLINK_OTP_REQUEST_URL" \
  -H 'Content-Type: application/json;charset=utf-8' \
  --max-time 15 \
  -d @- <<REQUEST
{
  "applicationId": "$APPLINK_APP_ID",
  "password": "$APPLINK_PASSWORD",
  "subscriberId": "tel:8801416177301"
}
REQUEST
```

Optional, and left out above because the value is yours to supply:

- `applicationHash`: specific to your app — published sample `"abcdefgh"`
- `applicationMetaData`: describes your client — send it with your own values or leave it out — published sample `{"client":"MOBILEAPP","device":"Samsung S10","os":"android 8","appCode":"https://play.google.com/store/apps/details?id=example"}`

Fields that do not belong in this body:

- ✗ `subscriberIds` — Request OTP takes one subscriber, as subscriberId — a single tel: string.
- ✗ `metaData` — The field is applicationMetaData — an object of strings (client, device, os, appCode). Omit it entirely rather than sending it empty.

### Response

HTTP 200. The expected outcome is `statusCode: "S1000"`.

```json
{
  "version": "1.0",
  "statusCode": "S1000",
  "referenceNo": "213561321321613",
  "statusDetail": "Success"
}
```

### Response fields

| Field | Type | Meaning |
|---|---|---|
| `version` | string | API version. |
| `statusCode` | string | The status code for the entire request. S1000 when the OTP challenge was sent. |
| `referenceNo` | string | Reference key that uniquely identifies the request. Keep it server-side against the user's session — it is what /otp/verify is called with. |
| `statusDetail` | string | The status detail for the entire request. |

### Handling the response

1. **Decide from `statusCode`**, never from the HTTP status. Expected: `S1000`. The OTP is on its way to the subscriber's phone.
2. **On `S1000`, read** `referenceNo` — present on the expected outcome; read them with a default anyway.
3. **Persist** referenceNo — server-side, in the user's session, for five minutes; never sent to the client.
4. **Then:** Collect the OTP the subscriber types in, then call Verify OTP with this referenceNo.
5. **Any other `statusCode`:** rely on `statusCode` and `statusDetail` only — the fields above may be absent — and handle it by class from the table below.

### Status codes for this endpoint

| Code | Class | Meaning |
|---|---|---|
| `S1000` | success | Process completed successfully for all the available destination numbers. |
| `E1301` | configuration | Requested ApplicationID is not allowed within the system for the operator. → The application is not enabled for this operator. Check the provisioning record in the portal. |
| `E1312` | client | The request is invalid — typically a missing mandatory field or a malformed value. → Compare the payload against the parameter table for that endpoint. `applink validate <id> '<json>'` catches most causes. |
| `E1313` | configuration | Authentication failed. There is no active application with that applicationId, no active service provider, or the password in the request is invalid. → Check APPLINK_APP_ID and APPLINK_PASSWORD, and that the application is active in the portal. |
| `E1603` | transient | A temporary system error occurred while delivering your request. |
| `E1856` | client | Invalid request. → Seen on the OTP endpoints. Check every mandatory field is present and correctly named before retrying. |

`configuration` fix the portal, not the code — the integration is down, not one request · `client` fix the payload or the user's input · `user-state` the user is not eligible right now; tell them, do not loop · `transient` retry with capped exponential backoff. Full table: [08-status-codes.md](08-status-codes.md).

### Rules

- Rate-limit OTP requests yourself, per number and per IP. Without it the application becomes an SMS-bombing tool aimed at arbitrary Bangladeshi numbers, at your expense.
- referenceNo lives server-side, in the session. Never send it to the client, never put it in a URL, and never let the client choose it.
- Never log the OTP or the referenceNo.
- Call this from the backend only — the platform enforces IP whitelisting that a browser or mobile client cannot satisfy.

---

## Verify OTP

Verify an OTP the subscriber typed in. On success the Applink subscription is activated and the subscriberId is returned.

| | |
|---|---|
| **Endpoint** | `POST https://api.applink.com.bd/otp/verify` |
| **Environment variable** | `APPLINK_OTP_VERIFY_URL` |
| **Content type** | `application/json;charset=utf-8` |
| **Full guide** | [04-subscription.md](04-subscription.md) |

### Request parameters

| Parameter | Type | | Definition |
|---|---|---|---|
| `applicationId` | string | **Required** | Identifies the application. Unique identifier generated when the application is provisioned. Only a single value per request. |
| `password` | string | **Required** | The API key sent to your registered email address when the application was approved. |
| `referenceNo` | string | **Required** | Reference number returned by the Request OTP API. See the Request OTP response. |
| `otp` | string | **Required** | The one-time password to use for MSISDN verification for this application. |

### Request

```bash
curl -sS -X POST "$APPLINK_OTP_VERIFY_URL" \
  -H 'Content-Type: application/json;charset=utf-8' \
  --max-time 15 \
  -d @- <<REQUEST
{
  "applicationId": "$APPLINK_APP_ID",
  "password": "$APPLINK_PASSWORD",
  "referenceNo": "213561321321613",
  "otp": "123564"
}
REQUEST
```

Fields that do not belong in this body:

- ✗ `requestCorrelator` — Verify OTP takes referenceNo, and it is the referenceNo from Request OTP. requestCorrelator belongs to the CaaS charging flow.
- ✗ `subscriberId` — Verify OTP does not take the subscriber — only referenceNo and otp. The subscriberId comes back in the response.
- ✗ `code` — The OTP the subscriber typed goes in otp, as a string.

### Response

HTTP 200. The expected outcome is `statusCode: "S1000"`.

```json
{
  "version": "1.0",
  "statusCode": "S1000",
  "subscriptionStatus": "REGISTERED",
  "statusDetail": "Success",
  "subscriberId": "tel:8801416177301"
}
```

### Response fields

| Field | Type | Meaning |
|---|---|---|
| `version` | string | API version. |
| `statusCode` | string | The status code for the entire request. S1000 when the OTP validated. |
| `subscriptionStatus` | string | Subscription status of the user — INITIAL or REGISTERED. |
| `statusDetail` | string | The status detail for the entire request. |
| `subscriberId` | string | The subscriber's mobile number, plain or masked depending on whether the application is set up for plain or masked number usage. Store this — it is the identity used by every later Applink call. |

### Handling the response

1. **Decide from `statusCode`**, never from the HTTP status. Expected: `S1000`. The OTP validated and the subscription was activated.
2. **On `S1000`, read** `subscriberId`, `subscriptionStatus` — present on the expected outcome; read them with a default anyway.
3. **Persist** subscriberId — exactly as returned; it may be masked, and it is the identity for every later Applink call; subscriptionStatus.
4. **Then:** Store subscriberId against your user. E1850 means re-prompt against the same referenceNo; E1851 means the OTP expired and a new one must be requested.
5. **Any other `statusCode`:** rely on `statusCode` and `statusDetail` only — the fields above may be absent — and handle it by class from the table below.

### Status codes for this endpoint

| Code | Class | Meaning |
|---|---|---|
| `S1000` | success | Process completed successfully for all the available destination numbers. |
| `E1850` | client | Invalid OTP. → Prompt the subscriber to re-enter it. Cap the attempts yourself and force a fresh OTP request after that. |
| `E1851` | client | The OTP request has expired. → An Applink OTP is valid for five minutes. Request a new one. |
| `E1855` | client | Invalid reference number. → referenceNo must be the value returned by the matching request — referenceNo from Request OTP, or requestCorrelator from CaaS OTP Generation. It is not the externalTrxId you generated. |
| `E1603` | transient | A temporary system error occurred while delivering your request. |
| `E1856` | client | Invalid request. → Seen on the OTP endpoints. Check every mandatory field is present and correctly named before retrying. |

`configuration` fix the portal, not the code — the integration is down, not one request · `client` fix the payload or the user's input · `user-state` the user is not eligible right now; tell them, do not loop · `transient` retry with capped exponential backoff. Full table: [08-status-codes.md](08-status-codes.md).

### Rules

- The OTP is valid for five minutes. Expire it on your side too rather than relying on the platform.
- Store the returned subscriberId as the user's identity for every later Applink call. It may be masked; treat it as opaque.
- E1850 (invalid OTP), E1851 (expired) and E1855 (invalid reference number) are user-facing prompts, not retries.
- Cap verification attempts per referenceNo on your side and force a fresh request after that.

---

## CaaS OTP Generation

Start a one-time charge against a subscriber's mobile account. Applink sends an OTP to the subscriber, who must enter it before the charge completes.

| | |
|---|---|
| **Endpoint** | `POST https://api.applink.com.bd/caas/direct/debit` |
| **Environment variable** | `APPLINK_CAAS_DEBIT_URL` |
| **Content type** | `application/json;charset=utf-8` |
| **Full guide** | [05-caas.md](05-caas.md) |

> **This call moves real money.** `externalTrxId` is the identifier that ties this
> attempt to one logical charge: persist it *before* sending, and reuse it unchanged on every
> resolution attempt. Starting the charge again with a fresh one bills a real person twice.

### Request parameters

| Parameter | Type | | Definition |
|---|---|---|---|
| `applicationId` | string | **Required** | Identifies the application. Unique identifier generated when the application is provisioned. Only a single value per request. |
| `password` | string | **Required** | The API key sent to your registered email address when the application was approved. |
| `externalTrxId` | string | **Required** | The transaction ID generated by the application to map the request to the response. It is what support and reconciliation trace on. Only a single value per request. |
| `amount` | string | **Required** | Amount to be reserved for charging, sent as a string. Only a single value per request. |
| `paymentInstrumentName` | string | **Required** | The name of the payment instrument, for example Mobile Account. Only a single value per request. |
| `subscriberId` | string | **Required** | The tel:-prefixed MSISDN of the subscriber to be charged. May be a masked value depending on the application type. Only a single value per request. |
| `Currency` | string | **Required** | Currency unit of the amount. Only BDT is allowed. Note the capital C — this is how the parameter is published, and it differs from the lower-case currency used by Query Balance. |

### Request

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

Fields that do not belong in this body:

- ✗ `currency` — CaaS OTP Generation spells it Currency — capital C. Lower-case currency is the Query Balance parameter.
- ✗ `referenceNo` — There is no referenceNo on this call. The platform returns requestCorrelator, which you then send as referenceNo to CaaS OTP Verification.
- ✗ `subscriberIds` — The subscriber goes in subscriberId — a single tel: string.

### Response

HTTP 200. The expected outcome is **`statusCode: "P1003"`** — pending, not a completed operation. Treat `"S1000"` the same way if it ever arrives here.

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

### Response fields

| Field | Type | Meaning |
|---|---|---|
| `timeStamp` | string | The time the request was sent. |
| `externalTrxId` | string | Echo of the transaction ID you generated. Assert it matches what you sent. |
| `statusDetail` | string | Detailed description explaining the status of the entire request. |
| `requestCorrelator` | string | The unique identifier used internally to identify the transaction. This is the value you must pass as referenceNo to CaaS OTP Verification — persist it with the pending charge. |
| `internalTrxId` | string | The transaction ID generated by the service provider, used to track the transaction. Persist it for support. |
| `statusCode` | string | Status of the request. A leading P means partial, E means error and S means success. P1003 means the OTP is on its way and the charge is not complete. |

### Handling the response

1. **Decide from `statusCode`**, never from the HTTP status. Expected: `P1003` or `S1000`. P1003 is the expected answer: the OTP was sent to the subscriber and nothing has been charged. S1000 is in this endpoint's published code list too — if it ever arrives here, handle it exactly like P1003: pending, never charged.
2. **On `P1003` or `S1000`, read** `requestCorrelator`, `externalTrxId`, `internalTrxId` — present on the expected outcome; read them with a default anyway.
3. **Persist** requestCorrelator — on the PENDING ledger row; it is the referenceNo step two needs and cannot be recovered; internalTrxId — for support.
4. **Then:** Assert the echoed externalTrxId equals the one you sent. Prompt the subscriber for the OTP, then call CaaS OTP Verification with referenceNo = requestCorrelator and sourceAddress = this subscriberId. Fulfil nothing yet.
5. **Any other `statusCode`:** rely on `statusCode` and `statusDetail` only — the fields above may be absent — and handle it by class from the table below.

### Status codes for this endpoint

| Code | Class | Meaning |
|---|---|---|
| `S1000` | success | Process completed successfully for all the available destination numbers. |
| `P1003` | pending | Request successfully processed. The OTP will be sent to the subscriber. → CaaS OTP Generation succeeded and nothing has been charged yet. Persist requestCorrelator, collect the OTP from the subscriber, and call CaaS OTP Verification with it. |
| `E1303` | configuration | The IP address this request originated from is not provisioned to send requests to the application. Use a provisioned system, or ask the administrator to provision the new IP. → Find the real egress IP by running curl -4 https://api.ipify.org on the calling server, then add it to the application's allowed host addresses in the portal. |
| `E1308` | client | Permanent charging error — the platform supplies the reason, for example insufficient balance. → Permanent for this attempt. Do not blind-retry; read statusDetail, tell the subscriber, and settle the ledger row from the charging notification. |
| `E1313` | configuration | Authentication failed. There is no active application with that applicationId, no active service provider, or the password in the request is invalid. → Check APPLINK_APP_ID and APPLINK_PASSWORD, and that the application is active in the portal. |
| `E1317` | user-state | The MSISDN in the request is invalid or not allowed. → Validate the number before sending. Do not retry the same value. |
| `E1318` | transient | The transaction limit per second has been exceeded. Throttle requests, or ask the administrator to raise the traffic limit. → Add a client-side rate limiter. Backoff will clear it; more concurrency will not. |
| `E1319` | transient | The transaction limit for today has been exceeded. Try again tomorrow, or ask the administrator to raise the per-day limit. → Retrying today will not help. Queue the work and alert — this is a capacity problem, not a request problem. |
| `E1326` | user-state | Insufficient balance. → Tell the subscriber. Retry later if they top up, never in a loop. |
| `E1328` | configuration | The charging operation is not allowed. Check the NCS configuration. |
| `E1337` | client | Duplicate request. → The platform already has a transaction with this identifier. Do NOT generate a fresh externalTrxId — that starts a second charge. Resolve the outcome of the original from the charging notification. |
| `E1343` | user-state | The MSISDN is not whitelisted. Only whitelisted numbers are allowed to send messages at this stage. → While the application is in Limited Production only numbers on the whitelist can use it. Add the test number in the portal. |
| `E1601` | transient | The system experienced an unexpected error. |
| `E1602` | transient | Message delivery failed. Retry. |
| `E1603` | transient | A temporary system error occurred while delivering your request. |

`configuration` fix the portal, not the code — the integration is down, not one request · `client` fix the payload or the user's input · `user-state` the user is not eligible right now; tell them, do not loop · `transient` retry with capped exponential backoff. Full table: [08-status-codes.md](08-status-codes.md).

### Rules

- This is step one of two. Nothing is deducted until the subscriber's OTP is verified through CaaS OTP Verification.
- externalTrxId is your idempotency key. Generate it, persist it with a PENDING charge row BEFORE sending, and reuse it unchanged on any resolution attempt.
- Persist requestCorrelator from the response — it is the referenceNo the verification step needs, and it is not recoverable if you drop it.
- P1003 is not success. It means the OTP was dispatched. The charge is settled by the charging notification callback, not by this response.
- Never retry with a fresh externalTrxId. A timeout does not mean the charge did not start.
- Hold amounts in a decimal type in your own code. Amount and currency come from server-side configuration, never from client input.
- Only BDT is allowed, and the parameter is spelled Currency with a capital C.

---

## CaaS OTP Verification

Verify the OTP the subscriber entered and complete the one-time charge against their mobile account.

| | |
|---|---|
| **Endpoint** | `POST https://api.applink.com.bd/caas/otp/verify` |
| **Environment variable** | `APPLINK_CAAS_OTP_VERIFY_URL` |
| **Content type** | `application/json;charset=utf-8` |
| **Full guide** | [05-caas.md](05-caas.md) |

> **This call moves real money.** `referenceNo` is the identifier that ties this
> attempt to one logical charge: persist it *before* sending, and reuse it unchanged on every
> resolution attempt. Starting the charge again with a fresh one bills a real person twice.

### Request parameters

| Parameter | Type | | Definition |
|---|---|---|---|
| `applicationId` | string | **Required** | Identifies the application. Unique identifier generated when the application is provisioned. Only a single value per request. |
| `password` | string | **Required** | The API key sent to your registered email address when the application was approved. |
| `referenceNo` | string | **Required** | The value returned as requestCorrelator in the CaaS OTP Generation response. It is the reference of the transaction. |
| `otp` | string | **Required** | The OTP the subscriber entered into the developer application. |
| `sourceAddress` | string | **Required** | The tel:-prefixed MSISDN that requested the OTP — the subscriber being charged. |

### Request

```bash
curl -sS -X POST "$APPLINK_CAAS_OTP_VERIFY_URL" \
  -H 'Content-Type: application/json;charset=utf-8' \
  --max-time 15 \
  -d @- <<REQUEST
{
  "applicationId": "$APPLINK_APP_ID",
  "password": "$APPLINK_PASSWORD",
  "referenceNo": "8801442233146169943053700500040",
  "otp": "123456",
  "sourceAddress": "tel:8801973579363"
}
REQUEST
```

Fields that do not belong in this body:

- ✗ `requestCorrelator` — Send the requestCorrelator value as referenceNo — that is the field name this endpoint takes.
- ✗ `externalTrxId` — Not a parameter here. referenceNo is the requestCorrelator from CaaS OTP Generation, never your externalTrxId.
- ✗ `subscriberId` — This endpoint names the subscriber sourceAddress — the same tel: value you sent as subscriberId to CaaS OTP Generation.

### Response

HTTP 200. The expected outcome is `statusCode: "S1000"`.

```json
{
  "statusCode": "S1000",
  "statusDetail": "Success."
}
```

### Response fields

| Field | Type | Meaning |
|---|---|---|
| `statusCode` | string | The status code for the request. The published sample for this endpoint echoes the request body rather than showing a response envelope, so read statusCode and statusDetail and treat the charging notification as the authoritative outcome. |
| `statusDetail` | string | Description of the status for the request. |

### Handling the response

1. **Decide from `statusCode`**, never from the HTTP status. Expected: `S1000`. The OTP was accepted and the charge submitted. It is not settled until the charging notification arrives.
2. **Persist** the ledger row's state — verified, awaiting the charging notification.
3. **Then:** Fulfil only when the charging notification for this externalTrxId arrives with statusCode S1000 and a paidAmount that covers the amount. E1850 means re-prompt against the same referenceNo; never re-run CaaS OTP Generation.
4. **Any other `statusCode`:** rely on `statusCode` and `statusDetail` only — the fields above may be absent — and handle it by class from the table below.

### Status codes for this endpoint

| Code | Class | Meaning |
|---|---|---|
| `S1000` | success | Process completed successfully for all the available destination numbers. |
| `E1303` | configuration | The IP address this request originated from is not provisioned to send requests to the application. Use a provisioned system, or ask the administrator to provision the new IP. → Find the real egress IP by running curl -4 https://api.ipify.org on the calling server, then add it to the application's allowed host addresses in the portal. |
| `E1308` | client | Permanent charging error — the platform supplies the reason, for example insufficient balance. → Permanent for this attempt. Do not blind-retry; read statusDetail, tell the subscriber, and settle the ledger row from the charging notification. |
| `E1313` | configuration | Authentication failed. There is no active application with that applicationId, no active service provider, or the password in the request is invalid. → Check APPLINK_APP_ID and APPLINK_PASSWORD, and that the application is active in the portal. |
| `E1317` | user-state | The MSISDN in the request is invalid or not allowed. → Validate the number before sending. Do not retry the same value. |
| `E1326` | user-state | Insufficient balance. → Tell the subscriber. Retry later if they top up, never in a loop. |
| `E1337` | client | Duplicate request. → The platform already has a transaction with this identifier. Do NOT generate a fresh externalTrxId — that starts a second charge. Resolve the outcome of the original from the charging notification. |
| `E1850` | client | Invalid OTP. → Prompt the subscriber to re-enter it. Cap the attempts yourself and force a fresh OTP request after that. |
| `E1851` | client | The OTP request has expired. → An Applink OTP is valid for five minutes. Request a new one. |
| `E1855` | client | Invalid reference number. → referenceNo must be the value returned by the matching request — referenceNo from Request OTP, or requestCorrelator from CaaS OTP Generation. It is not the externalTrxId you generated. |
| `E1601` | transient | The system experienced an unexpected error. |
| `E1603` | transient | A temporary system error occurred while delivering your request. |
| `E1856` | client | Invalid request. → Seen on the OTP endpoints. Check every mandatory field is present and correctly named before retrying. |

`configuration` fix the portal, not the code — the integration is down, not one request · `client` fix the payload or the user's input · `user-state` the user is not eligible right now; tell them, do not loop · `transient` retry with capped exponential backoff. Full table: [08-status-codes.md](08-status-codes.md).

### Rules

- This is the step that deducts money. Everything before it only reserved an intent.
- referenceNo is the requestCorrelator from CaaS OTP Generation, not the externalTrxId you generated.
- Never re-run the generation step to 'retry' a failed verification — that starts a second charge. Prompt the subscriber for the OTP again against the same referenceNo, or abandon the transaction and reconcile.
- Settle the ledger row from the charging notification callback, which carries paidAmount, balanceDue and the final statusCode. Do not treat this response as the last word.
- Never log the OTP or the referenceNo.
- The published response sample for this endpoint repeats the request fields. Read statusCode and statusDetail, and log the whole body once in Limited Production so you know what your account actually returns.

---

## Query Balance

Read a subscriber's chargeable balance, account type and account status before attempting a charge.

| | |
|---|---|
| **Endpoint** | `POST https://api.applink.com.bd/caas/get/balance` |
| **Environment variable** | `APPLINK_CAAS_BALANCE_URL` |
| **Content type** | `application/json;charset=utf-8` |
| **Full guide** | [05-caas.md](05-caas.md) |

> **Needs provisioning:** balance queries enabled on the application's CaaS configuration. Without it the call fails no matter how
> correct the payload is.

### Request parameters

| Parameter | Type | | Definition |
|---|---|---|---|
| `applicationId` | string | **Required** | Identifies the application. Unique identifier generated when the application is provisioned. Only a single value per request. |
| `password` | string | **Required** | The API key sent to your registered email address when the application was approved. |
| `subscriberId` | string | **Required** | The MSISDN or username of the subscriber whose account balance is being queried. May be a masked value depending on the application type. Only a single value per request. |
| `paymentInstrumentName` | string (enum) | **Required** | The name of the payment instrument. Only a single value per request. One of `"MobileAccount"`. |
| `accountId` | string | Optional | The account of the payment instrument. Only a single value per request. |
| `currency` | string | Optional | Currency unit of the amount. Only BDT is allowed. Note the lower-case c, unlike the Currency parameter on CaaS OTP Generation. |

### Request

```bash
curl -sS -X POST "$APPLINK_CAAS_BALANCE_URL" \
  -H 'Content-Type: application/json;charset=utf-8' \
  --max-time 15 \
  -d @- <<REQUEST
{
  "applicationId": "$APPLINK_APP_ID",
  "password": "$APPLINK_PASSWORD",
  "subscriberId": "tel:8801959979376",
  "paymentInstrumentName": "MobileAccount",
  "currency": "BDT"
}
REQUEST
```

Optional, and left out above because the value is yours to supply:

- `accountId`: specific to the subscriber's account

Fields that do not belong in this body:

- ✗ `Currency` — Query Balance spells it currency — lower-case c. Capital-C Currency is the CaaS OTP Generation parameter.
- ✗ `subscriberIds` — The subscriber goes in subscriberId — a single tel: string.

### Response

HTTP 200. The expected outcome is `statusCode: "S1000"`.

```json
{
  "accountType": "Pre Paid",
  "accountStatus": "Active",
  "chargeableBalance": "300.0",
  "statusCode": "S1000",
  "statusDetail": "Success."
}
```

### Response fields

| Field | Type | Meaning |
|---|---|---|
| `accountType` | string | Account type of the subscriber ID, for example Pre Paid or Post Paid. |
| `accountStatus` | string | Account status of the subscriber ID. |
| `chargeableBalance` | string | Available chargeable balance of the subscriber: remaining account balance for a prepaid user, or credit limit minus outstanding bill for a postpaid user. Rounded to two decimal points and sent as a string. |
| `statusCode` | string | The status code for the entire request. |
| `statusDetail` | string | Description of the status for the entire request. |

### Handling the response

1. **Decide from `statusCode`**, never from the HTTP status. Expected: `S1000`. chargeableBalance is what the subscriber can be charged right now.
2. **On `S1000`, read** `chargeableBalance` — present on the expected outcome; read them with a default anyway.
3. **Then:** Parse chargeableBalance into a decimal type — it arrives as a string. It is advisory: E1326 can still come back from the charge itself.
4. **Any other `statusCode`:** rely on `statusCode` and `statusDetail` only — the fields above may be absent — and handle it by class from the table below.

### Status codes for this endpoint

| Code | Class | Meaning |
|---|---|---|
| `S1000` | success | Process completed successfully for all the available destination numbers. |
| `E1303` | configuration | The IP address this request originated from is not provisioned to send requests to the application. Use a provisioned system, or ask the administrator to provision the new IP. → Find the real egress IP by running curl -4 https://api.ipify.org on the calling server, then add it to the application's allowed host addresses in the portal. |
| `E1313` | configuration | Authentication failed. There is no active application with that applicationId, no active service provider, or the password in the request is invalid. → Check APPLINK_APP_ID and APPLINK_PASSWORD, and that the application is active in the portal. |
| `E1317` | user-state | The MSISDN in the request is invalid or not allowed. → Validate the number before sending. Do not retry the same value. |
| `E1318` | transient | The transaction limit per second has been exceeded. Throttle requests, or ask the administrator to raise the traffic limit. → Add a client-side rate limiter. Backoff will clear it; more concurrency will not. |
| `E1319` | transient | The transaction limit for today has been exceeded. Try again tomorrow, or ask the administrator to raise the per-day limit. → Retrying today will not help. Queue the work and alert — this is a capacity problem, not a request problem. |
| `E1326` | user-state | Insufficient balance. → Tell the subscriber. Retry later if they top up, never in a loop. |
| `E1328` | configuration | The charging operation is not allowed. Check the NCS configuration. |
| `E1337` | client | Duplicate request. → The platform already has a transaction with this identifier. Do NOT generate a fresh externalTrxId — that starts a second charge. Resolve the outcome of the original from the charging notification. |
| `E1343` | user-state | The MSISDN is not whitelisted. Only whitelisted numbers are allowed to send messages at this stage. → While the application is in Limited Production only numbers on the whitelist can use it. Add the test number in the portal. |
| `E1601` | transient | The system experienced an unexpected error. |
| `E1602` | transient | Message delivery failed. Retry. |
| `E1603` | transient | A temporary system error occurred while delivering your request. |

`configuration` fix the portal, not the code — the integration is down, not one request · `client` fix the payload or the user's input · `user-state` the user is not eligible right now; tell them, do not loop · `transient` retry with capped exponential backoff. Full table: [08-status-codes.md](08-status-codes.md).

### Rules

- This endpoint is in the published API specification but is not listed in the rendered documentation's navigation. Confirm with support that it is enabled on your application before you depend on it.
- A balance check is advisory, not a reservation. The balance can change between this call and the charge — always handle E1326 on the charging path regardless of what this returned.
- chargeableBalance is a string. Parse it into a decimal type, never a binary float you then compare for equality.
- Leaving APPLINK_CAAS_BALANCE_URL unset is how you disable this locally on an application that does not have it.

---

# Inbound callbacks — Applink calls you

---

## SMS Receive (MO)

Fires when a subscriber sends an SMS to your shortcode with your keyword.

| | |
|---|---|
| **Direction** | Applink → you. There is nothing to call. |
| **Your route** | `POST <your-host>/api/applink/sms/receive` (the path is yours; register it in the portal) |
| **Configured in** | SMS API settings — the MO / receive URL |
| **Deduplicate on** | `requestId` |
| **Full guide** | [02-sms.md](02-sms.md) |

### Payload fields

| Field | Type | | Definition |
|---|---|---|---|
| `version` | string | **Always sent** | API version, numbered 1.0, 2.0 and so on. |
| `applicationId` | string | **Always sent** | Your application ID. Verify it matches before doing anything with the payload. |
| `sourceAddress` | string | **Always sent** | Address of the sender, masked if number masking is enabled on the application. |
| `message` | string | **Always sent** | Content of the message sent by the user, including the keyword that routed it to you. |
| `requestId` | string | **Always sent** | Uniquely identifies this request within the platform. This is the deduplication key. |
| `encoding` | string (enum) | **Always sent** | Encoding scheme used in the message. 0 = Text, 240 = Flash SMS, 245 = Binary, in which case the content is hex encoded. One of `"0"`, `"240"`, `"245"`. |

### What arrives

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

### What you must respond

HTTP 200, immediately, before doing any work:

```json
{
  "statusCode": "S1000",
  "statusDetail": "Success"
}
```

### Replay it against your own handler

`applicationId` comes from your environment, as the platform would send it — a handler that verifies `applicationId` ignores the sample value, and the replay would prove nothing.

```bash
curl -sS -X POST "http://localhost:3000/api/applink/sms/receive" \
  -H 'Content-Type: application/json;charset=utf-8' \
  -d @- <<PAYLOAD
{
  "version": "1.0",
  "applicationId": "$APPLINK_APP_ID",
  "sourceAddress": "tel:8801959979376",
  "message": "JOIN",
  "requestId": "22607072011552911",
  "encoding": "0"
}
PAYLOAD
```

### Rules

- The message arrives with the keyword included. Trim, collapse whitespace and compare the keyword case-insensitively.
- Recognise the standard opt-out words — STOP, UNSUB, OFF — and honour them by calling Subscription Unregister.
- An MO SMS is not authenticated beyond the source address. Never perform a destructive or chargeable action on the strength of one.
- Never echo user content back into an outbound SMS without sanitising it.

---

## SMS Delivery Status Report

Fires when an MT SMS sent with deliveryStatusRequest "1" reaches a final state at the message centre.

| | |
|---|---|
| **Direction** | Applink → you. There is nothing to call. |
| **Your route** | `POST <your-host>/api/applink/sms/report` (the path is yours; register it in the portal) |
| **Configured in** | SMS API settings — the delivery report URL |
| **Deduplicate on** | `requestId + deliveryStatus` |
| **Full guide** | [02-sms.md](02-sms.md) |

### Payload fields

| Field | Type | | Definition |
|---|---|---|---|
| `destinationAddress` | string | **Always sent** | Address of the subscriber the report is about. |
| `timeStamp` | string | **Always sent** | The timestamp sent from the SMS, documented as yyMMddHHmm — yy last two digits of the year, MM month 01-12, dd day 01-31, HH hour 00-23, mm minute 00-59. The published sample is 14 digits, so parse on length rather than assuming one form. |
| `requestId` | string | **Always sent** | Uniquely identifies the request within the platform. Match it against the requestId returned by the original SMS Send. |
| `deliveryStatus` | string (enum) | **Always sent** | Final state of the message as reported by the platform to the application. One of `"DELIVERED"`, `"EXPIRED"`, `"DELETED"`, `"UNDELIVERABLE"`, `"ACCEPTED"`, `"UNKNOWN"`, `"REJECTED"`. |

### What arrives

```json
{
  "destinationAddress": "tel:8801959979376",
  "timeStamp": "20120113082110",
  "requestId": "MSG_000111",
  "deliveryStatus": "DELIVERED"
}
```

### What you must respond

HTTP 200, immediately, before doing any work:

```json
{
  "statusCode": "S1000",
  "statusDetail": "Success"
}
```

### Replay it against your own handler

```bash
curl -sS -X POST "http://localhost:3000/api/applink/sms/report" \
  -H 'Content-Type: application/json;charset=utf-8' \
  -d @- <<PAYLOAD
{
  "destinationAddress": "tel:8801959979376",
  "timeStamp": "20120113082110",
  "requestId": "MSG_000111",
  "deliveryStatus": "DELIVERED"
}
PAYLOAD
```

### Rules

- ACCEPTED is not DELIVERED — it means the network took the message, nothing more.
- Reports arrive out of order, late, more than once, or never. Store the latest status keyed by requestId and keep the handler idempotent.
- Repeated UNDELIVERABLE for one subscriber usually means a dead number. Stop messaging it rather than paying for nothing.
- The underlying SMPP layer uses abbreviated spellings such as DELIVRD, UNDELIV, ACCEPTD and REJECTD. Normalise both forms on the way in.

---

## USSD Receive

Fires when a subscriber dials your USSD code or presses a key inside an open session.

| | |
|---|---|
| **Direction** | Applink → you. There is nothing to call. |
| **Your route** | `POST <your-host>/api/applink/ussd/receive` (the path is yours; register it in the portal) |
| **Configured in** | USSD API settings — the receive URL |
| **Deduplicate on** | `requestId` |
| **Full guide** | [03-ussd.md](03-ussd.md) |

### Payload fields

| Field | Type | | Definition |
|---|---|---|---|
| `version` | string | **Always sent** | API version, numbered 1.0, 2.0 and so on. |
| `applicationId` | string | **Always sent** | Your application ID. Verify it matches. |
| `message` | string | **Always sent** | Content of the message sent by the user — the code they dialled or the key they pressed. |
| `requestId` | string | **Always sent** | Uniquely identifies this request within the platform. This is the deduplication key. |
| `sessionId` | string | **Always sent** | Unique number the USSD gateway assigns to the application for the duration of the session, maintained across every message in that session. Echo it on every USSD Send. |
| `ussdOperation` | string (enum) | **Always sent** | USSD operation. Inbound you will see mo-init when the subscriber starts the session and mo-cont for each message after it. One of `"mo-init"`, `"mo-cont"`, `"mt-init"`, `"mt-cont"`, `"mt-fin"`. |
| `sourceAddress` | string | **Always sent** | Address of the sender, masked if number masking is enabled on the application. |
| `vlrAddress` | string | Optional | VLR (Visitor Location Register) address of the sender. |
| `encoding` | string (enum) | **Always sent** | Encoding scheme used in the message. 440 = plain ASCII characters. One of `"440"`. |

### What arrives

```json
{
  "version": "1.0",
  "applicationId": "APP_000029",
  "message": "*141#",
  "requestId": "1330933229901",
  "sessionId": "1330929317043",
  "ussdOperation": "mo-init",
  "sourceAddress": "tel:8801959979376",
  "vlrAddress": "tel:8801959979376",
  "encoding": "440"
}
```

### What you must respond

HTTP 200, immediately, before doing any work:

```json
{
  "statusCode": "S1000",
  "statusDetail": "Success"
}
```

### Replay it against your own handler

`applicationId` comes from your environment, as the platform would send it — a handler that verifies `applicationId` ignores the sample value, and the replay would prove nothing.

```bash
curl -sS -X POST "http://localhost:3000/api/applink/ussd/receive" \
  -H 'Content-Type: application/json;charset=utf-8' \
  -d @- <<PAYLOAD
{
  "version": "1.0",
  "applicationId": "$APPLINK_APP_ID",
  "message": "*141#",
  "requestId": "1330933229901",
  "sessionId": "1330929317043",
  "ussdOperation": "mo-init",
  "sourceAddress": "tel:8801959979376",
  "vlrAddress": "tel:8801959979376",
  "encoding": "440"
}
PAYLOAD
```

### Rules

- The body you return is an acknowledgement, not a reply. The screen the subscriber sees comes from a separate POST to /ussd/send.
- Acknowledge before doing any work — USSD sessions time out in seconds.
- Key session state on the platform's sessionId, with a TTL of about two minutes, in a store shared across every instance.
- mo-init starts a session; mo-cont continues one. Nothing tells you the path the user took to get here except your own session state.

---

## Subscriber Notification

Fires when a subscription changes — including changes you did not initiate, such as a subscriber texting STOP or a recurring charge failing.

| | |
|---|---|
| **Direction** | Applink → you. There is nothing to call. |
| **Your route** | `POST <your-host>/api/applink/subscription/notify` (the path is yours; register it in the portal) |
| **Configured in** | Subscription API settings — the notification URL |
| **Deduplicate on** | `subscriberId + status + timeStamp` |
| **Full guide** | [04-subscription.md](04-subscription.md) |

### Payload fields

| Field | Type | | Definition |
|---|---|---|---|
| `timeStamp` | string | **Always sent** | The timestamp sent from the SMS, documented as yyMMddHHmm — yy last two digits of the year, MM month 01-12, dd day 01-31, HH hour 00-23, mm minute 00-59. The published sample is 14 digits, so parse on length. |
| `version` | string | **Always sent** | API version, numbered 1.0, 2.0 and so on. |
| `applicationId` | string | **Always sent** | Your application ID. Verify it matches. |
| `password` | string | **Always sent** | Your API key, sent by the platform inside the notification. Never log this field, and if you compare it, compare it in constant time. |
| `subscriberId` | string | **Always sent** | The subscriber's tel:-prefixed MSISDN, a unique identifier. May be a masked value depending on the application type. |
| `frequency` | string (enum) | **Always sent** | Frequency at which notifications are sent for this subscription. One of `"daily"`, `"weekly"`, `"monthly"`, `"yearly"`. |
| `status` | string | **Always sent** | Status of the subscription, for example UNREGISTERED or REGISTERED. |

### What arrives

```json
{
  "timeStamp": "20120113082110",
  "version": "1.0",
  "applicationId": "APP_999999",
  "password": "$APPLINK_PASSWORD",
  "subscriberId": "tel:8801973579363",
  "frequency": "monthly",
  "status": "REGISTERED"
}
```

### What you must respond

HTTP 200, immediately, before doing any work:

```json
{
  "statusCode": "S1000",
  "statusDetail": "Success"
}
```

### Replay it against your own handler

`applicationId` and `password` come from your environment, as the platform would send them — a handler that verifies `applicationId` ignores the sample value, and the replay would prove nothing.

```bash
curl -sS -X POST "http://localhost:3000/api/applink/subscription/notify" \
  -H 'Content-Type: application/json;charset=utf-8' \
  -d @- <<PAYLOAD
{
  "timeStamp": "20120113082110",
  "version": "1.0",
  "applicationId": "$APPLINK_APP_ID",
  "password": "$APPLINK_PASSWORD",
  "subscriberId": "tel:8801973579363",
  "frequency": "monthly",
  "status": "REGISTERED"
}
PAYLOAD
```

### Rules

- This callback is the authoritative source of subscription state. Consuming it is what lets you keep a local mirror instead of re-querying.
- It carries your password in the body. Never log the raw payload, and redact that field before anything reaches a log aggregator.
- A notification is not authorisation. Reconcile against your own records before unlocking a paid feature.
- Deduplicate on subscriberId, status and timeStamp together — the same change can be delivered more than once.

---

## Charging Notification

Fires automatically when a charging transaction completes. There is nothing to call — it is the callback that settles the charge you started.

| | |
|---|---|
| **Direction** | Applink → you. There is nothing to call. |
| **Your route** | `POST <your-host>/api/applink/caas/charging-notification` (the path is yours; register it in the portal) |
| **Configured in** | CaaS API settings — the charging notification URL |
| **Deduplicate on** | `externalTrxId + statusCode` |
| **Full guide** | [05-caas.md](05-caas.md) |

### Payload fields

| Field | Type | | Definition |
|---|---|---|---|
| `timeStamp` | string | **Always sent** | The time the request was sent. The published sample is formatted 15-Nov-2023 11:55, which is not the format any other Applink field uses — parse defensively. |
| `TotalAmount` | string | **Always sent** | Amount deducted from the subscriber as the one-time charge. Note the capital T — this is how the field is published. |
| `externalTrxId` | string | **Always sent** | The transaction ID your application generated for the charge. This is how you match the notification to your ledger row. |
| `balanceDue` | string | **Always sent** | The amount still due, if any. Shows 0 when nothing is outstanding. |
| `statusDetail` | string | **Always sent** | Detailed description explaining the status of the entire request. |
| `currency` | string | **Always sent** | Currency unit of the amount. Only BDT is allowed. |
| `version` | string | **Always sent** | API version, numbered 1.0, 2.0 and so on. |
| `internalTrxId` | string | **Always sent** | The unique identifier used to track the request at the developer application end. |
| `paidAmount` | string | **Always sent** | The amount actually paid by the subscriber. Compare it against what you charged before marking the order fulfilled. |
| `referenceId` | string | **Always sent** | The unique reference used to identify the transaction within the system. |
| `statusCode` | string | **Always sent** | Status of the request. A leading P means partial, E means error and S means success. |

### What arrives

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

### What you must respond

HTTP 200, immediately, before doing any work:

```json
{
  "statusCode": "S1000",
  "statusDetail": "Success"
}
```

### Replay it against your own handler

```bash
curl -sS -X POST "http://localhost:3000/api/applink/caas/charging-notification" \
  -H 'Content-Type: application/json;charset=utf-8' \
  -d @- <<PAYLOAD
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
PAYLOAD
```

### Rules

- This is your reconciliation channel. Every charge your code left in an unknown state after a timeout is resolved here.
- Match on externalTrxId — the key you generated and persisted before starting the charge.
- Deduplicate on externalTrxId and statusCode together. A repeat notification for an already-settled transaction must not double-count revenue.
- Compare paidAmount and balanceDue against your ledger before treating an order as fulfilled — a partial payment is a real outcome.
- TotalAmount carries a capital T while paidAmount and balanceDue do not. Bind the field names exactly.

---

## What a curl does not show

Every command above is one HTTPS POST, and that part ports to any language in a few lines. The
difference between a working call and a production integration is what surrounds it — none of
which is visible in a shell command:

| | Why the curl hides it |
|---|---|
| **Credentials from the environment, injected once** | A shell export becomes a config module that validates at startup and fails loudly. One place reads it; no call site passes credentials as arguments. |
| **`statusCode` branching** | You read the JSON yourself here. Code that checks `res.ok`, `raise_for_status()` or `EnsureSuccessStatusCode()` reports every Applink failure as a success. |
| **`P1003` is not success** | CaaS OTP Generation returns it when the OTP is on its way to the subscriber. A curl shows you the code; only your code can hold the charge open, collect the OTP and finish with CaaS OTP Verification. |
| **Reaching the desired state** | Applink publishes no "already registered" code. Register and unregister are made idempotent by reading `subscriptionStatus` from the response — which a shell command has no state to compare against. |
| **Idempotency** | `externalTrxId` has to be generated, persisted before the call, and reused unchanged. A shell loop cannot do this; a ledger row can. |
| **Timeouts and retries** | `--max-time 15` becomes an explicit client timeout, with backoff on transient codes only and no automatic retry at all on the charging path. |
| **`tel:` normalisation** | Typed by hand here; in code it is one function at the boundary, never a concatenation at a call site. |
| **Acknowledge-first callbacks** | The replay commands return instantly. A real handler must respond `S1000` and then work out of band — USSD sessions time out in seconds. |

Those, plus a shared USSD session store, are the whole specification. They are written out
language-neutrally in [11-any-stack.md](11-any-stack.md), with an acceptance checklist for a
port. [templates/](../templates/README.md) shows the same seven already built in TypeScript/Node,
Python, Java, Go, PHP and C# — worked examples to read for shape, not output to paste.

## Related

| | |
|---|---|
| Machine-readable form of this page | [`catalog/applink-api.json`](../catalog/applink-api.json) |
| Build a request with your own values | `node tools/applink.mjs curl <id> key=value …` |
| Check a payload before sending it | `node tools/applink.mjs validate <id> '<json>'` |
| Decode a status code you received | `node tools/applink.mjs code <statusCode>` |
| Smoke-test the outbound path | [`scripts/smoke-test.sh`](../scripts/smoke-test.sh) (or `smoke-test.ps1`) |
| Test all five callback handlers | [`scripts/test-callbacks.sh`](../scripts/test-callbacks.sh) |
| Every status code, classified | [08-status-codes.md](08-status-codes.md) |
