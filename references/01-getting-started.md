# Getting Started with Applink

## What Applink is

Applink is a self-service telco platform for **Bangladesh**, built by hSenid Mobile and run on
the Banglalink network. It lets an independent developer or company ("service provider") use
carrier-grade capabilities — sending SMS, running USSD menus, managing subscriptions, charging a
subscriber's mobile account — through plain JSON-over-HTTPS APIs, without a direct operator
integration.

- **Developer portal:** <https://dev.applink.com.bd>
- **Application portal:** <https://user.applink.com.bd>
- **API documentation:** <https://dev.applink.com.bd/API_Documentation/docs/hSenidMobile_tap_api.html>
- **API overview:** <https://dev.applink.com.bd/applink-api.php>
- **Support:** `support@applink.com.bd`

### Reach

| Operator | Market | Addressing |
|---|---|---|
| Banglalink | Bangladesh | `tel:880XXXXXXXXXX` — the platform's published samples use `88019…` and `88014…` numbers |

You provision per API. An application can only call the services it was provisioned for, and
only reach the subscribers its provisioning covers — confirm both in the portal rather than
assuming, and expect charging configuration to be set per agreement.

Charging is in **BDT** only. Every CaaS call rejects any other currency.

## Applink API vs Applink Wizard

| | Applink API | Applink Wizard |
|---|---|---|
| Audience | Developers | Non-developers |
| You write the code | Yes | No |
| You host an endpoint | Yes — required | No |
| API access | Full | None (template services) |
| Customisation | Full | Template-bound |

**This skill is about the API.** Applink Wizard covers voting, contact, alert and scheduled-message
applications with no code at all. If that is what the user actually needs, say so rather than
building an integration — <https://dev.applink.com.bd/applink-wizard.php>.

## Before you provision

The portal asks for things that must already exist. Get these ready first:

1. **A hosted, publicly reachable HTTPS endpoint.** The platform pushes MO SMS, delivery
   reports, USSD requests, subscriber notifications and charging notifications *to you*.
   Without a live URL these flows cannot be configured. `localhost` will not work — use a
   tunnel (ngrok, Cloudflare Tunnel) for development only.
2. **The static egress IP of the server that will call Applink.** Applink publishes no
   IP-echo endpoint of its own, so use any public one — run it **on that server**:
   ```bash
   curl -4 https://api.ipify.org
   ```
   That value is what goes in the application's allowed host addresses. A laptop IP, a CI
   runner IP, or a rotating serverless IP will fail with `E1303` in production.
3. **A decision on charging** — amount, currency (BDT), frequency, and the reason. This must be
   disclosed to end users before they subscribe.
4. **A decision on which APIs you need.** You can only call what you provisioned.

## Creating an account

The published walkthrough is at <https://dev.applink.com.bd/register-tutorial.php>:

1. Go to <https://dev.applink.com.bd> and choose **Register as a New User**.
2. Fill in username, email address, mobile number and password, then **Continue**.
3. Enter the OTP sent to that mobile number and **Continue**.
4. Log in with the username and password.
5. On the dashboard, click **Complete** to finish the profile.
6. Fill in the organisation details, then **Next**.
7. Fill in the reconciliation details — the bank account revenue share is paid into — then
   **Complete**.

Then provision an application and configure, per API, the settings the platform needs. For SMS
that includes the **shortcode** users send to and the **keyword** that routes an SMS to your
application, and whether MO is enabled. For CaaS it includes the **charging notification URL**.
For subscription it includes the **notification URL**. See
[07-callbacks.md](07-callbacks.md) for what each URL receives.

## Approval states

1. **Draft** — you are still editing.
2. **Limited Production** — first approval. *Only whitelisted numbers can use the application.*
   This is your real integration-test environment.
3. **Production** — full subscriber base.

Budget for Limited Production being where you find every bug. Build with real credentials
against whitelisted test numbers. A non-whitelisted number gets `E1343`, and from the outside it
looks like nothing happened at all.

## Credentials

Provisioning and approval give you two values:

```
applicationId   APP_000375       — identifies the application
password        <API key>        — the key emailed to your registered address on approval
```

These are a symmetric shared secret with full authority over your application, including the
ability to charge your subscribers real money. Handle them accordingly —
[09-security-best-practices.md](09-security-best-practices.md) is not optional reading.

## Environments

Applink does not publish a separate public sandbox host. Practical approach:

| Stage | Target | How |
|---|---|---|
| Local development | `scripts/mock-applink.mjs` | Answers every endpoint from the contract and checks every body you send; point the service URLs at it |
| Integration test | Real platform, Limited Production | Real credentials, whitelisted numbers only |
| Production | Real platform, Production | Same code, different env values |

The only thing that changes between them is environment variables.

### Configure one URL per provisioned service

Your application can only call the APIs it was provisioned for. So the configuration is not a
single base URL — it is **one endpoint variable per service you enabled**:

```bash
APPLINK_APP_ID=APP_000375
APPLINK_PASSWORD=…

# Only the services enabled on this application:
APPLINK_SMS_SEND_URL=https://api.applink.com.bd/sms/send
APPLINK_SUBSCRIPTION_SEND_URL=https://api.applink.com.bd/subscription/send
APPLINK_SUBSCRIPTION_QUERY_BASE_URL=https://api.applink.com.bd/subscription/query-base
```

An unset endpoint is meaningful: it means that API is not enabled, and your client should
refuse to call it locally rather than send a request that fails `E1309` at the platform.
Pointing one of them at a mock is the whole local-development switch:

```bash
node scripts/mock-applink.mjs                         # in one terminal
APPLINK_SMS_SEND_URL=http://127.0.0.1:8089/sms/send   # in the app's environment
```

Never branch on an environment name (`NODE_ENV`, `APP_ENV`, `ASPNETCORE_ENVIRONMENT`, a Spring
profile) inside the client to pick a URL, and never inline one. Read them from config so the
same build runs everywhere. See [templates/.env.example](../templates/.env.example) — the
variable names are identical in every language — and the config module for your stack in
[templates/](../templates/README.md).

## Your first call

The cheapest way to prove credentials, whitelisting and connectivity all work is Base Size —
it needs no subscriber and charges nothing:

```bash
curl -X POST 'https://api.applink.com.bd/subscription/query-base' \
  --header 'Content-Type: application/json' \
  --data '{"applicationId":"'"$APPLINK_APP_ID"'","password":"'"$APPLINK_PASSWORD"'"}'
```

| Response | Meaning |
|---|---|
| `S1000` + `baseSize` | Everything works |
| `E1313` | Wrong `applicationId`/`password`, or the application is not active |
| `E1303` | This machine's IP is not in the allowed host addresses |
| `E1309` | Subscription API not provisioned for this application |
| Connection timeout | Network/firewall, or you are behind a proxy |

More smoke tests: [scripts/smoke-test.sh](../scripts/smoke-test.sh). Every other endpoint in the
same runnable form, with its parameters and response defined:
[13-curl-reference.md](13-curl-reference.md) — start there whatever language you will build in,
because a call proven by hand is one you cannot get wrong in code.

## Support

- Email: `support@applink.com.bd`

When you contact support, quote the `requestId`, `externalTrxId`, `internalTrxId` or `sessionId`
and the `statusCode` — that is what they trace with. The documentation calls the underlying
system **TAP**; it is the same platform.
