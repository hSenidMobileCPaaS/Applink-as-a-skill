# Status Codes

## The single most important rule

**Applink returns HTTP 200 for application-level failures.** The real outcome is the
`statusCode` field in the response body.

```
# WRONG — reports failures as successes
response = http_post(url, body)
if response.ok: return "sent"

# RIGHT
response = http_post(url, body)
data = parse_json(response.body)
if data.statusCode != "S1000":
    raise ApplinkError(data.statusCode, data.statusDetail)
```

Every stack spells the wrong version differently — `res.ok`, `raise_for_status()`,
`EnsureSuccessStatusCode()`, `response.IsSuccessStatusCode`, Guzzle's `http_errors`,
`resp.StatusCode == 200`. All of them are the same bug.

Every response carries `statusCode` and `statusDetail`. The prefix carries the meaning, and
Applink's own documentation states it: **`S` success, `P` partial, `E` error.**

| Prefix | Meaning |
|---|---|
| `S1000` | Success |
| `P1003` | Partial — accepted, not finished. The CaaS OTP is on its way to the subscriber |
| `E13xx` | Application, authentication, routing, delivery and charging errors |
| `E16xx` | Platform-side system errors |
| `E18xx` | OTP errors |

## The second most important rule

**`P1003` is not success.** It is the only non-`S` code you will see on a healthy charging
flow, and it means the charge has been *started*, not completed. Code that treats it as done
fulfils orders nobody paid for. See [05-caas.md](05-caas.md).

---

## Handling classes

Map codes to behaviour, not to strings. Five classes drive five different actions:

| Class | Retry? | What it means |
|---|---|---|
| **Success** | — | Proceed. |
| **Pending** | **Never re-send** | Accepted, not settled. Continue the flow — collect the OTP, verify — and settle from the charging notification. |
| **Configuration** | **Never** | Your provisioning or credentials are wrong. Code changes will not help. Fix the portal. |
| **Client** | **Never** | Your payload is wrong, or the user gave bad input. Fix the request or prompt the user. |
| **User state** | **Only after user action** | The subscriber is not eligible right now. Communicate, do not retry in a loop. |
| **Transient** | **Yes, backoff** | Platform-side. Exponential backoff with jitter, capped attempts, then dead-letter. |

Every published code carries its class in the [complete list](#complete-official-status-code-list)
below — build your sets from that column, not from a remembered range. `E1308`, for instance,
sits among configuration-class neighbours but is client-class.

### There are no benign duplicate-state codes

Some telco platforms publish "already registered", "not registered" or "transaction already
completed" codes that you map to success. **Applink publishes none of them.** Do not add codes
outside the table below to your handling, however plausible they look.

Instead:

- **Register / unregister:** read `subscriptionStatus` from the response. Reaching the state
  you wanted is the success condition, and the platform's own unregister sample returns
  `S1000` with `statusDetail: "not registered"`.
- **Charging:** `E1337` ("Duplicate request") tells you the platform already holds a
  transaction under that identifier. It does **not** tell you the charge succeeded, so it is
  not a success — resolve the real outcome from the charging notification, and never re-roll
  `externalTrxId`.

---

## Codes you will actually hit, and what to do

| Code | Meaning | Action |
|---|---|---|
| `S1000` | Success | Proceed |
| `P1003` | CaaS OTP dispatched | Charge is pending. Collect the OTP, call `/caas/otp/verify` |
| `E1303` | **Source IP not provisioned** | Run `curl -4 https://api.ipify.org` on the calling server; add that IP to the allowed host addresses in the portal |
| `E1309` | Requested service is not allowed for this application | The API was not provisioned. Portal fix, not a code fix |
| `E1313` | **Authentication failure** — no active application, no active service provider, or wrong password | Check `APPLINK_APP_ID` / `APPLINK_PASSWORD`; check the application is active |
| `E1312` | Invalid request — usually a missing mandatory field | Compare against the parameter table; `applink validate` catches most causes |
| `E1317` | MSISDN invalid or not allowed | Validate the number; do not retry |
| `E1325` | Format of the address is invalid | Missing `tel:` prefix, or a stray space |
| `E1326` | **Insufficient balance** | Tell the user; retry later, not immediately |
| `E1331` | Source address not allowed | `sourceAddress` is not a provisioned alias — use one, or omit it |
| `E1334` / `E1335` | Message too long (normal / advertisement) | Shorten or split. Bangla is UCS-2: 70 characters per part |
| `E1337` | Duplicate request | The platform already has this transaction. Settle from the charging notification; never re-roll `externalTrxId` |
| `E1343` | MSISDN not whitelisted | Limited Production. Add the number in the portal |
| `E1318` / `E1319` | Per-second / per-day transaction limit exceeded | Throttle. The daily limit will not clear today |
| `E1850` / `E1851` / `E1855` | OTP invalid / expired / bad reference number | Prompt the user; enforce the five-minute validity on your side too |

---

## Complete official status-code list

Reproduced from the Applink API documentation at
<https://dev.applink.com.bd/API_Documentation/docs/hSenidMobile_tap_api.html>, where the codes
are published inside each endpoint's `statusDetail` description. **These twenty-nine codes plus
`S1000` are the whole list** — nothing else should appear in your error handling.

The **Class** column is the one to build from: it maps each code to one of the behaviours above,
and it is the same classification `node tools/applink.mjs code <statusCode>` returns and
[`catalog/applink-api.json`](../catalog/applink-api.json) stores.

| Code | Class | Description |
|---|---|---|
| `P1003` | pending | Request successfully processed. The OTP will be sent to the subscriber. |
| `E1301` | configuration | Requested ApplicationID is not allowed within the system for the operator. |
| `E1303` | configuration | The IP address this request originated from is not provisioned to send requests to the application. Use a provisioned system, or ask the administrator to provision the new IP. |
| `E1308` | client | Permanent charging error — the platform supplies the reason, for example insufficient balance. |
| `E1309` | configuration | The requested service is not allowed for this application. |
| `E1311` | configuration | Mobile terminated SMS messages are not enabled. Check the NCS configuration in provisioning. |
| `E1312` | client | The request is invalid — typically a missing mandatory field or a malformed value. |
| `E1313` | configuration | Authentication failed. There is no active application with that applicationId, no active service provider, or the password in the request is invalid. |
| `E1315` | configuration | Cannot find the requested service, or it is not active. |
| `E1317` | user-state | The MSISDN in the request is invalid or not allowed. |
| `E1318` | transient | The transaction limit per second has been exceeded. Throttle requests, or ask the administrator to raise the traffic limit. |
| `E1319` | transient | The transaction limit for today has been exceeded. Try again tomorrow, or ask the administrator to raise the per-day limit. |
| `E1325` | client | The format of the address is invalid. The expected format is a tel:-prefixed MSISDN. |
| `E1326` | user-state | Insufficient balance. |
| `E1328` | configuration | The charging operation is not allowed. Check the NCS configuration. |
| `E1331` | configuration | The source address is not allowed. Use one of the values configured in the alias configuration in the SLAs, or send the request without a sourceAddress so the platform uses the default sender address. |
| `E1334` | client | The message could not be processed because its length is too long. The platform supplies the maximum. |
| `E1335` | client | The message could not be processed because the advertisement message length is too long. The platform supplies the maximum. |
| `E1337` | client | Duplicate request. |
| `E1341` | transient | The request failed. Errors occurred while sending the request for all the destinations. |
| `E1342` | user-state | The MSISDN is blacklisted and is not authorised to use this application. |
| `E1343` | user-state | The MSISDN is not whitelisted. Only whitelisted numbers are allowed to send messages at this stage. |
| `E1601` | transient | The system experienced an unexpected error. |
| `E1602` | transient | Message delivery failed. Retry. |
| `E1603` | transient | A temporary system error occurred while delivering your request. |
| `E1850` | client | Invalid OTP. |
| `E1851` | client | The OTP request has expired. |
| `E1855` | client | Invalid reference number. |
| `E1856` | client | Invalid request. |

Which codes each endpoint can return is listed per endpoint in
[13-curl-reference.md](13-curl-reference.md), and by `node tools/applink.mjs show <id>`.

---

## Reference implementation

Whatever your language calls an error — exception, error struct, result variant — it needs the
code, the detail, and two questions answerable from the sets below:

```
TRANSIENT = { E1318, E1319, E1341, E1601, E1602, E1603 }

CONFIGURATION = { E1301, E1303, E1309, E1311, E1313, E1315, E1328, E1331 }

USER_STATE = { E1317, E1326, E1342, E1343 }

CLIENT = { E1308, E1312, E1325, E1334, E1335, E1337, E1850, E1851, E1855, E1856 }

PENDING = { P1003 }   # accepted, not settled — never re-send

error ApplinkError(statusCode, statusDetail, service):
    retryable       = statusCode in TRANSIENT
    isConfiguration = statusCode in CONFIGURATION
    isPending       = statusCode in PENDING
```

These sets are also machine-readable in
[`catalog/applink-api.json`](../catalog/applink-api.json) under `statusCodes` (each code
carries its `class`), so you can generate them rather than retyping them.

Working versions: [templates/](../templates/README.md) — TypeScript, Python, Java, Go, PHP and
C# all express exactly this.

Alerting rule of thumb: any **configuration**-class code in production is a page — the whole
integration is down, not one request. Transient codes belong on a rate dashboard. A rising rate
of `P1003` with no matching charging notifications means subscribers are starting charges and
never finishing them, which is a product problem, not a platform one.
