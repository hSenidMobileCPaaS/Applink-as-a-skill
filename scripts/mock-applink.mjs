#!/usr/bin/env node
/**
 * A local stand-in for Applink that checks every request body an integration
 * sends — in whatever language it is written — and answers the way the
 * platform does.
 *
 *   node scripts/mock-applink.mjs [--port 8089] [--strict-credentials]
 *
 * Point the integration's endpoint variables at it instead of api.applink.com.bd:
 *
 *   APPLINK_SUBSCRIPTION_QUERY_BASE_URL=http://127.0.0.1:8089/subscription/query-base
 *
 * Every request is validated against catalog/applink-api.json — JSON types,
 * field names, required fields, fields that belong to another endpoint — and
 * logged as OK or BAD with the reason. A body the platform would reject gets
 * the E1312 the platform would send, so the integration's error path runs too.
 *
 * The response depends on an optional first path segment, the scenario:
 *
 *   /sms/send                the endpoint's published sample — its expected outcome
 *   /fail/sms/send           a failure body: statusCode and statusDetail only
 *   /fail-E1326/caas/...     that specific code
 *   /variant/sms/send        the expected outcome with every field the next step
 *                            does not need removed, numeric strings sent as bare
 *                            numbers, and an unknown field added — what a parser
 *                            written to the reading rules must survive
 *   /timeout/sms/send        no answer for 20 seconds — exercises the client timeout
 *
 * GET /__report returns every request seen, with its verdict, as JSON.
 *
 * Local testing only: it listens on 127.0.0.1, speaks plain HTTP, and makes no
 * outbound calls. With --strict-credentials it also answers E1313 unless the
 * body carries the APPLINK_APP_ID and APPLINK_PASSWORD it was started with.
 */

import http from "node:http";
import { catalog, lookupStatusCode, validatePayload } from "../tools/catalog.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};

const port = Number(option("--port", process.env.APPLINK_MOCK_PORT || 8089));
const strictCredentials = flag("--strict-credentials");
const quiet = flag("--quiet");

const report = [];
const log = (line) => {
  if (!quiet) console.log(line);
};

const SCENARIO = /^(fail(?:-[EP]\d{4})?|variant|timeout)$/;

/** The service a path names. /subscription/send is two services, told apart by action. */
function serviceFor(path, body) {
  const matches = catalog.services.filter((s) => s.path === path);
  if (matches.length <= 1) return matches[0] ?? null;
  return matches.find((s) => s.sampleRequest?.action === body?.action) ?? matches[0];
}

function failureFor(service, code) {
  const chosen =
    code ??
    (service.statusCodes.includes("E1313")
      ? "E1313"
      : service.statusCodes.find((c) => c.startsWith("E")));
  return { statusCode: chosen, statusDetail: lookupStatusCode(chosen).description };
}

/** The expected outcome, reduced to what a defensive reader must cope with. */
function variantFor(service) {
  const sample = service.sampleResponse;
  const keep = new Set(["statusCode", "statusDetail", ...(service.responseHandling?.expectFields ?? [])]);
  const body = {};
  for (const [key, value] of Object.entries(sample)) {
    if (!keep.has(key)) continue;
    body[key] = typeof value === "string" && /^\d+(\.\d+)?$/.test(value) && key !== "statusCode" &&
      !/Id|Correlator|referenceNo/i.test(key)
      ? Number(value)
      : value;
  }
  body.fieldAddedByAFutureRelease = "ignore me";
  return body;
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json;charset=utf-8" });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/__report") return send(res, 200, report);

  let raw = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const segments = req.url.split("?")[0].split("/").filter(Boolean);
    const scenario = SCENARIO.test(segments[0] ?? "") ? segments.shift() : "sample";
    const path = `/${segments.join("/")}`;

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      body = undefined;
    }
    const service = serviceFor(path, body);
    const problems = [];
    const warnings = [];

    if (req.method !== "POST") problems.push(`method ${req.method} — every Applink call is a POST`);
    if (!/application\/json/i.test(req.headers["content-type"] ?? "")) {
      problems.push(`Content-Type "${req.headers["content-type"] ?? ""}" — send ${catalog.conventions.contentType}`);
    }
    if (body === undefined) problems.push("the body is not JSON");
    if (!service) problems.push(`${path} is not an Applink endpoint`);

    if (service && body !== undefined) {
      const v = validatePayload(service, body);
      problems.push(...v.errors);
      warnings.push(...v.warnings.filter((w) => !/real money|P1003 in the response/.test(w)));
    }

    const entry = { service: service?.id ?? null, path, scenario, verdict: problems.length ? "BAD" : "OK", problems, warnings, body: raw };
    report.push(entry);

    log(`${entry.verdict.padEnd(3)} ${String(entry.service ?? path).padEnd(28)} ${scenario}`);
    for (const p of problems) log(`      ✗ ${p}`);
    for (const w of warnings) log(`      ! ${w}`);

    if (!service) return send(res, 404, { statusCode: "E1315", statusDetail: `${path} is not an Applink endpoint` });

    if (strictCredentials && body && (body.applicationId !== process.env.APPLINK_APP_ID || body.password !== process.env.APPLINK_PASSWORD)) {
      return send(res, 200, failureFor(service, "E1313"));
    }
    if (problems.length) {
      return send(res, 200, { statusCode: "E1312", statusDetail: `Invalid request: ${problems[0]}` });
    }
    if (scenario === "timeout") {
      setTimeout(() => res.destroy(), 20_000);
      return;
    }
    if (scenario.startsWith("fail")) return send(res, 200, failureFor(service, scenario.split("-")[1]));
    if (scenario === "variant") return send(res, 200, variantFor(service));
    return send(res, 200, service.sampleResponse);
  });
});

server.listen(port, "127.0.0.1", () => {
  log(`Applink mock on http://127.0.0.1:${port}  — scenarios: /fail[-CODE]/…  /variant/…  /timeout/…   report: GET /__report`);
});

const summarise = () => {
  const bad = report.filter((r) => r.verdict === "BAD").length;
  log(`\n${report.length} request(s), ${bad} with problems`);
  process.exit(bad ? 1 : 0);
};
process.on("SIGINT", summarise);
process.on("SIGTERM", summarise);
