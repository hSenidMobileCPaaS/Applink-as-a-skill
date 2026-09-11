// Conformance driver for templates/csharp. Usage: dotnet run -- <base-url> <sample|variant|fail>
// Drive.csproj compiles all three template files with it; run.mjs supplies the
// APPLINK_* environment.

using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text.Json;
using System.Threading.Tasks;
using Applink;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Options;

const string Correlator = "8801442233146169943053700500040";
var scenario = args[1];

var options = new ApplinkOptions();
options.Load(new ConfigurationBuilder().AddEnvironmentVariables().Build());
if (!options.Validate(out var error)) throw new InvalidOperationException(error);
var c = new ApplinkClient(new HttpClient(), Options.Create(options));

static void Check(bool ok, string message)
{
    if (!ok) throw new Exception(message);
}

static async Task ExpectFailure(string code, Func<Task> call)
{
    try
    {
        await call();
    }
    catch (ApplinkException e)
    {
        Check(e.StatusCode == code, $"expected {code}, got {e.StatusCode}");
        return;
    }
    throw new Exception($"expected ApplinkException {code}, the call returned normally");
}

if (scenario == "fail")
{
    await ExpectFailure("E1313", () => c.QueryBaseAsync());
    await ExpectFailure("E1313", () => c.RegisterAsync("8801959979376"));
    await ExpectFailure("E1313", () => c.SendSmsAsync(new[] { "8801959979376" }, "Hello"));
    await ExpectFailure("E1313", () => c.StartChargeAsync("8801973579363", 5m, "t1"));
    await ExpectFailure("E1313", () => c.ConfirmChargeAsync(Correlator, "123456", "8801973579363"));
    await ExpectFailure("E1850", () => c.VerifyOtpAsync("213561321321613", "000000"));
    Console.WriteLine("csharp fail: every failure body raised with its statusCode");
    return;
}

var sms = await c.SendSmsAsync(new[] { "01959979376" }, "Hello");
if (scenario == "sample")
{
    Check(sms.GetProperty("destinationResponses")[0].GetProperty("statusCode").GetString() == "S1000", "per-recipient code");
}
await c.SendSmsAsync(new[] { "+8801959979376", "tel:8801959979377" }, "হ্যালো");
await c.BroadcastSmsAsync("Service update", ApplinkClient.BroadcastConfirmation);
await c.SendUssdAsync("1330929317043", "tel:8801959979376", "1. One\n2. Two", "mt-cont");
Check(ApplinkClient.HasSubscriptionStatus(await c.RegisterAsync("8801959979376"), "REGISTERED"), "register");
Check(ApplinkClient.HasSubscriptionStatus(await c.UnregisterAsync("8801959979376"), "UNREGISTERED"), "unregister");
Check(await c.QueryBaseAsync() == 0, "baseSize");
await c.GetSubscriberChargingInfoAsync(new[] { "8801973579363" });
var otp = await c.RequestOtpAsync("8801416177301");
Check(otp.GetProperty("referenceNo").GetString() == "213561321321613", "referenceNo");
await c.RequestOtpAsync("8801416177301", new Dictionary<string, string>
{
    ["client"] = "WEBAPP", ["device"] = "PC", ["os"] = "Windows 10", ["appCode"] = "https://example.com",
});
var verified = await c.VerifyOtpAsync("213561321321613", "012345");
Check(verified.GetProperty("subscriberId").GetString() == "tel:8801416177301", "subscriberId");
var charge = await c.StartChargeAsync("8801973579363", 5m, ApplinkClient.GenerateExternalTrxId());
Check(charge.GetProperty("statusCode").GetString() == "P1003", "P1003");
Check(charge.GetProperty("requestCorrelator").GetString() == Correlator, "requestCorrelator must survive as the exact string");
await c.ConfirmChargeAsync(Correlator, "123456", "8801973579363");
await c.QueryBalanceAsync("8801959979376");
Console.WriteLine($"csharp {scenario}: every wrapper returned and parsed the response");
