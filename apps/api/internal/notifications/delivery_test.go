package notifications

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/httptest"
	"net/mail"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/pr0h0/finance-platform/apps/api/internal/app"
	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/config"
	"github.com/pr0h0/finance-platform/apps/api/internal/testdb"
)

func TestQuietHours(t *testing.T) {
	at := func(h, m int) time.Time { return time.Date(2026, 10, 22, h, m, 0, 0, time.UTC) }
	wrap := Prefs{QuietHoursStart: "22:00", QuietHoursEnd: "07:00"}
	for _, c := range []struct {
		p    Prefs
		t    time.Time
		tz   string
		want bool
	}{
		{wrap, at(23, 0), "UTC", true}, {wrap, at(6, 59), "UTC", true}, {wrap, at(7, 0), "UTC", false}, {wrap, at(12, 0), "UTC", false},
		{wrap, at(20, 30), "Europe/Sarajevo", true}, // 22:30 local (CEST)
		{Prefs{QuietHoursStart: "13:00", QuietHoursEnd: "14:00"}, at(13, 30), "UTC", true},
		{Prefs{}, at(23, 0), "UTC", false},
	} {
		if got := c.p.quiet(c.t, c.tz); got != c.want {
			t.Errorf("%+v at %s %s: %v", c.p, c.t.Format("15:04"), c.tz, got)
		}
	}
	ch := ChannelPrefs{Enabled: true, Bills: true}
	if !ch.wants("bill_due") || ch.wants("budget_threshold") || (ChannelPrefs{Bills: true}).wants("bill_due") {
		t.Fatal("type filter")
	}
}

func TestBuildMailEscapesAndLocalizes(t *testing.T) {
	from, _ := mail.ParseAddress("Finance <finance@example.test>")
	to, _ := mail.ParseAddress("user@example.test")
	title := "Rent <b>due</b>\r\nBcc: victim@example.test {{.Footer}}"
	msg, err := buildMail(from, to, "bs", title, "Body & <script>x</script>", "https://fin.example.test/notifications", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	m, err := mail.ReadMessage(bytes.NewReader(msg))
	if err != nil {
		t.Fatal(err)
	}
	if m.Header.Get("Bcc") != "" || len(m.Header["Subject"]) != 1 {
		t.Fatalf("header injection: %v", m.Header)
	}
	subj, _ := new(mime.WordDecoder).DecodeHeader(m.Header.Get("Subject"))
	if !strings.HasPrefix(subj, "Rent <b>due</b>") || strings.ContainsAny(subj, "\r\n") {
		t.Fatalf("subject %q", subj)
	}
	_, params, _ := mime.ParseMediaType(m.Header.Get("Content-Type"))
	parts := map[string]string{}
	mr := multipart.NewReader(m.Body, params["boundary"])
	for {
		p, err := mr.NextPart() // decodes quoted-printable
		if err != nil {
			break
		}
		b, _ := io.ReadAll(p)
		parts[strings.SplitN(p.Header.Get("Content-Type"), ";", 2)[0]] = string(b)
	}
	html, text := parts["text/html"], parts["text/plain"]
	if strings.Contains(html, "<script>") || !strings.Contains(html, "&lt;script&gt;") || !strings.Contains(html, `lang="bs"`) {
		t.Fatalf("HTML body not escaped: %s", html)
	}
	if !strings.Contains(text, "<script>x</script>") || !strings.Contains(text, "{{.Footer}}") { // data stays data, never evaluated
		t.Fatalf("text: %s", text)
	}
	if !strings.Contains(text, "Otvori obavještenja: https://fin.example.test/notifications") {
		t.Fatalf("not localized: %s", text)
	}
}

func TestEndpointGuard(t *testing.T) {
	for s, want := range map[string]bool{
		"https://fcm.googleapis.com/fcm/send/abc": true, "http://fcm.googleapis.com/x": false, "https://127.0.0.1/x": false,
		"https://localhost/x": false, "https://user:pw@push.example.com/x": false, "https://[::1]/x": false,
	} {
		if validEndpoint(s) != want {
			t.Errorf("%s: want %v", s, want)
		}
	}
	// Even a public-looking name that resolves to a private address is refused at dial time.
	if c, err := publicDialer.Dial("tcp", "127.0.0.1:9"); err == nil || !strings.Contains(err.Error(), "not public") {
		if c != nil {
			c.Close()
		}
		t.Fatalf("dialer allowed loopback: %v", err)
	}
}

// pushReceiver is a fake push service: it decrypts aes128gcm payloads (RFC 8188/8291) with the
// browser's private key, proving the library's encryption is interoperable.
type pushReceiver struct {
	priv    *ecdh.PrivateKey
	auth    []byte
	mu      sync.Mutex
	got     []pushMessage
	vapid   []string
	status  int
	srv     *httptest.Server
	decrypt error
}

func newReceiver(t *testing.T) *pushReceiver {
	priv, _ := ecdh.P256().GenerateKey(rand.Reader)
	r := &pushReceiver{priv: priv, auth: make([]byte, 16), status: http.StatusCreated}
	_, _ = rand.Read(r.auth)
	r.srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		body, _ := io.ReadAll(req.Body)
		r.mu.Lock()
		defer r.mu.Unlock()
		r.vapid = append(r.vapid, req.Header.Get("Authorization"))
		if req.Header.Get("Content-Encoding") != "aes128gcm" || req.Header.Get("TTL") == "" {
			r.decrypt = fmt.Errorf("headers %v", req.Header)
		} else if plain, err := r.open(body); err != nil {
			r.decrypt = err
		} else {
			var m pushMessage
			r.decrypt = json.Unmarshal(plain, &m)
			r.got = append(r.got, m)
		}
		w.WriteHeader(r.status)
	}))
	t.Cleanup(r.srv.Close)
	return r
}

func (r *pushReceiver) sub(path string) webpush.Subscription {
	return webpush.Subscription{Endpoint: r.srv.URL + path, Keys: webpush.Keys{
		P256dh: base64.RawURLEncoding.EncodeToString(r.priv.PublicKey().Bytes()), Auth: base64.RawURLEncoding.EncodeToString(r.auth)}}
}

func (r *pushReceiver) open(body []byte) ([]byte, error) {
	if len(body) < 21 {
		return nil, fmt.Errorf("short body")
	}
	salt, rs, idlen := body[:16], binary.BigEndian.Uint32(body[16:20]), int(body[20])
	if rs < 18 || len(body) < 21+idlen {
		return nil, fmt.Errorf("bad header")
	}
	asPub, ct := body[21:21+idlen], body[21+idlen:]
	pub, err := ecdh.P256().NewPublicKey(asPub)
	if err != nil {
		return nil, err
	}
	secret, err := r.priv.ECDH(pub)
	if err != nil {
		return nil, err
	}
	info := append(append([]byte("WebPush: info\x00"), r.priv.PublicKey().Bytes()...), asPub...)
	ikm, _ := hkdf.Key(sha256.New, secret, r.auth, string(info), 32)
	cek, _ := hkdf.Key(sha256.New, ikm, salt, "Content-Encoding: aes128gcm\x00", 16)
	nonce, _ := hkdf.Key(sha256.New, ikm, salt, "Content-Encoding: nonce\x00", 12)
	blk, _ := aes.NewCipher(cek)
	gcm, _ := cipher.NewGCM(blk)
	plain, err := gcm.Open(nil, nonce, ct, nil)
	if err != nil {
		return nil, err
	}
	plain = bytes.TrimRight(plain, "\x00")
	if len(plain) == 0 || plain[len(plain)-1] != 2 {
		return nil, fmt.Errorf("missing padding delimiter")
	}
	return plain[:len(plain)-1], nil
}

func testVAPID(t *testing.T) *config.Config {
	priv, pub, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		t.Fatal(err)
	}
	return &config.Config{VAPIDPublicKey: pub, VAPIDPrivateKey: priv, VAPIDSubject: "mailto:ops@example.test", PublicURL: "https://fin.example.test"}
}

func trustReceiver(t *testing.T, r *pushReceiver) {
	old := pushClient
	pushClient = r.srv.Client()
	t.Cleanup(func() { pushClient = old })
}

func TestPushPayloadEncryption(t *testing.T) {
	r := newReceiver(t)
	trustReceiver(t, r)
	cfg := testVAPID(t)
	msg := pushMessage{Title: "Rent due tomorrow", Body: "300.00 BAM", URL: "/notifications", Tag: "x"}
	if err := sendPush(context.Background(), cfg, cfg.VAPIDPublicKey, cfg.VAPIDPrivateKey, r.sub("/push/1"), msg); err != nil {
		t.Fatal(err)
	}
	if r.decrypt != nil || len(r.got) != 1 || r.got[0] != msg {
		t.Fatalf("decrypt: %v %+v", r.decrypt, r.got)
	}
	if !strings.HasPrefix(r.vapid[0], "vapid t=") || !strings.Contains(r.vapid[0], "k="+cfg.VAPIDPublicKey) {
		t.Fatalf("vapid header %q", r.vapid[0])
	}
	r.status = http.StatusGone
	if err := sendPush(context.Background(), cfg, cfg.VAPIDPublicKey, cfg.VAPIDPrivateKey, r.sub("/push/1"), msg); err != errGone {
		t.Fatalf("gone: %v", err)
	}
}

// ===== integration: preferences, subscriptions, Generate → outbox → Deliver over SMTP and push =====

func mailpit(t *testing.T) (smtpHost, api string) {
	smtpHost, api = "mailpit", "http://mailpit:8025"
	if v := os.Getenv("TEST_SMTP_HOST"); v != "" {
		smtpHost, api = v, os.Getenv("TEST_MAILPIT_API")
	}
	c, err := net.DialTimeout("tcp", smtpHost+":1025", time.Second)
	if err != nil {
		t.Skip("SMTP test server not reachable (docker compose -f docker-compose.dev.yml --profile integrations up -d mailpit)")
	}
	c.Close()
	return smtpHost, api
}

type mailpitMsg struct {
	ID, Subject, Text, HTML string
	To                      []struct{ Address string }
}

func findMail(t *testing.T, api, to string) []mailpitMsg {
	t.Helper()
	res, err := http.Get(api + "/api/v1/search?query=" + "to:" + to)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var list struct{ Messages []struct{ ID string } }
	_ = json.NewDecoder(res.Body).Decode(&list)
	var out []mailpitMsg
	for _, m := range list.Messages {
		r, err := http.Get(api + "/api/v1/message/" + m.ID)
		if err != nil {
			t.Fatal(err)
		}
		var full mailpitMsg
		_ = json.NewDecoder(r.Body).Decode(&full)
		r.Body.Close()
		out = append(out, full)
	}
	return out
}

func TestSMTPModes(t *testing.T) {
	host, api := mailpit(t)
	old := smtpTLS
	smtpTLS = func(h string) *tls.Config { return &tls.Config{ServerName: h, InsecureSkipVerify: true} } // mailpit's self-signed cert
	t.Cleanup(func() { smtpTLS = old })
	for _, mode := range []string{"none", "starttls"} {
		to := "smtp-" + mode + "-" + uuid.NewString()[:8] + "@example.test"
		cfg := &config.Config{SMTPHost: host, SMTPPort: 1025, SMTPFrom: "Finance <finance@example.test>", SMTPTLS: mode, PublicURL: "https://fin.example.test"}
		if mode == "starttls" {
			cfg.SMTPUser, cfg.SMTPPassword = "u", "p" // PLAIN auth only goes over TLS
		}
		if err := sendMail(cfg, to, "en", "Test "+mode, "Hello"); err != nil {
			t.Fatalf("%s: %v", mode, err)
		}
		if got := findMail(t, api, to); len(got) != 1 || got[0].Subject != "Test "+mode || !strings.Contains(got[0].HTML, "Open notifications") {
			t.Fatalf("%s: %+v", mode, got)
		}
	}
	// PLAIN auth without TLS to a non-localhost server is refused by net/smtp (no password leak).
	cfg := &config.Config{SMTPHost: host, SMTPPort: 1025, SMTPFrom: "finance@example.test", SMTPTLS: "none", SMTPUser: "u", SMTPPassword: "p"}
	if err := sendMail(cfg, "x@example.test", "en", "t", "b"); err == nil {
		t.Fatal("plaintext auth allowed")
	}
}

type testAPI struct {
	t *testing.T
	h http.Handler
}

func (a testAPI) do(want int, method, path string, body any, out any) {
	a.t.Helper()
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(method, "/api/v1"+path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	a.h.ServeHTTP(rec, req)
	if rec.Code != want {
		a.t.Fatalf("%s %s: %d want %d: %s", method, path, rec.Code, want, rec.Body)
	}
	if out != nil {
		_ = json.Unmarshal(rec.Body.Bytes(), out)
	}
}

func TestDeliveryEndToEnd(t *testing.T) {
	host, mapi := mailpit(t)
	pool := testdb.New(t)
	user, profile := testdb.SeedUserProfile(t, pool)
	email := "deliver-" + uuid.NewString()[:8] + "@example.test"
	if _, err := pool.Exec(t.Context(), `UPDATE users SET email = $2, locale = 'bs' WHERE id = $1`, user, email); err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{SMTPHost: host, SMTPPort: 1025, SMTPFrom: "finance@example.test", SMTPTLS: "none", PublicURL: "https://fin.example.test"}
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(authz.WithPrincipal(req.Context(), authz.Principal{UserID: user, ActorType: authz.ActorUser})))
		})
	})
	r.Route("/api/v1", func(v chi.Router) {
		Register(v, &app.Deps{Config: cfg, DB: pool, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	})
	api := testAPI{t, r}

	var prefs prefsOut
	api.do(200, "GET", "/notifications/preferences", nil, &prefs)
	if prefs.Email.Enabled || prefs.Push.Enabled || !prefs.Email.Bills || !prefs.EmailConfigured || prefs.EmailAddress != email || len(prefs.PushPublicKey) < 80 {
		t.Fatalf("defaults: %+v", prefs)
	}
	var again prefsOut
	api.do(200, "GET", "/notifications/preferences", nil, &again)
	if again.PushPublicKey != prefs.PushPublicKey {
		t.Fatal("VAPID key not persisted")
	}
	api.do(422, "PUT", "/notifications/preferences", Prefs{QuietHoursStart: "25:00", QuietHoursEnd: "07:00"}, nil)
	api.do(422, "POST", "/notifications/push-subscriptions", map[string]any{"endpoint": "https://127.0.0.1/x", "keys": map[string]string{"p256dh": strings.Repeat("A", 87), "auth": strings.Repeat("A", 22)}}, nil)

	keys := map[string]string{"p256dh": strings.Repeat("B", 87), "auth": strings.Repeat("C", 22)}
	api.do(204, "POST", "/notifications/push-subscriptions", map[string]any{"endpoint": "https://push.example.test/s/1", "keys": keys}, nil)
	api.do(200, "GET", "/notifications/preferences", nil, &again)
	if again.PushSubscriptions != 1 {
		t.Fatalf("subscriptions %d", again.PushSubscriptions)
	}
	api.do(204, "DELETE", "/notifications/push-subscriptions", map[string]any{"endpoint": "https://push.example.test/s/1"}, nil)

	// email: bills only; push: budgets only (and no quiet hours).
	in := Prefs{Email: ChannelPrefs{Enabled: true, Bills: true}, Push: ChannelPrefs{Enabled: true, Budgets: true, Bills: false}}
	api.do(200, "PUT", "/notifications/preferences", in, nil)

	// A push subscription on the fake push service (registered directly: its host is loopback).
	recv := newReceiver(t)
	trustReceiver(t, recv)
	sub := recv.sub("/push/" + uuid.NewString())
	if _, err := pool.Exec(t.Context(), `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1,$2,$3,$4)`,
		user, sub.Endpoint, sub.Keys.P256dh, sub.Keys.Auth); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	for _, c := range []candidate{
		{kind: "bill_due", severity: "info", title: "Rent due tomorrow", body: "300.00 BAM is scheduled tomorrow.", dedupe: "a"},
		{kind: "budget_threshold", severity: "warning", title: "Groceries: budget threshold reached", body: "Spent 90%.", dedupe: "b"},
		{kind: "unusual_expense", severity: "warning", title: "Unusual expense", body: "x", dedupe: "c"},
	} {
		p, _ := loadPrefs(ctx, pool, user)
		if err := enqueue(ctx, pool, user, p, true, profile, c, []byte(`{}`), c.dedupe); err != nil {
			t.Fatal(err)
		}
	}
	var queued int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM notifications WHERE user_id = $1 AND channel <> 'in_app'`, user).Scan(&queued)
	if queued != 2 { // bill → email, budget → push, anomaly → neither
		t.Fatalf("queued %d", queued)
	}

	// Quiet hours covering the whole day except one minute hold delivery back.
	now := time.Now().UTC()
	in.QuietHoursStart, in.QuietHoursEnd = now.Add(-time.Hour).Format("15:04"), now.Add(time.Hour).Format("15:04")
	api.do(200, "PUT", "/notifications/preferences", in, nil)
	if n, err := Deliver(ctx, pool, cfg); err != nil || n != 0 {
		t.Fatalf("quiet: %d %v", n, err)
	}
	in.QuietHoursStart, in.QuietHoursEnd = "", ""
	api.do(200, "PUT", "/notifications/preferences", in, nil)
	if n, err := Deliver(ctx, pool, cfg); err != nil || n != 2 {
		t.Fatalf("deliver: %d %v", n, err)
	}
	if n, _ := Deliver(ctx, pool, cfg); n != 0 {
		t.Fatalf("redelivered %d", n)
	}
	got := findMail(t, mapi, email)
	if len(got) != 1 || got[0].Subject != "Rent due tomorrow" || !strings.Contains(got[0].Text, "Otvori obavještenja") {
		t.Fatalf("mail: %+v", got)
	}
	if recv.decrypt != nil || len(recv.got) != 1 || recv.got[0].Title != "Groceries: budget threshold reached" {
		t.Fatalf("push: %v %+v", recv.decrypt, recv.got)
	}

	// Test endpoint on both channels; an expired subscription is removed.
	api.do(204, "POST", "/notifications/test", map[string]string{"channel": "email"}, nil)
	api.do(204, "POST", "/notifications/test", map[string]string{"channel": "push"}, nil)
	if len(findMail(t, mapi, email)) != 2 || len(recv.got) != 2 || recv.got[1].Title != "Probno obavještenje" {
		t.Fatal("test messages not delivered")
	}
	recv.status = http.StatusGone
	api.do(502, "POST", "/notifications/test", map[string]string{"channel": "push"}, nil)
	var subs int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM push_subscriptions WHERE user_id = $1`, user).Scan(&subs)
	if subs != 0 {
		t.Fatal("expired subscription kept")
	}
	// The outbox rows never show in the in-app list.
	var list struct{ Items []Notification }
	api.do(200, "GET", "/notifications", nil, &list)
	if len(list.Items) != 0 {
		t.Fatalf("outbox leaked into the list: %+v", list.Items)
	}
}

func TestSyncConflictNotification(t *testing.T) {
	pool := testdb.New(t)
	user, profile := testdb.SeedUserProfile(t, pool)
	ctx := context.Background()
	for range 2 {
		if _, err := pool.Exec(ctx, `INSERT INTO sync_conflicts (profile_id, entity_type, entity_id, op_id, base_version, fields, server_data, client_data)
			VALUES ($1, 'account', gen_random_uuid(), gen_random_uuid(), 1, '{name}', '{}', '{}')`, profile); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := Generate(ctx, pool, profile); err != nil {
		t.Fatal(err)
	}
	var title string
	if err := pool.QueryRow(ctx, `SELECT title FROM notifications WHERE user_id = $1 AND kind = 'sync_conflict' AND channel = 'in_app'`, user).Scan(&title); err != nil || !strings.HasPrefix(title, "2 sync conflict") {
		t.Fatalf("%q %v", title, err)
	}
}
