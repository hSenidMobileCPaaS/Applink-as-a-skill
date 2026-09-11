// Conformance driver for templates/typescript. Usage: drive.ts <base-url> <sample|variant|fail>
// Runs under Node's built-in type stripping; resolve-ts.mjs maps the template's
// extensionless imports ("./applink-config") to their .ts files.
import assert from "node:assert/strict";

const [base, scenario] = process.argv.slice(2);
const paths: Record<string, string> = {
  APPLINK_SMS_SEND_URL: "/sms/send",
  APPLINK_USSD_SEND_URL: "/ussd/send",
  APPLINK_SUBSCRIPTION_SEND_URL: "/subscription/send",
  APPLINK_SUBSCRIPTION_QUERY_BASE_URL: "/subscription/query-base",
  APPLINK_SUBSCRIPTION_CHARGING_INFO_URL: "/subscription/getSubscriberChargingInfo",
  APPLINK_OTP_REQUEST_URL: "/otp/request",
  APPLINK_OTP_VERIFY_URL: "/otp/verify",
  APPLINK_CAAS_DEBIT_URL: "/caas/direct/debit",
  APPLINK_CAAS_OTP_VERIFY_URL: "/caas/otp/verify",
  APPLINK_CAAS_BALANCE_URL: "/caas/get/balance",
};
for (const [name, path] of Object.entries(paths)) process.env[name] = base + path;
process.env.APPLINK_APP_ID ??= "APP_000001";
process.env.APPLINK_PASSWORD ??= "conformance-only";

const c = await import("../../../templates/typescript/applink-client.ts");
const CORRELATOR = "8801442233146169943053700500040";

async function expectFailure(code: string, call: () => Promise<unknown>) {
  await assert.rejects(call, (err: any) => {
    assert.ok(err instanceof c.ApplinkError, `expected ApplinkError, got ${err}`);
    assert.equal(err.statusCode, code);
    return true;
  });
}

if (scenario === "fail") {
  await expectFailure("E1313", () => c.queryBase());
  await expectFailure("E1313", () => c.register("8801959979376"));
  await expectFailure("E1313", () => c.sendSms("8801959979376", "Hello"));
  await expectFailure("E1313", () => c.startCharge({ subscriberId: "8801973579363", amount: "5", externalTrxId: "t1" }));
  await expectFailure("E1313", () => c.confirmCharge({ requestCorrelator: CORRELATOR, otp: "123456", subscriberId: "8801973579363" }));
  await expectFailure("E1850", () => c.verifyOtp({ referenceNo: "213561321321613", otp: "000000" }));
  console.log("typescript fail: every failure body raised with its statusCode");
  process.exit(0);
}

const sms = await c.sendSms("01959979376", "Hello", { deliveryStatusRequest: "1" });
if (scenario === "sample") assert.equal(sms.destinationResponses?.[0]?.statusCode, "S1000");
await c.sendSms(["+8801959979376", "tel:8801959979377"], "হ্যালো");
await c.broadcastSms("Service update", "I_HAVE_VERIFIED_THIS_GOES_TO_ALL_SUBSCRIBERS");
await c.sendUssd({ sessionId: "1330929317043", destinationAddress: "tel:8801959979376", message: "1. One\n2. Two", operation: "mt-cont" });
assert.ok(c.hasSubscriptionStatus(await c.register("8801959979376"), "REGISTERED"));
assert.ok(c.hasSubscriptionStatus(await c.unregister("8801959979376"), "UNREGISTERED"));
assert.equal((await c.queryBase()).size, 0);
await c.getSubscriberChargingInfo(["8801973579363"]);
const otp = await c.requestOtp({ subscriberId: "8801416177301" });
assert.equal(otp.referenceNo, "213561321321613");
await c.requestOtp({
  subscriberId: "8801416177301",
  applicationHash: "abcdefgh",
  metaData: { client: "WEBAPP", device: "PC", os: "Windows 10", appCode: "https://example.com" },
});
const verified = await c.verifyOtp({ referenceNo: otp.referenceNo!, otp: "012345" });
assert.equal(verified.subscriberId, "tel:8801416177301");
const charge = await c.startCharge({ subscriberId: "8801973579363", amount: "5", externalTrxId: c.generateExternalTrxId() });
assert.equal(charge.statusCode, "P1003");
assert.equal(charge.requestCorrelator, CORRELATOR, "requestCorrelator must survive as the exact string");
await c.confirmCharge({ requestCorrelator: charge.requestCorrelator!, otp: "123456", subscriberId: "8801973579363" });
await c.queryBalance({ subscriberId: "8801959979376" });
console.log(`typescript ${scenario}: every wrapper returned and parsed the response`);
