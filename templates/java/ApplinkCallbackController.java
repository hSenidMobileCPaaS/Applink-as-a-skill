package com.example.applink;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.scheduling.annotation.Async;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Applink callback (inbound webhook) handlers — Spring Boot.
 *
 * <p>Routes to register in the Applink portal:
 *
 * <pre>
 *   SMS receive (MO)          POST /api/applink/sms/receive
 *   Delivery status report    POST /api/applink/sms/report
 *   USSD receive              POST /api/applink/ussd/receive
 *   Subscriber notification   POST /api/applink/subscription/notify
 *   Charging notification     POST /api/applink/caas/charging-notification
 * </pre>
 *
 * <p>The contract, for all five:
 *
 * <ul>
 *   <li>Respond {@code {"statusCode":"S1000","statusDetail":"Success"}}
 *   <li>Respond FIRST, work afterwards
 *   <li>Always HTTP 200, even for payloads you reject
 *   <li>Be idempotent — every callback can arrive more than once
 *   <li>Never trust the body; it is unauthenticated JSON from the internet
 * </ul>
 *
 * <p>Spring Security must permit these paths and CSRF must be disabled for them — they are
 * machine-to-machine POSTs with no cookie. Then rely on the source-IP allowlist below, or you
 * have left an open endpoint.
 *
 * <p>Full rules: references/07-callbacks.md.
 */
@RestController
@RequestMapping("/api/applink")
public class ApplinkCallbackController {

  private static final Logger log = LoggerFactory.getLogger(ApplinkCallbackController.class);

  /** The only response Applink expects. */
  private static final Map<String, String> ACK =
      Map.of("statusCode", "S1000", "statusDetail", "Success");

  private final ApplinkConfig config;
  private final ApplinkClient client;
  private final UssdSessionStore sessions;
  private final DedupeStore dedupe = new DedupeStore(Duration.ofMinutes(10));

  public ApplinkCallbackController(
      ApplinkConfig config, ApplinkClient client, UssdSessionStore sessions) {
    this.config = config;
    this.client = client;
    this.sessions = sessions;
  }

  private static ResponseEntity<Map<String, String>> ack() {
    return ResponseEntity.ok().contentType(MediaType.APPLICATION_JSON).body(ACK);
  }

  /** Reject payloads addressed to a different application. Cheap noise filter. */
  private boolean isOurApp(Map<String, Object> body) {
    return Objects.equals(body.get("applicationId"), config.applicationId());
  }

  /* ── 1. MO SMS ─────────────────────────────────────────────────────────── */

  @PostMapping("/sms/receive")
  public ResponseEntity<Map<String, String>> moSms(@RequestBody Map<String, Object> body) {
    if (!isOurApp(body) || body.get("requestId") == null) {
      return ack();
    }
    if (dedupe.isDuplicate("mo:" + body.get("requestId"))) {
      return ack();
    }
    log.info(
        "mo-sms requestId={} from={}",
        body.get("requestId"),
        ApplinkClient.maskAddress(String.valueOf(body.get("sourceAddress"))));
    // Message content deliberately not logged — it is user communication.
    handleAsync("sms.mo", body);
    return ack();
  }

  /* ── 2. SMS delivery report ────────────────────────────────────────────── */

  /** Applink and the SMPP gateway use different spellings. Normalise both. */
  private static final Map<String, String> DELIVERY_STATUS =
      Map.of(
          "DELIVRD", "DELIVERED",
          "UNDELIV", "UNDELIVERABLE",
          "ACCEPTD", "ACCEPTED",
          "REJECTD", "REJECTED");

  @PostMapping("/sms/report")
  public ResponseEntity<Map<String, String>> deliveryReport(@RequestBody Map<String, Object> body) {
    Object requestId = body.get("requestId");
    Object raw = body.get("deliveryStatus");
    if (requestId == null || raw == null) {
      return ack();
    }
    String status = DELIVERY_STATUS.getOrDefault(String.valueOf(raw), String.valueOf(raw));
    if (dedupe.isDuplicate("dlr:" + requestId + ":" + status)) {
      return ack();
    }
    log.info("delivery-report requestId={} status={}", requestId, status);
    handleAsync("sms.dlr", body);
    return ack();
  }

  /* ── 3. USSD receive ───────────────────────────────────────────────────── */

  /**
   * The response body here is ONLY an acknowledgement. The screen the user sees comes from a
   * separate POST /ussd/send — which is why the reply is handled asynchronously.
   *
   * <p>USSD sessions time out in seconds. Do nothing slow before acknowledging.
   */
  @PostMapping("/ussd/receive")
  public ResponseEntity<Map<String, String>> ussd(@RequestBody Map<String, Object> body) {
    if (!isOurApp(body) || body.get("sessionId") == null || body.get("sourceAddress") == null) {
      return ack();
    }
    if (dedupe.isDuplicate("ussd:" + body.get("requestId"))) {
      return ack();
    }
    log.info(
        "ussd sessionId={} operation={} from={}",
        body.get("sessionId"),
        body.get("ussdOperation"),
        ApplinkClient.maskAddress(String.valueOf(body.get("sourceAddress"))));
    handleAsync("ussd.receive", body);
    return ack();
  }

  /** The menu logic, run out of band. Replies via sendUssd(). */
  private void handleUssdInput(Map<String, Object> payload) {
    String sessionId = String.valueOf(payload.get("sessionId"));
    String source = String.valueOf(payload.get("sourceAddress"));
    String operation = String.valueOf(payload.get("ussdOperation"));
    String input = String.valueOf(payload.getOrDefault("message", "")).trim();

    if ("mo-init".equals(operation)) {
      sessions.set(sessionId, "root", source);
      client.sendUssd(
          sessionId, source, "Welcome to Acme\n1. Balance\n2. Support\n0. Exit", "mt-cont");
      return;
    }

    if (sessions.get(sessionId).isEmpty()) {
      // Expired or unknown — close cleanly rather than leaving it hanging.
      client.sendUssd(sessionId, source, "Session expired. Please dial again.", "mt-fin");
      return;
    }

    // Terminal screens MUST use mt-fin, or the session hangs until the network times it out.
    switch (input) {
      case "0" -> {
        sessions.end(sessionId);
        client.sendUssd(sessionId, source, "Thank you.", "mt-fin");
      }
      case "1" -> {
        sessions.end(sessionId);
        client.sendUssd(sessionId, source, "Your balance is BDT 300.00", "mt-fin");
      }
      case "2" -> {
        sessions.set(sessionId, "support", source);
        client.sendUssd(sessionId, source, "Support\n1. Call us\n2. SMS us\n0. Exit", "mt-cont");
      }
      // Invalid input: reshow rather than dropping the session.
      default -> client.sendUssd(
          sessionId, source, "Invalid option\n1. Balance\n2. Support\n0. Exit", "mt-cont");
    }
  }

  /* ── 4. Subscriber notification ────────────────────────────────────────── */

  /**
   * The authoritative source of subscription state — including changes you did not initiate (a
   * user texting STOP, an operator removal, a billing failure). Consuming this is what lets you
   * keep a local mirror instead of re-querying getSubscriberChargingInfo, which is capped at ten
   * MSISDNs per call.
   *
   * <p>NOTE: this is the one callback that carries your {@code password}. It is stripped before
   * anything else touches the payload.
   */
  @PostMapping("/subscription/notify")
  public ResponseEntity<Map<String, String>> subscriptionNotification(
      @RequestBody Map<String, Object> body) {
    // The platform sends your API key back to you here. Remove it before this
    // payload can reach a log, a trace, or an error reporter.
    body.remove("password");
    if (!isOurApp(body) || body.get("subscriberId") == null || body.get("status") == null) {
      return ack();
    }
    String key =
        "sub:" + body.get("subscriberId") + ":" + body.get("status") + ":" + body.get("timeStamp");
    if (dedupe.isDuplicate(key)) {
      return ack();
    }
    log.info(
        "subscription-notify subscriber={} status={}",
        ApplinkClient.maskAddress(String.valueOf(body.get("subscriberId"))),
        body.get("status"));
    handleAsync("subscription.notification", body);
    return ack();
  }

  /* ── 5. Charging notification ──────────────────────────────────────────── */

  /**
   * Your reconciliation channel, and the only place a charge is actually settled. Applink
   * charging is two calls plus this callback: neither the P1003 from OTP generation nor the
   * response to OTP verification tells you what was paid.
   *
   * <p>Idempotency is not optional — a duplicate that double-counts revenue is a real bug with
   * real consequences.
   */
  @PostMapping("/caas/charging-notification")
  public ResponseEntity<Map<String, String>> chargingNotification(
      @RequestBody Map<String, Object> body) {
    Object key =
        body.get("externalTrxId") != null ? body.get("externalTrxId") : body.get("internalTrxId");
    if (key == null) {
      return ack();
    }
    if (dedupe.isDuplicate("charge:" + key + ":" + body.get("statusCode"))) {
      return ack();
    }
    log.info(
        "charging-notification externalTrxId={} statusCode={} paidAmount={} balanceDue={}",
        body.get("externalTrxId"),
        body.get("statusCode"),
        body.get("paidAmount"),
        body.get("balanceDue"));
    handleAsync("charging.notification", body);
    return ack();
  }

  /* ── Job dispatch ──────────────────────────────────────────────────────── */

  /**
   * Runs after the response has been sent. Requires {@code @EnableAsync} on a configuration
   * class. For anything that must survive a crash — charging reconciliation above all — publish
   * to a real broker instead.
   */
  @Async
  void handleAsync(String job, Map<String, Object> payload) {
    try {
      switch (job) {
        case "ussd.receive" -> handleUssdInput(payload);
        case "sms.mo" -> {
          // Honour opt-out keywords, then handle your own commands:
          //   if (message.strip().matches("(?i)^(stop|unsub|off)\\b.*")) client.unregister(from);
        }
        case "sms.dlr" -> {
          // Persist the latest status keyed by requestId.
        }
        case "subscription.notification" -> {
          // Upsert your local subscription mirror.
        }
        case "charging.notification" -> {
          // Find the ledger row by externalTrxId, compare paidAmount against
          // what you charged, and mark it CHARGED only when balanceDue is zero.
        }
        default -> log.warn("unknown job {}", job);
      }
    } catch (ApplinkClient.ApplinkException e) {
      log.error("job {} failed with {}", job, e.statusCode());
      // Send to a dead-letter queue here.
    } catch (RuntimeException e) {
      log.error("job {} failed", job, e);
    }
  }

  /* ── Support types ─────────────────────────────────────────────────────── */

  /**
   * Deduplication. Replace with Redis (SETNX + TTL) or a unique database constraint in
   * production — an in-process map does not survive a restart or a second instance, which is
   * exactly when duplicates arrive.
   */
  static final class DedupeStore {
    private final Duration ttl;
    private final Map<String, Instant> seen = new ConcurrentHashMap<>();

    DedupeStore(Duration ttl) {
      this.ttl = ttl;
    }

    boolean isDuplicate(String key) {
      Instant now = Instant.now();
      seen.values().removeIf(expiry -> expiry.isBefore(now));
      return seen.putIfAbsent(key, now.plus(ttl)) != null;
    }
  }

  /**
   * USSD session store contract. The in-memory implementation below is DEVELOPMENT ONLY — a
   * keypress routed to another instance cannot see it, and the user's menu dies mid-flow. Back it
   * with Redis (or Spring Session) in production, with a ~2 minute TTL.
   */
  public interface UssdSessionStore {
    java.util.Optional<String> get(String sessionId);

    void set(String sessionId, String node, String sourceAddress);

    void end(String sessionId);
  }

  /** Development-only implementation. Do not deploy this behind more than one instance. */
  public static final class InMemoryUssdSessionStore implements UssdSessionStore {
    private static final Duration TTL = Duration.ofMinutes(2);
    private final Map<String, Map.Entry<String, Instant>> sessions = new ConcurrentHashMap<>();

    @Override
    public java.util.Optional<String> get(String sessionId) {
      var entry = sessions.get(sessionId);
      if (entry == null) {
        return java.util.Optional.empty();
      }
      if (entry.getValue().isBefore(Instant.now())) {
        sessions.remove(sessionId);
        return java.util.Optional.empty();
      }
      return java.util.Optional.of(entry.getKey());
    }

    @Override
    public void set(String sessionId, String node, String sourceAddress) {
      sessions.put(sessionId, Map.entry(node, Instant.now().plus(TTL)));
    }

    @Override
    public void end(String sessionId) {
      sessions.remove(sessionId);
    }
  }

  /** USSD screens are plain ASCII (encoding 440) and roughly 182 characters. Assume 160. */
  public static String sanitiseUssd(String text) {
    String ascii =
        text.replaceAll("[“”]", "\"")
            .replaceAll("[‘’]", "'")
            .replaceAll("[–—]", "-")
            .replaceAll("[^\\x20-\\x7E\n]", "")
            .replace("\t", " ");
    return ascii.length() <= 160 ? ascii : ascii.substring(0, 160);
  }
}
