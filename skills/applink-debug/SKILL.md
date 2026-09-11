---
name: applink-debug
description: Diagnose a failing Applink integration from a status code or a symptom — E1303, E1313, E1309, E1855, callbacks not arriving, USSD sessions dying, charges stuck at P1003, double charges, works-locally-fails-deployed. Use when an Applink call or callback is not behaving.
---

# Debug an Applink integration

Start with the tool, not with guesses:

```bash
node tools/applink.mjs code E1303
node tools/applink.mjs diagnose "callbacks never arrive"
node tools/applink.mjs validate <id> '<payload>'
node tools/applink.mjs response <id> '<response body>'   # what the platform actually said
node tools/applink.mjs curl <id> [key=value ...]   # reproduce the call outside your code
```

## Get the real error first

Applink returns **HTTP 200 for failures**. If the code decides on the HTTP status — `res.ok`,
`raise_for_status()`, `EnsureSuccessStatusCode()`, Guzzle's `http_errors`, a `2xx` check — it is
swallowing the error. Log `statusCode` and `statusDetail` before investigating anything else —
most "mysterious" Applink bugs are a clear error code that nothing was reading.

And remember `P1003` is a *pending* code, not a failure and not a success.

## Failure signatures

| Symptom | Almost always |
|---|---|
| Everything returns `E1303` | Calling from an IP that is not provisioned — a laptop, a CI runner, or a serverless function with rotating egress. Run `curl -4 https://api.ipify.org` **on the calling server**. |
| Everything returns `E1313` | Wrong credentials, the wrong environment's credentials, or the application is not active. |
| One API returns `E1309`, others work | That API was not provisioned. A portal fix, not a code fix. |
| Test number gets nothing, no error | The number is not whitelisted while the application is in Limited Production (`E1343`). |
| Callbacks never arrive | URL not publicly reachable, wrong in the portal, a bot-protection challenge, auth middleware in front, or the handler is not returning 200 with `S1000`. |
| USSD dies mid-flow | Session store not shared across instances or workers (an in-process map, whatever the language), no `mt-fin`, or a handler too slow for the session timeout. |
| **Orders fulfilled, no money taken** | `P1003` treated as a completed charge. `/caas/direct/debit` only sends an OTP — the money moves at `/caas/otp/verify`. |
| **Duplicate charges** | OTP generation re-run to "retry" a failed verification, or a fresh `externalTrxId` issued after a timeout. Each starts a second transaction. |
| `E1855` on every charge confirmation | The wrong identifier as `referenceNo`. It is the `requestCorrelator` from OTP generation — not your `externalTrxId`, and not the `referenceNo` from `/otp/request`. |
| `E1337` on a charge | The platform already has that transaction. Do **not** re-roll `externalTrxId`; settle from the charging notification. |
| `E1312` on `getSubscriberChargingInfo` | `subscriberId` sent instead of `subscriberIds`, or more than ten MSISDNs. |
| `E1312` / `E1856` on a payload that "looks right" | A value sent as a number (`"amount": 5`, `"action": 1`), a `null` or empty optional field, or a name from another endpoint (`currency` on the charge, `version` where it is not a parameter). Log the serialised body and run `validate` on it. |
| A 31-digit identifier "changes" between calls | It went through a number type — `requestCorrelator` becomes `8.80144223314617e+30`. Keep every identifier a string end to end. |
| `E1325` on an address | Missing `tel:` prefix, or a stray space. On SMS specifically, the published samples use `tel:+880…` while every other API uses `tel:880…` — try the other form there. |
| Works locally, fails deployed | The egress IP changed, or secrets are not set in the host environment. |
| Certificate / TLS errors | Incomplete certificate chain — supply the intermediate CA, do **not** disable verification. |

## Narrowing it down

1. **Is it every call or one call?** Every call points at `E1303`/`E1313` — configuration.
   One call points at that service's provisioning or your payload.
2. **Is the payload even valid?** Point the failing call at `node scripts/mock-applink.mjs`
   — it prints the exact body the code sent and every fault in it — or log the body as
   serialised and run `node tools/applink.mjs validate <id> '<json>'` on it. Then
   `node tools/applink.mjs response <id> '<body>'` on what came back. A body that is right in
   the source but wrong on the wire is a serializer default; see the per-stack table in
   `references/11-any-stack.md`.
3. **Take the code out of it.** Run the endpoint by hand from
   `references/13-curl-reference.md` (or `node tools/applink.mjs curl <id> key=value …`) **from
   the same server**. A curl that works proves the payload, the credentials, the provisioning
   and the egress IP are all fine, and the bug is in your code; a curl that fails gives you the
   real `statusCode` with nothing swallowing it.
4. **Is it environment-specific?** Compare the egress IP and the loaded config between the
   working and failing environments.
5. **Is it a code you invented?** Only twenty-nine status codes are published. Anything else in
   your error handling came from somewhere else and will never match.

## Escalating

Applink support traces on identifiers, so quote them: `requestId`, `externalTrxId`,
`internalTrxId`, `requestCorrelator`, `sessionId`, and the `statusCode`. The documentation
calls the underlying system TAP; it is the same platform.
Support: `support@applink.com.bd`.

Detail: `references/08-status-codes.md` and the failure table in
`references/10-production-checklist.md`.
