<?php

declare(strict_types=1);

namespace App\Applink;

use Throwable;

/**
 * Applink callback (inbound webhook) handlers — framework-neutral PHP.
 *
 * Routes to register in the Applink portal:
 *   SMS receive (MO)          POST /api/applink/sms/receive
 *   Delivery status report    POST /api/applink/sms/report
 *   USSD receive              POST /api/applink/ussd/receive
 *   Subscriber notification   POST /api/applink/subscription/notify
 *   Charging notification     POST /api/applink/caas/charging-notification
 *
 * The contract, for all five:
 *   - Respond {"statusCode":"S1000","statusDetail":"Success"}
 *   - Respond FIRST, work afterwards
 *   - Always HTTP 200, even for payloads you reject
 *   - Be idempotent — every callback can arrive more than once
 *   - Never trust the body; it is unauthenticated JSON from the internet
 *   - Redact the subscriber notification's password field before logging
 *
 * Laravel: make each method a controller action returning response()->json(self::ACK),
 * put the routes in routes/api.php (which is CSRF-exempt), and dispatch a queued
 * Job instead of calling handleJob() inline.
 *
 * Full rules: references/07-callbacks.md.
 */
final class ApplinkCallbacks
{
    /** The only response Applink expects. */
    public const ACK = ['statusCode' => 'S1000', 'statusDetail' => 'Success'];

    /**
     * Restrict to Applink's egress IPs. Applink signs nothing, so there is no
     * signature to verify — source IP is the strongest control available. Ask
     * support for the current list. Prefer enforcing it at the firewall or load
     * balancer; this is the fallback for when you cannot.
     *
     * @var list<string>
     */
    public const APPLINK_SOURCE_IPS = [];

    public function __construct(
        private readonly ApplinkConfig $config,
        private readonly ApplinkClient $client,
        private readonly UssdSessionStore $sessions,
        private readonly DedupeStore $dedupe,
        private readonly JobQueue $queue,
    ) {
    }

    /* ── Shared guards ────────────────────────────────────────────────────── */

    public static function isAllowedSource(?string $remoteAddress): bool
    {
        if (self::APPLINK_SOURCE_IPS === []) {
            return true; // not configured yet
        }

        return $remoteAddress !== null
            && in_array($remoteAddress, self::APPLINK_SOURCE_IPS, true);
    }

    /**
     * Read the JSON body without failing the response on malformed input.
     *
     * @return array<string, mixed>|null
     */
    public static function readJson(string $raw): ?array
    {
        $decoded = json_decode($raw, true);

        return is_array($decoded) ? $decoded : null;
    }

    /** Reject payloads addressed to a different application. Cheap noise filter. */
    private function isOurApp(array $body): bool
    {
        return ($body['applicationId'] ?? null) === $this->config->applicationId;
    }

    /* ── 1. MO SMS ────────────────────────────────────────────────────────── */

    /** @param array<string, mixed>|null $body */
    public function smsReceive(?array $body): array
    {
        if ($body === null || !$this->isOurApp($body) || empty($body['requestId'])) {
            return self::ACK;
        }
        if ($this->dedupe->isDuplicate('mo:' . $body['requestId'])) {
            return self::ACK;
        }

        // Message content deliberately not logged — it is user communication.
        error_log(sprintf(
            '[applink] sms-receive requestId=%s from=%s',
            (string) $body['requestId'],
            ApplinkClient::maskAddress((string) ($body['sourceAddress'] ?? ''))
        ));

        $this->queue->push('sms.mo', $body);

        return self::ACK;
    }

    /* ── 2. SMS delivery status report ────────────────────────────────────── */

    /** Applink and the SMPP layer use different spellings. Normalise both. */
    private const DELIVERY_STATUS = [
        'DELIVRD' => 'DELIVERED',
        'UNDELIV' => 'UNDELIVERABLE',
        'ACCEPTD' => 'ACCEPTED',
        'REJECTD' => 'REJECTED',
    ];

    /** @param array<string, mixed>|null $body */
    public function smsReport(?array $body): array
    {
        if ($body === null || empty($body['requestId']) || empty($body['deliveryStatus'])) {
            return self::ACK;
        }

        $raw = (string) $body['deliveryStatus'];
        $status = self::DELIVERY_STATUS[$raw] ?? $raw;
        if ($this->dedupe->isDuplicate("dlr:{$body['requestId']}:{$status}")) {
            return self::ACK;
        }

        error_log(sprintf(
            '[applink] sms-report requestId=%s status=%s',
            (string) $body['requestId'],
            $status
        ));

        $this->queue->push('sms.dlr', array_merge($body, ['deliveryStatus' => $status]));

        return self::ACK;
    }

    /**
     * Timestamps arrive as either yyMMddHHmm (10) or yyyyMMddHHmmss (14).
     * Parse both; return null rather than guessing.
     */
    public static function parseApplinkTimestamp(string $raw): ?\DateTimeImmutable
    {
        $format = match (strlen($raw)) {
            14 => 'YmdHis',
            10 => 'ymdHi',
            default => null,
        };
        if ($format === null || !ctype_digit($raw)) {
            return null;
        }

        $parsed = \DateTimeImmutable::createFromFormat(
            $format,
            $raw,
            new \DateTimeZone('UTC')
        );

        return $parsed === false ? null : $parsed;
    }

    /* ── 3. USSD receive ──────────────────────────────────────────────────── */

    /**
     * The response body here is ONLY an acknowledgement. The screen the user
     * sees comes from a separate POST /ussd/send — which is why the reply is
     * queued rather than returned.
     *
     * USSD sessions time out in seconds. Do nothing slow before acknowledging.
     *
     * @param array<string, mixed>|null $body
     */
    public function ussd(?array $body): array
    {
        if ($body === null || !$this->isOurApp($body)) {
            return self::ACK;
        }
        if (empty($body['sessionId']) || empty($body['sourceAddress'])) {
            return self::ACK;
        }
        if ($this->dedupe->isDuplicate('ussd:' . ($body['requestId'] ?? ''))) {
            return self::ACK;
        }

        error_log(sprintf(
            '[applink] ussd sessionId=%s operation=%s from=%s',
            (string) $body['sessionId'],
            (string) ($body['ussdOperation'] ?? ''),
            ApplinkClient::maskAddress((string) $body['sourceAddress'])
        ));

        $this->queue->push('ussd.receive', $body);

        return self::ACK;
    }

    /**
     * The menu logic, run out of band. Replies via sendUssd().
     *
     * @param array<string, mixed> $payload
     */
    public function handleUssdInput(array $payload): void
    {
        $sessionId = (string) $payload['sessionId'];
        $source = (string) $payload['sourceAddress'];
        $input = trim((string) ($payload['message'] ?? ''));

        if (($payload['ussdOperation'] ?? '') === 'mo-init') {
            $this->sessions->set($sessionId, 'root', $source);
            $this->client->sendUssd(
                $sessionId,
                $source,
                "Welcome to Acme\n1. Balance\n2. Support\n0. Exit",
                'mt-cont'
            );

            return;
        }

        if ($this->sessions->get($sessionId) === null) {
            // Expired or unknown — close cleanly rather than leaving it hanging.
            $this->client->sendUssd(
                $sessionId,
                $source,
                'Session expired. Please dial again.',
                'mt-fin'
            );

            return;
        }

        // Terminal screens MUST use mt-fin, or the session hangs until the
        // network times it out.
        switch ($input) {
            case '0':
                $this->sessions->end($sessionId);
                $this->client->sendUssd($sessionId, $source, 'Thank you.', 'mt-fin');

                return;

            case '1':
                $this->sessions->end($sessionId);
                $this->client->sendUssd(
                    $sessionId,
                    $source,
                    'Your balance is BDT 300.00',
                    'mt-fin'
                );

                return;

            case '2':
                $this->sessions->set($sessionId, 'support', $source);
                $this->client->sendUssd(
                    $sessionId,
                    $source,
                    "Support\n1. Call us\n2. SMS us\n0. Exit",
                    'mt-cont'
                );

                return;

            default:
                // Invalid input: reshow rather than dropping the session.
                $this->client->sendUssd(
                    $sessionId,
                    $source,
                    "Invalid option\n1. Balance\n2. Support\n0. Exit",
                    'mt-cont'
                );
        }
    }

    /* ── 4. Subscriber notification ───────────────────────────────────────── */

    /**
     * The authoritative source of subscription state — including changes you did
     * not initiate (a user texting STOP, an operator removal, a billing
     * failure). Consuming this is what lets you keep a local mirror instead of
     * re-querying getSubscriberChargingInfo, which is capped at ten MSISDNs per
     * call.
     *
     * NOTE: this is the one callback that carries your password. It is stripped
     * before anything else touches the payload.
     *
     * @param array<string, mixed>|null $body
     */
    public function subscriptionNotification(?array $body): array
    {
        if ($body === null) {
            return self::ACK;
        }
        // The platform sends your API key back to you here. Remove it before
        // this payload can reach a log, a trace, or an error reporter.
        unset($body['password']);
        if (!$this->isOurApp($body)) {
            return self::ACK;
        }
        if (empty($body['subscriberId']) || empty($body['status'])) {
            return self::ACK;
        }

        $key = sprintf(
            'sub:%s:%s:%s',
            $body['subscriberId'],
            $body['status'],
            $body['timeStamp'] ?? ''
        );
        if ($this->dedupe->isDuplicate($key)) {
            return self::ACK;
        }

        error_log(sprintf(
            '[applink] subscription-notify subscriber=%s status=%s',
            ApplinkClient::maskAddress((string) $body['subscriberId']),
            (string) $body['status']
        ));

        $this->queue->push('subscription.notification', $body);

        return self::ACK;
    }

    /* ── 5. Charging notification ─────────────────────────────────────────── */

    /**
     * Your reconciliation channel, and the only place a charge is actually
     * settled. Applink charging is two calls plus this callback: neither the
     * P1003 from OTP generation nor the response to OTP verification tells you
     * what was paid.
     *
     * Idempotency is not optional — a duplicate that double-counts revenue is a
     * real bug with real consequences.
     *
     * @param array<string, mixed>|null $body
     */
    public function chargingNotification(?array $body): array
    {
        if ($body === null) {
            return self::ACK;
        }

        $key = $body['externalTrxId'] ?? $body['internalTrxId'] ?? null;
        if ($key === null) {
            return self::ACK;
        }
        if ($this->dedupe->isDuplicate("charge:{$key}:" . ($body['statusCode'] ?? ''))) {
            return self::ACK;
        }

        error_log(sprintf(
            '[applink] charging-notification externalTrxId=%s statusCode=%s paidAmount=%s balanceDue=%s',
            (string) ($body['externalTrxId'] ?? ''),
            (string) ($body['statusCode'] ?? ''),
            (string) ($body['paidAmount'] ?? ''),
            (string) ($body['balanceDue'] ?? '')
        ));

        $this->queue->push('charging.notification', $body);

        return self::ACK;
    }

    /* ── Job dispatch ─────────────────────────────────────────────────────── */

    /** @param array<string, mixed> $payload */
    public function handleJob(string $job, array $payload): void
    {
        try {
            match ($job) {
                'ussd.receive' => $this->handleUssdInput($payload),
                // Honour opt-out keywords, then handle your own commands.
                'sms.mo' => null,
                // Persist the latest status keyed by requestId.
                'sms.dlr' => null,
                // Upsert your local subscription mirror.
                'subscription.notification' => null,
                // Reconcile against your transaction ledger by externalTrxId.
                'charging.notification' => null,
                default => error_log("[applink] unknown job {$job}"),
            };
        } catch (Throwable $error) {
            error_log("[applink] job {$job} failed: " . $error->getMessage());
            // Send to a dead-letter queue here.
        }
    }
}

/**
 * Deduplication. The array implementation below lives only as long as one
 * request, which is useless — wire this to Redis (SETNX + TTL) or a unique
 * database constraint, because duplicates arrive as separate requests.
 */
interface DedupeStore
{
    public function isDuplicate(string $key): bool;
}

/**
 * USSD session store: keyed by sessionId, ~2 minute TTL, shared across
 * processes. PHP has no long-lived process to hold sessions in, so Redis (or a
 * database table with an expiry column) is the only correct implementation here.
 */
interface UssdSessionStore
{
    public function get(string $sessionId): ?string;

    public function set(string $sessionId, string $node, string $sourceAddress): void;

    public function end(string $sessionId): void;
}

/**
 * Work handed off so the HTTP response does not wait for it.
 *
 * PHP-FPM has no background worker of its own: a queue (Laravel queues, a Redis
 * list drained by a worker, a database table with a cron consumer) is required.
 * fastcgi_finish_request() flushes the response early and is an acceptable
 * stopgap for USSD, but it does not survive a crash — never use it for charging
 * reconciliation.
 */
interface JobQueue
{
    /** @param array<string, mixed> $payload */
    public function push(string $job, array $payload): void;
}

/* ── Front controller ──────────────────────────────────────────────────────
 *
 * A plain-PHP entry point, for projects without a framework router:
 *
 *   $body = ApplinkCallbacks::readJson(file_get_contents('php://input') ?: '');
 *   $callbacks = new ApplinkCallbacks($config, $client, $sessions, $dedupe, $queue);
 *
 *   $response = match ($_SERVER['REQUEST_URI'] ?? '') {
 *       '/api/applink/sms/receive'                  => $callbacks->smsReceive($body),
 *       '/api/applink/sms/report'                   => $callbacks->smsReport($body),
 *       '/api/applink/ussd/receive'                 => $callbacks->ussd($body),
 *       '/api/applink/subscription/notify'          => $callbacks->subscriptionNotification($body),
 *       '/api/applink/caas/charging-notification'   => $callbacks->chargingNotification($body),
 *       default                                     => ApplinkCallbacks::ACK,
 *   };
 *
 *   http_response_code(200);                      // ALWAYS 200
 *   header('Content-Type: application/json');
 *   echo json_encode($response);
 *
 * Keep these paths out of any auth middleware and rely on the source-IP
 * allowlist instead — or you have left an open endpoint.
 */
