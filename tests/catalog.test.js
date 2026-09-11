import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  allEntries,
  buildPayload,
  catalog,
  diagnose,
  findEntry,
  interpretResponse,
  lookupStatusCode,
  parseCliValues,
  repoRoot,
  search,
  toCurl,
  urlFor,
  validatePayload,
} from "../tools/catalog.mjs";

/* ── Catalog integrity ───────────────────────────────────────────────────── */

test("catalog declares the Bangladesh market and no other", () => {
  assert.equal(catalog.platform.market, "Bangladesh");
  assert.equal(catalog.platform.operator, "Banglalink");
  assert.deepEqual(catalog.operators.map((o) => o.name), ["Banglalink"]);
});

test("every service has a unique id, path, parameters and a sample", () => {
  const ids = new Set();
  for (const s of catalog.services) {
    assert.ok(s.id, "service missing id");
    assert.ok(!ids.has(s.id), `duplicate service id ${s.id}`);
    ids.add(s.id);
    assert.ok(s.path, `${s.id} missing path`);
    assert.equal(s.method, "POST", `${s.id} should be POST`);
    assert.ok(s.parameters?.length, `${s.id} has no parameters`);
    assert.ok(s.sampleRequest, `${s.id} has no sampleRequest`);
    assert.ok(s.summary, `${s.id} has no summary`);
  }
});

test("every outbound service requires applicationId and password", () => {
  for (const s of catalog.services) {
    const names = s.parameters.map((p) => p.name);
    assert.ok(names.includes("applicationId"), `${s.id} missing applicationId`);
    assert.ok(names.includes("password"), `${s.id} missing password`);
    for (const field of ["applicationId", "password"]) {
      const p = s.parameters.find((x) => x.name === field);
      assert.equal(p.required, true, `${s.id}.${field} should be required`);
    }
  }
});

/**
 * The published surface is closed: eleven outbound endpoints and five
 * callbacks. This test is the guard against an invented endpoint being added
 * because it looked plausible.
 */
test("the catalog covers exactly the published endpoints", () => {
  const paths = catalog.services.map((s) => s.path).sort();
  assert.deepEqual(paths, [
    "/caas/direct/debit",
    "/caas/get/balance",
    "/caas/otp/verify",
    "/otp/request",
    "/otp/verify",
    "/sms/send",
    "/subscription/getSubscriberChargingInfo",
    "/subscription/query-base",
    "/subscription/send",
    "/subscription/send",
    "/ussd/send",
  ]);
  assert.equal(catalog.callbacks.length, 5);
});

test("every callback declares a dedupe key and a route", () => {
  for (const cb of catalog.callbacks) {
    assert.ok(cb.dedupeKey, `${cb.id} missing dedupeKey — callbacks must be idempotent`);
    assert.ok(cb.suggestedPath?.startsWith("/"), `${cb.id} suggestedPath must be a route`);
    assert.ok(
      cb.platformContract?.startsWith("/"),
      `${cb.id} must record the platform's own contract path`
    );
  }
});

/**
 * Every callback must be implementable from the catalog alone: fields, a sample
 * payload, and a dedupe key. A handler cannot be generated from a shrug.
 */
test("every callback carries fields and a sample payload", () => {
  for (const cb of catalog.callbacks) {
    assert.ok(cb.fields?.length, `${cb.id} has no fields`);
    assert.ok(cb.samplePayload, `${cb.id} has no samplePayload`);
    for (const field of cb.fields) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(cb.samplePayload, field.name) || !field.required,
        `${cb.id}.${field.name} is required but missing from samplePayload`
      );
    }
  }
});

test("every status code referenced by a service exists in the code table", () => {
  for (const e of allEntries()) {
    for (const code of e.statusCodes || []) {
      assert.ok(catalog.statusCodes[code], `${e.id} references unknown status code ${code}`);
    }
  }
});

test("every status code has a known handling class", () => {
  const classes = new Set(Object.keys(catalog.statusCodeClasses));
  for (const [code, meta] of Object.entries(catalog.statusCodes)) {
    assert.ok(classes.has(meta.class), `${code} has unknown class "${meta.class}"`);
    assert.ok(meta.description, `${code} has no description`);
  }
});

/**
 * Applink publishes twenty-nine error codes plus S1000. A code outside that set
 * in someone's error handling can never match, and one carried over from
 * another telco platform (an "already registered" or "already completed" code)
 * makes working flows look broken or, worse, failed charges look settled.
 */
test("the code table is exactly the published set", () => {
  const codes = Object.keys(catalog.statusCodes).sort();
  assert.equal(codes.length, 30, `expected 30 codes, found ${codes.length}`);
  assert.ok(codes.includes("S1000"));
  assert.ok(codes.includes("P1003"));
  for (const foreign of ["E1351", "E1356", "E1379", "E1378", "E1406", "E1367"]) {
    assert.ok(!codes.includes(foreign), `${foreign} is not published by Applink`);
  }
});

test("P1003 is pending, never success", () => {
  const info = lookupStatusCode("P1003");
  assert.equal(info.class, "pending");
  assert.equal(info.retry, false);
  assert.match(info.action, /OTP|charged|correlator/i);
});

test("every parameter is fully specified", () => {
  for (const e of allEntries()) {
    for (const p of e.parameters || e.fields || []) {
      assert.ok(p.name, `${e.id} has an unnamed parameter`);
      assert.ok(p.type, `${e.id}.${p.name} has no type`);
      assert.equal(typeof p.required, "boolean", `${e.id}.${p.name} has no required flag`);
      assert.ok(p.description, `${e.id}.${p.name} has no description`);
    }
  }
});

test("every reference path in the catalog points at a real file", () => {
  const refs = new Set();
  for (const e of allEntries()) if (e.reference) refs.add(e.reference);
  for (const p of catalog.practices) refs.add(p.reference);
  for (const ref of refs) {
    assert.ok(existsSync(join(repoRoot, ref)), `missing referenced file: ${ref}`);
  }
});

test("no code is marked benign — Applink publishes none", () => {
  for (const [code, meta] of Object.entries(catalog.statusCodes)) {
    assert.equal(meta.benignFor, undefined, `${code} claims a benign operation`);
  }
});

test("E1303 and E1313 are configuration-class and never retryable", () => {
  for (const code of ["E1303", "E1313", "E1309"]) {
    const info = lookupStatusCode(code);
    assert.equal(info.class, "configuration", `${code} should be configuration-class`);
    assert.equal(info.retry, false, `${code} must never be retried`);
  }
});

test("both charging steps are flagged as moving money", () => {
  const generation = findEntry("caas-otp-generation");
  assert.equal(generation.movesMoney, true);
  assert.equal(generation.idempotencyKey, "externalTrxId");

  const verify = findEntry("caas-otp-verify");
  assert.equal(verify.movesMoney, true);
  assert.equal(verify.idempotencyKey, "referenceNo");
});

test("the charging flow is discoverable as two steps", () => {
  const generation = findEntry("caas-otp-generation");
  assert.ok(
    generation.responseFields.some((f) => f.name === "requestCorrelator"),
    "OTP generation must document requestCorrelator — step two cannot run without it"
  );
  assert.ok(generation.statusCodes.includes("P1003"));
  assert.ok(
    generation.rules.some((r) => /step one of two|not success/i.test(r)),
    "OTP generation must state that it does not complete the charge"
  );
});

test("no real credential-shaped string appears in the catalog", () => {
  const raw = readFileSync(join(repoRoot, "catalog", "applink-api.json"), "utf8");
  const hexSecret = /"password"\s*:\s*"[0-9a-f]{16,}"/i;
  assert.equal(hexSecret.test(raw), false, "catalog contains a credential-shaped password value");
});

/* ── Lookup ──────────────────────────────────────────────────────────────── */

test("services resolve by id, name and alias", () => {
  assert.equal(findEntry("subscription-unregister").id, "subscription-unregister");
  assert.equal(findEntry("unsub").id, "subscription-unregister");
  assert.equal(findEntry("UNSUB").id, "subscription-unregister");
  assert.equal(findEntry("Base Size").id, "subscription-query-base");
  assert.equal(findEntry("nope"), null);
});

test("every service resolves to the one production host", () => {
  for (const s of catalog.services) {
    assert.ok(
      urlFor(s).startsWith("https://api.applink.com.bd/"),
      `${s.id} resolves to ${urlFor(s)}`
    );
  }
});

test("unknown status codes degrade gracefully", () => {
  const unknown = lookupStatusCode("E9999");
  assert.equal(unknown.known, false);
  assert.equal(unknown.class, "unknown");
  assert.equal(lookupStatusCode("S9999").class, "success");
});

test("search finds services by intent, not just by id", () => {
  assert.ok(search("base size").some((r) => r.id === "subscription-query-base"));
  assert.ok(search("opt out").some((r) => r.id === "subscription-unregister"));
  assert.ok(search("E1303").some((r) => r.id === "E1303"));
  assert.equal(search("").length, 0);
});

/* ── Validation ──────────────────────────────────────────────────────────── */

test("validation catches destinationAddresses sent as a string", () => {
  const result = validatePayload(findEntry("sms-send"), {
    applicationId: "APP_000001",
    password: "x",
    version: "1.0",
    message: "hi",
    destinationAddresses: "tel:8801959979376",
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("must be an ARRAY")));
});

test("validation catches a missing tel: prefix", () => {
  const result = validatePayload(findEntry("subscription-register"), {
    applicationId: "APP_000001",
    password: "x",
    action: "1",
    subscriberId: "8801959979376",
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("tel:")));
});

test("validation catches the stray space in the published charging-info sample", () => {
  const result = validatePayload(findEntry("subscription-charging-info"), {
    applicationId: "APP_000001",
    password: "x",
    subscriberIds: ["tel: 8801973579363"],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("spaces")));
});

test("validation warns about the + the SMS samples carry, but does not reject it", () => {
  const result = validatePayload(findEntry("sms-send"), {
    applicationId: "APP_000001",
    password: "x",
    version: "1.0",
    message: "hi",
    destinationAddresses: ["tel:+8801959979376"],
  });
  assert.equal(result.valid, true, result.errors.join("; "));
  assert.ok(result.warnings.some((w) => w.includes('"+"')));
});

test("validation catches a bad enum value", () => {
  const result = validatePayload(findEntry("subscription-register"), {
    applicationId: "APP_000001",
    password: "x",
    action: "yes",
    subscriberId: "tel:8801959979376",
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("must be one of")));
});

test("validation rejects a currency other than BDT", () => {
  const result = validatePayload(findEntry("caas-otp-generation"), {
    applicationId: "APP_000001",
    password: "x",
    externalTrxId: "abc",
    amount: "5.00",
    paymentInstrumentName: "Mobile Account",
    subscriberId: "tel:8801973579363",
    Currency: "USD",
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("BDT")));
});

test("validation caps subscriberIds at ten", () => {
  const result = validatePayload(findEntry("subscription-charging-info"), {
    applicationId: "APP_000001",
    password: "x",
    subscriberIds: Array.from({ length: 11 }, (_, i) => `tel:88019599793${i}0`),
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("maximum of 10")));
});

test("validation warns loudly about a broadcast", () => {
  const result = validatePayload(findEntry("sms-send"), {
    applicationId: "APP_000001",
    password: "x",
    version: "1.0",
    message: "hi",
    destinationAddresses: ["tel:all"],
  });
  assert.equal(result.valid, true, result.errors.join("; "));
  assert.ok(result.warnings.some((w) => w.includes("ENTIRE subscriber base")));
});

test("validation warns that charging moves real money, and that P1003 is not done", () => {
  const result = validatePayload(findEntry("caas-otp-generation"), {
    applicationId: "APP_000001",
    password: "x",
    externalTrxId: "abc",
    amount: "5.00",
    paymentInstrumentName: "Mobile Account",
    subscriberId: "tel:8801973579363",
    Currency: "BDT",
  });
  assert.ok(result.warnings.some((w) => w.includes("real money")));
  assert.ok(result.warnings.some((w) => w.includes("P1003")));
});

test("a well-formed payload validates", () => {
  const result = validatePayload(findEntry("sms-send"), {
    applicationId: "APP_000001",
    password: "x",
    version: "1.0",
    message: "hi",
    destinationAddresses: ["tel:8801959979376"],
  });
  assert.equal(result.valid, true, result.errors.join("; "));
});

test("every documented sample request validates against its own spec", () => {
  for (const s of catalog.services) {
    const payload = { ...s.sampleRequest, applicationId: "APP_000001", password: "x" };
    const result = validatePayload(s, payload);
    assert.equal(result.valid, true, `${s.id} sample is invalid: ${result.errors.join("; ")}`);
  }
});

/* ── Building ────────────────────────────────────────────────────────────── */

test("built payloads never contain a literal credential", () => {
  for (const s of catalog.services) {
    const payload = buildPayload(s, {});
    assert.equal(payload.applicationId, "$APPLINK_APP_ID");
    assert.equal(payload.password, "$APPLINK_PASSWORD");
  }
});

test("curl output is a single runnable POST with a JSON body", () => {
  const s = findEntry("subscription-query-base");
  const curl = toCurl(s, buildPayload(s, {}));
  assert.match(curl, /^curl -sS -X POST "\$APPLINK_SUBSCRIPTION_QUERY_BASE_URL"/);
  assert.match(curl, /Content-Type: application\/json;charset=utf-8/);
  assert.match(curl, /--max-time \d+/);
  // The heredoc is unquoted on purpose: the credential variables must expand,
  // so the command runs as printed without a secret ever being written down.
  assert.match(curl, /-d @- <<REQUEST\n[\s\S]*\nREQUEST$/);
  assert.match(curl, /"applicationId": "\$APPLINK_APP_ID"/);
});

/* ── Wire types ──────────────────────────────────────────────────────────── */

/**
 * The bug that made `applink curl` hand out broken bodies: every key=value was
 * run through JSON.parse, so amounts, actions and versions became numbers and a
 * 31-digit requestCorrelator became a float in scientific notation.
 */
test("key=value arguments keep every scalar as the string Applink expects", () => {
  const verify = findEntry("caas-otp-verify");
  const { values, errors } = parseCliValues(verify, [
    "referenceNo=8801442233146169943053700500040",
    "otp=012345",
  ]);
  assert.deepEqual(errors, []);
  assert.equal(values.referenceNo, "8801442233146169943053700500040");
  assert.equal(values.otp, "012345");

  const charge = parseCliValues(findEntry("caas-otp-generation"), ["amount=5.00", "externalTrxId=256091232"]);
  assert.equal(charge.values.amount, "5.00");
  assert.equal(charge.values.externalTrxId, "256091232");

  const ussd = parseCliValues(findEntry("ussd-send"), ["version=1.0", "sessionId=1330929317043"]);
  assert.equal(ussd.values.version, "1.0");
  assert.equal(ussd.values.sessionId, "1330929317043");

  assert.equal(parseCliValues(findEntry("subscription-register"), ["action=1"]).values.action, "1");
});

test("key=value arguments parse arrays and objects where the contract has them", () => {
  const sms = findEntry("sms-send");
  assert.deepEqual(
    parseCliValues(sms, ['destinationAddresses=["tel:8801959979376"]']).values.destinationAddresses,
    ["tel:8801959979376"]
  );
  assert.deepEqual(
    parseCliValues(sms, ["destinationAddresses=tel:8801959979376,tel:8801959979377"]).values.destinationAddresses,
    ["tel:8801959979376", "tel:8801959979377"]
  );
  const otp = parseCliValues(findEntry("otp-request"), ['applicationMetaData={"client":"WEBAPP"}']);
  assert.deepEqual(otp.values.applicationMetaData, { client: "WEBAPP" });
  assert.ok(parseCliValues(findEntry("otp-request"), ["applicationMetaData={nope"]).errors.length);
});

test("validation rejects a number wherever the contract says string", () => {
  const cases = [
    ["caas-otp-generation", { amount: 5 }],
    ["caas-otp-generation", { externalTrxId: 256091232 }],
    ["subscription-register", { action: 1 }],
    ["sms-send", { version: 1 }],
    ["ussd-send", { encoding: 440 }],
    ["caas-otp-verify", { referenceNo: 8.80144223314617e30 }],
    ["otp-verify", { otp: 123456 }],
  ];
  for (const [id, override] of cases) {
    const s = findEntry(id);
    const payload = { ...s.sampleRequest, applicationId: "APP_000001", password: "x", ...override };
    const result = validatePayload(s, payload);
    const field = Object.keys(override)[0];
    assert.equal(result.valid, false, `${id}.${field} as a number must be rejected`);
    assert.ok(result.errors.some((e) => e.includes(`"${field}" must be a JSON string`)), result.errors.join("; "));
  }
});

test("validation rejects null, empty arrays and an array where an object belongs", () => {
  const otp = findEntry("otp-request");
  const base = { applicationId: "APP_000001", password: "x", subscriberId: "tel:8801416177301" };
  assert.equal(validatePayload(otp, { ...base, applicationMetaData: null }).valid, false);
  assert.equal(validatePayload(otp, { ...base, applicationMetaData: [] }).valid, false);
  assert.equal(validatePayload(otp, { ...base, applicationMetaData: { client: 1 } }).valid, false);

  const info = findEntry("subscription-charging-info");
  assert.equal(validatePayload(info, { applicationId: "APP_000001", password: "x", subscriberIds: [] }).valid, false);
});

test("validation checks the shape of amount and version", () => {
  const s = findEntry("caas-otp-generation");
  const base = { ...s.sampleRequest, applicationId: "APP_000001", password: "x" };
  for (const bad of ["5.001", "-5", "0", "5,00", "BDT 5", "0.00"]) {
    assert.equal(validatePayload(s, { ...base, amount: bad }).valid, false, `amount ${bad} must be rejected`);
  }
  for (const good of ["5", "5.0", "5.00", "150.50"]) {
    assert.equal(validatePayload(s, { ...base, amount: good }).valid, true, `amount ${good} must pass`);
  }
  const sms = findEntry("sms-send");
  const smsBase = { applicationId: "APP_000001", password: "x", message: "hi", destinationAddresses: ["tel:8801959979376"] };
  assert.equal(validatePayload(sms, { ...smsBase, version: "v1" }).valid, false);
});

test("validation names the right field when one from another endpoint is sent", () => {
  const cases = [
    ["caas-otp-generation", "currency", "Currency"],
    ["caas-query-balance", "Currency", "currency"],
    ["caas-otp-verify", "requestCorrelator", "referenceNo"],
    ["caas-otp-verify", "subscriberId", "sourceAddress"],
    ["sms-send", "destinationAddress", "destinationAddresses"],
    ["ussd-send", "destinationAddresses", "destinationAddress"],
    ["subscription-charging-info", "subscriberId", "subscriberIds"],
  ];
  for (const [id, wrong, right] of cases) {
    const s = findEntry(id);
    const payload = { ...s.sampleRequest, applicationId: "APP_000001", password: "x", [wrong]: "x" };
    const result = validatePayload(s, payload);
    assert.equal(result.valid, false, `${id}: "${wrong}" must be an error`);
    assert.ok(
      result.errors.some((e) => e.includes(`"${wrong}"`) && e.includes(right)),
      `${id}: the error for "${wrong}" must name "${right}" — got ${result.errors.join("; ")}`
    );
  }
});

test("validation catches a case-only mistake in any field name", () => {
  const s = findEntry("subscription-register");
  const result = validatePayload(s, {
    applicationId: "APP_000001",
    password: "x",
    SubscriberId: "tel:8801959979376",
    action: "1",
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("case-sensitive") && e.includes('"subscriberId"')));
});

test("the charging verification step insists on a tel: sourceAddress", () => {
  const s = findEntry("caas-otp-verify");
  const result = validatePayload(s, { ...s.sampleRequest, applicationId: "APP_000001", password: "x", sourceAddress: "8801973579363" });
  assert.equal(result.valid, false);
});

/* ── Responses ───────────────────────────────────────────────────────────── */

test("every service says which statusCode to expect and what to do with the body", () => {
  for (const s of catalog.services) {
    const h = s.responseHandling;
    assert.ok(h, `${s.id} has no responseHandling`);
    assert.ok(h.expect?.length, `${s.id} does not say which statusCode to expect`);
    for (const code of h.expect) {
      assert.ok(s.statusCodes.includes(code), `${s.id} expects ${code}, which it does not publish`);
    }
    assert.ok(h.expect.includes(s.sampleResponse.statusCode), `${s.id}'s sample response is not an expected outcome`);
    assert.ok(h.outcome && h.next, `${s.id} responseHandling needs an outcome and a next step`);
    for (const f of h.expectFields || []) {
      assert.ok(s.responseFields.some((r) => r.name === f), `${s.id} expects undocumented field ${f}`);
    }
  }
  assert.deepEqual(findEntry("caas-otp-generation").responseHandling.expect[0], "P1003");
});

test("the published sample response of every service reads as its expected outcome", () => {
  for (const s of catalog.services) {
    const r = interpretResponse(s, s.sampleResponse);
    assert.ok(["success", "pending"].includes(r.outcome), `${s.id} sample reads as ${r.outcome}`);
    assert.deepEqual(r.problems, [], `${s.id}: ${r.problems.join("; ")}`);
  }
});

test("response reading: P1003 is pending, and a missing requestCorrelator is flagged", () => {
  const s = findEntry("caas-otp-generation");
  assert.equal(interpretResponse(s, s.sampleResponse).outcome, "pending");
  const { requestCorrelator, ...withoutCorrelator } = s.sampleResponse;
  const r = interpretResponse(s, withoutCorrelator);
  assert.ok(r.problems.some((p) => p.includes("requestCorrelator")));
  const echo = interpretResponse(s, s.sampleResponse, { externalTrxId: "different" });
  assert.ok(echo.problems.some((p) => p.includes("externalTrxId")));
});

test("response reading: failures, partial sends and subscription state", () => {
  const base = findEntry("subscription-query-base");
  const failed = interpretResponse(base, { statusCode: "E1303", statusDetail: "x" });
  assert.equal(failed.outcome, "failure");
  assert.equal(failed.class, "configuration");

  assert.equal(interpretResponse(base, { statusDetail: "no code" }).outcome, "not-applink");
  assert.equal(interpretResponse(base, "<html>").outcome, "not-applink");

  const sms = interpretResponse(findEntry("sms-send"), {
    statusCode: "S1000",
    requestId: "1",
    destinationResponses: [
      { address: "tel:8801959979376", statusCode: "S1000" },
      { address: "tel:8801959979377", statusCode: "E1343" },
    ],
  });
  assert.equal(sms.outcome, "partial");

  const register = findEntry("subscription-register");
  assert.equal(
    interpretResponse(register, { statusCode: "S1000", subscriptionStatus: "REG_PENDING" }).outcome,
    "processed-not-in-desired-state"
  );
  const unregister = findEntry("subscription-unregister");
  assert.equal(interpretResponse(unregister, { statusCode: "S1000", subscriptionStatus: "UNREGISTERED." }).outcome, "success");
});

/* ── The generated reference ─────────────────────────────────────────────── */

test("the curl reference never calls P1003 a failure, nor S1000 the only success", () => {
  const doc = readFileSync(join(repoRoot, "references", "13-curl-reference.md"), "utf8");
  assert.doesNotMatch(doc, /Success is `statusCode: "S1000"` — nothing else/);
  const section = doc.slice(doc.indexOf("## CaaS OTP Generation"), doc.indexOf("## CaaS OTP Verification"));
  assert.match(section, /expected outcome is \*\*`statusCode: "P1003"`\*\*/);
});

test("the curl reference shows every enum value as a JSON string", () => {
  const doc = readFileSync(join(repoRoot, "references", "13-curl-reference.md"), "utf8");
  for (const e of allEntries()) {
    for (const p of (e.parameters || e.fields || []).filter((x) => x.enum)) {
      const shown = `One of ${p.enum.map((v) => `\`"${v}"\``).join(", ")}.`;
      assert.ok(doc.includes(shown), `${e.id}.${p.name} enum is not shown quoted`);
    }
  }
});

test("every runnable request in the curl reference is a valid body for its endpoint", () => {
  const doc = readFileSync(join(repoRoot, "references", "13-curl-reference.md"), "utf8");
  for (const s of catalog.services) {
    const section = doc.indexOf(`\n## ${s.name}\n`);
    const start = doc.indexOf(`curl -sS -X POST "$${s.envVar}"`, section);
    const bodyStart = doc.indexOf("{", start);
    const bodyEnd = doc.indexOf("\nREQUEST", bodyStart);
    const body = JSON.parse(doc.slice(bodyStart, bodyEnd));
    const result = validatePayload(s, body);
    assert.equal(result.valid, true, `${s.id}: ${result.errors.join("; ")}`);
    assert.deepEqual(
      result.warnings.filter((w) => w.startsWith("Unrecognised")),
      [],
      `${s.id} request carries a field the endpoint does not take`
    );
    for (const p of s.parameters.filter((x) => !x.required && x.exampleNote)) {
      assert.equal(body[p.name], undefined, `${s.id} example must not carry the application-specific ${p.name}`);
    }
  }
});

test("callback replays carry the application's own id, so a verifying handler processes them", () => {
  const doc = readFileSync(join(repoRoot, "references", "13-curl-reference.md"), "utf8");
  const replays = doc.slice(doc.indexOf("# Inbound callbacks"));
  assert.doesNotMatch(replays, /<<'PAYLOAD'/, "a quoted heredoc would not expand $APPLINK_APP_ID");
  for (const cb of catalog.callbacks.filter((c) => "applicationId" in c.samplePayload)) {
    const section = replays.slice(replays.indexOf(`## ${cb.name}`));
    const replay = section.slice(section.indexOf("### Replay"), section.indexOf("\nPAYLOAD"));
    assert.match(replay, /"applicationId": "\$APPLINK_APP_ID"/, `${cb.id} replay uses a sample applicationId`);
  }
});

/* ── Diagnosis ───────────────────────────────────────────────────────────── */

test("diagnose extracts a status code from free text", () => {
  const d = diagnose("everything returns E1303 in production");
  assert.equal(d.matchedOn, "statusCode");
  assert.equal(d.code, "E1303");
});

test("diagnose recognises P1003 as a code, not a symptom", () => {
  const d = diagnose("stuck on P1003");
  assert.equal(d.matchedOn, "statusCode");
  assert.equal(d.class, "pending");
});

test("diagnose matches symptom signatures", () => {
  assert.equal(diagnose("callbacks never arrive").matchedOn, "symptom");
  assert.equal(diagnose("works locally but fails deployed").matchedOn, "symptom");
  assert.match(diagnose("we double charged a customer").fix, /externalTrxId|requestCorrelator/);
  assert.match(diagnose("money not taken but the order went through").fix, /caas-otp-verify|OTP/);
  assert.match(diagnose("invalid reference number").fix, /requestCorrelator/);
});

test("diagnose degrades to search when nothing matches", () => {
  const d = diagnose("subscription");
  assert.equal(d.matchedOn, "none");
  assert.ok(Array.isArray(d.searchResults));
});

/* ── Repo consistency ────────────────────────────────────────────────────── */

test("all thirteen reference documents exist", () => {
  const files = readdirSync(join(repoRoot, "references")).filter((f) => f.endsWith(".md"));
  assert.equal(files.length, 13, `expected 13 reference docs, found ${files.length}`);
});

/**
 * Error handling is built from the complete table in 08-status-codes.md, so every
 * code there must carry the same handling class the catalog and `applink code`
 * report. A class that disagrees sends someone's retry logic the wrong way.
 */
test("the status-code reference classifies every code exactly as the catalog does", () => {
  const doc = readFileSync(join(repoRoot, "references", "08-status-codes.md"), "utf8");
  const table = doc.slice(doc.indexOf("## Complete official status-code list"));
  const rows = [...table.matchAll(/^\| `([EP]1\d{3})` \| (\S+) \| /gm)];

  const documented = new Map(rows.map(([, code, cls]) => [code, cls]));
  const expected = Object.entries(catalog.statusCodes).filter(([code]) => code !== "S1000");

  assert.equal(documented.size, expected.length, "the complete list is missing codes");
  for (const [code, meta] of expected) {
    assert.equal(documented.get(code), meta.class, `08-status-codes.md misclassifies ${code}`);
  }
});

/**
 * The skill deliberately ships no code emitters: an emitter encodes language
 * idiom rather than the Applink contract, so it ages with every ecosystem it
 * covers while making every uncovered language second-class. The curl reference
 * is the delivery mechanism instead. This keeps the docs from advertising a
 * command that does not exist — and the emitters from reappearing without the
 * decision being revisited.
 */
test("no entry point advertises a code generator", () => {
  const surfaces = [
    "SKILL.md",
    "AGENTS.md",
    "README.md",
    ...readdirSync(join(repoRoot, "skills")).map((d) => `skills/${d}/SKILL.md`),
    ...readdirSync(join(repoRoot, "references")).map((f) => `references/${f}`),
  ];
  const offenders = surfaces.filter((file) =>
    /applink(\.mjs)?\s+codegen|npm run codegen|--lang=/.test(readFileSync(join(repoRoot, file), "utf8"))
  );
  assert.deepEqual(offenders, [], `these still document a removed codegen command: ${offenders}`);
  assert.equal(existsSync(join(repoRoot, "tools", "codegen.mjs")), false);
});

/**
 * The curl reference is the tool-free path into the platform: an agent working
 * in Ruby, Rust or Kotlin gets no emitter, so this page is the whole contract it
 * has. It is generated from the catalog, and CI fails if it drifts.
 */
test("the curl reference is in sync with the catalog", () => {
  assert.doesNotThrow(() =>
    execFileSync("node", ["scripts/build-curl-reference.mjs", "--check"], {
      cwd: repoRoot,
      encoding: "utf8",
    })
  );
});

test("the curl reference documents every endpoint, parameter and response field", () => {
  const doc = readFileSync(join(repoRoot, "references", "13-curl-reference.md"), "utf8");
  const missing = [];
  // Pipes are escaped in the generated tables, or they would split a cell.
  const documents = (text) => doc.includes(String(text).replace(/\|/g, "\\|"));

  for (const service of catalog.services) {
    const url = service.absoluteUrl || `${catalog.baseUrls.primary}${service.path}`;
    if (!doc.includes(`POST ${url}`)) missing.push(`endpoint ${url}`);
    if (!doc.includes(`curl -sS -X POST "$${service.envVar}"`)) {
      missing.push(`runnable request for ${service.id}`);
    }
    for (const p of service.parameters) {
      if (!doc.includes(`\`${p.name}\``)) missing.push(`${service.id}.${p.name}`);
      if (!documents(p.description)) missing.push(`definition of ${service.id}.${p.name}`);
    }
    for (const f of service.responseFields || []) {
      if (!documents(f.description)) missing.push(`response field ${service.id}.${f.name}`);
    }
  }

  for (const cb of catalog.callbacks) {
    if (!doc.includes(cb.suggestedPath)) missing.push(`callback route ${cb.id}`);
    for (const f of cb.fields) {
      if (!documents(f.description)) missing.push(`definition of ${cb.id}.${f.name}`);
    }
  }

  assert.deepEqual(missing, [], `curl reference is missing:\n${missing.join("\n")}`);
});

test("the curl reference contains no credential, only environment placeholders", () => {
  const doc = readFileSync(join(repoRoot, "references", "13-curl-reference.md"), "utf8");
  assert.match(doc, /"password": "\$APPLINK_PASSWORD"/);
  assert.doesNotMatch(doc, /"password"\s*:\s*"(?!\$APPLINK_PASSWORD)[^"]{6,}"/);
});

/**
 * The CLI lists reference documents from a hardcoded array. A new file in
 * references/ that nobody registered is invisible to `applink reference`.
 */
test("the CLI lists every reference document that exists", () => {
  const onDisk = readdirSync(join(repoRoot, "references"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""))
    .sort();
  const listed = JSON.parse(
    execFileSync("node", ["tools/applink.mjs", "reference", "--json"], {
      cwd: repoRoot,
      encoding: "utf8",
    })
  ).documents.sort();
  assert.deepEqual(listed, onDisk);
});

/**
 * The environment surface is deliberately tiny: two credentials, plus one URL
 * per provisionable service. Anything else (timeouts, encodings, retry counts)
 * belongs in code as a constant — it is a property of the protocol, not of the
 * deployment. This test stops that surface creeping back.
 */
test("the env example exposes only credentials and per-service endpoints", () => {
  const example = readFileSync(join(repoRoot, "templates", ".env.example"), "utf8");
  const declared = [...example.matchAll(/^#?([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);

  const allowed = new Set([
    "APPLINK_APP_ID",
    "APPLINK_PASSWORD",
    "APPLINK_SMS_SEND_URL",
    "APPLINK_USSD_SEND_URL",
    "APPLINK_SUBSCRIPTION_SEND_URL",
    "APPLINK_SUBSCRIPTION_QUERY_BASE_URL",
    "APPLINK_SUBSCRIPTION_CHARGING_INFO_URL",
    "APPLINK_OTP_REQUEST_URL",
    "APPLINK_OTP_VERIFY_URL",
    "APPLINK_CAAS_DEBIT_URL",
    "APPLINK_CAAS_OTP_VERIFY_URL",
    "APPLINK_CAAS_BALANCE_URL",
  ]);

  const unexpected = declared.filter((v) => !allowed.has(v));
  assert.deepEqual(unexpected, [], `unexpected env vars in .env.example: ${unexpected.join(", ")}`);

  for (const required of ["APPLINK_APP_ID", "APPLINK_PASSWORD"]) {
    assert.ok(declared.includes(required), `.env.example is missing ${required}`);
  }
});

test("every catalog service endpoint variable appears in the env example", () => {
  const example = readFileSync(join(repoRoot, "templates", ".env.example"), "utf8");
  for (const service of catalog.services) {
    assert.ok(
      example.includes(`${service.envVar}=`),
      `.env.example is missing ${service.envVar} (${service.id})`
    );
  }
});

test("every service endpoint variable maps to a real catalog service", () => {
  const example = readFileSync(join(repoRoot, "templates", ".env.example"), "utf8");
  const urls = [...example.matchAll(/^#?APPLINK_\w+_URL=(\S+)/gm)].map((m) => m[1]);
  const known = new Set(
    catalog.services.map((s) => s.absoluteUrl || `${catalog.baseUrls.primary}${s.path}`)
  );
  for (const url of urls) {
    assert.ok(known.has(url), `.env.example lists ${url}, which is not a catalog endpoint`);
  }
});

/**
 * The same two patterns the CI secrets job runs, so a leak fails locally
 * before it reaches a push. These detect what a real credential looks like
 * rather than allowlisting placeholder spellings — a real Applink password is
 * a long unbroken alphanumeric run, which "replace-me", "…", "" and "$VAR"
 * never are.
 */
test("no credential-shaped string is committed anywhere", () => {
  const patterns = [
    { name: "JSON password value", re: /"password"\s*:\s*"[A-Za-z0-9]{16,}"/ },
    { name: "env password value", re: /APPLINK_PASSWORD=[A-Za-z0-9]{12,}/ },
  ];

  // ci.yml is excluded because it contains the patterns as its own source text.
  // Nothing else is excluded — including this file, which is why the fixture
  // below is generated at runtime rather than written as a literal.
  const skipDirs = new Set([".git", "node_modules"]);
  const skipFiles = new Set(["ci.yml"]);
  const offenders = [];

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) walk(join(dir, entry.name));
        continue;
      }
      if (skipFiles.has(entry.name)) continue;
      const path = join(dir, entry.name);
      let content;
      try {
        content = readFileSync(path, "utf8");
      } catch {
        continue; // binary or unreadable
      }
      for (const { name, re } of patterns) {
        if (re.test(content)) {
          offenders.push(`${path.replace(repoRoot, ".")} — ${name}`);
        }
      }
    }
  };

  walk(repoRoot);
  assert.deepEqual(
    offenders,
    [],
    `credential-shaped strings found:\n${offenders.join("\n")}\n` +
      `Rotate the credential in the Applink portal before anything else — see SECURITY.md.`
  );
});

test("documented placeholders do not trip the credential scan", () => {
  // Regression guard: these are the placeholder spellings actually used in the
  // repo. An earlier allowlist-based scan broke CI when "…" was introduced.
  const envRe = /APPLINK_PASSWORD=[A-Za-z0-9]{12,}/;
  for (const placeholder of [
    "APPLINK_PASSWORD=replace-me",
    "APPLINK_PASSWORD=…",
    "APPLINK_PASSWORD=",
    "APPLINK_PASSWORD=$APPLINK_PASSWORD",
    "APPLINK_PASSWORD=<your-password>",
  ]) {
    assert.equal(envRe.test(placeholder), false, `"${placeholder}" must not be flagged`);
  }
  // ...but a real one must still be caught.
  //
  // Generated at runtime, never written as a literal: a credential-shaped
  // string committed here would be flagged by the very scan it is testing.
  const credentialShaped = randomBytes(16).toString("hex"); // 32 hex chars
  assert.equal(envRe.test(`APPLINK_PASSWORD=${credentialShaped}`), true);
});

/**
 * Every MSISDN in the documentation must be a Bangladesh one. An other-market
 * number in a sample is a sign that content was carried over from a different
 * platform's skill without being reconciled.
 */
test("every documented MSISDN is a Bangladesh number", () => {
  const files = readdirSync(join(repoRoot, "references")).map((f) =>
    join(repoRoot, "references", f)
  );
  const offenders = [];
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    for (const [match] of content.matchAll(/tel:\+?(\d{6,})/g)) {
      const digits = match.replace(/^tel:\+?/, "");
      if (!digits.startsWith("880")) offenders.push(`${file.replace(repoRoot, ".")}: ${match}`);
    }
  }
  assert.deepEqual(offenders, [], `non-Bangladesh MSISDNs found:\n${offenders.join("\n")}`);
});
