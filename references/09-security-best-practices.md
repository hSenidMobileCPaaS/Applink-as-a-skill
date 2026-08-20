# Security and Best Practices

An Applink `applicationId` + `password` pair can send SMS to your entire subscriber base and
charge real money to real people's mobile accounts. It deserves the handling you would give a
production payment key, because that is what it is.

---

## 1. Credentials

### Never hardcode. Ever.

```
# ❌ Never — in source, in a test fixture, in application.yml / appsettings.json / settings.py
APP_ID   = "APP_001807"
PASSWORD = "<a real 32-character password>"

# ❌ Never — a "default" is a hardcoded credential with extra steps
password = env("APPLINK_PASSWORD") or "<a real 32-character password>"

# ❌ Never — client-side, whatever the framework calls it
APP_ID = env("NEXT_PUBLIC_APPLINK_APP_ID")     # or VITE_ / REACT_APP_ / PUBLIC_ / EXPO_PUBLIC_

# ✅ Environment variable, validated at startup, server-side only
password = require_env("APPLINK_PASSWORD")
```

### The rules

| Rule | Why |
|---|---|
| Credentials come from environment variables only | The only mechanism every host supports without putting secrets in the repo |
| `.env` is in `.gitignore`; `.env.example` holds **placeholder** values only | The example file is committed; it must never contain a real value |
| Validate at startup and **crash loudly** if missing | A silent `undefined` becomes an `E1313` at 3am instead of a clear boot error |
| One config module; nothing else reads the environment | One place to audit, one place to change |
| Never a browser-exposed prefix — `NEXT_PUBLIC_`, `VITE_`, `REACT_APP_`, `PUBLIC_`, `EXPO_PUBLIC_` — and never served through a client-facing config endpoint | Those are compiled into the browser bundle, or fetched by it, and are world-readable |
| Never in logs, error messages, stack traces, or crash reports | Redact by key name, not by value matching |
| Never in a URL or query string | Proxies, browser history and access logs capture URLs |
| Never in a Docker `ENV` line or a committed compose file | Image layers are readable by anyone who pulls the image |
| Separate credentials per environment | A leaked dev key must not touch production subscribers |
| Rotate through the portal after any suspected exposure | Rotation is only useful if you can do it fast |

### Where secrets actually live, per host

| Environment | Mechanism |
|---|---|
| Local development | `.env`, git-ignored (dotenv, python-dotenv, godotenv, `spring.config.import`, `DotNetEnv` — same file, different loader) |
| Docker / Compose | `env_file:` or Docker secrets — **not** `ENV` in the Dockerfile |
| Kubernetes | `Secret` mounted as env, ideally via External Secrets / Sealed Secrets |
| Vercel / Netlify / Railway / Render | Project environment variables, marked secret, **server-side scope** |
| AWS | Secrets Manager or SSM Parameter Store (SecureString), injected at runtime |
| GCP | Secret Manager |
| Azure | Key Vault |
| CI (GitHub Actions etc.) | Repository/environment secrets — never in workflow YAML |

### If a credential leaks

Assume it is compromised the moment it lands anywhere shared — a commit, a Slack message, a
screenshot, a log aggregator, a pasted stack trace.

1. Rotate the password in the portal **first**.
2. Deploy the new value.
3. Review app reports for unexpected SMS volume or charges.
4. Purge from git history (`git filter-repo`) — and understand that anything pushed to a
   public remote must be treated as permanently public regardless.
5. Tell Applink support if you see unauthorised usage.

### Startup validation

```
function require_env(name):
    value = env(name)
    if value is empty:
        fail("Missing required environment variable " + name +
             ". Copy .env.example to .env and fill in your Applink credentials.")
    return trim(value)
```

Fail at boot, not at first use. A misconfigured deployment should refuse to start rather than
accept traffic it cannot serve. Where the framework has a mechanism for this, use it:
`ValidateOnStart()` in .NET, `@Validated` `@ConfigurationProperties` in Spring, a module-level
factory in Python, `LoadConfig` before `ListenAndServe` in Go, a container binding in PHP.

---

## 2. Network position

**All Applink calls originate from your backend.** There is no supported client-side flow.

```
Browser / Mobile app  ──►  Your API  ──►  Applink
        (your auth)          (static IP, credentials)
```

Consequences to design for:

- **A static egress IP is a hard requirement.** IP whitelisting is enforced (`E1303`). Get it
  with `curl -4 https://api.ipify.org` **from the server that will make the calls**.
- **Serverless needs planning.** Lambda, Cloud Run and Vercel functions have rotating egress
  IPs by default. Route through a NAT Gateway with an Elastic IP, a static-IP proxy, or a
  small always-on service. Decide before choosing the host — retrofitting is painful.
- **Whitelist the minimum.** Do not add `0.0.0.0/0` or an office range "temporarily".
- **Restrict inbound too.** Your callback URLs should accept traffic only from Applink's
  egress ranges — ask support for the current list. See [07-callbacks.md](07-callbacks.md).

---

## 3. TLS verification

Some Applink hosts serve an incomplete certificate chain — they send the leaf certificate but
not the intermediate. Browsers paper over this by fetching the missing cert; strict clients do
not, and the handshake fails. Node, Python, Java, Go, PHP/cURL and .NET are all strict clients.

The workaround you will find in sample code is to turn verification off. Every stack spells it
differently and every spelling is the same mistake:

| Stack | ❌ Do not ship this |
|---|---|
| Node | `new https.Agent({ rejectUnauthorized: false })`, `NODE_TLS_REJECT_UNAUTHORIZED=0` |
| Python | `verify=False`, `ssl._create_unverified_context()` |
| Java | a `TrustManager` whose `checkServerTrusted` does nothing |
| Go | `tls.Config{ InsecureSkipVerify: true }` |
| PHP | `CURLOPT_SSL_VERIFYPEER => false` |
| .NET | `ServerCertificateCustomValidationCallback` returning `true` |

Each of them disables **all** certificate validation on that connection. Anyone able to intercept the
route can present their own certificate and read your `applicationId` and `password` in
plaintext — the exact credentials that can charge your subscribers. It converts a cosmetic
chain problem into a total compromise of the integration.

**Acceptable options, in order of preference:**

1. **Supply the missing intermediate CA explicitly.** Fetch the intermediate certificate, commit
   it as a `.pem` (it is public — it is not a secret), and point the HTTP client at it.
   Validation stays fully on:

   | Stack | ✅ How |
   |---|---|
   | Node | `new https.Agent({ ca: fs.readFileSync("certs/applink-chain.pem") })` |
   | Python | `ssl.create_default_context(cafile="certs/applink-chain.pem")` |
   | Java | import into a truststore (`keytool -importcert`) and build an `SSLContext` from it |
   | Go | `x509.NewCertPool()` + `AppendCertsFromPEM` → `tls.Config{RootCAs: pool}` |
   | PHP | `CURLOPT_CAINFO => 'certs/applink-chain.pem'` |
   | .NET | `SocketsHttpHandler` with a custom `SslClientAuthenticationOptions` trust store |

2. **Update the system trust store** on the host / in the container image, and let the default
   client work. This fixes every language at once and is often the cleanest answer.
3. **Ask Applink support to fix the chain.** It is a server misconfiguration; report it.
4. **If you must disable verification to unblock local development**, keep it a source-level
   constant that is obvious in code review and impossible to switch on by deployment
   configuration — never an environment variable or a config-file key, which are exactly the
   things that get copied into production by accident:
   ```
   # Development only. Never commit this as true.
   ALLOW_INSECURE_TLS = false
   ```

Never disable verification process-wide — `NODE_TLS_REJECT_UNAUTHORIZED=0`,
`PYTHONHTTPSVERIFY=0`, or a trust-all factory installed through
`HttpsURLConnection.setDefaultSSLSocketFactory`. Those strip TLS validation from every
unrelated dependency in the process, not just from the Applink call.

---

## 4. Subscriber data

Mobile numbers are personal data, and a subscription record says what someone pays for.

- **Enable number masking at provisioning** if you do not need the real MSISDN. The platform
  gives you a hash instead, and you cannot leak what you never held.
- **Treat `subscriberId` as an opaque string.** Do not parse it, do not strip `tel:` for
  storage, do not assume a length.
- **Mask in logs.** `tel:8801959979376` → `tel:880*******376`. Apply it in the logger, not at
  each call site, so it cannot be forgotten.
- **Never log message bodies** containing user content without a stated reason and a retention
  period. MO SMS is private communication.
- **Never log the OTP, `referenceNo`, `requestCorrelator`, or the password.**
- **The subscriber notification callback carries your `password` in its body.** Redact that
  field before the payload reaches any log, trace, error report or analytics sink — see
  [07-callbacks.md](07-callbacks.md).
- **Encrypt at rest** if you store MSISDNs, and put an actual retention policy on them.
- **Delete on unsubscribe**, or anonymise, unless you have a documented legal reason to keep
  the record.
- **Do not export subscriber lists** to analytics tools, spreadsheets, or LLM prompts.

---

## 5. Consent

This is a compliance requirement, not a nicety — Applink suspends applications over it.

- **Explicit opt-in before Register.** A checkbox pre-ticked is not consent. An imported list
  is not consent.
- **Disclose the charge before subscribing** — amount, currency (BDT), frequency, what the
  user gets.
- **Record the evidence**: user identifier, timestamp, channel (USSD `sessionId`, OTP
  `referenceNo`, web session), and the exact wording shown. Store the fact that a
  `referenceNo` was verified — never the value itself.
- **Honour opt-out immediately and everywhere.** Support `STOP` / `UNSUB` / `OFF` over MO SMS,
  a USSD menu option, and an in-app control. Call Unregister and stop sending — including
  stopping any queued messages already scheduled.
- **Never re-subscribe a user who opted out** without a fresh, separate opt-in.
- **Never charge outside what the user agreed to.** Amount and currency come from server-side
  configuration or a server-side price lookup, never from client input.

---

## 6. Application robustness

| Concern | Practice |
|---|---|
| **Timeouts** | Set an explicit timeout (10–15s) on every call. No default-infinite requests. |
| **Retries** | Only for transport errors and transient codes. Exponential backoff + jitter, capped attempts, then dead-letter. Never restart a charge with a new `externalTrxId`, and never re-run CaaS OTP Generation to retry a verification. |
| **Idempotency** | Callbacks in, charges out. Both need dedupe keys. |
| **Rate limiting** | Respect the per-second (`E1318`) and per-day (`E1319`) transaction limits. Queue and throttle rather than firing loops. Rate-limit OTP requests per number and per IP, or the application becomes an SMS-bombing tool. |
| **Circuit breaking** | Stop hammering the platform when it is failing; fail fast and recover. |
| **Observability** | Log `requestId`, `sessionId`, `externalTrxId`, `internalTrxId` and `statusCode` on every operation. These are what support traces with. |
| **Alerting** | Page on configuration-class errors (`E1303`, `E1313`, `E1309`) — they mean the integration is fully down. |
| **Broadcast guard** | `tel:all` requires a deliberate, separately-authorised code path. Never reachable by accident. |
| **Money** | Decimal types, never binary floats. |
| **Config** | Endpoint paths and base URLs in config, not scattered through code. |
| **Secrets in AI tooling** | Never paste a real `password` into a prompt, an issue, or a shared notebook. Use the placeholder from `.env.example`. |

---

## 7. Pre-commit hygiene

```gitignore
.env
.env.*
!.env.example
*.pem
*.key
```

Add a secret scanner to CI — `gitleaks`, `trufflehog`, or GitHub push protection. An
`APP_\d{6}` pattern next to a 32-hex-character string is trivially detectable, and finding it
before the push is far cheaper than rotating after.

Review generated code specifically for hardcoded credentials before committing. Assistants
reproduce sample values from documentation, and the docs' sample passwords look exactly like
real ones.
