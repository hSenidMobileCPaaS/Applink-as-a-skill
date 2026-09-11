import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { catalog, repoRoot } from "../tools/catalog.mjs";

/**
 * scripts/mock-applink.mjs is how an integration in any language proves its
 * bodies and its response handling. These pin what it promises.
 */

const port = 18300 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
let mock;

const post = async (path, body, headers = { "Content-Type": "application/json;charset=utf-8" }) => {
  const res = await fetch(base + path, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const report = async () => (await fetch(`${base}/__report`)).json();
const creds = { applicationId: "APP_000001", password: "x" };

before(async () => {
  mock = spawn(process.execPath, [join(repoRoot, "scripts", "mock-applink.mjs"), "--port", String(port), "--quiet"]);
  for (let i = 0; i < 50; i++) {
    try {
      await report();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("mock did not start");
});

after(() => mock.kill());

test("a valid body gets the endpoint's published response and an OK verdict", async () => {
  for (const s of catalog.services) {
    const r = await post(s.path, { ...creds, ...s.sampleRequest });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, s.sampleResponse, `${s.id} did not get its sample response`);
  }
  const seen = await report();
  assert.ok(seen.every((x) => x.verdict === "OK"), JSON.stringify(seen.filter((x) => x.verdict !== "OK")));
  // /subscription/send is two services; the action tells them apart.
  assert.deepEqual(
    seen.filter((x) => x.path === "/subscription/send").map((x) => x.service),
    ["subscription-register", "subscription-unregister"]
  );
});

test("a body the platform would reject gets E1312 and a BAD verdict naming the fault", async () => {
  const s = catalog.services.find((x) => x.id === "caas-otp-generation");
  const r = await post(s.path, { ...creds, ...s.sampleRequest, amount: 5 });
  assert.equal(r.body.statusCode, "E1312");
  assert.match(r.body.statusDetail, /amount/);
  const last = (await report()).at(-1);
  assert.equal(last.verdict, "BAD");
  assert.ok(last.problems.some((p) => p.includes('"amount" must be a JSON string')));
});

test("a non-JSON content type or body is a BAD request", async () => {
  const r = await post("/subscription/query-base", "applicationId=APP_000001", { "Content-Type": "application/x-www-form-urlencoded" });
  assert.equal(r.body.statusCode, "E1312");
  const last = (await report()).at(-1);
  assert.ok(last.problems.some((p) => p.includes("Content-Type")));
  assert.ok(last.problems.some((p) => p.includes("not JSON")));
});

test("/fail answers with statusCode and statusDetail only", async () => {
  const base = catalog.services.find((x) => x.id === "subscription-query-base");
  const r = await post(`/fail${base.path}`, creds);
  assert.deepEqual(Object.keys(r.body).sort(), ["statusCode", "statusDetail"]);
  assert.equal(r.body.statusCode, "E1313");

  const verify = catalog.services.find((x) => x.id === "otp-verify");
  assert.equal((await post(`/fail${verify.path}`, { ...creds, ...verify.sampleRequest })).body.statusCode, "E1850");

  const charge = catalog.services.find((x) => x.id === "caas-otp-generation");
  assert.equal((await post(`/fail-E1326${charge.path}`, { ...creds, ...charge.sampleRequest })).body.statusCode, "E1326");
});

test("/variant keeps what the next step needs, sends numbers bare, and adds an unknown field", async () => {
  const baseSize = await post("/variant/subscription/query-base", creds);
  assert.equal(baseSize.body.baseSize, 0);
  assert.equal(baseSize.body.fieldAddedByAFutureRelease, "ignore me");
  assert.equal(baseSize.body.version, undefined);

  const charge = catalog.services.find((x) => x.id === "caas-otp-generation");
  const r = (await post(`/variant${charge.path}`, { ...creds, ...charge.sampleRequest })).body;
  assert.equal(r.statusCode, "P1003");
  assert.equal(r.requestCorrelator, charge.sampleResponse.requestCorrelator, "identifiers stay strings");
  assert.equal(r.timeStamp, undefined);
});

test("an unknown path is a 404, not a silent success", async () => {
  const r = await post("/sms/sendd", creds);
  assert.equal(r.status, 404);
});
