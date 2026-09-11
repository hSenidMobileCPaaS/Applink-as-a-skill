#!/usr/bin/env node
/**
 * Generate references/13-curl-reference.md from catalog/applink-api.json.
 *
 *   node scripts/build-curl-reference.mjs           write the document
 *   node scripts/build-curl-reference.mjs --check   fail if it is stale (used in CI)
 *
 * The curl reference is *the* way this skill hands over an implementation:
 * every endpoint, every parameter definition, a runnable request and the
 * response it returns. There is no code generator — a curl and the host
 * project's HTTP client cover every language equally.
 *
 * It is generated rather than hand-written for the same reason the agent rule
 * copies are: a parameter that drifts from the catalog becomes a wrong parameter
 * in someone's production integration.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  callbackReplayCurl,
  catalog,
  lookupStatusCode,
  repoRoot,
  toCurl,
  urlFor,
} from "../tools/catalog.mjs";

const OUT = join(repoRoot, "references", "13-curl-reference.md");
const check = process.argv.includes("--check");

/* ── Helpers ─────────────────────────────────────────────────────────────── */

const md = (s) => String(s).replace(/\|/g, "\\|");

/** Anchor for the in-page index, matching GitHub's slug rules. */
const anchor = (heading) =>
  heading
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9 -]/g, "")
    .trim()
    .replace(/\s+/g, "-");

/**
 * The example body for a service: credentials as environment placeholders, then
 * every parameter the official sample carries, in the order the contract
 * declares them. Required parameters with no sample value get a named
 * placeholder so nothing runnable is silently missing.
 *
 * Optional parameters whose sample value only works on the documentation's own
 * application (an `exampleNote` in the catalog) are left out, so the request
 * runs unchanged against yours; they are listed under it instead.
 */
function exampleBody(service) {
  const body = {
    applicationId: "$APPLINK_APP_ID",
    password: "$APPLINK_PASSWORD",
  };
  for (const p of service.parameters || []) {
    if (p.name === "applicationId" || p.name === "password") continue;
    if (!p.required && p.exampleNote) continue;
    const sample = service.sampleRequest?.[p.name];
    if (sample !== undefined) body[p.name] = sample;
    else if (p.required) body[p.name] = `<${p.name}>`;
  }
  return body;
}

/** The optional parameters left out of the example body, and why. */
function leftOutList(service) {
  const left = (service.parameters || []).filter((p) => !p.required && p.exampleNote);
  if (!left.length) return null;
  return left
    .map((p) => {
      const sample = service.sampleRequest?.[p.name];
      const shown = sample === undefined ? "" : ` — published sample \`${JSON.stringify(sample)}\``;
      return `- \`${p.name}\`: ${md(p.exampleNote)}${shown}`;
    })
    .join("\n");
}

/**
 * Enum values are shown as the JSON strings they are on the wire. Written bare,
 * `0` and `440` read as numbers — and a number is exactly what gets sent.
 */
function parameterTable(spec, { label = "Parameter", required = "Required" } = {}) {
  const rows = spec.map((p) => {
    const type = p.enum ? `string (enum)` : p.type;
    const values = p.enum ? ` One of ${p.enum.map((v) => `\`"${v}"\``).join(", ")}.` : "";
    const need = p.required ? `**${required}**` : "Optional";
    return `| \`${p.name}\` | ${type} | ${need} | ${md(p.description)}${md(values)} |`;
  });
  return [`| ${label} | Type | | Definition |`, `|---|---|---|---|`, ...rows].join("\n");
}

function responseTable(fields) {
  return [
    `| Field | Type | Meaning |`,
    `|---|---|---|`,
    ...fields.map((f) => `| \`${f.name}\` | ${f.type} | ${md(f.description)} |`),
  ].join("\n");
}

/**
 * Per-code rows carry only the fix specific to that code; the generic per-class
 * advice is stated once in the legend rather than repeated on every row.
 */
function statusTable(codes, entryId) {
  const rows = codes.map((code) => {
    const s = lookupStatusCode(code);
    const specificFix = catalog.statusCodes[s.code]?.fix;
    const benign = s.benignFor?.includes(entryId) ? " **Treat this as success.**" : "";
    const fix = specificFix ? ` → ${md(specificFix)}` : "";
    return `| \`${s.code}\` | ${s.class} | ${md(s.description)}${fix}${benign} |`;
  });
  return [`| Code | Class | Meaning |`, `|---|---|---|`, ...rows].join("\n");
}

const CLASS_LEGEND =
  "`configuration` fix the portal, not the code — the integration is down, not one request · " +
  "`client` fix the payload or the user's input · " +
  "`user-state` the user is not eligible right now; tell them, do not loop · " +
  "`transient` retry with capped exponential backoff. " +
  "Full table: [08-status-codes.md](08-status-codes.md).";

const json = (value) => "```json\n" + JSON.stringify(value, null, 2) + "\n```";

/**
 * A runnable request, built by the same function `applink curl` uses so the two
 * cannot drift. The heredoc is unquoted so the credential variables expand.
 */
function requestCurl(service) {
  return ["```bash", toCurl(service, exampleBody(service)), "```"].join("\n");
}

/** A request that replays what Applink sends, against your own handler. */
function callbackCurl(cb) {
  return ["```bash", callbackReplayCurl(cb), "```"].join("\n");
}

/** Fields that belong to another endpoint, or are misspelt, and what to send instead. */
function wrongFieldsList(service) {
  const entries = Object.entries(service.wrongFields || {});
  if (!entries.length) return null;
  return entries.map(([field, fix]) => `- ✗ \`${field}\` — ${fix}`).join("\n");
}

/** How the calling code must read what comes back. */
function handlingList(service) {
  const h = service.responseHandling;
  const codes = h.expect.map((c) => `\`${c}\``).join(" or ");
  const lines = [
    `1. **Decide from \`statusCode\`**, never from the HTTP status. Expected: ${codes}. ${h.outcome}`,
  ];
  let n = 2;
  if (h.expectFields?.length) {
    lines.push(
      `${n++}. **On ${codes}, read** ${h.expectFields.map((f) => `\`${f}\``).join(", ")} — ` +
        `present on the expected outcome; read them with a default anyway.`
    );
  }
  if (h.persist?.length) {
    lines.push(`${n++}. **Persist** ${h.persist.join("; ")}.`);
  }
  if (h.next) lines.push(`${n++}. **Then:** ${h.next}`);
  lines.push(
    `${n++}. **Any other \`statusCode\`:** rely on \`statusCode\` and \`statusDetail\` only — the fields above ` +
      `may be absent — and handle it by class from the table below.`
  );
  return lines.join("\n");
}

/* ── Document ────────────────────────────────────────────────────────────── */

const services = catalog.services;
const callbacks = catalog.callbacks;

const preamble = `<!-- Generated from catalog/applink-api.json by scripts/build-curl-reference.mjs. Do not edit directly. -->

# Every Endpoint as curl

The whole Applink contract at the wire: each endpoint, each parameter defined, a request you
can run, and the response it returns. No SDK, no generated code, no tooling of any kind between
you and the platform.

**Write the integration from this page, in whatever language the project already uses.** There
is deliberately no code generator in this skill: a generator would privilege a handful of
languages and rot as their idioms move, while the request below is the same call in all of
them. The body, the headers and the branching are identical whether it goes out through
\`requests\` in Python, \`HttpClient\` in Java or .NET, \`net/http\` in Go, Guzzle in PHP,
\`Net::HTTP\` in Ruby, \`reqwest\` in Rust, \`HTTPoison\` in Elixir or \`fetch\` in Node. Translate the
curl into the project's own HTTP client and idiom; keep everything else exactly as specified.

Run these against a real application to confirm provisioning and credentials before writing a
line of code — a working curl removes half the possible causes when the integration then fails.

---

## The shape of every call

\`\`\`
POST  ${catalog.baseUrls.primary}/<service-path>
Content-Type: ${catalog.conventions.contentType}
\`\`\`

- **Credentials travel in the JSON body**, as \`applicationId\` and \`password\`. There are no
  headers, no tokens, no signatures and no OAuth on this platform.
- **Every value is a JSON string** — ${catalog.conventions.wireTypes.rule.replace(/^Every request value is a JSON string — /, "")}
- **Send exactly the parameters listed for that endpoint** — no more, no fewer, spelt exactly as
  shown. ${catalog.conventions.wireTypes.version}
- **Every response is HTTP 200**, including failures. ${catalog.conventions.responseEnvelope.criticalNote}
- Every response carries \`${catalog.conventions.responseEnvelope.always.join("\` and \`")}\`; most also carry
  \`${catalog.conventions.responseEnvelope.common.join("\` and \`")}\`.
- Subscriber addresses are always \`${catalog.conventions.addressing.format}\`, with no spaces. Send
  \`tel:8801959979376\` — the form the subscription, OTP and CaaS samples use. The published SMS
  samples write the same address with a \`+\`; both forms appear in the platform's own
  documentation, so normalise to one in a single helper.
- A masked application receives an opaque value instead of a number. Do not parse it — send back
  exactly what you received.
- **Charging takes two calls.** CaaS OTP Generation returns \`P1003\` and sends the subscriber an
  OTP; the money moves at CaaS OTP Verification, and the outcome is settled by the charging
  notification callback.

### Getting the body exactly right

${catalog.conventions.wireTypes.names}

| Send | Never |
|---|---|
${catalog.conventions.wireTypes.examples.map(([good, bad]) => `| \`${good}\` | \`${bad}\` |`).join("\n")}

In code, build the body as a map or object of strings and let the JSON library serialise it;
never assemble JSON by string concatenation. \`node tools/applink.mjs validate <id> '<json>'\`
catches every mistake in the table above, and names the field an endpoint expects when you send
one that belongs to another.

### Reading the response

${catalog.conventions.responseEnvelope.reading.map((r) => `- ${r}`).join("\n")}

Each endpoint below spells out its expected \`statusCode\`, what to read and persist from the
body, and the next step. \`node tools/applink.mjs response <id> '<body>'\` checks a real response
against the same rules.

## Before you run anything

Export your credentials and the endpoints your application is provisioned for. Every command on
this page reads them from the environment, so nothing here contains a credential and nothing you
copy can commit one.

\`\`\`bash
export APPLINK_APP_ID='APP_XXXXXX'
export APPLINK_PASSWORD='…'                 # from the portal — never commit it
${[...new Map(services.map((s) => [s.envVar, `export ${s.envVar}='${urlFor(s)}'`])).values()].join("\n")}

: "\${APPLINK_APP_ID:?not set}" "\${APPLINK_PASSWORD:?not set}"   # fail here, not as E1313
\`\`\`

One variable per provisioned service, never one shared base URL: an application can only call
the APIs it was provisioned for, so an endpoint you have no variable for is one you must not
call.

The requests below splice the password into JSON text. If it contains a \`"\` or a \`\\\`, build
the body with \`jq\` instead so it is escaped:

\`\`\`bash
jq -n --arg id "$APPLINK_APP_ID" --arg pw "$APPLINK_PASSWORD" '{applicationId: $id, password: $pw}' |
  curl -sS -X POST "$APPLINK_SUBSCRIPTION_QUERY_BASE_URL" \\
    -H 'Content-Type: ${catalog.conventions.contentType}' --max-time 15 -d @-
\`\`\`

Windows PowerShell, where \`curl\` is an alias for \`Invoke-WebRequest\` and the syntax differs:

\`\`\`powershell
$body = @{ applicationId = $env:APPLINK_APP_ID; password = $env:APPLINK_PASSWORD } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri $env:APPLINK_SUBSCRIPTION_QUERY_BASE_URL \`
  -ContentType '${catalog.conventions.contentType}' -Body $body
\`\`\`

Three flags in every request below, all deliberate: \`-sS\` prints errors but not a progress bar,
\`--max-time 15\` stops a hung call holding a request thread, and \`-d @- <<REQUEST\` reads the body
from a heredoc so the credential variables expand and the JSON stays readable.

**Start with Base Size.** It needs no subscriber, costs nothing and touches no one, so it is
the safest way to prove that your credentials, your provisioning and your egress IP all work.

---

## Endpoint index

| Service | Endpoint | Environment variable |
|---|---|---|
${services
  .map(
    (s) =>
      `| [${s.name}](#${anchor(s.name)}) | \`POST ${urlFor(s)}\` | \`${s.envVar}\` |`
  )
  .join("\n")}

| Callback | Applink calls | Configured in |
|---|---|---|
${callbacks
  .map(
    (c) =>
      `| [${c.name}](#${anchor(c.name)}) | \`POST <your-host>${c.suggestedPath}\` | ${c.configuredIn} |`
  )
  .join("\n")}

---

# Outbound services — you call Applink
`;

function serviceSection(s) {
  const parts = [];
  parts.push(`---\n`);
  parts.push(`## ${s.name}\n`);
  parts.push(`${s.summary}\n`);

  const facts = [
    `| | |`,
    `|---|---|`,
    `| **Endpoint** | \`POST ${urlFor(s)}\` |`,
    `| **Environment variable** | \`${s.envVar}\` |`,
    `| **Content type** | \`${catalog.conventions.contentType}\` |`,
    `| **Full guide** | [${s.reference.replace("references/", "")}](${s.reference.replace("references/", "")}) |`,
  ];
  parts.push(facts.join("\n") + "\n");

  if (s.movesMoney) {
    parts.push(
      `> **This call moves real money.** \`${s.idempotencyKey}\` is the identifier that ties this\n` +
        `> attempt to one logical charge: persist it *before* sending, and reuse it unchanged on every\n` +
        `> resolution attempt. Starting the charge again with a fresh one bills a real person twice.\n`
    );
  }
  if (s.requiresProvisioning) {
    parts.push(
      `> **Needs provisioning:** ${s.requiresProvisioning}. Without it the call fails no matter how\n` +
        `> correct the payload is.\n`
    );
  }

  parts.push(`### Request parameters\n`);
  parts.push(parameterTable(s.parameters) + "\n");

  parts.push(`### Request\n`);
  parts.push(requestCurl(s) + "\n");

  const leftOut = leftOutList(s);
  if (leftOut) {
    parts.push(`Optional, and left out above because the value is yours to supply:\n`);
    parts.push(leftOut + "\n");
  }

  const wrong = wrongFieldsList(s);
  if (wrong) {
    parts.push(`Fields that do not belong in this body:\n`);
    parts.push(wrong + "\n");
  }

  const expect = s.responseHandling.expect;
  parts.push(`### Response\n`);
  const others = expect.slice(1).map((c) => `\`"${c}"\``).join(", ");
  parts.push(
    expect[0] === "S1000"
      ? `HTTP 200. The expected outcome is \`statusCode: "S1000"\`.\n`
      : `HTTP 200. The expected outcome is **\`statusCode: "${expect[0]}"\`** — pending, not a completed ` +
          `operation.${others ? ` Treat ${others} the same way if it ever arrives here.` : ""}\n`
  );
  parts.push(json(s.sampleResponse) + "\n");

  if (s.responseFields?.length) {
    parts.push(`### Response fields\n`);
    parts.push(responseTable(s.responseFields) + "\n");
  }

  parts.push(`### Handling the response\n`);
  parts.push(handlingList(s) + "\n");

  if (s.statusCodes?.length) {
    parts.push(`### Status codes for this endpoint\n`);
    parts.push(statusTable(s.statusCodes, s.id) + "\n");
    parts.push(CLASS_LEGEND + "\n");
  }

  if (s.rules?.length) {
    parts.push(`### Rules\n`);
    parts.push(s.rules.map((r) => `- ${r}`).join("\n") + "\n");
  }

  return parts.join("\n");
}

function callbackSection(c) {
  const parts = [];
  parts.push(`---\n`);
  parts.push(`## ${c.name}\n`);
  parts.push(`${c.summary}\n`);

  parts.push(
    [
      `| | |`,
      `|---|---|`,
      `| **Direction** | Applink → you. There is nothing to call. |`,
      `| **Your route** | \`POST <your-host>${c.suggestedPath}\` (the path is yours; register it in the portal) |`,
      `| **Configured in** | ${c.configuredIn} |`,
      `| **Deduplicate on** | \`${c.dedupeKey}\` |`,
      `| **Full guide** | [${c.reference.replace("references/", "")}](${c.reference.replace("references/", "")}) |`,
    ].join("\n") + "\n"
  );

  parts.push(`### Payload fields\n`);
  parts.push(parameterTable(c.fields, { label: "Field", required: "Always sent" }) + "\n");

  parts.push(`### What arrives\n`);
  parts.push(json(c.samplePayload) + "\n");

  parts.push(`### What you must respond\n`);
  parts.push(`HTTP 200, immediately, before doing any work:\n`);
  parts.push(json(catalog.conventions.callbackAck) + "\n");

  parts.push(`### Replay it against your own handler\n`);
  if ("applicationId" in c.samplePayload) {
    parts.push(
      `\`applicationId\`${"password" in c.samplePayload ? " and `password` come" : " comes"} from your environment, ` +
        `as the platform would send ${"password" in c.samplePayload ? "them" : "it"} — a handler that verifies ` +
        `\`applicationId\` ignores the sample value, and the replay would prove nothing.\n`
    );
  }
  parts.push(callbackCurl(c) + "\n");

  if (c.rules?.length) {
    parts.push(`### Rules\n`);
    parts.push(c.rules.map((r) => `- ${r}`).join("\n") + "\n");
  }

  return parts.join("\n");
}

const epilogue = `---

## What a curl does not show

Every command above is one HTTPS POST, and that part ports to any language in a few lines. The
difference between a working call and a production integration is what surrounds it — none of
which is visible in a shell command:

| | Why the curl hides it |
|---|---|
| **Credentials from the environment, injected once** | A shell export becomes a config module that validates at startup and fails loudly. One place reads it; no call site passes credentials as arguments. |
| **\`statusCode\` branching** | You read the JSON yourself here. Code that checks \`res.ok\`, \`raise_for_status()\` or \`EnsureSuccessStatusCode()\` reports every Applink failure as a success. |
| **\`P1003\` is not success** | CaaS OTP Generation returns it when the OTP is on its way to the subscriber. A curl shows you the code; only your code can hold the charge open, collect the OTP and finish with CaaS OTP Verification. |
| **Reaching the desired state** | Applink publishes no "already registered" code. Register and unregister are made idempotent by reading \`subscriptionStatus\` from the response — which a shell command has no state to compare against. |
| **Idempotency** | \`externalTrxId\` has to be generated, persisted before the call, and reused unchanged. A shell loop cannot do this; a ledger row can. |
| **Timeouts and retries** | \`--max-time 15\` becomes an explicit client timeout, with backoff on transient codes only and no automatic retry at all on the charging path. |
| **\`tel:\` normalisation** | Typed by hand here; in code it is one function at the boundary, never a concatenation at a call site. |
| **Acknowledge-first callbacks** | The replay commands return instantly. A real handler must respond \`S1000\` and then work out of band — USSD sessions time out in seconds. |

Those, plus a shared USSD session store, are the whole specification. They are written out
language-neutrally in [11-any-stack.md](11-any-stack.md), with an acceptance checklist for a
port. [templates/](../templates/README.md) shows the same seven already built in TypeScript/Node,
Python, Java, Go, PHP and C# — worked examples to read for shape, not output to paste.

## Related

| | |
|---|---|
| Machine-readable form of this page | [\`catalog/applink-api.json\`](../catalog/applink-api.json) |
| Build a request with your own values | \`node tools/applink.mjs curl <id> key=value …\` |
| Check a payload before sending it | \`node tools/applink.mjs validate <id> '<json>'\` |
| Check a response you received | \`node tools/applink.mjs response <id> '<json>'\` |
| Prove your code's bodies and response handling, in any language | [\`scripts/mock-applink.mjs\`](../scripts/mock-applink.mjs) — see [11-any-stack.md](11-any-stack.md#proving-the-bodies-in-any-language) |
| Decode a status code you received | \`node tools/applink.mjs code <statusCode>\` |
| Smoke-test the outbound path | [\`scripts/smoke-test.sh\`](../scripts/smoke-test.sh) (or \`smoke-test.ps1\`) |
| Test all five callback handlers | [\`scripts/test-callbacks.sh\`](../scripts/test-callbacks.sh) |
| Every status code, classified | [08-status-codes.md](08-status-codes.md) |
`;

const document = [
  preamble,
  ...services.map(serviceSection),
  `---\n\n# Inbound callbacks — Applink calls you\n`,
  ...callbacks.map(callbackSection),
  epilogue,
].join("\n");

/* ── Write or check ──────────────────────────────────────────────────────── */

const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : null;

if (current === document) {
  console.log("references/13-curl-reference.md is in sync with the catalog.");
} else if (check) {
  console.error(
    "stale: references/13-curl-reference.md\n\n" +
      "The curl reference no longer matches catalog/applink-api.json. Run\n" +
      "`node scripts/build-curl-reference.mjs` and commit the result."
  );
  process.exit(1);
} else {
  writeFileSync(OUT, document);
  console.log(
    `wrote references/13-curl-reference.md — ${services.length} endpoints, ${callbacks.length} callbacks.`
  );
}
