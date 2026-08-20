using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Applink;

/// <summary>
/// Applink callback (inbound webhook) endpoints — ASP.NET Core minimal APIs.
///
/// <para>Routes to register in the Applink portal:</para>
/// <code>
///   SMS receive (MO)          POST /api/applink/sms/receive
///   Delivery status report    POST /api/applink/sms/report
///   USSD receive              POST /api/applink/ussd/receive
///   Subscriber notification   POST /api/applink/subscription/notify
///   Charging notification     POST /api/applink/caas/charging-notification
/// </code>
///
/// <para>The contract, for all five: respond <c>{"statusCode":"S1000","statusDetail":"Success"}</c>
/// with HTTP 200 — always, even for payloads you reject — respond FIRST and work afterwards, be
/// idempotent, and never trust the body. The subscriber notification additionally carries your
/// <c>password</c>: never log its raw payload.</para>
///
/// <para>Exclude these routes from authentication and antiforgery
/// (<c>.AllowAnonymous().DisableAntiforgery()</c>) and rely on the source-IP allowlist instead,
/// or you have left an open endpoint.</para>
///
/// <para>Full rules: references/07-callbacks.md.</para>
/// </summary>
public static class ApplinkCallbacks
{
    /// <summary>The only response Applink expects.</summary>
    private static readonly Dictionary<string, string> Ack = new()
    {
        ["statusCode"] = "S1000",
        ["statusDetail"] = "Success",
    };

    /// <summary>
    /// Restrict to Applink's egress IPs. Applink signs nothing, so there is no signature to
    /// verify — source IP is the strongest control available. Ask support for the current list.
    /// Prefer enforcing it at the firewall or load balancer; this is the fallback.
    /// </summary>
    public static readonly HashSet<string> SourceIps = new();

    public static IEndpointRouteBuilder MapApplinkCallbacks(this IEndpointRouteBuilder routes)
    {
        var group = routes.MapGroup("/api/applink");

        group.MapPost("/sms/receive", SmsReceive);
        group.MapPost("/sms/report", SmsReport);
        group.MapPost("/ussd/receive", Ussd);
        group.MapPost("/subscription/notify", SubscriptionNotification);
        group.MapPost("/caas/charging-notification", ChargingNotification);

        return routes;
    }

    /* ── Shared guards ────────────────────────────────────────────────────── */

    private static IResult AckResult() => Results.Json(Ack);

    private static bool AllowedSource(HttpContext context)
    {
        if (SourceIps.Count == 0)
        {
            return true; // not configured yet
        }

        var ip = context.Connection.RemoteIpAddress?.ToString();
        return ip is not null && SourceIps.Contains(ip);
    }

    /// <summary>Read the body without failing the response on malformed input.</summary>
    private static async Task<JsonElement?> ReadJsonAsync(HttpRequest request)
    {
        try
        {
            return await request.ReadFromJsonAsync<JsonElement>().ConfigureAwait(false);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static string Field(JsonElement body, string name) =>
        body.ValueKind == JsonValueKind.Object && body.TryGetProperty(name, out var value)
            ? value.ToString()
            : string.Empty;

    /* ── 1. SMS receive (MO) ──────────────────────────────────────────────── */

    private static async Task<IResult> SmsReceive(
        HttpContext context,
        IOptions<ApplinkOptions> options,
        ApplinkWorkQueue queue,
        ILogger<ApplinkWorkQueue> logger,
        ApplinkDedupe dedupe)
    {
        if (!AllowedSource(context))
        {
            return AckResult();
        }

        var body = await ReadJsonAsync(context.Request).ConfigureAwait(false);
        if (body is null || Field(body.Value, "applicationId") != options.Value.ApplicationId)
        {
            return AckResult();
        }

        var requestId = Field(body.Value, "requestId");
        if (requestId.Length == 0 || dedupe.IsDuplicate($"mo:{requestId}"))
        {
            return AckResult();
        }

        // Message content deliberately not logged — it is user communication.
        logger.LogInformation(
            "sms-receive requestId={RequestId} from={From}",
            requestId,
            ApplinkClient.MaskAddress(Field(body.Value, "sourceAddress")));

        await queue.EnqueueAsync(new ApplinkJob("sms.mo", body.Value.Clone()))
            .ConfigureAwait(false);
        return AckResult();
    }

    /* ── 2. SMS delivery report ───────────────────────────────────────────── */

    /// <summary>Applink and the SMPP gateway use different spellings. Normalise both.</summary>
    private static readonly Dictionary<string, string> DeliveryStatuses = new()
    {
        ["DELIVRD"] = "DELIVERED",
        ["UNDELIV"] = "UNDELIVERABLE",
        ["ACCEPTD"] = "ACCEPTED",
        ["REJECTD"] = "REJECTED",
    };

    private static async Task<IResult> SmsReport(
        HttpContext context,
        ApplinkWorkQueue queue,
        ILogger<ApplinkWorkQueue> logger,
        ApplinkDedupe dedupe)
    {
        if (!AllowedSource(context))
        {
            return AckResult();
        }

        var body = await ReadJsonAsync(context.Request).ConfigureAwait(false);
        if (body is null)
        {
            return AckResult();
        }

        var requestId = Field(body.Value, "requestId");
        var raw = Field(body.Value, "deliveryStatus");
        if (requestId.Length == 0 || raw.Length == 0)
        {
            return AckResult();
        }

        var status = DeliveryStatuses.TryGetValue(raw, out var normalised) ? normalised : raw;
        if (dedupe.IsDuplicate($"dlr:{requestId}:{status}"))
        {
            return AckResult();
        }

        logger.LogInformation(
            "delivery-report requestId={RequestId} status={Status}", requestId, status);

        await queue.EnqueueAsync(new ApplinkJob("sms.dlr", body.Value.Clone()))
            .ConfigureAwait(false);
        return AckResult();
    }

    /* ── 3. USSD receive ──────────────────────────────────────────────────── */

    /// <summary>
    /// The response body here is ONLY an acknowledgement. The screen the user sees comes from a
    /// separate POST /ussd/send — which is why the reply is queued rather than returned. USSD
    /// sessions time out in seconds, so nothing slow may happen before the acknowledgement.
    /// </summary>
    private static async Task<IResult> Ussd(
        HttpContext context,
        IOptions<ApplinkOptions> options,
        ApplinkWorkQueue queue,
        ILogger<ApplinkWorkQueue> logger,
        ApplinkDedupe dedupe)
    {
        if (!AllowedSource(context))
        {
            return AckResult();
        }

        var body = await ReadJsonAsync(context.Request).ConfigureAwait(false);
        if (body is null || Field(body.Value, "applicationId") != options.Value.ApplicationId)
        {
            return AckResult();
        }

        var sessionId = Field(body.Value, "sessionId");
        var source = Field(body.Value, "sourceAddress");
        if (sessionId.Length == 0 || source.Length == 0)
        {
            return AckResult();
        }

        if (dedupe.IsDuplicate($"ussd:{Field(body.Value, "requestId")}"))
        {
            return AckResult();
        }

        logger.LogInformation(
            "ussd sessionId={SessionId} operation={Operation} from={From}",
            sessionId,
            Field(body.Value, "ussdOperation"),
            ApplinkClient.MaskAddress(source));

        await queue.EnqueueAsync(new ApplinkJob("ussd.receive", body.Value.Clone()))
            .ConfigureAwait(false);
        return AckResult();
    }

    /* ── 4. Subscriber notification ───────────────────────────────────────── */

    /// <summary>
    /// The authoritative source of subscription state — including changes you did not initiate
    /// (a user texting STOP, an operator removal, a billing failure). Consuming it is what lets
    /// you keep a local mirror instead of re-querying getSubscriberChargingInfo, which is capped
    /// at ten MSISDNs per call.
    ///
    /// <para>NOTE: this is the one callback that carries your <c>password</c>. Never log the raw
    /// payload, and strip the field before the body reaches a queue or an error reporter.</para>
    /// </summary>
    private static async Task<IResult> SubscriptionNotification(
        HttpContext context,
        IOptions<ApplinkOptions> options,
        ApplinkWorkQueue queue,
        ILogger<ApplinkWorkQueue> logger,
        ApplinkDedupe dedupe)
    {
        if (!AllowedSource(context))
        {
            return AckResult();
        }

        var body = await ReadJsonAsync(context.Request).ConfigureAwait(false);
        if (body is null || Field(body.Value, "applicationId") != options.Value.ApplicationId)
        {
            return AckResult();
        }

        var subscriberId = Field(body.Value, "subscriberId");
        var status = Field(body.Value, "status");
        if (subscriberId.Length == 0 || status.Length == 0)
        {
            return AckResult();
        }

        if (dedupe.IsDuplicate($"sub:{subscriberId}:{status}:{Field(body.Value, "timeStamp")}"))
        {
            return AckResult();
        }

        logger.LogInformation(
            "subscription-notify subscriber={Subscriber} status={Status}",
            ApplinkClient.MaskAddress(subscriberId),
            status);

        await queue.EnqueueAsync(new ApplinkJob("subscription.notification", body.Value.Clone()))
            .ConfigureAwait(false);
        return AckResult();
    }

    /* ── 5. Charging notification ─────────────────────────────────────────── */

    /// <summary>
    /// Your reconciliation channel, and the only place a charge is actually settled. Applink
    /// charging is two calls plus this callback: neither the P1003 from OTP generation nor the
    /// response to OTP verification tells you what was paid.
    ///
    /// <para>Idempotency is not optional — a duplicate that double-counts revenue is a real bug
    /// with real consequences.</para>
    /// </summary>
    private static async Task<IResult> ChargingNotification(
        HttpContext context,
        ApplinkWorkQueue queue,
        ILogger<ApplinkWorkQueue> logger,
        ApplinkDedupe dedupe)
    {
        if (!AllowedSource(context))
        {
            return AckResult();
        }

        var body = await ReadJsonAsync(context.Request).ConfigureAwait(false);
        if (body is null)
        {
            return AckResult();
        }

        var external = Field(body.Value, "externalTrxId");
        var key = external.Length > 0 ? external : Field(body.Value, "internalTrxId");
        if (key.Length == 0)
        {
            return AckResult();
        }

        var statusCode = Field(body.Value, "statusCode");
        if (dedupe.IsDuplicate($"charge:{key}:{statusCode}"))
        {
            return AckResult();
        }

        logger.LogInformation(
            "charging-notification externalTrxId={ExternalTrxId} statusCode={StatusCode} "
                + "paidAmount={PaidAmount} balanceDue={BalanceDue}",
            external,
            statusCode,
            Field(body.Value, "paidAmount"),
            Field(body.Value, "balanceDue"));

        await queue.EnqueueAsync(new ApplinkJob("charging.notification", body.Value.Clone()))
            .ConfigureAwait(false);
        return AckResult();
    }
}

/// <summary>A payload handed off for processing after the response was sent.</summary>
public sealed record ApplinkJob(string Name, JsonElement Payload);

/// <summary>
/// Bounded in-process queue. Register as a singleton. For anything that must survive a crash —
/// charging reconciliation above all — publish to a real broker instead.
/// </summary>
public sealed class ApplinkWorkQueue
{
    private readonly Channel<ApplinkJob> _channel =
        Channel.CreateBounded<ApplinkJob>(new BoundedChannelOptions(1024)
        {
            FullMode = BoundedChannelFullMode.DropWrite,
        });

    public ValueTask EnqueueAsync(ApplinkJob job) => _channel.Writer.WriteAsync(job);

    public IAsyncEnumerable<ApplinkJob> ReadAllAsync(CancellationToken cancellationToken) =>
        _channel.Reader.ReadAllAsync(cancellationToken);
}

/// <summary>Drains the queue outside the request lifetime. Register as a hosted service.</summary>
public sealed class ApplinkWorker : BackgroundService
{
    private readonly ApplinkWorkQueue _queue;
    private readonly ApplinkClient _client;
    private readonly ILogger<ApplinkWorker> _logger;

    public ApplinkWorker(
        ApplinkWorkQueue queue, ApplinkClient client, ILogger<ApplinkWorker> logger)
    {
        _queue = queue;
        _client = client;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var job in _queue.ReadAllAsync(stoppingToken).ConfigureAwait(false))
        {
            try
            {
                switch (job.Name)
                {
                    case "ussd.receive":
                        // Look up the session, decide the next screen, and reply with
                        // _client.SendUssdAsync(...). Terminal screens MUST use "mt-fin".
                        break;
                    case "sms.mo":
                        // Honour opt-out keywords, then handle your own commands.
                        break;
                    case "sms.dlr":
                        // Persist the latest status keyed by requestId.
                        break;
                    case "subscription.notification":
                        // Upsert your local subscription mirror.
                        break;
                    case "charging.notification":
                        // Find the ledger row by externalTrxId, compare paidAmount against what
                        // you charged, and mark it CHARGED only when balanceDue is zero.
                        break;
                    default:
                        _logger.LogWarning("unknown job {Job}", job.Name);
                        break;
                }
            }
            catch (ApplinkException error)
            {
                _logger.LogError(
                    "job {Job} failed with {StatusCode}", job.Name, error.StatusCode);
                // Send to a dead-letter queue here.
            }
            catch (Exception error)
            {
                _logger.LogError(error, "job {Job} failed", job.Name);
            }
        }
    }
}

/// <summary>
/// Deduplication. DEVELOPMENT ONLY as written — replace the dictionary with Redis (SETNX + TTL)
/// or a unique database constraint in production, because an in-process store does not survive
/// a restart or a second instance, which is exactly when duplicates arrive.
/// </summary>
public sealed class ApplinkDedupe
{
    private static readonly TimeSpan Ttl = TimeSpan.FromMinutes(10);
    private readonly ConcurrentDictionary<string, DateTimeOffset> _seen = new();

    public bool IsDuplicate(string key)
    {
        var now = DateTimeOffset.UtcNow;

        foreach (var entry in _seen)
        {
            if (entry.Value < now)
            {
                _seen.TryRemove(entry.Key, out _);
            }
        }

        return !_seen.TryAdd(key, now.Add(Ttl));
    }
}

/* ── Wiring ────────────────────────────────────────────────────────────────
 *
 *   builder.Services.AddHttpClient<ApplinkClient>();
 *   builder.Services.AddSingleton<ApplinkWorkQueue>();
 *   builder.Services.AddSingleton<ApplinkDedupe>();
 *   builder.Services.AddHostedService<ApplinkWorker>();
 *
 *   var app = builder.Build();
 *   app.MapApplinkCallbacks();
 *
 * The USSD session store is not shown: use IDistributedCache backed by Redis, keyed by
 * sessionId with a ~2 minute expiry. An in-memory cache breaks the moment you run a second
 * instance, and the user's menu dies mid-flow.
 */
