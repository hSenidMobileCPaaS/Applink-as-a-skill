using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Options;

namespace Applink;

/// <summary>
/// Applink API client — C# port of templates/typescript/applink-client.ts.
///
/// <para>One <c>PostAsync</c> helper injects credentials, applies a timeout, and turns
/// non-S1000 responses into typed errors. Every service is a thin wrapper that resolves its
/// endpoint through <see cref="ApplinkOptions.RequireEndpoint"/> — so calling an API your
/// application was not provisioned for fails locally with a clear message, rather than as
/// E1309 from the platform.</para>
///
/// <para>Register with <c>IHttpClientFactory</c>:
/// <c>builder.Services.AddHttpClient&lt;ApplinkClient&gt;();</c></para>
///
/// <para>SERVER-SIDE ONLY.</para>
/// </summary>
public sealed class ApplinkClient
{
    /// <summary>A single outbound call should never hang. Protocol constant, not config.</summary>
    public static readonly TimeSpan Timeout = TimeSpan.FromSeconds(15);

    /// <summary>Applink's API version. Sent where the contract marks it mandatory.</summary>
    public const string ApiVersion = "1.0";

    /// <summary>The only currency Applink accepts.</summary>
    public const string Currency = "BDT";

    /// <summary>Platform-side. Worth retrying with backoff.</summary>
    public static readonly IReadOnlySet<string> Transient = new HashSet<string>
    {
        "E1318", "E1319", "E1341", "E1601", "E1602", "E1603",
    };

    /// <summary>Provisioning or credentials are wrong. Retrying will never help.</summary>
    public static readonly IReadOnlySet<string> Configuration = new HashSet<string>
    {
        "E1301", "E1303", "E1309", "E1311", "E1313", "E1315", "E1328", "E1331",
    };

    /// <summary>
    /// Accepted, not settled. P1003 from CaaS OTP generation means the OTP is on its way to the
    /// subscriber and NOTHING has been charged. <see cref="StartChargeAsync"/> returns it rather
    /// than throwing; never treat it as a completed charge, and never re-send.
    ///
    /// <para>Applink publishes no benign duplicate-state codes: register and unregister
    /// outcomes come from <c>subscriptionStatus</c> in the response body. See
    /// <see cref="HasSubscriptionStatus"/>.</para>
    /// </summary>
    public const string PendingOtpSent = "P1003";

    public const string BroadcastConfirmation = "I_HAVE_VERIFIED_THIS_GOES_TO_ALL_SUBSCRIBERS";

    private readonly ApplinkOptions _options;
    private readonly HttpClient _http;

    /// <summary>
    /// Applink hosts have served an incomplete certificate chain, which .NET rejects. Do NOT
    /// install a callback that returns true unconditionally — that lets anyone on the path read
    /// the applicationId and password that can charge your subscribers. Supply the intermediate
    /// CA through a SocketsHttpHandler with a custom trust store instead. See
    /// references/09-security-best-practices.md.
    /// </summary>
    public ApplinkClient(HttpClient http, IOptions<ApplinkOptions> options)
    {
        _http = http;
        _http.Timeout = Timeout;
        _options = options.Value;
    }

    /* ── Helpers ──────────────────────────────────────────────────────────── */

    private static readonly Regex Separators = new(@"[\s()\-]", RegexOptions.Compiled);

    /// <summary>
    /// Normalise a subscriber address. The ONLY place <c>tel:</c> is added. Accepts an
    /// already-prefixed address, a masked value, +880…, 00880… or a local 01… number.
    ///
    /// <para>The "+" is stripped: Applink's SMS samples include one and every other API's
    /// samples do not, so one form has to win, and the no-"+" form is what the subscription,
    /// OTP and CaaS endpoints publish.</para>
    /// </summary>
    public static string ToTelAddress(string msisdn)
    {
        var trimmed = (msisdn ?? string.Empty).Trim();
        if (trimmed.Length == 0)
        {
            throw new ArgumentException("[applink] Empty subscriber address", nameof(msisdn));
        }

        if (trimmed.StartsWith("tel:", StringComparison.OrdinalIgnoreCase))
        {
            return "tel:" + Separators.Replace(trimmed[4..], string.Empty).TrimStart('+');
        }

        var digits = Separators.Replace(trimmed, string.Empty).TrimStart('+');
        if (digits.StartsWith("00", StringComparison.Ordinal))
        {
            digits = digits[2..];
        }

        if (digits.StartsWith("0", StringComparison.Ordinal))
        {
            digits = "880" + digits[1..];
        }

        return "tel:" + digits;
    }

    /// <summary>
    /// Applink publishes no benign "already registered" code, so the desired state is read from
    /// <c>subscriptionStatus</c>. The published samples carry a trailing dot ("UNREGISTERED."),
    /// hence the prefix comparison.
    /// </summary>
    public static bool HasSubscriptionStatus(JsonElement response, string expected)
    {
        var actual = response.TryGetProperty("subscriptionStatus", out var value)
            ? (value.GetString() ?? string.Empty).Trim()
            : string.Empty;

        return actual.StartsWith(expected, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>Mask a subscriber address for logging. Never log the raw value.</summary>
    public static string MaskAddress(string address)
    {
        var body = address ?? string.Empty;
        if (body.StartsWith("tel:", StringComparison.OrdinalIgnoreCase))
        {
            body = body[4..];
        }

        return body.Length <= 6
            ? "tel:***"
            : $"tel:{body[..3]}{new string('*', body.Length - 6)}{body[^3..]}";
    }

    /// <summary>A unique, persistable idempotency key for a charge. Max 32 characters.</summary>
    public static string GenerateExternalTrxId() => Guid.NewGuid().ToString("N");

    /* ── Core ─────────────────────────────────────────────────────────────── */

    private async Task<JsonElement> PostAsync(
        string service,
        string url,
        IDictionary<string, object?> body,
        CancellationToken cancellationToken,
        params string[] acceptedCodes)
    {
        var payload = new Dictionary<string, object?>(body)
        {
            ["applicationId"] = _options.ApplicationId,
            ["password"] = _options.Password,
        };

        using var response = await _http
            .PostAsJsonAsync(url, payload, cancellationToken)
            .ConfigureAwait(false);

        // response.EnsureSuccessStatusCode() is deliberately NOT called: Applink returns
        // HTTP 200 for application-level failures, and the real outcome is statusCode.
        var data = await response.Content
            .ReadFromJsonAsync<JsonElement>(cancellationToken: cancellationToken)
            .ConfigureAwait(false);

        var statusCode = data.TryGetProperty("statusCode", out var code)
            ? code.GetString() ?? string.Empty
            : string.Empty;

        if (statusCode == "S1000" || acceptedCodes.Contains(statusCode))
        {
            return data;
        }

        var detail = data.TryGetProperty("statusDetail", out var value)
            ? value.GetString() ?? string.Empty
            : string.Empty;

        throw new ApplinkException(statusCode, detail, service);
    }

    /* ── SMS ──────────────────────────────────────────────────────────────── */

    /// <summary>Send an MT SMS to one or more subscribers.</summary>
    public Task<JsonElement> SendSmsAsync(
        IEnumerable<string> to,
        string message,
        CancellationToken cancellationToken = default)
    {
        var recipients = to.Select(ToTelAddress).ToList();
        if (recipients.Contains("tel:all"))
        {
            throw new ArgumentException(
                "[applink] Use BroadcastSmsAsync for tel:all — broadcasts must be deliberate.",
                nameof(to));
        }

        return PostAsync(
            "sms-send",
            _options.RequireEndpoint("SmsSend"),
            new Dictionary<string, object?>
            {
                ["version"] = ApiVersion,
                ["message"] = message,
                ["destinationAddresses"] = recipients,
            },
            cancellationToken);
    }

    /// <summary>
    /// Send to the ENTIRE subscribed base. Deliberately separate from
    /// <see cref="SendSmsAsync"/> so it can never be reached by accident — check the subscriber
    /// base size first, and put an authorisation check in front of this.
    /// </summary>
    public Task<JsonElement> BroadcastSmsAsync(
        string message,
        string confirmation,
        CancellationToken cancellationToken = default)
    {
        if (confirmation != BroadcastConfirmation)
        {
            throw new ArgumentException(
                "[applink] Broadcast confirmation token missing", nameof(confirmation));
        }

        return PostAsync(
            "sms-send",
            _options.RequireEndpoint("SmsSend"),
            new Dictionary<string, object?>
            {
                ["message"] = message,
                ["destinationAddresses"] = new[] { "tel:all" },
            },
            cancellationToken);
    }

    /* ── USSD ─────────────────────────────────────────────────────────────── */

    /// <summary>
    /// Send a USSD screen. <paramref name="sessionId"/> MUST be the one the platform sent you.
    /// Use "mt-fin" for the final screen — anything else leaves the session hanging until the
    /// network times out.
    /// </summary>
    public Task<JsonElement> SendUssdAsync(
        string sessionId,
        string destinationAddress,
        string message,
        string operation,
        CancellationToken cancellationToken = default)
    {
        if (operation is not ("mt-init" or "mt-cont" or "mt-fin"))
        {
            throw new ArgumentException(
                $"[applink] Invalid ussdOperation '{operation}'", nameof(operation));
        }

        return PostAsync(
            "ussd-send",
            _options.RequireEndpoint("UssdSend"),
            new Dictionary<string, object?>
            {
                ["message"] = message,
                ["sessionId"] = sessionId,
                ["ussdOperation"] = operation,
                ["destinationAddress"] = ToTelAddress(destinationAddress),
                ["encoding"] = "440",
                ["version"] = ApiVersion,
            },
            cancellationToken);
    }

    /* ── Subscription ─────────────────────────────────────────────────────── */

    /// <summary>
    /// Opt a subscriber in. Only call this with recorded, explicit consent.
    ///
    /// <para>Applink publishes no "already registered" code: confirm the outcome with
    /// <see cref="HasSubscriptionStatus"/> rather than treating a repeat call as an
    /// error.</para>
    /// </summary>
    public Task<JsonElement> RegisterAsync(
        string subscriberId, CancellationToken cancellationToken = default) =>
        SubscriptionAsync("subscription-register", subscriberId, "1", cancellationToken);

    /// <summary>
    /// Opt a subscriber out.
    ///
    /// <para>The platform's own sample returns S1000 with statusDetail "not registered" for a
    /// subscriber who was never registered — reaching the desired state is the success
    /// condition. Confirm with <see cref="HasSubscriptionStatus"/>.</para>
    /// </summary>
    public Task<JsonElement> UnregisterAsync(
        string subscriberId, CancellationToken cancellationToken = default) =>
        SubscriptionAsync("subscription-unregister", subscriberId, "0", cancellationToken);

    private Task<JsonElement> SubscriptionAsync(
        string service,
        string subscriberId,
        string action,
        CancellationToken cancellationToken) =>
        PostAsync(
            service,
            _options.RequireEndpoint("SubscriptionSend"),
            new Dictionary<string, object?>
            {
                ["subscriberId"] = ToTelAddress(subscriberId),
                ["action"] = action,
            },
            cancellationToken);

    /// <summary>
    /// Subscription status and last-charge details for up to ten subscribers. This is Applink's
    /// status lookup — there is no getStatus endpoint. Use it for reconciliation, not as a
    /// per-request gate: mirror state from the subscriber notification callback instead.
    /// </summary>
    public Task<JsonElement> GetSubscriberChargingInfoAsync(
        IEnumerable<string> subscriberIds, CancellationToken cancellationToken = default)
    {
        var addresses = subscriberIds.Select(ToTelAddress).ToList();
        if (addresses.Count == 0)
        {
            throw new ArgumentException(
                "[applink] getSubscriberChargingInfo needs at least one subscriber",
                nameof(subscriberIds));
        }

        if (addresses.Count > 10)
        {
            throw new ArgumentException(
                "[applink] getSubscriberChargingInfo accepts a maximum of 10 MSISDNs",
                nameof(subscriberIds));
        }

        return PostAsync(
            "subscription-charging-info",
            _options.RequireEndpoint("SubscriptionChargingInfo"),
            new Dictionary<string, object?> { ["subscriberIds"] = addresses },
            cancellationToken);
    }

    /// <summary>
    /// Subscriber base size. Needs no subscriber and charges nothing, which also makes it the
    /// best connectivity and credential smoke test. <c>baseSize</c> comes back as a string.
    /// </summary>
    public async Task<long> QueryBaseAsync(CancellationToken cancellationToken = default)
    {
        var data = await PostAsync(
            "subscription-query-base",
            _options.RequireEndpoint("SubscriptionQueryBase"),
            new Dictionary<string, object?>(),
            cancellationToken).ConfigureAwait(false);

        var raw = data.TryGetProperty("baseSize", out var value) ? value.GetString() : "0";
        return long.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var size)
            ? size
            : 0;
    }

    /* ── OTP ──────────────────────────────────────────────────────────────── */

    /// <summary>
    /// Send an OTP to a plain mobile number. Rate-limit per number AND per IP before calling,
    /// or the app becomes an SMS-bombing tool. Keep the returned referenceNo server-side.
    /// </summary>
    public Task<JsonElement> RequestOtpAsync(
        string subscriberId,
        IDictionary<string, object?> applicationMetaData,
        CancellationToken cancellationToken = default) =>
        PostAsync(
            "otp-request",
            _options.RequireEndpoint("OtpRequest"),
            new Dictionary<string, object?>
            {
                ["subscriberId"] = ToTelAddress(subscriberId),
                ["applicationMetaData"] = applicationMetaData,
            },
            cancellationToken);

    /// <summary>
    /// Verify an OTP. Valid five minutes — enforce that on your side too, and cap attempts
    /// yourself; the platform documents no attempt limit. The returned subscriberId is the
    /// identifier to use for every subsequent call.
    /// </summary>
    public Task<JsonElement> VerifyOtpAsync(
        string referenceNo, string otp, CancellationToken cancellationToken = default) =>
        PostAsync(
            "otp-verify",
            _options.RequireEndpoint("OtpVerify"),
            new Dictionary<string, object?> { ["referenceNo"] = referenceNo, ["otp"] = otp },
            cancellationToken);

    /* ── CaaS — charging is TWO calls ──────────────────────────────── */

    /// <summary>
    /// Step 1 of charging: reserve the charge and send the subscriber an OTP.
    ///
    /// <para>THIS DOES NOT CHARGE ANYONE. It returns P1003 and a <c>requestCorrelator</c>.</para>
    ///
    /// <para><paramref name="externalTrxId"/> is your idempotency key: generate it with
    /// <see cref="GenerateExternalTrxId"/>, PERSIST IT with a PENDING ledger row, then call
    /// this. Persist <c>requestCorrelator</c> from the response — without it the charge can
    /// never be completed, and there is no way to recover it.</para>
    ///
    /// <para>There are deliberately no retries: a timeout does NOT mean the charge did not
    /// start. Reconcile against the charging notification instead.</para>
    ///
    /// <para><paramref name="amount"/> is <c>decimal</c>, never <c>double</c>.</para>
    /// </summary>
    public Task<JsonElement> StartChargeAsync(
        string subscriberId,
        decimal amount,
        string externalTrxId,
        string paymentInstrumentName = "Mobile Account",
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(externalTrxId))
        {
            throw new ArgumentException(
                "[applink] externalTrxId is required and must be persisted first",
                nameof(externalTrxId));
        }

        return PostAsync(
            "caas-otp-generation",
            _options.RequireEndpoint("CaasOtpGeneration"),
            new Dictionary<string, object?>
            {
                ["externalTrxId"] = externalTrxId,
                ["amount"] = amount.ToString(CultureInfo.InvariantCulture),
                ["paymentInstrumentName"] = paymentInstrumentName,
                ["subscriberId"] = ToTelAddress(subscriberId),
                // Capital C, as published. The balance endpoint uses lower case.
                ["Currency"] = Currency,
            },
            cancellationToken,
            PendingOtpSent);
    }

    /// <summary>
    /// Step 2 of charging: verify the subscriber's OTP and complete the charge.
    /// THIS MOVES REAL MONEY.
    ///
    /// <para><paramref name="requestCorrelator"/> comes from the
    /// <see cref="StartChargeAsync"/> response. It is NOT the externalTrxId you generated and
    /// NOT the referenceNo from <c>RequestOtpAsync</c>. Getting that wrong is E1855.</para>
    ///
    /// <para>On E1850 (wrong OTP), re-prompt against the SAME correlator. On E1851 (expired),
    /// abandon the transaction. NEVER call <see cref="StartChargeAsync"/> again to retry this —
    /// that begins a second charge.</para>
    ///
    /// <para>The authoritative outcome is the charging notification callback, which carries
    /// paidAmount and balanceDue. Settle the ledger there.</para>
    /// </summary>
    public Task<JsonElement> ConfirmChargeAsync(
        string requestCorrelator,
        string otp,
        string subscriberId,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(requestCorrelator))
        {
            throw new ArgumentException(
                "[applink] requestCorrelator is required — it comes from StartChargeAsync",
                nameof(requestCorrelator));
        }

        return PostAsync(
            "caas-otp-verify",
            _options.RequireEndpoint("CaasOtpVerify"),
            new Dictionary<string, object?>
            {
                ["referenceNo"] = requestCorrelator,
                ["otp"] = otp,
                ["sourceAddress"] = ToTelAddress(subscriberId),
            },
            cancellationToken);
    }

    /// <summary>
    /// Query chargeable balance. Advisory only: the balance can change between this and the
    /// charge. Always handle E1326 on the charging path regardless of what this returned.
    ///
    /// <para>This endpoint is in the published specification but not in the rendered
    /// documentation's navigation. Leaving APPLINK_CAAS_BALANCE_URL unset is how you disable it
    /// until support confirms it is enabled on your application.</para>
    /// </summary>
    public Task<JsonElement> QueryBalanceAsync(
        string subscriberId,
        CancellationToken cancellationToken = default) =>
        PostAsync(
            "caas-query-balance",
            _options.RequireEndpoint("CaasBalance"),
            new Dictionary<string, object?>
            {
                ["subscriberId"] = ToTelAddress(subscriberId),
                ["paymentInstrumentName"] = "MobileAccount",
                // Lower-case c on this endpoint, capital C on the charging request.
                ["currency"] = Currency,
            },
            cancellationToken);

    /* ── Extension point ───────────────────────────────────────────────────
     *
     * Adding a service Applink publishes later:
     *
     *   1. Add its URL variable to .env.example and to EndpointVariables in ApplinkOptions
     *   2. Add one wrapper here that calls PostAsync with the new key.
     *
     * It inherits credential injection, the timeout, error mapping and the not-provisioned
     * guard for free. Do not build a parallel client.
     */
}

/// <summary>A non-S1000 application-level response.</summary>
public sealed class ApplinkException : Exception
{
    public ApplinkException(string statusCode, string statusDetail, string service)
        : base($"[{statusCode}] {statusDetail} ({service})")
    {
        StatusCode = statusCode;
        StatusDetail = statusDetail;
        Service = service;
    }

    public string StatusCode { get; }

    public string StatusDetail { get; }

    public string Service { get; }

    public bool IsRetryable => ApplinkClient.Transient.Contains(StatusCode);

    public bool IsConfiguration => ApplinkClient.Configuration.Contains(StatusCode);
}
