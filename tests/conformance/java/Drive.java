// Conformance driver for templates/java. Usage: java Drive <base-url> <sample|variant|fail>
// run.mjs compiles it with ApplinkClient.java and ApplinkConfig.java against
// Jackson, and supplies the APPLINK_* environment (Java cannot set it itself).

import com.example.applink.ApplinkClient;
import com.example.applink.ApplinkConfig;
import com.fasterxml.jackson.databind.JsonNode;
import java.math.BigDecimal;
import java.util.List;
import java.util.Map;

public final class Drive {
  private static final String CORRELATOR = "8801442233146169943053700500040";

  interface Call {
    Object run();
  }

  static void check(boolean ok, String message) {
    if (!ok) throw new AssertionError(message);
  }

  static void expectFailure(String code, Call call) {
    try {
      call.run();
    } catch (ApplinkClient.ApplinkException e) {
      check(code.equals(e.statusCode()), "expected " + code + ", got " + e.statusCode());
      return;
    }
    throw new AssertionError("expected ApplinkException " + code + ", the call returned normally");
  }

  public static void main(String[] args) {
    String scenario = args[1];
    ApplinkClient c = new ApplinkClient(ApplinkConfig.fromEnvironment());

    if (scenario.equals("fail")) {
      expectFailure("E1313", c::queryBase);
      expectFailure("E1313", () -> c.register("8801959979376"));
      expectFailure("E1313", () -> c.sendSms(List.of("8801959979376"), "Hello"));
      expectFailure("E1313", () -> c.startCharge("8801973579363", new BigDecimal("5"), "t1", null));
      expectFailure("E1313", () -> c.confirmCharge(CORRELATOR, "123456", "8801973579363"));
      expectFailure("E1850", () -> c.verifyOtp("213561321321613", "000000"));
      System.out.println("java fail: every failure body raised with its statusCode");
      return;
    }

    JsonNode sms = c.sendSms(List.of("01959979376"), "Hello");
    if (scenario.equals("sample")) {
      check(sms.path("destinationResponses").path(0).path("statusCode").asText().equals("S1000"), "per-recipient code");
    }
    c.sendSms(List.of("+8801959979376", "tel:8801959979377"), "হ্যালো");
    c.broadcastSms("Service update", ApplinkClient.BROADCAST_CONFIRMATION);
    c.sendUssd("1330929317043", "tel:8801959979376", "1. One\n2. Two", "mt-cont");
    check(ApplinkClient.hasSubscriptionStatus(c.register("8801959979376"), "REGISTERED"), "register");
    check(ApplinkClient.hasSubscriptionStatus(c.unregister("8801959979376"), "UNREGISTERED"), "unregister");
    check(c.queryBase() == 0, "baseSize");
    c.getSubscriberChargingInfo(List.of("8801973579363"));
    JsonNode otp = c.requestOtp("8801416177301", null);
    check(otp.path("referenceNo").asText().equals("213561321321613"), "referenceNo");
    c.requestOtp(
        "8801416177301",
        Map.of("client", "WEBAPP", "device", "PC", "os", "Windows 10", "appCode", "https://example.com"));
    JsonNode verified = c.verifyOtp("213561321321613", "012345");
    check(verified.path("subscriberId").asText().equals("tel:8801416177301"), "subscriberId");
    JsonNode charge =
        c.startCharge("8801973579363", new BigDecimal("5"), ApplinkClient.generateExternalTrxId(), null);
    check(charge.path("statusCode").asText().equals("P1003"), "P1003");
    check(charge.path("requestCorrelator").asText().equals(CORRELATOR), "requestCorrelator must survive as the exact string");
    c.confirmCharge(CORRELATOR, "123456", "8801973579363");
    c.queryBalance("8801959979376");
    System.out.println("java " + scenario + ": every wrapper returned and parsed the response");
  }
}
