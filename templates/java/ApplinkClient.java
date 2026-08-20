package com.example.applink;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Applink API client — Java port of templates/typescript/applink-client.ts.
 *
 * <p>One {@link #post} helper injects credentials, applies a timeout, and turns non-S1000
 * responses into typed errors. Every service is a thin wrapper that resolves its endpoint
 * through {@link ApplinkConfig#requireEndpoint} — so calling an API your application was not
 * provisioned for fails locally with a clear message, rather than as E1309 from the platform.
 *
 * <p>Java 17 ({@code java.net.http.HttpClient}, {@code Stream.toList()}, switch expressions) and
 * Jackson — the Spring Boot 3 baseline. On Java 11 replace {@code .toList()} with
 * {@code .collect(Collectors.toList())}. Register it as a singleton bean; it is thread-safe and
 * the underlying {@code HttpClient} pools connections.
 *
 * <p>SERVER-SIDE ONLY.
 */
public final class ApplinkClient {

  /** A single outbound call should never hang. Protocol constant, not config. */
  private static final Duration TIMEOUT = Duration.ofSeconds(15);

  /** Applink's API version. Sent where the contract marks it mandatory. */
  private static final String API_VERSION = "1.0";

  /** The only currency Applink accepts. */
  private static final String CURRENCY = "BDT";

  /** Platform-side. Worth retrying with backoff. */
  private static final Set<String> TRANSIENT =
      Set.of("E1318", "E1319", "E1341", "E1601", "E1602", "E1603");

  /** Provisioning or credentials are wrong. Retrying will never help. */
  private static final Set<String> CONFIGURATION =
      Set.of("E1301", "E1303", "E1309", "E1311", "E1313", "E1315", "E1328", "E1331");

  /**
   * Accepted, not settled. P1003 from CaaS OTP generation means the OTP is on its way to the
   * subscriber and NOTHING has been charged. It is returned by {@link #startCharge} rather than
   * thrown, and must never be treated as a completed charge, nor re-sent.
   *
   * <p>Applink publishes no benign duplicate-state codes: register and unregister outcomes come
   * from {@code subscriptionStatus} in the response body. See {@link #hasSubscriptionStatus}.
   */
  public static final String PENDING_OTP_SENT = "P1003";

  private final ApplinkConfig config;
  private final ObjectMapper mapper = new ObjectMapper();
  private final HttpClient http;

  public ApplinkClient(ApplinkConfig config) {
    this.config = config;
    // Applink hosts have served an incomplete certificate chain, which strict clients reject.
    // Do NOT install a trust-all TrustManager to work around it — that lets anyone on the path
    // read the applicationId and password that can charge your subscribers. Import the
    // intermediate CA into a truststore and point an SSLContext at it instead:
    //
    //   .sslContext(SSLContexts.custom().loadTrustMaterial(truststore, null).build())
    //
    // See references/09-security-best-practices.md.
    this.http = HttpClient.newBuilder().connectTimeout(TIMEOUT).build();
  }

  /* ── Errors ─────────────────────────────────────────────────────────────── */

  public static final class ApplinkException extends RuntimeException {
    private final String statusCode;
    private final String statusDetail;
    private final String service;

    ApplinkException(String statusCode, String statusDetail, String service) {
      super("[" + statusCode + "] " + statusDetail + " (" + service + ")");
      this.statusCode = statusCode;
      this.statusDetail = statusDetail;
      this.service = service;
    }

    public String statusCode() {
      return statusCode;
    }

    public String statusDetail() {
      return statusDetail;
    }

    public String service() {
      return service;
    }

    public boolean isRetryable() {
      return TRANSIENT.contains(statusCode);
    }

    public boolean isConfiguration() {
      return CONFIGURATION.contains(statusCode);
    }
  }

  /* ── Helpers ────────────────────────────────────────────────────────────── */

  /**
   * Normalise a subscriber address. The ONLY place {@code tel:} is added.
   *
   * <p>Accepts an already-prefixed address, a masked value, +880…, 00880… or a local 01…
   * number. The "+" is stripped: Applink's SMS samples include one and every other API's
   * samples do not, so one form has to win, and the no-"+" form is what the subscription, OTP
   * and CaaS endpoints publish.
   */
  public static String toTelAddress(String msisdn) {
    String trimmed = msisdn == null ? "" : msisdn.trim();
    if (trimmed.isEmpty()) {
      throw new IllegalArgumentException("[applink] Empty subscriber address");
    }
    if (trimmed.toLowerCase(Locale.ROOT).startsWith("tel:")) {
      return "tel:" + trimmed.substring(4).replaceAll("[\\s+]", "");
    }
    String digits = trimmed.replaceAll("[\\s()-]", "").replaceFirst("^\\+", "");
    if (digits.startsWith("00")) {
      digits = digits.substring(2);
    }
    if (digits.startsWith("0")) {
      digits = "880" + digits.substring(1);
    }
    return "tel:" + digits;
  }

  /**
   * Applink publishes no benign "already registered" code, so the desired state is read from
   * {@code subscriptionStatus}. The published samples carry a trailing dot ("UNREGISTERED."),
   * hence the prefix comparison.
   */
  public static boolean hasSubscriptionStatus(JsonNode response, String expected) {
    String actual = response.path("subscriptionStatus").asText("").trim().toUpperCase(Locale.ROOT);
    return actual.startsWith(expected.toUpperCase(Locale.ROOT));
  }

  /** Mask a subscriber address for logging. Never log the raw value. */
  public static String maskAddress(String address) {
    String body = address == null ? "" : address.replaceFirst("(?i)^tel:", "");
    if (body.length() <= 6) {
      return "tel:***";
    }
    return "tel:"
        + body.substring(0, 3)
        + "*".repeat(body.length() - 6)
        + body.substring(body.length() - 3);
  }

  /** A unique, persistable idempotency key for a charge. Max 32 characters. */
  public static String generateExternalTrxId() {
    return UUID.randomUUID().toString().replace("-", "");
  }

  /* ── Core ───────────────────────────────────────────────────────────────── */

  private JsonNode post(
      String service, String url, Map<String, Object> body, String... acceptedCodes) {
    Map<String, Object> payload = new LinkedHashMap<>();
    payload.put("applicationId", config.applicationId());
    payload.put("password", config.password());
    payload.putAll(body);

    JsonNode data;
    try {
      HttpRequest request =
          HttpRequest.newBuilder(URI.create(url))
              .timeout(TIMEOUT)
              .header("Content-Type", "application/json;charset=utf-8")
              .POST(HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(payload)))
              .build();
      HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
      // The HTTP status is deliberately not consulted: Applink returns 200 for
      // application-level failures, and the real outcome is statusCode in the body.
      data = mapper.readTree(response.body());
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new IllegalStateException("[applink] " + service + " interrupted", e);
    } catch (Exception e) {
      throw new IllegalStateException("[applink] " + service + " transport failure", e);
    }

    String statusCode = data.path("statusCode").asText("");
    if ("S1000".equals(statusCode) || List.of(acceptedCodes).contains(statusCode)) {
      return data;
    }
    throw new ApplinkException(statusCode, data.path("statusDetail").asText(""), service);
  }

  /* ── SMS ────────────────────────────────────────────────────────────────── */

  /** Send an MT SMS to one or more subscribers. */
  public JsonNode sendSms(List<String> to, String message) {
    List<String> recipients = to.stream().map(ApplinkClient::toTelAddress).toList();
    if (recipients.contains("tel:all")) {
      throw new IllegalArgumentException(
          "[applink] Use broadcastSms() for tel:all — broadcasts must be deliberate.");
    }
    return post(
        "sms-send",
        config.requireEndpoint("smsSend"),
        Map.of(
            "version", API_VERSION,
            "message", message,
            "destinationAddresses", recipients));
  }

  public static final String BROADCAST_CONFIRMATION =
      "I_HAVE_VERIFIED_THIS_GOES_TO_ALL_SUBSCRIBERS";

  /**
   * Send to the ENTIRE subscribed base.
   *
   * <p>Deliberately separate from {@link #sendSms} so it can never be reached by accident —
   * check the subscriber base size first, and put an authorisation check in front of this.
   */
  public JsonNode broadcastSms(String message, String confirmation) {
    if (!BROADCAST_CONFIRMATION.equals(confirmation)) {
      throw new IllegalArgumentException("[applink] Broadcast confirmation token missing");
    }
    return post(
        "sms-send",
        config.requireEndpoint("smsSend"),
        Map.of(
            "version", API_VERSION,
            "message", message,
            "destinationAddresses", List.of("tel:all")));
  }

  /* ── USSD ───────────────────────────────────────────────────────────────── */

  /**
   * Send a USSD screen.
   *
   * <p>{@code sessionId} MUST be the one the platform sent you. Use "mt-fin" for the final
   * screen — anything else leaves the session hanging until the network times out.
   */
  public JsonNode sendUssd(
      String sessionId, String destinationAddress, String message, String operation) {
    if (!Set.of("mt-init", "mt-cont", "mt-fin").contains(operation)) {
      throw new IllegalArgumentException("[applink] Invalid ussdOperation '" + operation + "'");
    }
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("message", message);
    body.put("sessionId", sessionId);
    body.put("ussdOperation", operation);
    body.put("destinationAddress", toTelAddress(destinationAddress));
    body.put("encoding", "440");
    body.put("version", API_VERSION);
    return post("ussd-send", config.requireEndpoint("ussdSend"), body);
  }

  /* ── Subscription ───────────────────────────────────────────────────────── */

  /**
   * Opt a subscriber in. Only call this with recorded, explicit consent.
   *
   * <p>Applink publishes no "already registered" code: confirm the outcome with {@code
   * hasSubscriptionStatus(response, "REGISTERED")} rather than treating a repeat call as an
   * error.
   */
  public JsonNode register(String subscriberId) {
    return post(
        "subscription-register",
        config.requireEndpoint("subscriptionSend"),
        Map.of("subscriberId", toTelAddress(subscriberId), "action", "1"));
  }

  /**
   * Opt a subscriber out.
   *
   * <p>The platform's own sample returns S1000 with statusDetail "not registered" for a
   * subscriber who was never registered — reaching the desired state is the success condition.
   * Confirm with {@code hasSubscriptionStatus(response, "UNREGISTERED")}.
   */
  public JsonNode unregister(String subscriberId) {
    return post(
        "subscription-unregister",
        config.requireEndpoint("subscriptionSend"),
        Map.of("subscriberId", toTelAddress(subscriberId), "action", "0"));
  }

  /**
   * Subscription status and last-charge details for up to ten subscribers.
   *
   * <p>This is Applink's status lookup — there is no getStatus endpoint. Use it for
   * reconciliation, not as a per-request gate: mirror state from the subscriber notification
   * callback instead.
   */
  public JsonNode getSubscriberChargingInfo(List<String> subscriberIds) {
    if (subscriberIds.isEmpty()) {
      throw new IllegalArgumentException(
          "[applink] getSubscriberChargingInfo needs at least one subscriber");
    }
    if (subscriberIds.size() > 10) {
      throw new IllegalArgumentException(
          "[applink] getSubscriberChargingInfo accepts a maximum of 10 MSISDNs");
    }
    return post(
        "subscription-charging-info",
        config.requireEndpoint("subscriptionChargingInfo"),
        Map.of(
            "subscriberIds",
            subscriberIds.stream().map(ApplinkClient::toTelAddress).toList()));
  }

  /**
   * Subscriber base size. Needs no subscriber and charges nothing, which also makes it the best
   * connectivity and credential smoke test. {@code baseSize} comes back as a string.
   */
  public long queryBase() {
    JsonNode data =
        post("subscription-query-base", config.requireEndpoint("subscriptionQueryBase"), Map.of());
    return Long.parseLong(data.path("baseSize").asText("0"));
  }

  /* ── OTP ────────────────────────────────────────────────────────────────── */

  /**
   * Send an OTP to a plain mobile number.
   *
   * <p>Rate-limit per number AND per IP before calling, or the app becomes an SMS-bombing tool.
   * Keep the returned referenceNo server-side; never log it.
   */
  public JsonNode requestOtp(String subscriberId, Map<String, Object> applicationMetaData) {
    return post(
        "otp-request",
        config.requireEndpoint("otpRequest"),
        Map.of(
            "subscriberId", toTelAddress(subscriberId),
            "applicationMetaData", applicationMetaData));
  }

  /**
   * Verify an OTP. Valid five minutes — enforce that on your side too, and cap attempts
   * yourself; the platform documents no attempt limit. The returned subscriberId is the
   * identifier to use for every subsequent call.
   */
  public JsonNode verifyOtp(String referenceNo, String otp) {
    return post(
        "otp-verify",
        config.requireEndpoint("otpVerify"),
        Map.of("referenceNo", referenceNo, "otp", otp));
  }

  /* ── CaaS — charging is TWO calls ──────────────────────────────────── */

  /**
   * Step 1 of charging: reserve the charge and send the subscriber an OTP.
   *
   * <p>THIS DOES NOT CHARGE ANYONE. It returns P1003 and a {@code requestCorrelator}.
   *
   * <ul>
   *   <li>{@code externalTrxId} is your idempotency key. Generate it with {@link
   *       #generateExternalTrxId()}, PERSIST IT with a PENDING ledger row, then call this.
   *   <li>Persist {@code requestCorrelator} from the response. Without it the charge can never
   *       be completed, and there is no way to recover it.
   *   <li>There are deliberately no retries here. A timeout does NOT mean the charge did not
   *       start; reconcile against the charging notification.
   *   <li>P1003 is returned, not thrown — it is the expected outcome.
   *   <li>Amount is {@link BigDecimal} — never {@code double}.
   * </ul>
   */
  public JsonNode startCharge(
      String subscriberId,
      BigDecimal amount,
      String externalTrxId,
      String paymentInstrumentName) {
    if (externalTrxId == null || externalTrxId.isBlank()) {
      throw new IllegalArgumentException(
          "[applink] externalTrxId is required and must be persisted first");
    }
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("externalTrxId", externalTrxId);
    body.put("amount", amount.toPlainString());
    body.put(
        "paymentInstrumentName",
        paymentInstrumentName == null ? "Mobile Account" : paymentInstrumentName);
    body.put("subscriberId", toTelAddress(subscriberId));
    // Capital C, as published. The balance endpoint uses lower case.
    body.put("Currency", CURRENCY);
    return post(
        "caas-otp-generation",
        config.requireEndpoint("caasOtpGeneration"),
        body,
        PENDING_OTP_SENT);
  }

  /**
   * Step 2 of charging: verify the subscriber's OTP and complete the charge.
   *
   * <p>THIS MOVES REAL MONEY.
   *
   * <ul>
   *   <li>{@code requestCorrelator} comes from the {@link #startCharge} response. It is NOT the
   *       externalTrxId you generated and NOT the referenceNo from {@link #requestOtp}. Getting
   *       that wrong is E1855.
   *   <li>On E1850 (wrong OTP), re-prompt against the SAME correlator. On E1851 (expired),
   *       abandon the transaction.
   *   <li>NEVER call {@link #startCharge} again to retry this — that begins a second charge.
   *   <li>The authoritative outcome is the charging notification callback, which carries
   *       paidAmount and balanceDue. Settle the ledger there.
   * </ul>
   */
  public JsonNode confirmCharge(String requestCorrelator, String otp, String subscriberId) {
    if (requestCorrelator == null || requestCorrelator.isBlank()) {
      throw new IllegalArgumentException(
          "[applink] requestCorrelator is required — it comes from startCharge()");
    }
    return post(
        "caas-otp-verify",
        config.requireEndpoint("caasOtpVerify"),
        Map.of(
            "referenceNo", requestCorrelator,
            "otp", otp,
            "sourceAddress", toTelAddress(subscriberId)));
  }

  /**
   * Query chargeable balance.
   *
   * <p>Advisory only: the balance can change between this and the charge. Always handle E1326
   * on the charging path regardless of what this returned.
   *
   * <p>This endpoint is in the published specification but not in the rendered documentation's
   * navigation. Leaving APPLINK_CAAS_BALANCE_URL unset is how you disable it until support
   * confirms it is enabled on your application.
   */
  public JsonNode queryBalance(String subscriberId) {
    return post(
        "caas-query-balance",
        config.requireEndpoint("caasBalance"),
        Map.of(
            "subscriberId", toTelAddress(subscriberId),
            "paymentInstrumentName", "MobileAccount",
            // Lower-case c on this endpoint, capital C on the charging request.
            "currency", CURRENCY));
  }

  /* ── Extension point ────────────────────────────────────────────────────────
   *
   * Adding a service Applink publishes later:
   *
   *   1. Add its URL variable to .env.example and to ENDPOINT_VARS in ApplinkConfig
   *   2. Add one wrapper here:
   *
   *        public JsonNode newThing(Map<String, Object> input) {
   *          return post("new-thing", config.requireEndpoint("newThing"), input);
   *        }
   *
   * It inherits credential injection, the timeout, error mapping and the not-provisioned guard
   * for free. Do not build a parallel client.
   */
}
