package notifications

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"syscall"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
	"github.com/jackc/pgx/v5"

	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin"
	"github.com/pr0h0/finance-platform/apps/api/internal/config"
)

var vapid struct {
	sync.Mutex
	pub, priv string
}

// vapidKeys returns the Web Push application server keys: VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY when set,
// otherwise a pair generated once and stored in the server settings (shared by every API instance).
func vapidKeys(ctx context.Context, db fin.DB, cfg *config.Config) (pub, priv string, err error) {
	if cfg.VAPIDPublicKey != "" {
		return cfg.VAPIDPublicKey, cfg.VAPIDPrivateKey, nil
	}
	vapid.Lock()
	defer vapid.Unlock()
	if vapid.pub != "" {
		return vapid.pub, vapid.priv, nil
	}
	var v struct{ Public, Private string }
	load := func() error {
		return db.QueryRow(ctx, `SELECT value FROM settings WHERE scope = 'server' AND owner_id IS NULL AND key = 'vapid_keys'`).Scan(&v)
	}
	err = load()
	if errors.Is(err, pgx.ErrNoRows) {
		v.Private, v.Public, err = webpush.GenerateVAPIDKeys()
		if err != nil {
			return "", "", err
		}
		raw, _ := json.Marshal(v)
		if _, err = db.Exec(ctx, `INSERT INTO settings (scope, owner_id, key, value) VALUES ('server', NULL, 'vapid_keys', $1)
			ON CONFLICT (scope, owner_id, key) DO NOTHING`, raw); err == nil {
			err = load() // another instance may have won the insert
		}
	}
	if err != nil {
		return "", "", fmt.Errorf("vapid keys: %w", err)
	}
	vapid.pub, vapid.priv = v.Public, v.Private
	return v.Public, v.Private, nil
}

// publicDialer refuses connections to loopback, private, link-local and other non-public addresses, so
// a user-supplied push endpoint cannot make the server call into its own network (SSRF).
var publicDialer = &net.Dialer{Timeout: 10 * time.Second, Control: func(_, address string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return err
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() {
		return fmt.Errorf("push endpoint address %s is not public", host)
	}
	return nil
}}

// pushClient sends Web Push requests (tests replace it to reach an httptest server).
var pushClient webpush.HTTPClient = &http.Client{Timeout: 20 * time.Second, Transport: &http.Transport{
	DialContext: publicDialer.DialContext, TLSHandshakeTimeout: 10 * time.Second, ForceAttemptHTTP2: true,
}}

// validEndpoint: push services are HTTPS URLs on a public host name.
func validEndpoint(s string) bool {
	u, err := url.Parse(s)
	return err == nil && u.Scheme == "https" && u.Host != "" && u.User == nil && len(s) <= 2048 &&
		net.ParseIP(u.Hostname()) == nil && strings.Contains(u.Hostname(), ".")
}

type pushMessage struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	URL   string `json:"url"`
	Tag   string `json:"tag,omitempty"`
}

var errGone = errors.New("push subscription expired")

// sendPush encrypts msg for one subscription (RFC 8291, aes128gcm) and posts it with a VAPID JWT.
// errGone means the browser unsubscribed (404/410) and the subscription should be deleted.
func sendPush(ctx context.Context, cfg *config.Config, pub, priv string, sub webpush.Subscription, msg pushMessage) error {
	payload, _ := json.Marshal(msg)
	subject := cfg.VAPIDSubject
	if !strings.HasPrefix(subject, "https:") {
		subject = strings.TrimPrefix(subject, "mailto:") // the library adds mailto: to non-https subjects
		if !strings.Contains(subject, "@") {
			subject = "admin@" + hostOf(cfg.PublicURL)
		}
	}
	res, err := webpush.SendNotificationWithContext(ctx, payload, &sub, &webpush.Options{
		HTTPClient: pushClient, Subscriber: subject, TTL: 24 * 3600, Urgency: webpush.UrgencyNormal,
		VAPIDPublicKey: pub, VAPIDPrivateKey: priv,
	})
	if err != nil {
		return fmt.Errorf("push: %w", err)
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 4096))
	switch {
	case res.StatusCode == http.StatusNotFound || res.StatusCode == http.StatusGone:
		return errGone
	case res.StatusCode >= 300:
		return fmt.Errorf("push service answered %d", res.StatusCode)
	}
	return nil
}

func hostOf(u string) string {
	if p, err := url.Parse(u); err == nil && p.Hostname() != "" {
		return p.Hostname()
	}
	return "localhost"
}
