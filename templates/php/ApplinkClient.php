<?php

declare(strict_types=1);

namespace App\Applink;

use InvalidArgumentException;
use RuntimeException;

/**
 * Applink API client — PHP port of templates/typescript/applink-client.ts.
 *
 * One post() helper injects credentials, applies a timeout, and turns non-S1000
 * responses into typed errors. Every service is a thin wrapper that resolves its
 * endpoint through ApplinkConfig::requireEndpoint() — so calling an API your
 * application was not provisioned for fails locally with a clear message, rather
 * than as E1309 from the platform.
 *
 * Uses the cURL extension so it drops into any project without Composer
 * dependencies. Guzzle is a fine substitute — replace request() and keep
 * everything else, but do NOT enable http_errors as a success check: Applink
 * returns HTTP 200 for its own failures.
 *
 * Requires PHP 8.1+ (readonly properties, enums-free but typed constants). ApplinkException
 * shares this file for readability — split it into its own file if you autoload with PSR-4.
 *
 * SERVER-SIDE ONLY.
 */
final class ApplinkClient
{
    /** A single outbound call should never hang. Protocol constant, not config. */
    private const TIMEOUT_SECONDS = 15;

    /** Applink's API version. Sent where the contract marks it mandatory. */
    private const API_VERSION = '1.0';

    /** The only currency Applink accepts. */
    private const CURRENCY = 'BDT';

    /** Platform-side. Worth retrying with backoff. */
    public const TRANSIENT = ['E1318', 'E1319', 'E1341', 'E1601', 'E1602', 'E1603'];

    /** Provisioning or credentials are wrong. Retrying will never help. */
    public const CONFIGURATION = [
        'E1301', 'E1303', 'E1309', 'E1311', 'E1313', 'E1315', 'E1328', 'E1331',
    ];

    /**
     * Accepted, not settled. P1003 from CaaS OTP generation means the OTP is on
     * its way to the subscriber and NOTHING has been charged. startCharge()
     * returns it rather than throwing; never treat it as a completed charge,
     * and never re-send.
     *
     * Applink publishes no benign duplicate-state codes: register and
     * unregister outcomes come from subscriptionStatus in the response body.
     * See hasSubscriptionStatus().
     */
    public const PENDING_OTP_SENT = 'P1003';

    public const BROADCAST_CONFIRMATION = 'I_HAVE_VERIFIED_THIS_GOES_TO_ALL_SUBSCRIBERS';

    public function __construct(private readonly ApplinkConfig $config)
    {
    }

    /* ── Helpers ──────────────────────────────────────────────────────────── */

    /**
     * Normalise a subscriber address. The ONLY place `tel:` is added.
     *
     * Accepts an already-prefixed address, a masked value, +880…, 00880… or a
     * local 01… number. The '+' is stripped: Applink's SMS samples include one
     * and every other API's samples do not, so one form has to win, and the
     * no-'+' form is what the subscription, OTP and CaaS endpoints publish.
     */
    public static function toTelAddress(string $msisdn): string
    {
        $trimmed = trim($msisdn);
        if ($trimmed === '') {
            throw new InvalidArgumentException('[applink] Empty subscriber address');
        }
        if (stripos($trimmed, 'tel:') === 0) {
            return 'tel:' . (string) preg_replace('/[\s+]/', '', substr($trimmed, 4));
        }

        $digits = ltrim((string) preg_replace('/[\s()\-]/', '', $trimmed), '+');
        if (str_starts_with($digits, '00')) {
            $digits = substr($digits, 2);
        }
        if (str_starts_with($digits, '0')) {
            $digits = '880' . substr($digits, 1);
        }

        return 'tel:' . $digits;
    }

    /**
     * Applink publishes no benign 'already registered' code, so the desired
     * state is read from subscriptionStatus. The published samples carry a
     * trailing dot ('UNREGISTERED.'), hence the prefix comparison.
     *
     * @param array<string, mixed> $response
     */
    public static function hasSubscriptionStatus(array $response, string $expected): bool
    {
        $actual = strtoupper(trim((string) ($response['subscriptionStatus'] ?? '')));

        return str_starts_with($actual, strtoupper($expected));
    }

    /** Mask a subscriber address for logging. Never log the raw value. */
    public static function maskAddress(string $address): string
    {
        $body = (string) preg_replace('/^tel:/i', '', $address);
        if (strlen($body) <= 6) {
            return 'tel:***';
        }

        return 'tel:' . substr($body, 0, 3)
            . str_repeat('*', strlen($body) - 6)
            . substr($body, -3);
    }

    /** A unique, persistable idempotency key for a charge. */
    public static function generateExternalTrxId(): string
    {
        return bin2hex(random_bytes(16));
    }

    /* ── Core ─────────────────────────────────────────────────────────────── */

    /**
     * @param array<string, mixed> $body
     * @param list<string>         $acceptedCodes
     *
     * @return array<string, mixed>
     */
    private function post(string $service, string $url, array $body, array $acceptedCodes = []): array
    {
        $payload = json_encode(
            array_merge(
                [
                    'applicationId' => $this->config->applicationId,
                    'password'      => $this->config->password,
                ],
                $body
            ),
            JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES
        );

        $data = $this->request($service, $url, $payload);

        $statusCode = (string) ($data['statusCode'] ?? '');
        if ($statusCode === 'S1000' || in_array($statusCode, $acceptedCodes, true)) {
            return $data;
        }

        throw new ApplinkException(
            $statusCode,
            (string) ($data['statusDetail'] ?? ''),
            $service,
            $data
        );
    }

    /** @return array<string, mixed> */
    private function request(string $service, string $url, string $payload): array
    {
        $handle = curl_init($url);
        if ($handle === false) {
            throw new RuntimeException("[applink] {$service}: could not initialise cURL");
        }

        curl_setopt_array($handle, [
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => $payload,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => self::TIMEOUT_SECONDS,
            CURLOPT_HTTPHEADER     => ['Content-Type: application/json;charset=utf-8'],
            // Applink hosts have served an incomplete certificate chain. Do NOT
            // "fix" that with CURLOPT_SSL_VERIFYPEER => false — that lets anyone
            // on the path read the applicationId and password that can charge
            // your subscribers. Supply the intermediate CA instead:
            //   CURLOPT_CAINFO => __DIR__ . '/certs/applink-chain.pem',
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
        ]);

        $raw = curl_exec($handle);
        $error = curl_error($handle);
        curl_close($handle);

        if ($raw === false) {
            throw new RuntimeException("[applink] {$service}: transport failure: {$error}");
        }

        // The HTTP status is deliberately not consulted: Applink returns 200 for
        // application-level failures, and the real outcome is statusCode.
        $decoded = json_decode((string) $raw, true);
        if (!is_array($decoded)) {
            throw new RuntimeException(
                "[applink] {$service}: non-JSON response: " . substr((string) $raw, 0, 200)
            );
        }

        return $decoded;
    }

    /* ── SMS ──────────────────────────────────────────────────────────────── */

    /**
     * Send an MT SMS to one or more subscribers.
     *
     * @param string|list<string>  $to
     * @param array<string, mixed> $options sourceAddress, deliveryStatusRequest,
     *                                      encoding, binaryHeader
     *
     * @return array<string, mixed>
     */
    public function sendSms(string|array $to, string $message, array $options = []): array
    {
        $recipients = array_map(
            [self::class, 'toTelAddress'],
            is_array($to) ? $to : [$to]
        );
        if (in_array('tel:all', $recipients, true)) {
            throw new InvalidArgumentException(
                '[applink] Use broadcastSms() for tel:all — broadcasts must be deliberate.'
            );
        }

        return $this->post('sms-send', $this->config->requireEndpoint('smsSend'), array_merge(
            [
                'version'              => self::API_VERSION,
                'message'              => $message,
                'destinationAddresses' => array_values($recipients),
            ],
            self::smsOptions($options)
        ));
    }

    /**
     * The optional SMS fields, as the strings the platform expects. PHP happily
     * passes deliveryStatusRequest => 1 through json_encode as a number.
     *
     * @param array<string, mixed> $options
     *
     * @return array<string, string>
     */
    private static function smsOptions(array $options): array
    {
        $allowed = ['sourceAddress', 'deliveryStatusRequest', 'encoding', 'binaryHeader'];
        $unknown = array_diff(array_keys($options), $allowed);
        if ($unknown !== []) {
            throw new InvalidArgumentException(
                '[applink] Unknown SMS option(s): ' . implode(', ', $unknown)
            );
        }

        return array_map(static fn ($value): string => (string) $value, array_filter(
            $options,
            static fn ($value): bool => $value !== null && $value !== ''
        ));
    }

    /**
     * Money crosses the wire as a string with two decimal places, as the
     * published sample does ('5.00'). Rejects anything that is not a positive
     * amount in whole poisha.
     */
    public static function formatAmount(string $amount): string
    {
        $trimmed = trim($amount);
        if (!preg_match('/^(\d+)(?:\.(\d{1,2}))?$/', $trimmed, $match)
            || preg_match('/^0+(\.0+)?$/', $trimmed)) {
            throw new InvalidArgumentException(
                "[applink] amount must be a positive decimal string such as \"5.00\", got \"{$amount}\""
            );
        }

        return $match[1] . '.' . str_pad($match[2] ?? '', 2, '0');
    }

    /**
     * Send to the ENTIRE subscribed base.
     *
     * Deliberately separate from sendSms() so it can never be reached by
     * accident — check the subscriber base size first, and put an authorisation
     * check in front of this.
     *
     * @param array<string, mixed> $options
     *
     * @return array<string, mixed>
     */
    public function broadcastSms(string $message, string $confirmation, array $options = []): array
    {
        if ($confirmation !== self::BROADCAST_CONFIRMATION) {
            throw new InvalidArgumentException('[applink] Broadcast confirmation token missing');
        }

        return $this->post('sms-send', $this->config->requireEndpoint('smsSend'), array_merge(
            [
                'version'              => self::API_VERSION,
                'message'              => $message,
                'destinationAddresses' => ['tel:all'],
            ],
            self::smsOptions($options)
        ));
    }

    /* ── USSD ─────────────────────────────────────────────────────────────── */

    /**
     * Send a USSD screen.
     *
     * $sessionId MUST be the one the platform sent you. Use 'mt-fin' for the
     * final screen — anything else leaves the session hanging until the network
     * times out.
     *
     * @return array<string, mixed>
     */
    public function sendUssd(
        string $sessionId,
        string $destinationAddress,
        string $message,
        string $operation
    ): array {
        if (!in_array($operation, ['mt-init', 'mt-cont', 'mt-fin'], true)) {
            throw new InvalidArgumentException("[applink] Invalid ussdOperation '{$operation}'");
        }

        return $this->post('ussd-send', $this->config->requireEndpoint('ussdSend'), [
            'message'            => $message,
            'sessionId'          => $sessionId,
            'ussdOperation'      => $operation,
            'destinationAddress' => self::toTelAddress($destinationAddress),
            'encoding'           => '440',
            'version'            => self::API_VERSION,
        ]);
    }

    /* ── Subscription ─────────────────────────────────────────────────────── */

    /**
     * Opt a subscriber in. Only call this with recorded, explicit consent.
     *
     * Applink publishes no 'already registered' code: confirm the outcome with
     * hasSubscriptionStatus($response, 'REGISTERED') rather than treating a
     * repeat call as an error.
     *
     * @return array<string, mixed>
     */
    public function register(string $subscriberId): array
    {
        return $this->post(
            'subscription-register',
            $this->config->requireEndpoint('subscriptionSend'),
            [
                'subscriberId' => self::toTelAddress($subscriberId),
                'action'       => '1',
            ]
        );
    }

    /**
     * Opt a subscriber out.
     *
     * The platform's own sample returns S1000 with statusDetail 'not registered'
     * for a subscriber who was never registered — reaching the desired state is
     * the success condition. Confirm with
     * hasSubscriptionStatus($response, 'UNREGISTERED').
     *
     * @return array<string, mixed>
     */
    public function unregister(string $subscriberId): array
    {
        return $this->post(
            'subscription-unregister',
            $this->config->requireEndpoint('subscriptionSend'),
            [
                'subscriberId' => self::toTelAddress($subscriberId),
                'action'       => '0',
            ]
        );
    }

    /**
     * Subscription status and last-charge details for up to ten subscribers.
     *
     * This is Applink's status lookup — there is no getStatus endpoint. Use it
     * for reconciliation, not as a per-request gate: mirror state from the
     * subscriber notification callback instead.
     *
     * @param list<string> $subscriberIds
     *
     * @return array<string, mixed>
     */
    public function getSubscriberChargingInfo(array $subscriberIds): array
    {
        if ($subscriberIds === []) {
            throw new InvalidArgumentException(
                '[applink] getSubscriberChargingInfo needs at least one subscriber'
            );
        }
        if (count($subscriberIds) > 10) {
            throw new InvalidArgumentException(
                '[applink] getSubscriberChargingInfo accepts a maximum of 10 MSISDNs'
            );
        }

        return $this->post(
            'subscription-charging-info',
            $this->config->requireEndpoint('subscriptionChargingInfo'),
            [
                'subscriberIds' => array_values(
                    array_map([self::class, 'toTelAddress'], $subscriberIds)
                ),
            ]
        );
    }

    /**
     * Subscriber base size. Needs no subscriber and charges nothing, which also
     * makes it the best connectivity and credential smoke test.
     */
    public function queryBase(): int
    {
        $data = $this->post(
            'subscription-query-base',
            $this->config->requireEndpoint('subscriptionQueryBase'),
            []
        );

        return (int) ($data['baseSize'] ?? 0); // documented as a string
    }

    /* ── OTP ──────────────────────────────────────────────────────────────── */

    /**
     * Send an OTP to a plain mobile number.
     *
     * Rate-limit per number AND per IP before calling, or the app becomes an
     * SMS-bombing tool. Keep the returned referenceNo server-side; never log it.
     *
     * Both extras are optional and omitted when empty: json_encode turns an
     * empty PHP array into [] — a JSON array where the platform expects an
     * object.
     *
     * @param array<string, string> $applicationMetaData client, device, os, appCode
     *
     * @return array<string, mixed>
     */
    public function requestOtp(
        string $subscriberId,
        array $applicationMetaData = [],
        ?string $applicationHash = null
    ): array {
        $body = ['subscriberId' => self::toTelAddress($subscriberId)];
        if ($applicationHash !== null && $applicationHash !== '') {
            $body['applicationHash'] = $applicationHash;
        }
        if ($applicationMetaData !== []) {
            $body['applicationMetaData'] = array_map(
                static fn ($value): string => (string) $value,
                $applicationMetaData
            );
        }

        return $this->post('otp-request', $this->config->requireEndpoint('otpRequest'), $body);
    }

    /**
     * Verify an OTP. Valid five minutes — enforce that on your side too, and cap
     * attempts yourself; the platform documents no attempt limit. The returned
     * subscriberId is the identifier to use for every subsequent call.
     *
     * @return array<string, mixed>
     */
    public function verifyOtp(string $referenceNo, string $otp): array
    {
        return $this->post('otp-verify', $this->config->requireEndpoint('otpVerify'), [
            'referenceNo' => $referenceNo,
            'otp'         => $otp,
        ]);
    }

    /* ── CaaS — charging is TWO calls ─────────────────────────────── */

    /**
     * Step 1 of charging: reserve the charge and send the subscriber an OTP.
     *
     * THIS DOES NOT CHARGE ANYONE. It returns P1003 and a requestCorrelator.
     *
     * - $externalTrxId is your idempotency key. Generate it with
     *   generateExternalTrxId(), PERSIST IT with a PENDING ledger row, then
     *   call this.
     * - Persist requestCorrelator from the response. Without it the charge can
     *   never be completed, and there is no way to recover it.
     * - There are deliberately no retries here. A timeout does NOT mean the
     *   charge did not start; reconcile against the charging notification.
     * - P1003 is returned, not thrown — it is the expected outcome.
     * - $amount is a string: keep money in bcmath or integer minor units. A
     *   float will eventually charge someone 99.99999 taka.
     *
     * @return array<string, mixed>
     */
    public function startCharge(
        string $subscriberId,
        string $amount,
        string $externalTrxId,
        string $paymentInstrumentName = 'Mobile Account'
    ): array {
        if ($externalTrxId === '') {
            throw new InvalidArgumentException(
                '[applink] externalTrxId is required and must be persisted first'
            );
        }

        return $this->post(
            'caas-otp-generation',
            $this->config->requireEndpoint('caasOtpGeneration'),
            [
                'externalTrxId'         => $externalTrxId,
                'amount'                => self::formatAmount($amount),
                'paymentInstrumentName' => $paymentInstrumentName,
                'subscriberId'          => self::toTelAddress($subscriberId),
                // Capital C, as published. The balance endpoint uses lower case.
                'Currency'              => self::CURRENCY,
            ],
            [self::PENDING_OTP_SENT]
        );
    }

    /**
     * Step 2 of charging: verify the subscriber's OTP and complete the charge.
     *
     * THIS MOVES REAL MONEY.
     *
     * - $requestCorrelator comes from the startCharge() response. It is NOT the
     *   externalTrxId you generated and NOT the referenceNo from requestOtp().
     *   Getting that wrong is E1855.
     * - On E1850 (wrong OTP), re-prompt against the SAME correlator. On E1851
     *   (expired), abandon the transaction.
     * - NEVER call startCharge() again to retry this — that begins a second
     *   charge.
     * - The authoritative outcome is the charging notification callback, which
     *   carries paidAmount and balanceDue. Settle the ledger there.
     *
     * @return array<string, mixed>
     */
    public function confirmCharge(
        string $requestCorrelator,
        string $otp,
        string $subscriberId
    ): array {
        if ($requestCorrelator === '') {
            throw new InvalidArgumentException(
                '[applink] requestCorrelator is required — it comes from startCharge()'
            );
        }

        return $this->post(
            'caas-otp-verify',
            $this->config->requireEndpoint('caasOtpVerify'),
            [
                'referenceNo'   => $requestCorrelator,
                'otp'           => $otp,
                'sourceAddress' => self::toTelAddress($subscriberId),
            ]
        );
    }

    /**
     * Query chargeable balance.
     *
     * Advisory only: the balance can change between this and the charge. Always
     * handle E1326 on the charging path regardless of what this returned.
     *
     * This endpoint is in the published specification but not in the rendered
     * documentation's navigation. Leaving APPLINK_CAAS_BALANCE_URL unset is how
     * you disable it until support confirms it is enabled on your application.
     *
     * @return array<string, mixed>
     */
    public function queryBalance(string $subscriberId): array
    {
        return $this->post('caas-query-balance', $this->config->requireEndpoint('caasBalance'), [
            'subscriberId'          => self::toTelAddress($subscriberId),
            'paymentInstrumentName' => 'MobileAccount',
            // Lower-case c on this endpoint, capital C on the charging request.
            'currency'              => self::CURRENCY,
        ]);
    }

    /* ── Extension point ───────────────────────────────────────────────────
     *
     * Adding a service Applink publishes later:
     *
     *   1. Add its URL variable to .env.example and to ENDPOINT_VARS in
     *      ApplinkConfig
     *   2. Add one wrapper here that calls $this->post() with the new key.
     *
     * It inherits credential injection, the timeout, error mapping and the
     * not-provisioned guard for free. Do not build a parallel client.
     */
}

/** A non-S1000 application-level response. */
final class ApplinkException extends RuntimeException
{
    /** @param array<string, mixed> $raw */
    public function __construct(
        public readonly string $statusCode,
        public readonly string $statusDetail,
        public readonly string $service,
        public readonly array $raw = [],
    ) {
        parent::__construct("[{$statusCode}] {$statusDetail} ({$service})");
    }

    public function isRetryable(): bool
    {
        return in_array($this->statusCode, ApplinkClient::TRANSIENT, true);
    }

    public function isConfiguration(): bool
    {
        return in_array($this->statusCode, ApplinkClient::CONFIGURATION, true);
    }
}
