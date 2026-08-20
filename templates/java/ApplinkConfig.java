package com.example.applink;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Applink configuration — the ONLY class that reads the environment.
 *
 * <p>Two credentials, plus one URL per service you provisioned. Nothing else is
 * configuration: timeouts and encodings are constants in the client, because they are
 * properties of the protocol rather than of your deployment.
 *
 * <p>An endpoint that is not set means that API is not enabled on your application. The client
 * refuses to call it, so you get a clear local error instead of E1309 from the platform.
 *
 * <p>Validation runs when the instance is created. Build it once at startup — from a
 * {@code @Bean} method in Spring, or in {@code main()} — so a misconfigured deployment fails
 * at boot rather than under load.
 *
 * <p>In Spring you may prefer {@code @ConfigurationProperties(prefix = "applink")} with
 * {@code @Validated} and {@code spring.config.import=optional:file:.env[.properties]}; the
 * variable names below stay the same either way. Do not put credentials in
 * {@code application.yml} — that file is committed.
 *
 * <p>Java 17 baseline, matching the client and the Spring Boot 3 line.
 *
 * <p>SERVER-SIDE ONLY.
 */
public final class ApplinkConfig {

  /**
   * Environment variable per service. The names are identical in every language template, so a
   * polyglot estate has one deployment story.
   */
  private static final Map<String, String> ENDPOINT_VARS = new LinkedHashMap<>();

  static {
    ENDPOINT_VARS.put("smsSend", "APPLINK_SMS_SEND_URL");
    ENDPOINT_VARS.put("ussdSend", "APPLINK_USSD_SEND_URL");
    ENDPOINT_VARS.put("subscriptionSend", "APPLINK_SUBSCRIPTION_SEND_URL");
    ENDPOINT_VARS.put("subscriptionQueryBase", "APPLINK_SUBSCRIPTION_QUERY_BASE_URL");
    ENDPOINT_VARS.put("subscriptionChargingInfo", "APPLINK_SUBSCRIPTION_CHARGING_INFO_URL");
    ENDPOINT_VARS.put("otpRequest", "APPLINK_OTP_REQUEST_URL");
    ENDPOINT_VARS.put("otpVerify", "APPLINK_OTP_VERIFY_URL");
    // CaaS step 1 sends the subscriber an OTP; step 2 is what moves money.
    ENDPOINT_VARS.put("caasOtpGeneration", "APPLINK_CAAS_DEBIT_URL");
    ENDPOINT_VARS.put("caasOtpVerify", "APPLINK_CAAS_OTP_VERIFY_URL");
    ENDPOINT_VARS.put("caasBalance", "APPLINK_CAAS_BALANCE_URL");
  }

  private final String applicationId;
  private final String password;
  private final Map<String, String> endpoints;

  private ApplinkConfig(String applicationId, String password, Map<String, String> endpoints) {
    this.applicationId = applicationId;
    this.password = password;
    this.endpoints = Map.copyOf(endpoints);
  }

  /** Read and validate the environment. Call once, at startup. */
  public static ApplinkConfig fromEnvironment() {
    Map<String, String> resolved = new LinkedHashMap<>();
    for (Map.Entry<String, String> entry : ENDPOINT_VARS.entrySet()) {
      endpoint(entry.getValue()).ifPresent(url -> resolved.put(entry.getKey(), url));
    }
    return new ApplinkConfig(
        requireEnv("APPLINK_APP_ID"), requireEnv("APPLINK_PASSWORD"), resolved);
  }

  private static String requireEnv(String name) {
    String value = System.getenv(name);
    if (value == null || value.isBlank()) {
      throw new IllegalStateException(
          "[applink] Missing required environment variable "
              + name
              + ".\nCopy .env.example to .env and fill in your Applink credentials."
              + "\nIn production, set it in your host's secret manager.");
    }
    return value.trim();
  }

  /** An endpoint is optional: absent means that API is not provisioned. */
  private static Optional<String> endpoint(String name) {
    String value = System.getenv(name);
    if (value == null || value.isBlank()) {
      return Optional.empty();
    }
    return Optional.of(value.trim().replaceAll("/+$", ""));
  }

  /** Never log this. Never send it to a client. */
  public String applicationId() {
    return applicationId;
  }

  /** Never log this. Never send it to a client. */
  public String password() {
    return password;
  }

  /**
   * Resolve an endpoint, or fail with a message that names the missing variable. This is the
   * guard that keeps you from calling an API your application was never provisioned for.
   */
  public String requireEndpoint(String service) {
    String variable = ENDPOINT_VARS.get(service);
    if (variable == null) {
      throw new IllegalArgumentException("[applink] Unknown service '" + service + "'");
    }
    String url = endpoints.get(service);
    if (url == null) {
      throw new IllegalStateException(
          "[applink] "
              + service
              + " is not configured. Either the API is not enabled on your application in "
              + "the Applink developer portal, or "
              + variable
              + " is missing from the environment. See .env.example.");
    }
    return url;
  }

  /** Which services this deployment can actually call. Useful at startup. */
  public List<String> enabledServices() {
    return new ArrayList<>(endpoints.keySet());
  }

  /** Redacted view, safe to log at startup to confirm what the process loaded. */
  public String describe() {
    return "Applink{applicationId="
        + applicationId
        + ", password=***redacted***, enabledServices="
        + enabledServices()
        + "}";
  }
}
