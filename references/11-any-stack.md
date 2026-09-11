# Implementing in Any Stack

Applink is JSON over HTTPS with a shared-secret credential pair. **Nothing about it requires
a particular language, framework or runtime.** Any stack that can make an HTTPS POST and serve
an HTTPS POST endpoint can run a complete, production-grade integration.

This document is the language-neutral specification. Build the seven components below in
whatever the host project already uses. The files in [templates/](../templates/) are the same
seven components written out in several languages — read the one closest to your stack, but
treat *this* page as the contract.

**The calls themselves are in [13-curl-reference.md](13-curl-reference.md)** — every endpoint as
a runnable curl, with every parameter defined, the response, and every response field explained,
plus all five callbacks. That page and this one are together a complete integration in a
language nobody here has written a template for: it gives you the wire, this gives you what
surrounds it.

> Rule of thumb: **match the host project.** A Django codebase gets Python, a Spring service
> gets Java, a Laravel app gets PHP. Introducing a second runtime "because the sample was in
> TypeScript" is a worse outcome than any template mismatch.

---

## The seven components

Every correct integration, in every language, is these seven things. Nothing more is required
and nothing here is optional.

| # | Component | Responsibility |
|---|---|---|
| 1 | **Config module** | The only place that reads the environment. Validates at startup, fails loudly, exposes one URL per provisioned service. |
| 2 | **Address normaliser** | The only place `tel:` is added. One function, applied at the boundary. |
| 3 | **Transport helper** | One `post(service, url, body)`: injects credentials, sets a timeout, parses JSON, branches on `statusCode`, raises a typed error. |
| 4 | **Status-code classifier** | Maps a code to one of four classes — configuration, client, user-state, transient — plus `P1003`, the one pending code, accepted by CaaS OTP Generation alone. |
| 5 | **Service wrappers** | One thin function per API (`sendSms`, `register`, `debit`, …). No call site builds a payload itself. |
| 6 | **Callback endpoints** | Five HTTPS POST routes that acknowledge with `S1000` first and process out of band. |
| 7 | **State stores** | A USSD session store (shared, TTL ~2 min) and an idempotency store for `externalTrxId`. Both must survive a restart and work across instances. |

If your port has all seven and passes the [acceptance checklist](#acceptance-checklist-for-a-port),
it is as correct as any other language's version.

---

## 1. Config

```
APPLINK_APP_ID          required — fail to start without it
APPLINK_PASSWORD        required — fail to start without it
APPLINK_<SERVICE>_URL   optional — absent means "not provisioned, refuse to call"
```

Requirements, in any language:

- One module owns environment access. Nothing else reads it — not a controller, not a job.
- Validation runs **at startup**, not at first use. A missing credential must stop the process
  from accepting traffic, not surface as `E1313` at 3am.
- Resolving an unset endpoint raises a local error naming the missing variable. That is the
  guard that turns "the API was never provisioned" into a clear boot-time message instead of
  `E1309` from the platform.
- A redacted `describeConfig()`-style dump is worth having: application id, `***redacted***`
  for the password, and the list of enabled services.

The variable names are fixed across every language — see
[templates/.env.example](../templates/.env.example). Keep them identical so a polyglot estate
has one deployment story.

## 2. Address normalisation

```
input                        output
tel:8801959979376        →   tel:8801959979376   (already prefixed — return unchanged)
tel:<masked value>       →   unchanged           (opaque — never parse)
+880 19 5997 9376        →   tel:8801959979376
008801959979376          →   tel:8801959979376
01959979376              →   tel:8801959979376   (local form → country code)
""                       →   error
```

One function. Never concatenate `tel:` at a call site. A separate `maskAddress()` for logging
that keeps the first three and last three characters and stars the middle.

The platform's own samples are inconsistent about the `+`: the SMS documentation writes
`tel:+8801959979376`, and subscription, OTP and CaaS all write `tel:8801973579363`. Strip it,
so one helper serves every endpoint — and if an SMS send returns `E1325`, try the `+` form for
that endpoint alone and report it to support.

## 3. The transport helper

The whole platform is one request shape, so it is one function:

```
function post(service, url, body, acceptedCodes = []):
    payload = { applicationId: config.appId, password: config.password } merged with body
    response = HTTP POST url
                 header Content-Type: application/json;charset=utf-8
                 body   json(payload)          # the JSON library serialises; never concatenate
                 timeout 15 seconds            # never unbounded
    data = json(response.body)                 # non-JSON body is a transport error

    if data.statusCode == "S1000":        return data
    if data.statusCode in acceptedCodes:  return data   # only ["P1003"], only on CaaS OTP Generation
    raise ApplinkError(data.statusCode, data.statusDetail, service, data)
```

**The body the wrappers hand to `post()`** is a map of strings. Every value Applink takes is a
JSON string — `"amount": "5.00"`, `"action": "1"`, `"version": "1.0"`, `"encoding": "440"` —
and the identifiers that come back (`requestCorrelator`, `referenceNo`, `requestId`) must stay
strings all the way through your storage and back into the next call; a 31-digit
`requestCorrelator` held as a number comes back as `8.80144223314617e+30`. The only non-string
values are the arrays `destinationAddresses` / `subscriberIds` and the object
`applicationMetaData`, both of strings. An optional field with no value is left out of the map
— not set to `null`, `""`, `{}` or `[]`. Each endpoint's exact parameter set is in
[13-curl-reference.md](13-curl-reference.md); `version` is on SMS Send and USSD Send only.

**The data `post()` returns** is read defensively: `statusCode` decides, every other field is
read with a default (on a failure the endpoint's own fields are usually absent), numbers arrive
as strings and are parsed at the boundary (`baseSize` to an integer, money to a decimal type),
and unknown fields are ignored rather than rejected. Typed response models should mark every
field except `statusCode` optional.

Three things the pseudocode says that are easy to get wrong in a port:

- **The HTTP status is never consulted.** Applink returns 200 for application-level failures.
  If your HTTP library raises on non-2xx, that is fine — but success is decided by
  `statusCode` alone.
- **The timeout is a constant, not configuration.** It is a property of the protocol.
- **Credentials are injected here, once.** No wrapper accepts them as an argument, so no call
  site can pass the wrong ones or log them.

## 4. Status-code classification

The four classes and their members are in [08-status-codes.md](08-status-codes.md) and, as
machine-readable data, in [`catalog/applink-api.json`](../catalog/applink-api.json) under
`statusCodes` — generate the sets from the catalog rather than retyping them.

The error type your language uses (exception, error struct, result variant) needs three
things: the code, the detail, and a way to ask `retryable?` and `configuration?`.

Two things a port must get right that a naive `statusCode == "S1000"` check does not:

| Situation | What the code must do |
|---|---|
| `P1003` from CaaS OTP Generation | Treat as **pending**, not success. Persist `requestCorrelator`, keep the ledger row open, and continue to CaaS OTP Verification |
| Register / unregister | Applink publishes **no** benign duplicate-state codes. Decide the outcome from `subscriptionStatus` in the response body, not from an error code |

And one that is purely negative: **do not invent codes.** The twenty-nine published codes in
[08-status-codes.md](08-status-codes.md) are the whole list.

## 5. Service wrappers

One function per API, each a single `post()` call. Two carry extra local guards regardless of
language:

- **Broadcast** (`tel:all`) lives in its own function with an explicit confirmation argument,
  so it can never be reached by an ordinary code path.
- **Charging is two wrappers, not one.** `startCharge()` posts to `/caas/direct/debit`,
  requires a caller-supplied `externalTrxId`, and returns the `requestCorrelator` for the
  caller to persist. `confirmCharge()` posts to `/caas/otp/verify` with that
  `requestCorrelator` as `referenceNo`. Neither retries internally, and neither may call the
  other — a timeout does not mean the charge failed, and re-running the first one starts a
  second charge.

## 6. Callback endpoints

Five routes, one contract: respond HTTP 200 with
`{"statusCode":"S1000","statusDetail":"Success"}`, immediately, before doing any work. Full
rules in [07-callbacks.md](07-callbacks.md).

"Process out of band" means different things per stack, and picking the wrong one is the most
common porting mistake:

| Stack | Acknowledge-first mechanism |
|---|---|
| Node / TypeScript | Push to a queue, return the response; never `await` the work |
| Python (FastAPI/Django) | `BackgroundTasks`, Celery, RQ, or a thread pool — **not** a bare `await` |
| Java (Spring) | `@Async` method, or hand off to an `ExecutorService` / message broker |
| Go | Send to a buffered channel consumed by a worker goroutine (bounded, not a bare `go func`) |
| PHP | Queue the payload (Laravel queues, Redis list, database table) — PHP-FPM has no "after response" worker of its own |
| .NET | `IHostedService` + `Channel<T>`, or a background queue |
| Serverless | Write to SQS/PubSub and return; do not do the work in the request lifetime |

The USSD timeout is measured in seconds. Anything that does a database write chain or an
outbound HTTP call before responding will lose sessions in production.

## 7. State stores

| Store | Key | TTL | Must survive |
|---|---|---|---|
| USSD session | `sessionId` | ~2 minutes | Restart, deploy, and routing to another instance |
| Charge ledger | `externalTrxId` (+ `requestCorrelator`) | Until reconciled | Everything — this one prevents double-charging, and without `requestCorrelator` the charge cannot be completed at all |
| OTP session | your session id → `referenceNo` | 5 minutes | The verification step; `referenceNo` must never reach the client |
| Callback dedupe | the documented key per callback | Hours | Redelivery |

An in-process map or dictionary is a development convenience in **every** language. Redis,
Memcached with persistence, or a database table are the production answers. The failure mode
is identical whether the map is a JS `Map`, a Python `dict`, a Go `map`, or a static
`HashMap` — the second instance cannot see it and the user's menu dies mid-flow.

---

## Per-language notes

The parts that genuinely differ between stacks, and the answer for each.

| Concern | Node / TS | Python | Java | Go | PHP | .NET |
|---|---|---|---|---|---|---|
| HTTP client | `https` / `fetch` / undici | `urllib.request`, `httpx`, `requests` | `java.net.http.HttpClient` | `net/http` | cURL extension, Guzzle | `HttpClient` (via `IHttpClientFactory`) |
| JSON | built in | `json` | Jackson / Gson | `encoding/json` | `json_encode` / `json_decode` | `System.Text.Json` |
| Env loading | `process.env` (+ dotenv in dev) | `os.environ` (+ python-dotenv) | `System.getenv` / Spring `@Value` | `os.Getenv` | `getenv` / `$_ENV` | `IConfiguration` + `IOptions<T>` |
| Startup validation | throw at module load | raise in a module-level factory | fail fast in a `@PostConstruct` / bean init | `panic` in `init()`/`LoadConfig` | throw in the container binding | `ValidateOnStart()` |
| Money | **not** `number` — decimal string or a decimal library | `decimal.Decimal` | `BigDecimal` | `shopspring/decimal` or minor-unit ints | `bcmath` / string | `decimal` |
| Schema validation of callbacks | zod / valibot | pydantic | Bean Validation / Jackson strict binding | struct tags + explicit checks | manual guards or a validator | data annotations / `System.Text.Json` strict |
| TLS chain fix | `https.Agent({ ca })` | `ssl.create_default_context(cafile=…)` | `KeyStore` / `SSLContext`, or `keytool -importcert` | `x509.CertPool` + `tls.Config.RootCAs` | `CURLOPT_CAINFO` | `SocketsHttpHandler` + custom root store |
| Never do this | `rejectUnauthorized: false`, `NODE_TLS_REJECT_UNAUTHORIZED=0` | `verify=False` | trust-all `TrustManager` | `InsecureSkipVerify: true` | `CURLOPT_SSL_VERIFYPEER=0` | callback returning `true` unconditionally |

### Serialising the request and parsing the response, per stack

The wire rules are the same everywhere: every request value a string, only that endpoint's
fields, optional fields omitted, exact field names — and on the way back, only `statusCode`
guaranteed, numbers arriving as strings, unknown fields ignored. What differs is how each JSON
library breaks those rules by default. These are the defaults that turn a correct-looking
client into `E1312`, `E1855` or a parser crash:

| Stack | Request: what goes wrong by default | Fix | Response: what goes wrong by default | Fix |
|---|---|---|---|---|
| JavaScript / TypeScript | `null` is serialised (only `undefined` is dropped); values read from forms or `Number()` go out as numbers | Build the object with only the fields you have, as strings | A typed model makes fields look present on a failure body | Every field but `statusCode` optional; `Number.parseInt(String(x), 10)` for `baseSize` |
| Python (`json`, pydantic) | `None` becomes `null`; `Decimal` raises `TypeError`, so people reach for `float` | Drop `None` keys; `f"{amount:.2f}"` on a `Decimal`; pydantic `model_dump(exclude_none=True, by_alias=True)` and `Field(alias="Currency")` | A pydantic field without a default raises on a failure body | `Optional[...] = None` for all but `statusCode`; extra fields are ignored by default |
| Java (Jackson) | POJO `null`s are written; a field named `currency` is written as `currency`; `Map.of` throws on a `null` value; `BigDecimal` is written as a number | `@JsonInclude(Include.NON_NULL)`, `@JsonProperty("Currency")`, a `LinkedHashMap`, `String` amounts | `FAIL_ON_UNKNOWN_PROPERTIES` is **on** by default — one new platform field breaks every call | `@JsonIgnoreProperties(ignoreUnknown = true)`; `@JsonProperty("TotalAmount")` on the notification |
| Kotlin (kotlinx.serialization) | `null`s are written unless `explicitNulls = false`; properties left at their default value — `val version = "1.0"` — are **not written at all** unless `encodeDefaults = true` | `Json { explicitNulls = false; encodeDefaults = true }`, `@SerialName("Currency")` | Unknown keys throw by default; a non-null property with no default throws when missing | `ignoreUnknownKeys = true`; nullable properties with defaults |
| Go (`encoding/json`) | A nil map, slice or pointer becomes `null`; an untagged `Amount` field is written as `"Amount"` | Tag every field (`json:"amount"`, `json:"Currency"`) and add `omitempty` to optional ones; `string` for money | A number decoded into `any` becomes `float64` | Decode into `string` fields, or accept both types as `templates/go` does for `baseSize` |
| PHP | `json_encode([])` is `[]` — an array where an object belongs; ints and floats stay numbers (`5.00` is written `5.0`) | Omit empty optional fields; cast every value to `string` | `json_decode` without `true` gives objects, and reading a missing key raises a warning | `json_decode($raw, true)` and `$data['x'] ?? default` |
| C# (`System.Text.Json`) | `PostAsJsonAsync` uses web defaults, which **camel-case POCO properties** — `Currency` is sent as `currency`; `null`s are written; `decimal` is a number | `[JsonPropertyName("Currency")]` (dictionary keys are sent verbatim, which is why `templates/csharp` uses one), `JsonIgnoreCondition.WhenWritingNull`, `string` amounts | `GetString()` throws on a number; `required` members throw on a failure body | Check `ValueKind`; nullable members |
| Ruby | `nil` becomes `null`; `BigDecimal#to_s` is scientific (`"0.5e1"`) | `hash.compact`; `amount.to_s("F")`, padded to two decimals | Missing keys are silently `nil` — fine — but `Integer(nil)` raises | `Integer(data.fetch("baseSize", "0"))` |
| Rust (serde) | `Option::None` becomes `null`; `rename_all = "camelCase"` never produces `Currency` | `#[serde(skip_serializing_if = "Option::is_none")]`, `#[serde(rename = "Currency")]`, `String` amounts | A missing non-`Option` field fails the whole parse | `Option<String>` or `#[serde(default)]`; unknown fields are ignored unless `deny_unknown_fields` |
| Dart | `jsonEncode` writes `null`s | `@JsonSerializable(includeIfNull: false)`, `@JsonKey(name: 'Currency')` | `as String` throws on a missing field | `as String?` with a default |

Whatever the stack, prove it rather than trust it — see
[Proving the bodies in any language](#proving-the-bodies-in-any-language).

**Client-side prefixes to never use on an Applink variable**, since every framework has one:
`NEXT_PUBLIC_`, `VITE_`, `REACT_APP_`, `PUBLIC_` (SvelteKit), `EXPO_PUBLIC_`,
`NG_` build-time replacements, `@Value` injected into a browser-served config endpoint. They
all publish the password to the browser.

### Runtimes that need a decision before you build

- **Serverless functions** (Lambda, Cloud Run, Vercel, Azure Functions) have rotating egress
  IPs, and Applink enforces IP allow-listing (`E1303`). Route through a NAT gateway with a
  fixed IP, a static-IP proxy, or a small always-on service. This is a hosting decision, not a
  code one, and retrofitting it is painful.
- **Edge runtimes** (Cloudflare Workers, Deno Deploy, Vercel Edge) additionally give you no
  control over egress IP at all. Do not put Applink calls there.
- **Mobile and desktop clients** never call Applink directly, in any language. They call your
  backend.
- **Short-lived CLI or cron processes** are fine, provided they run on a whitelisted host and
  read credentials from the environment rather than a config file in the repo.

---

## Proving the bodies in any language

[`scripts/mock-applink.mjs`](../scripts/mock-applink.mjs) is a local stand-in for Applink that
checks every request body against the contract — JSON types, field names, required fields,
fields that belong to another endpoint — and answers the way the platform does. It does not
care what language sent the request, so it is the same proof for a Rails app as for a Spring
service.

```bash
node scripts/mock-applink.mjs                      # http://127.0.0.1:8089, one line per request

export APPLINK_SUBSCRIPTION_QUERY_BASE_URL=http://127.0.0.1:8089/subscription/query-base
export APPLINK_CAAS_DEBIT_URL=http://127.0.0.1:8089/caas/direct/debit
# … one per service, then run your wrappers or your test suite
```

Each request is logged `OK`, or `BAD` with the reason — and a bad body gets the `E1312` the
platform would send, so your error path runs too. A first path segment picks the response,
which is how you test the reading side:

| Base URL | Response | Your code must |
|---|---|---|
| `http://127.0.0.1:8089` | The endpoint's published sample | Parse it: `P1003` and the exact 31-digit `requestCorrelator` on a charge, `subscriptionStatus` by prefix, `baseSize` as an integer |
| `…:8089/fail` (or `/fail-E1326`) | `statusCode` and `statusDetail` only | Raise its typed error with that code — not crash on the missing fields |
| `…:8089/variant` | Only the fields the next step needs, numeric strings as bare numbers, one unknown field | Carry on exactly as with the sample |
| `…:8089/timeout` | Nothing for 20 seconds | Give up at its own timeout — and on the charging path, not retry |

`GET http://127.0.0.1:8089/__report` returns every request with its verdict, for a test to
assert on. The mock listens on loopback only and makes no outbound calls.

The six shipped templates are held to exactly this in CI:
[`tests/conformance/run.mjs`](../tests/conformance/run.mjs) builds each one as written, calls
every wrapper under the sample, variant and failure responses, and fails on any body that does
not validate or any response it misreads. A port to a new language is done when it would pass
the same run.

---

## Acceptance checklist for a port

A port in a language with no template is done when all of these hold. Check them against the
code, not against intent.

1. Exactly one module reads the environment, and the process refuses to start with
   `APPLINK_APP_ID` or `APPLINK_PASSWORD` missing.
2. Calling a service whose URL variable is unset raises a local error naming the variable —
   no request leaves the process.
3. Exactly one function produces a `tel:` address; a grep for `"tel:"` finds it and nothing
   else.
4. Success is decided by `statusCode == "S1000"`, never by the HTTP status.
   Every request body is built from a map of strings by the JSON library: no numeric, boolean
   or `null` values, no optional field sent empty, and exactly the parameters the curl
   reference lists for that endpoint. Every wrapper, pointed at `scripts/mock-applink.mjs`,
   produces zero `BAD` lines — and reads the `/fail` and `/variant` responses correctly.
5. `P1003` is handled as pending: the ledger row stays open, `requestCorrelator` is persisted,
   and nothing downstream treats it as a completed charge.
6. Every outbound call has an explicit timeout.
7. Retries cover transport errors and transient codes only, with backoff — and the debit path
   has no automatic retry at all.
8. `externalTrxId` is generated and persisted **before** the first charging call, and reused
   unchanged on any resolution attempt. No code path re-runs CaaS OTP Generation to retry a
   verification.
9. All five callback routes return `{"statusCode":"S1000","statusDetail":"Success"}` with
   HTTP 200 for valid, malformed, wrong-application and duplicate payloads alike.
10. Callback work happens after the response, through the stack's real background mechanism.
11. The USSD session store is shared across instances and expires entries.
12. Logs contain `requestId` / `sessionId` / `externalTrxId` / `internalTrxId` / `statusCode`,
    and never a password, an OTP, a `referenceNo`, a `requestCorrelator`, or an unmasked
    subscriber address — including the `password` field the subscriber notification carries.
13. TLS verification is on, with the intermediate CA supplied if the handshake needs it.

Verify 4 against [the mock](#proving-the-bodies-in-any-language), the rest of 1–8 by reading
the code; verify 9–11 with
[scripts/test-callbacks.sh](../scripts/test-callbacks.sh), which is plain curl and works
against a handler in any language. Verify the whole outbound path with
[scripts/smoke-test.sh](../scripts/smoke-test.sh) (or `smoke-test.ps1`).

---

## Shipped templates

| Directory | Contents | Notes |
|---|---|---|
| [templates/typescript/](../templates/typescript/) | config, client, types, Next.js callback routes, USSD session store | The most complete set; read it for the full commentary |
| [templates/python/](../templates/python/) | config, client, FastAPI callback routes, USSD session store | Standard library only; `httpx`/`requests` notes inline |
| [templates/java/](../templates/java/) | config, client, Spring callback controller | Java 17 `HttpClient`, Jackson |
| [templates/go/](../templates/go/) | config, client, callback handlers | Standard library only |
| [templates/php/](../templates/php/) | config, client, callback front controller | cURL extension; Laravel notes inline |
| [templates/csharp/](../templates/csharp/) | options, typed client, ASP.NET Core callback endpoints | `IHttpClientFactory`, `System.Text.Json` |

No template for your stack — Ruby, Rust, Kotlin, Elixir, Scala, Dart on a server? Take the
calls from [13-curl-reference.md](13-curl-reference.md), implement the seven components above
around them, use the closest template for the shape, and run the acceptance checklist. The
contract also ships as [`catalog/applink-api.json`](../catalog/applink-api.json), plain JSON
that every language can read directly.

---

## Tooling versus stack

`tools/applink.mjs` runs on Node. That is a property of the *documentation tool*, not of your
integration — it makes no network calls and never sees a credential. If Node is not available on
your machine, nothing is lost: [13-curl-reference.md](13-curl-reference.md) is the same contract
as prose, and the underlying data is in
[`catalog/applink-api.json`](../catalog/applink-api.json):

```bash
jq '.services[] | select(.id=="caas-otp-generation")' catalog/applink-api.json
python -c "import json;print(json.load(open('catalog/applink-api.json'))['statusCodes']['E1303'])"
```

Same contract, no runtime required.
