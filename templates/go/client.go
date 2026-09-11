package applink

// Applink API client — Go port of templates/typescript/applink-client.ts.
//
// One post() helper injects credentials, applies a timeout, and turns non-S1000
// responses into typed errors. Every service is a thin wrapper that resolves its
// endpoint through Config.RequireEndpoint — so calling an API your application
// was not provisioned for fails locally with a clear message, rather than as
// E1309 from the platform.
//
// Standard library only. SERVER-SIDE ONLY.

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// timeout is a protocol constant, not configuration: a single outbound call
// should never hang.
const timeout = 15 * time.Second

// apiVersion is sent where the contract marks it mandatory.
const apiVersion = "1.0"

// currency is the only one Applink accepts.
const currency = "BDT"

// transient codes are platform-side. Worth retrying with backoff.
var transient = map[string]bool{
	"E1318": true, "E1319": true, "E1341": true,
	"E1601": true, "E1602": true, "E1603": true,
}

// configuration codes mean provisioning or credentials are wrong. Retrying will
// never help.
var configuration = map[string]bool{
	"E1301": true, "E1303": true, "E1309": true, "E1311": true,
	"E1313": true, "E1315": true, "E1328": true, "E1331": true,
}

// PendingOTPSent means the request was accepted and an OTP is on its way to the
// subscriber — NOTHING has been charged. StartCharge returns it rather than
// erroring; never treat it as a completed charge, and never re-send.
//
// Applink publishes no benign duplicate-state codes: register and unregister
// outcomes come from subscriptionStatus in the response body. See
// HasSubscriptionStatus.
const PendingOTPSent = "P1003"

// Error is a non-S1000 application-level response.
type Error struct {
	StatusCode   string
	StatusDetail string
	Service      string
	Raw          map[string]any
}

func (e *Error) Error() string {
	return fmt.Sprintf("[%s] %s (%s)", e.StatusCode, e.StatusDetail, e.Service)
}

// Retryable reports whether a backoff retry is appropriate.
func (e *Error) Retryable() bool { return transient[e.StatusCode] }

// IsConfiguration reports a provisioning or credential fault. Page on these.
func (e *Error) IsConfiguration() bool { return configuration[e.StatusCode] }

// Client is safe for concurrent use. Build one at startup and share it.
type Client struct {
	config *Config
	http   *http.Client
}

// NewClient builds a client over the given config.
//
// Applink hosts have served an incomplete certificate chain, which Go rejects.
// Do NOT set InsecureSkipVerify — that lets anyone on the path read the
// applicationId and password that can charge your subscribers. Supply the
// intermediate CA instead:
//
//	pool := x509.NewCertPool()
//	pem, _ := os.ReadFile("certs/applink-chain.pem")
//	pool.AppendCertsFromPEM(pem)
//	transport := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool}}
//
// See references/09-security-best-practices.md.
func NewClient(config *Config) *Client {
	return &Client{config: config, http: &http.Client{Timeout: timeout}}
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

var separators = regexp.MustCompile(`[\s()\-]`)

// ToTelAddress normalises a subscriber address. The ONLY place "tel:" is added.
//
// Accepts an already-prefixed address, a masked value, +880…, 00880… or a local
// 01… number. The "+" is stripped: Applink's SMS samples include one and every
// other API's samples do not, so one form has to win, and the no-"+" form is
// what the subscription, OTP and CaaS endpoints publish.
func ToTelAddress(msisdn string) (string, error) {
	trimmed := strings.TrimSpace(msisdn)
	if trimmed == "" {
		return "", fmt.Errorf("[applink] empty subscriber address")
	}
	if strings.HasPrefix(strings.ToLower(trimmed), "tel:") {
		body := separators.ReplaceAllString(trimmed[4:], "")
		return "tel:" + strings.TrimPrefix(body, "+"), nil
	}
	digits := strings.TrimPrefix(separators.ReplaceAllString(trimmed, ""), "+")
	digits = strings.TrimPrefix(digits, "00")
	if strings.HasPrefix(digits, "0") {
		digits = "880" + digits[1:]
	}
	return "tel:" + digits, nil
}

// HasSubscriptionStatus reports whether a register/unregister response reached
// the state you wanted. Applink publishes no benign "already registered" code,
// and the published samples carry a trailing dot ("UNREGISTERED."), hence the
// prefix comparison.
func HasSubscriptionStatus(response map[string]any, expected string) bool {
	actual, _ := response["subscriptionStatus"].(string)
	return strings.HasPrefix(
		strings.ToUpper(strings.TrimSpace(actual)),
		strings.ToUpper(expected),
	)
}

// MaskAddress masks a subscriber address for logging. Never log the raw value.
func MaskAddress(address string) string {
	body := address
	if len(body) >= 4 && strings.EqualFold(body[:4], "tel:") {
		body = body[4:]
	}
	if len(body) <= 6 {
		return "tel:***"
	}
	return "tel:" + body[:3] + strings.Repeat("*", len(body)-6) + body[len(body)-3:]
}

var amountPattern = regexp.MustCompile(`^(\d+)(?:\.(\d{1,2}))?$`)
var zeroAmount = regexp.MustCompile(`^0+(\.0+)?$`)

// FormatAmount renders a decimal string the way the published sample does, with
// two decimal places ("5" becomes "5.00"), and rejects anything that is not a
// positive amount in whole poisha.
func FormatAmount(amount string) (string, error) {
	trimmed := strings.TrimSpace(amount)
	match := amountPattern.FindStringSubmatch(trimmed)
	if match == nil || zeroAmount.MatchString(trimmed) {
		return "", fmt.Errorf("[applink] amount must be a positive decimal string such as \"5.00\", got %q", amount)
	}
	fraction := match[2]
	for len(fraction) < 2 {
		fraction += "0"
	}
	return match[1] + "." + fraction, nil
}

// GenerateExternalTrxID returns a unique, persistable idempotency key for a
// charge.
func GenerateExternalTrxID() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

/* ── Core ────────────────────────────────────────────────────────────────── */

func (c *Client) post(
	ctx context.Context,
	service, url string,
	body map[string]any,
	accepted ...string,
) (map[string]any, error) {
	payload := map[string]any{
		"applicationId": c.config.ApplicationID,
		"password":      c.config.Password,
	}
	for key, value := range body {
		payload[key] = value
	}

	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("[applink] %s: encoding payload: %w", service, err)
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(encoded))
	if err != nil {
		return nil, fmt.Errorf("[applink] %s: building request: %w", service, err)
	}
	request.Header.Set("Content-Type", "application/json;charset=utf-8")

	response, err := c.http.Do(request)
	if err != nil {
		return nil, fmt.Errorf("[applink] %s: transport failure: %w", service, err)
	}
	defer response.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("[applink] %s: reading response: %w", service, err)
	}

	// response.StatusCode is deliberately not consulted: Applink returns 200 for
	// application-level failures, and the real outcome is statusCode in the body.
	var data map[string]any
	if err := json.Unmarshal(raw, &data); err != nil {
		limit := len(raw)
		if limit > 200 {
			limit = 200
		}
		return nil, fmt.Errorf("[applink] %s: non-JSON response: %s", service, raw[:limit])
	}

	statusCode, _ := data["statusCode"].(string)
	if statusCode == "S1000" {
		return data, nil
	}
	for _, code := range accepted {
		if statusCode == code {
			return data, nil
		}
	}
	statusDetail, _ := data["statusDetail"].(string)
	return nil, &Error{StatusCode: statusCode, StatusDetail: statusDetail, Service: service, Raw: data}
}

/* ── SMS ─────────────────────────────────────────────────────────────────── */

// SendSMS sends an MT SMS to one or more subscribers.
func (c *Client) SendSMS(ctx context.Context, to []string, message string) (map[string]any, error) {
	url, err := c.config.RequireEndpoint("smsSend")
	if err != nil {
		return nil, err
	}
	recipients := make([]string, 0, len(to))
	for _, raw := range to {
		address, err := ToTelAddress(raw)
		if err != nil {
			return nil, err
		}
		if address == "tel:all" {
			return nil, fmt.Errorf(
				"[applink] use BroadcastSMS for tel:all — broadcasts must be deliberate")
		}
		recipients = append(recipients, address)
	}
	return c.post(ctx, "sms-send", url, map[string]any{
		"version":              apiVersion,
		"message":              message,
		"destinationAddresses": recipients,
	})
}

// BroadcastConfirmation must be passed verbatim to BroadcastSMS.
const BroadcastConfirmation = "I_HAVE_VERIFIED_THIS_GOES_TO_ALL_SUBSCRIBERS"

// BroadcastSMS sends to the ENTIRE subscribed base.
//
// Deliberately separate from SendSMS so it can never be reached by accident —
// check the subscriber base size first, and put an authorisation check in front
// of this.
func (c *Client) BroadcastSMS(
	ctx context.Context, message, confirmation string,
) (map[string]any, error) {
	if confirmation != BroadcastConfirmation {
		return nil, fmt.Errorf("[applink] broadcast confirmation token missing")
	}
	url, err := c.config.RequireEndpoint("smsSend")
	if err != nil {
		return nil, err
	}
	return c.post(ctx, "sms-send", url, map[string]any{
		"version":              apiVersion,
		"message":              message,
		"destinationAddresses": []string{"tel:all"},
	})
}

/* ── USSD ────────────────────────────────────────────────────────────────── */

// SendUSSD sends a USSD screen.
//
// sessionID MUST be the one the platform sent you. Use "mt-fin" for the final
// screen — anything else leaves the session hanging until the network times out.
func (c *Client) SendUSSD(
	ctx context.Context, sessionID, destinationAddress, message, operation string,
) (map[string]any, error) {
	switch operation {
	case "mt-init", "mt-cont", "mt-fin":
	default:
		return nil, fmt.Errorf("[applink] invalid ussdOperation %q", operation)
	}
	url, err := c.config.RequireEndpoint("ussdSend")
	if err != nil {
		return nil, err
	}
	address, err := ToTelAddress(destinationAddress)
	if err != nil {
		return nil, err
	}
	return c.post(ctx, "ussd-send", url, map[string]any{
		"message":            message,
		"sessionId":          sessionID,
		"ussdOperation":      operation,
		"destinationAddress": address,
		"encoding":           "440",
		"version":            apiVersion,
	})
}

/* ── Subscription ────────────────────────────────────────────────────────── */

// Register opts a subscriber in. Only call this with recorded, explicit consent.
//
// Applink publishes no "already registered" code: confirm the outcome with
// HasSubscriptionStatus(response, "REGISTERED") rather than treating a repeat
// call as an error.
func (c *Client) Register(ctx context.Context, subscriberID string) (map[string]any, error) {
	return c.subscription(ctx, "subscription-register", subscriberID, "1")
}

// Unregister opts a subscriber out.
//
// The platform's own sample returns S1000 with statusDetail "not registered"
// for a subscriber who was never registered — reaching the desired state is the
// success condition. Confirm with HasSubscriptionStatus(response, "UNREGISTERED").
func (c *Client) Unregister(ctx context.Context, subscriberID string) (map[string]any, error) {
	return c.subscription(ctx, "subscription-unregister", subscriberID, "0")
}

func (c *Client) subscription(
	ctx context.Context, service, subscriberID, action string,
) (map[string]any, error) {
	url, err := c.config.RequireEndpoint("subscriptionSend")
	if err != nil {
		return nil, err
	}
	address, err := ToTelAddress(subscriberID)
	if err != nil {
		return nil, err
	}
	return c.post(ctx, service, url, map[string]any{
		"subscriberId": address,
		"action":       action,
	})
}

// GetSubscriberChargingInfo returns subscription status and last-charge details
// for up to ten subscribers.
//
// This is Applink's status lookup — there is no getStatus endpoint. Use it for
// reconciliation, not as a per-request gate: mirror state from the subscriber
// notification callback instead.
func (c *Client) GetSubscriberChargingInfo(
	ctx context.Context, subscriberIDs []string,
) (map[string]any, error) {
	if len(subscriberIDs) == 0 {
		return nil, fmt.Errorf("[applink] getSubscriberChargingInfo needs at least one subscriber")
	}
	if len(subscriberIDs) > 10 {
		return nil, fmt.Errorf("[applink] getSubscriberChargingInfo accepts a maximum of 10 MSISDNs")
	}
	url, err := c.config.RequireEndpoint("subscriptionChargingInfo")
	if err != nil {
		return nil, err
	}
	addresses := make([]string, 0, len(subscriberIDs))
	for _, id := range subscriberIDs {
		address, err := ToTelAddress(id)
		if err != nil {
			return nil, err
		}
		addresses = append(addresses, address)
	}
	return c.post(ctx, "subscription-charging-info", url, map[string]any{
		"subscriberIds": addresses,
	})
}

// QueryBase returns the subscriber base size. It needs no subscriber and charges
// nothing, which also makes it the best connectivity and credential smoke test.
func (c *Client) QueryBase(ctx context.Context) (int64, error) {
	url, err := c.config.RequireEndpoint("subscriptionQueryBase")
	if err != nil {
		return 0, err
	}
	data, err := c.post(ctx, "subscription-query-base", url, map[string]any{})
	if err != nil {
		return 0, err
	}
	// Documented as a string; accept a bare number too, so a platform-side
	// change cannot break the parser.
	var size string
	switch v := data["baseSize"].(type) {
	case string:
		size = v
	case float64:
		size = strconv.FormatFloat(v, 'f', -1, 64)
	}
	parsed, err := strconv.ParseInt(strings.TrimSpace(size), 10, 64)
	if err != nil {
		return 0, fmt.Errorf("[applink] unexpected baseSize %q", size)
	}
	return parsed, nil
}

/* ── OTP ─────────────────────────────────────────────────────────────────── */

// RequestOTP sends an OTP to a plain mobile number.
//
// Rate-limit per number AND per IP before calling, or the app becomes an
// SMS-bombing tool. Keep the returned referenceNo server-side; never log it.
func (c *Client) RequestOTP(
	ctx context.Context, subscriberID string, metaData map[string]any,
) (map[string]any, error) {
	url, err := c.config.RequireEndpoint("otpRequest")
	if err != nil {
		return nil, err
	}
	address, err := ToTelAddress(subscriberID)
	if err != nil {
		return nil, err
	}
	body := map[string]any{"subscriberId": address}
	// Optional. A nil map would marshal as "applicationMetaData": null — omit it
	// instead of sending a value the platform has to reject.
	if len(metaData) > 0 {
		body["applicationMetaData"] = metaData
	}
	return c.post(ctx, "otp-request", url, body)
}

// VerifyOTP verifies an OTP. Valid five minutes — enforce that on your side
// too, and cap attempts yourself; the platform documents no attempt limit. The
// returned subscriberId is the identifier to use for every subsequent call.
func (c *Client) VerifyOTP(ctx context.Context, referenceNo, otp string) (map[string]any, error) {
	url, err := c.config.RequireEndpoint("otpVerify")
	if err != nil {
		return nil, err
	}
	return c.post(ctx, "otp-verify", url, map[string]any{
		"referenceNo": referenceNo,
		"otp":         otp,
	})
}

/* ── CaaS — charging is TWO calls ──────────────────────────────────── */

// StartCharge is step 1 of charging: it reserves the charge and sends the
// subscriber an OTP.
//
// THIS DOES NOT CHARGE ANYONE. It returns P1003 and a requestCorrelator.
//
//   - externalTrxID is your idempotency key. Generate it with
//     GenerateExternalTrxID, PERSIST IT with a PENDING ledger row, then call
//     this.
//   - Persist requestCorrelator from the response. Without it the charge can
//     never be completed, and there is no way to recover it.
//   - There are deliberately no retries here. A timeout does NOT mean the
//     charge did not start; reconcile against the charging notification.
//   - P1003 is returned, not an error — it is the expected outcome.
//   - amount is a string: keep money in a decimal type (shopspring/decimal, or
//     integer minor units) and format it here. Never float64.
func (c *Client) StartCharge(
	ctx context.Context, subscriberID, amount, externalTrxID, paymentInstrumentName string,
) (map[string]any, error) {
	if externalTrxID == "" {
		return nil, fmt.Errorf("[applink] externalTrxId is required and must be persisted first")
	}
	formatted, err := FormatAmount(amount)
	if err != nil {
		return nil, err
	}
	url, err := c.config.RequireEndpoint("caasOtpGeneration")
	if err != nil {
		return nil, err
	}
	address, err := ToTelAddress(subscriberID)
	if err != nil {
		return nil, err
	}
	if paymentInstrumentName == "" {
		paymentInstrumentName = "Mobile Account"
	}
	return c.post(ctx, "caas-otp-generation", url, map[string]any{
		"externalTrxId":         externalTrxID,
		"amount":                formatted,
		"paymentInstrumentName": paymentInstrumentName,
		"subscriberId":          address,
		// Capital C, as published. The balance endpoint uses lower case.
		"Currency": currency,
	}, PendingOTPSent)
}

// ConfirmCharge is step 2 of charging: it verifies the subscriber's OTP and
// completes the charge.
//
// THIS MOVES REAL MONEY.
//
//   - requestCorrelator comes from the StartCharge response. It is NOT the
//     externalTrxID you generated and NOT the referenceNo from RequestOTP.
//     Getting that wrong is E1855.
//   - On E1850 (wrong OTP), re-prompt against the SAME correlator. On E1851
//     (expired), abandon the transaction.
//   - NEVER call StartCharge again to retry this — that begins a second charge.
//   - The authoritative outcome is the charging notification callback, which
//     carries paidAmount and balanceDue. Settle the ledger there.
func (c *Client) ConfirmCharge(
	ctx context.Context, requestCorrelator, otp, subscriberID string,
) (map[string]any, error) {
	if requestCorrelator == "" {
		return nil, fmt.Errorf("[applink] requestCorrelator is required — it comes from StartCharge")
	}
	url, err := c.config.RequireEndpoint("caasOtpVerify")
	if err != nil {
		return nil, err
	}
	address, err := ToTelAddress(subscriberID)
	if err != nil {
		return nil, err
	}
	return c.post(ctx, "caas-otp-verify", url, map[string]any{
		"referenceNo":   requestCorrelator,
		"otp":           otp,
		"sourceAddress": address,
	})
}

// QueryBalance reads chargeable balance.
//
// Advisory only: the balance can change between this and the charge. Always
// handle E1326 on the charging path regardless of what this returned.
//
// This endpoint is in the published specification but not in the rendered
// documentation's navigation. Leaving APPLINK_CAAS_BALANCE_URL unset is how you
// disable it until support confirms it is enabled on your application.
func (c *Client) QueryBalance(
	ctx context.Context, subscriberID string,
) (map[string]any, error) {
	url, err := c.config.RequireEndpoint("caasBalance")
	if err != nil {
		return nil, err
	}
	address, err := ToTelAddress(subscriberID)
	if err != nil {
		return nil, err
	}
	return c.post(ctx, "caas-query-balance", url, map[string]any{
		"subscriberId":          address,
		"paymentInstrumentName": "MobileAccount",
		// Lower-case c on this endpoint, capital C on the charging request.
		"currency": currency,
	})
}

/* ── Extension point ──────────────────────────────────────────────────────
 *
 * Adding a service Applink publishes later:
 *
 *   1. Add its URL variable to .env.example and to endpointVars in config.go
 *   2. Add one wrapper here that calls c.post with the new endpoint key.
 *
 * It inherits credential injection, the timeout, error mapping and the
 * not-provisioned guard for free. Do not build a parallel client.
 */
