/**
 * Query library over catalog/applink-api.json.
 *
 * Zero dependencies, Node 18+. Importable from your own code, and driven by
 * tools/applink.mjs on the command line.
 *
 * This is the whole Applink contract as structured data: every service, every
 * parameter, every status code, every callback, every practice.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "..");

export const catalog = JSON.parse(
  readFileSync(join(repoRoot, "catalog", "applink-api.json"), "utf8")
);

/** Every service and callback in one list, tagged by kind. */
export function allEntries() {
  return [
    ...catalog.services.map((s) => ({ ...s, kind: "service" })),
    ...catalog.callbacks.map((c) => ({ ...c, kind: "callback" })),
  ];
}

/** Look up a service or callback by id, name or alias. Case-insensitive. */
export function findEntry(idOrName) {
  const needle = String(idOrName || "").toLowerCase().trim();
  return (
    allEntries().find(
      (e) =>
        e.id.toLowerCase() === needle ||
        e.name.toLowerCase() === needle ||
        (e.aliases || []).some((a) => a.toLowerCase() === needle)
    ) || null
  );
}

/** Resolve the full URL for a service. */
export function urlFor(service, baseUrl) {
  if (service.absoluteUrl) return service.absoluteUrl;
  const base = (baseUrl || catalog.baseUrls.primary).replace(/\/+$/, "");
  return `${base}${service.path}`;
}

/** Decode a status code into meaning, class, retryability and the fix. */
export function lookupStatusCode(code) {
  const key = String(code || "").toUpperCase().trim();
  const entry = catalog.statusCodes[key];
  if (!entry) {
    const isSuccess = key.startsWith("S");
    return {
      code: key,
      known: false,
      class: isSuccess ? "success" : "unknown",
      description: `Not in the published code list. Treat as ${isSuccess ? "success" : "a failure"} and check ${catalog.platform.docs}.`,
      retry: false,
      action: "Escalate to Applink support with the requestId if it persists.",
      benignFor: [],
      affects: [],
    };
  }
  const cls = catalog.statusCodeClasses[entry.class] || {};
  return {
    code: key,
    known: true,
    class: entry.class,
    description: entry.description,
    retry: cls.retry ?? false,
    action: entry.fix || cls.action,
    benignFor: entry.benignFor || [],
    affects: allEntries()
      .filter((e) => (e.statusCodes || []).includes(key))
      .map((e) => e.id),
  };
}

/** Read a reference document from the repo. */
export function readReference(name) {
  const safe = String(name || "").replace(/[^a-zA-Z0-9._-]/g, "");
  for (const path of [
    join(repoRoot, "references", safe),
    join(repoRoot, "references", `${safe}.md`),
  ]) {
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  return null;
}

/** Build a request payload for a service, with env placeholders for secrets. */
export function buildPayload(service, values = {}, credentials = {}) {
  const payload = {
    applicationId: credentials.applicationId || "$APPLINK_APP_ID",
    password: credentials.password || "$APPLINK_PASSWORD",
  };
  for (const p of service.parameters || []) {
    if (p.name === "applicationId" || p.name === "password") continue;
    if (values[p.name] !== undefined) payload[p.name] = values[p.name];
    else if (p.required && service.sampleRequest?.[p.name] !== undefined) {
      payload[p.name] = service.sampleRequest[p.name];
    }
  }
  return payload;
}

/** Fields that must carry a single tel:-prefixed subscriber address. */
const TEL_FIELDS = /^(subscriberId|destinationAddress)$/;

/**
 * Validate a payload against a service or callback definition.
 * Catches the mistakes that actually happen, not just missing fields.
 */
export function validatePayload(entry, payload) {
  const spec = entry.parameters || entry.fields || [];
  const errors = [];
  const warnings = [];
  const known = new Set(spec.map((p) => p.name));

  for (const p of spec) {
    const value = payload?.[p.name];

    if (p.required && (value === undefined || value === null || value === "")) {
      errors.push(`Missing required field "${p.name}" — ${p.description}`);
      continue;
    }
    if (value === undefined) continue;

    if (p.enum && !p.enum.includes(String(value))) {
      errors.push(`"${p.name}" must be one of ${p.enum.join(" | ")}, got ${JSON.stringify(value)}`);
    }
    if (p.type === "string[]" && !Array.isArray(value)) {
      errors.push(
        `"${p.name}" must be an ARRAY, got ${typeof value}. This is the most common Applink integration bug.`
      );
    }
    if (TEL_FIELDS.test(p.name) && typeof value === "string") {
      checkTelAddress(p.name, value, errors, warnings);
    }
    /**
     * sourceAddress is two different things depending on the endpoint: on SMS
     * Send it is a provisioned alias such as a shortcode, on CaaS OTP
     * Verification it is the subscriber's MSISDN. Only insist on tel: when the
     * caller has already committed to that form.
     */
    if (p.name === "sourceAddress" && typeof value === "string" && value.includes(":")) {
      checkTelAddress(p.name, value, errors, warnings);
    }
    if (p.name === "destinationAddresses" && Array.isArray(value)) {
      for (const a of value) {
        if (String(a) === "tel:all") continue;
        checkTelAddress("destinationAddresses entry", String(a), errors, warnings);
      }
      if (value.includes("tel:all")) {
        warnings.push(
          "tel:all broadcasts to your ENTIRE subscriber base. Confirm this is intended and check the base size first."
        );
      }
    }
    if (p.name === "subscriberIds" && Array.isArray(value)) {
      for (const a of value) checkTelAddress("subscriberIds entry", String(a), errors, warnings);
      if (value.length > 10) {
        errors.push("subscriberIds accepts a maximum of 10 MSISDNs per request");
      }
    }
    if (p.name === "Currency" && String(value) !== "BDT") {
      errors.push(`"Currency" must be "BDT" — it is the only currency Applink accepts`);
    }
    if (p.name === "currency" && String(value) !== "BDT") {
      warnings.push(`"currency" is documented as BDT only; got ${JSON.stringify(value)}`);
    }
  }

  for (const key of Object.keys(payload || {})) {
    if (!known.has(key)) warnings.push(`Unrecognised field "${key}" — it will be ignored.`);
  }
  if (entry.movesMoney) {
    warnings.push(
      `This call moves real money. Persist ${entry.idempotencyKey} BEFORE sending, and never restart the charge with a new one.`
    );
  }
  if (entry.id === "caas-otp-generation") {
    warnings.push(
      "P1003 in the response means the OTP was dispatched, NOT that the subscriber was charged. Persist requestCorrelator and finish with caas-otp-verify."
    );
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * One address check, shared by every field that carries one.
 *
 * The `+` is a warning rather than an error on purpose: the platform's own SMS
 * samples include it while its subscription, OTP and CaaS samples do not, so
 * both forms are documented and only one can be recommended.
 */
function checkTelAddress(label, value, errors, warnings) {
  if (!value.toLowerCase().startsWith("tel:")) {
    errors.push(`"${label}" must be tel:-prefixed, got ${JSON.stringify(value)}`);
    return;
  }
  if (/\s/.test(value)) {
    errors.push(`"${label}" must not contain spaces — got ${JSON.stringify(value)}`);
  }
  if (value.includes("+")) {
    warnings.push(
      `"${label}" contains a "+". Applink's SMS samples include it and every other API's samples omit it; send tel:8801959979376 and normalise in one helper.`
    );
  }
}

/**
 * Render a service call as a runnable curl command.
 *
 * The body goes in through an unquoted heredoc so that $APPLINK_APP_ID and
 * $APPLINK_PASSWORD expand from the environment: the command runs as printed,
 * and no credential is ever written down. Same shape as
 * references/13-curl-reference.md, so the two paths cannot drift.
 */
export function toCurl(service, payload, baseUrl) {
  return [
    `curl -sS -X POST '${urlFor(service, baseUrl)}' \\`,
    `  --header 'Content-Type: application/json' \\`,
    `  --max-time 15 \\`,
    `  --data @- <<REQUEST`,
    JSON.stringify(payload, null, 2),
    `REQUEST`,
  ].join("\n");
}

/** Full-text search across services, callbacks, status codes and practices. */
export function search(query, limit = 20) {
  const needle = String(query || "").toLowerCase().trim();
  if (!needle) return [];
  const hit = (haystack, weight) =>
    String(haystack).toLowerCase().includes(needle) ? weight : 0;
  const results = [];

  for (const e of allEntries()) {
    const score =
      hit(e.id, 10) +
      hit(e.name, 8) +
      hit((e.aliases || []).join(" "), 8) +
      hit(e.path || e.platformContract || "", 6) +
      hit(e.summary, 4) +
      hit(JSON.stringify(e.parameters || e.fields || []), 2) +
      hit((e.rules || []).join(" "), 1);
    if (score) results.push({ type: e.kind, id: e.id, name: e.name, summary: e.summary, score });
  }
  for (const [code, meta] of Object.entries(catalog.statusCodes)) {
    const score = hit(code, 12) + hit(meta.description, 3);
    if (score) results.push({ type: "statusCode", id: code, name: code, summary: meta.description, score });
  }
  for (const p of catalog.practices) {
    const score = hit(p.id, 8) + hit(p.title, 6) + hit(p.detail, 2);
    if (score) results.push({ type: "practice", id: p.id, name: p.title, summary: p.detail, score });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Symptom signatures for the diagnose command. */
export const SIGNATURES = [
  {
    when: /callback|webhook|notification.*(not|never)|no.*(callback|webhook)/,
    cause: "The callback URL is not publicly reachable, is wrong in the portal, is behind a WAF challenge or auth middleware, or your handler is not returning HTTP 200 with S1000.",
    fix: "Verify the URL in the portal; confirm it is reachable over public HTTPS with a complete certificate chain; exempt it from CSRF and auth middleware, and restrict by Applink source IP instead. Test locally with scripts/test-callbacks.sh.",
  },
  {
    when: /nothing happens|gets nothing|no error|silent|not working.*(test|number)/,
    cause: "The test number is not on the application's whitelist while the application is in Limited Production.",
    fix: "Add the number to the whitelisted numbers in the portal. In Limited Production only whitelisted numbers can use the application; non-whitelisted access returns E1343.",
  },
  {
    when: /works locally|fails.*(deploy|production|server)|local.*works/,
    cause: "The deployed server's egress IP is not provisioned, or the secrets are not set in the host environment.",
    fix: "Run curl -4 https://api.ipify.org ON THE DEPLOYED SERVER and add that IP to the application's allowed host addresses. Confirm APPLINK_APP_ID and APPLINK_PASSWORD are set in the host's secret manager.",
  },
  {
    when: /ussd.*(die|drop|hang|stuck|expire)|session.*(lost|expire|die)/,
    cause: "USSD session state is not shared across instances, the flow never sends mt-fin, or the handler is too slow.",
    fix: "Move the session store to Redis with a ~2 minute TTL, end terminal screens with mt-fin, and acknowledge the callback before doing any work.",
  },
  {
    when: /double.?charg|charg\w*\b[^.!?]{0,30}\btwice\b|duplicate charge|charged again|second charge/,
    cause: "CaaS OTP Generation was re-run to retry a charge, or a fresh externalTrxId was issued after a timeout. Each one starts a second transaction.",
    fix: "Persist externalTrxId before the first call and reuse it. To retry a failed verification, re-prompt for the OTP against the SAME requestCorrelator — never re-run generation. E1337 means the platform already has that transaction; settle it from the charging notification.",
  },
  {
    when: /p1003|charge.*(not|never).*(complete|deduct)|(no|not|never).{0,20}(money|paid|payment)|money.*(not|never)|order.*without.*pay|fulfil\w*.*(unpaid|not paid)/,
    cause: "P1003 from CaaS OTP Generation was treated as a completed charge. It only means the OTP was dispatched.",
    fix: "Collect the OTP from the subscriber, call caas-otp-verify with requestCorrelator as referenceNo, and settle the ledger row from the charging notification callback.",
  },
  {
    when: /certificate|tls|ssl|self.?signed|unable to verify/,
    cause: "The server is presenting an incomplete certificate chain, which strict clients reject.",
    fix: "Supply the missing intermediate CA to the HTTPS agent. Do NOT disable verification — that exposes the credentials that can charge your subscribers.",
  },
  {
    when: /success.*but|reports success|no error but.*fail|always succeeds/,
    cause: "The code checks the HTTP status instead of statusCode.",
    fix: "Applink returns HTTP 200 for application-level failures. Branch on statusCode; S1000 is the only unqualified success, and P1003 means pending.",
  },
  {
    when: /array|destinationaddress/,
    cause: "destinationAddresses was sent as a bare string.",
    fix: "It is always an array, even for a single recipient.",
  },
  {
    when: /referenceno|reference number|e1855/,
    cause: "The wrong identifier was passed as referenceNo.",
    fix: "For otp-verify it is the referenceNo from otp-request. For caas-otp-verify it is the requestCorrelator from caas-otp-generation. It is never the externalTrxId you generated.",
  },
];

/** Diagnose from a status code or a plain-language symptom. */
export function diagnose(symptom) {
  const codeMatch = String(symptom).match(/\b([SEP]\d{4})\b/i);
  if (codeMatch) return { matchedOn: "statusCode", ...lookupStatusCode(codeMatch[1]) };

  const s = String(symptom).toLowerCase();
  const sig = SIGNATURES.find((x) => x.when.test(s));
  if (sig) return { matchedOn: "symptom", symptom, cause: sig.cause, fix: sig.fix };

  return {
    matchedOn: "none",
    symptom,
    suggestion: "No signature matched. Try `applink search <keyword>`, or look up the statusCode from the response body.",
    searchResults: search(symptom, 5),
  };
}
