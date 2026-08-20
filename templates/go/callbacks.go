package applink

// Applink callback (inbound webhook) handlers — net/http.
//
// Routes to register in the Applink portal:
//
//	SMS receive (MO)          POST /api/applink/sms/receive
//	Delivery status report    POST /api/applink/sms/report
//	USSD receive              POST /api/applink/ussd/receive
//	Subscriber notification   POST /api/applink/subscription/notify
//	Charging notification     POST /api/applink/caas/charging-notification
//
// The contract, for all five:
//   - Respond {"statusCode":"S1000","statusDetail":"Success"}
//   - Respond FIRST, work afterwards
//   - Always HTTP 200, even for payloads you reject
//   - Be idempotent — every callback can arrive more than once
//   - Never trust the body; it is unauthenticated JSON from the internet
//   - Redact the subscriber notification's password field before logging
//
// These are plain http.HandlerFunc values, so they mount unchanged on chi, gin
// (via gin.WrapF), echo, or the standard mux. Full rules: references/07-callbacks.md.

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

// ack is the only response Applink expects.
var ack = map[string]string{"statusCode": "S1000", "statusDetail": "Success"}

// Callbacks holds the dependencies the five handlers share.
type Callbacks struct {
	Config   *Config
	Client   *Client
	Sessions SessionStore
	Jobs     chan job
	dedupe   *dedupeStore
}

type job struct {
	name    string
	payload map[string]any
}

// NewCallbacks wires the handlers and starts the worker that processes payloads
// after each response has been sent.
//
// The channel is bounded on purpose: an unbounded `go func()` per request turns
// a callback flood into an out-of-memory kill. For anything that must survive a
// crash — charging reconciliation above all — publish to a real broker instead.
func NewCallbacks(config *Config, client *Client, sessions SessionStore) *Callbacks {
	callbacks := &Callbacks{
		Config:   config,
		Client:   client,
		Sessions: sessions,
		Jobs:     make(chan job, 1024),
		dedupe:   newDedupeStore(10 * time.Minute),
	}
	go callbacks.worker()
	return callbacks
}

// Register mounts every callback route on a mux.
func (c *Callbacks) Register(mux *http.ServeMux) {
	mux.HandleFunc("/api/applink/sms/receive", c.SMSReceive)
	mux.HandleFunc("/api/applink/sms/report", c.SMSReport)
	mux.HandleFunc("/api/applink/ussd/receive", c.USSD)
	mux.HandleFunc("/api/applink/subscription/notify", c.SubscriptionNotification)
	mux.HandleFunc("/api/applink/caas/charging-notification", c.ChargingNotification)
}

/* ── Shared guards ───────────────────────────────────────────────────────── */

// ApplinkSourceIPs restricts callbacks to Applink's egress addresses. Applink
// signs nothing, so there is no signature to verify — source IP is the strongest
// control available. Ask support for the current list. Prefer enforcing it at
// the firewall or load balancer; this is the fallback for when you cannot.
var ApplinkSourceIPs []string

func allowedSource(r *http.Request) bool {
	if len(ApplinkSourceIPs) == 0 {
		return true // not configured yet
	}
	ip := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-For"), ",")[0])
	for _, allowed := range ApplinkSourceIPs {
		if ip == allowed {
			return true
		}
	}
	return false
}

func writeAck(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(ack)
}

// readJSON reads the body without failing the response on malformed input.
func readJSON(r *http.Request) map[string]any {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		return nil
	}
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil
	}
	return body
}

// isOurApp rejects payloads addressed to a different application. Cheap noise filter.
// redactSecrets removes the API key the subscriber notification carries, before
// the payload can reach a log, a trace, or an error reporter.
func redactSecrets(body map[string]any) map[string]any {
	delete(body, "password")
	return body
}

func (c *Callbacks) isOurApp(body map[string]any) bool {
	id, _ := body["applicationId"].(string)
	return id == c.Config.ApplicationID
}

func str(body map[string]any, key string) string {
	value, _ := body[key].(string)
	return value
}

func (c *Callbacks) enqueue(name string, payload map[string]any) {
	select {
	case c.Jobs <- job{name: name, payload: payload}:
	default:
		log.Printf("[applink] job queue full, dropping %s", name)
	}
}

/* ── 1. MO SMS ───────────────────────────────────────────────────────────── */

func (c *Callbacks) SMSReceive(w http.ResponseWriter, r *http.Request) {
	defer writeAck(w)
	if !allowedSource(r) {
		return
	}
	body := readJSON(r)
	if body == nil || !c.isOurApp(body) || str(body, "requestId") == "" {
		return
	}
	if c.dedupe.isDuplicate("mo:" + str(body, "requestId")) {
		return
	}
	// Message content deliberately not logged — it is user communication.
	log.Printf("[applink] mo-sms requestId=%s from=%s",
		str(body, "requestId"), MaskAddress(str(body, "sourceAddress")))
	c.enqueue("sms.mo", body)
}

/* ── 2. SMS delivery report ──────────────────────────────────────────────── */

// deliveryStatus normalises the two spellings Applink and the SMPP gateway use.
var deliveryStatus = map[string]string{
	"DELIVRD": "DELIVERED", "UNDELIV": "UNDELIVERABLE",
	"ACCEPTD": "ACCEPTED", "REJECTD": "REJECTED",
}

func (c *Callbacks) SMSReport(w http.ResponseWriter, r *http.Request) {
	defer writeAck(w)
	if !allowedSource(r) {
		return
	}
	body := readJSON(r)
	if body == nil || str(body, "requestId") == "" || str(body, "deliveryStatus") == "" {
		return
	}
	status := str(body, "deliveryStatus")
	if normalised, ok := deliveryStatus[status]; ok {
		status = normalised
	}
	if c.dedupe.isDuplicate("dlr:" + str(body, "requestId") + ":" + status) {
		return
	}
	log.Printf("[applink] delivery-report requestId=%s status=%s",
		str(body, "requestId"), status)
	body["deliveryStatus"] = status
	c.enqueue("sms.dlr", body)
}

/* ── 3. USSD receive ─────────────────────────────────────────────────────── */

// USSD acknowledges only. The screen the user sees comes from a separate
// POST /ussd/send — which is why the reply is enqueued rather than returned.
// USSD sessions time out in seconds, so nothing slow may happen before the ack.
func (c *Callbacks) USSD(w http.ResponseWriter, r *http.Request) {
	defer writeAck(w)
	if !allowedSource(r) {
		return
	}
	body := readJSON(r)
	if body == nil || !c.isOurApp(body) {
		return
	}
	if str(body, "sessionId") == "" || str(body, "sourceAddress") == "" {
		return
	}
	if c.dedupe.isDuplicate("ussd:" + str(body, "requestId")) {
		return
	}
	log.Printf("[applink] ussd sessionId=%s operation=%s from=%s",
		str(body, "sessionId"), str(body, "ussdOperation"),
		MaskAddress(str(body, "sourceAddress")))
	c.enqueue("ussd.receive", body)
}

// handleUSSDInput is the menu logic, run out of band. Replies via SendUSSD.
func (c *Callbacks) handleUSSDInput(payload map[string]any) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	sessionID := str(payload, "sessionId")
	source := str(payload, "sourceAddress")
	input := strings.TrimSpace(str(payload, "message"))

	send := func(message, operation string) {
		if _, err := c.Client.SendUSSD(ctx, sessionID, source, message, operation); err != nil {
			log.Printf("[applink] ussd send failed sessionId=%s: %v", sessionID, err)
		}
	}

	if str(payload, "ussdOperation") == "mo-init" {
		c.Sessions.Set(sessionID, "root", source)
		send("Welcome to Acme\n1. Balance\n2. Support\n0. Exit", "mt-cont")
		return
	}

	if _, live := c.Sessions.Get(sessionID); !live {
		// Expired or unknown — close cleanly rather than leaving it hanging.
		send("Session expired. Please dial again.", "mt-fin")
		return
	}

	// Terminal screens MUST use mt-fin, or the session hangs until the network
	// times it out.
	switch input {
	case "0":
		c.Sessions.End(sessionID)
		send("Thank you.", "mt-fin")
	case "1":
		c.Sessions.End(sessionID)
		send("Your balance is BDT 300.00", "mt-fin")
	case "2":
		c.Sessions.Set(sessionID, "support", source)
		send("Support\n1. Call us\n2. SMS us\n0. Exit", "mt-cont")
	default:
		// Invalid input: reshow rather than dropping the session.
		send("Invalid option\n1. Balance\n2. Support\n0. Exit", "mt-cont")
	}
}

/* ── 4. Subscriber notification ──────────────────────────────────────────── */

// SubscriptionNotification is the authoritative source of subscription state —
// including changes you did not initiate (a user texting STOP, an operator
// removal, a billing failure). Consuming it is what lets you keep a local mirror
// instead of re-querying GetSubscriberChargingInfo, which is capped at ten
// MSISDNs per call.
//
// NOTE: this is the one callback that carries your password. It is stripped
// before anything else touches the payload.
func (c *Callbacks) SubscriptionNotification(w http.ResponseWriter, r *http.Request) {
	defer writeAck(w)
	if !allowedSource(r) {
		return
	}
	body := readJSON(r)
	if body == nil {
		return
	}
	body = redactSecrets(body)
	if !c.isOurApp(body) {
		return
	}
	if str(body, "subscriberId") == "" || str(body, "status") == "" {
		return
	}
	key := "sub:" + str(body, "subscriberId") + ":" + str(body, "status") + ":" +
		str(body, "timeStamp")
	if c.dedupe.isDuplicate(key) {
		return
	}
	log.Printf("[applink] subscription-notify subscriber=%s status=%s",
		MaskAddress(str(body, "subscriberId")), str(body, "status"))
	c.enqueue("subscription.notification", body)
}

/* ── 5. Charging notification ────────────────────────────────────────────── */

// ChargingNotification is your reconciliation channel, and the only place a
// charge is actually settled. Applink charging is two calls plus this callback:
// neither the P1003 from OTP generation nor the response to OTP verification
// tells you what was paid.
//
// Idempotency is not optional — a duplicate that double-counts revenue is a real
// bug with real consequences.
func (c *Callbacks) ChargingNotification(w http.ResponseWriter, r *http.Request) {
	defer writeAck(w)
	if !allowedSource(r) {
		return
	}
	body := readJSON(r)
	if body == nil {
		return
	}
	key := str(body, "externalTrxId")
	if key == "" {
		key = str(body, "internalTrxId")
	}
	if key == "" {
		return
	}
	if c.dedupe.isDuplicate("charge:" + key + ":" + str(body, "statusCode")) {
		return
	}
	log.Printf("[applink] charging-notification externalTrxId=%s statusCode=%s paidAmount=%s balanceDue=%s",
		str(body, "externalTrxId"), str(body, "statusCode"),
		str(body, "paidAmount"), str(body, "balanceDue"))
	c.enqueue("charging.notification", body)
}

/* ── Job dispatch ────────────────────────────────────────────────────────── */

func (c *Callbacks) worker() {
	for next := range c.Jobs {
		switch next.name {
		case "ussd.receive":
			c.handleUSSDInput(next.payload)
		case "sms.mo":
			// Honour opt-out keywords, then handle your own commands.
		case "sms.dlr":
			// Persist the latest status keyed by requestId.
		case "subscription.notification":
			// Upsert your local subscription mirror.
		case "charging.notification":
			// Find the ledger row by externalTrxId, compare paidAmount against
			// what you charged, and mark it CHARGED only when balanceDue is zero.
		default:
			log.Printf("[applink] unknown job %s", next.name)
		}
	}
}

/* ── Support types ───────────────────────────────────────────────────────── */

// dedupeStore is DEVELOPMENT ONLY. Replace with Redis (SETNX + TTL) or a unique
// database constraint in production — an in-process map does not survive a
// restart or a second instance, which is exactly when duplicates arrive.
type dedupeStore struct {
	ttl  time.Duration
	mu   sync.Mutex
	seen map[string]time.Time
}

func newDedupeStore(ttl time.Duration) *dedupeStore {
	return &dedupeStore{ttl: ttl, seen: make(map[string]time.Time)}
}

func (d *dedupeStore) isDuplicate(key string) bool {
	now := time.Now()
	d.mu.Lock()
	defer d.mu.Unlock()
	for existing, expiry := range d.seen {
		if expiry.Before(now) {
			delete(d.seen, existing)
		}
	}
	if _, found := d.seen[key]; found {
		return true
	}
	d.seen[key] = now.Add(d.ttl)
	return false
}

// SessionStore keeps USSD menu position, keyed by sessionId with a ~2 minute TTL.
//
// It MUST be shared across instances in production: a keypress routed to another
// instance cannot see an in-process map, and the user's menu dies mid-flow. Back
// it with Redis and this interface stays the same.
type SessionStore interface {
	Get(sessionID string) (node string, live bool)
	Set(sessionID, node, sourceAddress string)
	End(sessionID string)
}

// MemorySessionStore is DEVELOPMENT ONLY. See SessionStore.
type MemorySessionStore struct {
	mu       sync.Mutex
	sessions map[string]memorySession
}

type memorySession struct {
	node      string
	source    string
	expiresAt time.Time
}

// NewMemorySessionStore builds the development store.
func NewMemorySessionStore() *MemorySessionStore {
	return &MemorySessionStore{sessions: make(map[string]memorySession)}
}

const sessionTTL = 2 * time.Minute

func (s *MemorySessionStore) Get(sessionID string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	session, found := s.sessions[sessionID]
	if !found || session.expiresAt.Before(time.Now()) {
		delete(s.sessions, sessionID)
		return "", false
	}
	return session.node, true
}

func (s *MemorySessionStore) Set(sessionID, node, sourceAddress string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sessions[sessionID] = memorySession{
		node:      node,
		source:    sourceAddress,
		expiresAt: time.Now().Add(sessionTTL),
	}
}

func (s *MemorySessionStore) End(sessionID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sessions, sessionID)
}

/* ── Wiring ───────────────────────────────────────────────────────────────
 *
 *   config, err := applink.LoadConfig()
 *   if err != nil { log.Fatal(err) }            // fail at boot, not under load
 *
 *   client := applink.NewClient(config)
 *   callbacks := applink.NewCallbacks(config, client, applink.NewMemorySessionStore())
 *
 *   mux := http.NewServeMux()
 *   callbacks.Register(mux)
 *   log.Fatal(http.ListenAndServe(":8080", mux))
 *
 * Keep these routes out of any auth middleware, and rely on the source-IP
 * allowlist instead — or you have left an open endpoint.
 */
