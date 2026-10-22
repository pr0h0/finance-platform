package notifications

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin"
	"github.com/pr0h0/finance-platform/apps/api/internal/app"
	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/config"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
)

// ChannelPrefs: whether a delivery channel is on and which notification types it carries.
type ChannelPrefs struct {
	Enabled   bool `json:"enabled"`
	Bills     bool `json:"bills"`     // bill_due, bill_overdue, trial_ending
	Budgets   bool `json:"budgets"`   // budget_threshold, low_balance
	Anomalies bool `json:"anomalies"` // unusual_expense
	Sync      bool `json:"sync"`      // sync_conflict
}

// Prefs are per user (settings scope user, key notification_preferences). Email and push are opt-in;
// quiet hours ("HH:MM", the user's timezone) hold email/push back until they end (in-app is unaffected).
type Prefs struct {
	Email           ChannelPrefs `json:"email"`
	Push            ChannelPrefs `json:"push"`
	QuietHoursStart string       `json:"quietHoursStart"`
	QuietHoursEnd   string       `json:"quietHoursEnd"`
}

func defaultPrefs() Prefs {
	all := ChannelPrefs{Bills: true, Budgets: true, Anomalies: true, Sync: true}
	return Prefs{Email: all, Push: all}
}

func (c ChannelPrefs) wants(kind string) bool {
	if !c.Enabled {
		return false
	}
	switch kind {
	case "bill_due", "bill_overdue", "trial_ending":
		return c.Bills
	case "budget_threshold", "low_balance":
		return c.Budgets
	case "unusual_expense":
		return c.Anomalies
	case "sync_conflict":
		return c.Sync
	}
	return true // test messages
}

func (p Prefs) channel(ch string) ChannelPrefs {
	if ch == "email" {
		return p.Email
	}
	return p.Push
}

func minutes(hhmm string) (int, bool) {
	t, err := time.Parse("15:04", hhmm)
	if err != nil || len(hhmm) != 5 {
		return 0, false
	}
	return t.Hour()*60 + t.Minute(), true
}

// quiet reports whether now (in tz) falls in [start, end); the window may wrap midnight.
func (p Prefs) quiet(now time.Time, tz string) bool {
	s, ok1 := minutes(p.QuietHoursStart)
	e, ok2 := minutes(p.QuietHoursEnd)
	if !ok1 || !ok2 || s == e {
		return false
	}
	if loc, err := time.LoadLocation(tz); err == nil {
		now = now.In(loc)
	}
	m := now.Hour()*60 + now.Minute()
	if s < e {
		return m >= s && m < e
	}
	return m >= s || m < e
}

func loadPrefs(ctx context.Context, db fin.DB, user uuid.UUID) (Prefs, error) {
	p := defaultPrefs()
	err := db.QueryRow(ctx, `SELECT value FROM settings WHERE scope = 'user' AND owner_id = $1 AND key = 'notification_preferences'`, user).Scan(&p)
	if errors.Is(err, pgx.ErrNoRows) {
		err = nil
	}
	return p, err
}

type prefsOut struct {
	Prefs
	EmailConfigured   bool   `json:"emailConfigured"`
	EmailAddress      string `json:"emailAddress"`
	PushPublicKey     string `json:"pushPublicKey"`
	PushSubscriptions int    `json:"pushSubscriptions"`
}

type subscriptionIn struct {
	Endpoint string `json:"endpoint"`
	Keys     struct {
		P256dh string `json:"p256dh"`
		Auth   string `json:"auth"`
	} `json:"keys"`
}

func registerDelivery(r chi.Router, deps *app.Deps) {
	db, cfg := deps.DB, deps.Config
	r.Get("/notifications/preferences", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, err := authz.Require(r.Context())
		if err != nil {
			return err
		}
		out := prefsOut{EmailConfigured: emailConfigured(cfg)}
		if out.Prefs, err = loadPrefs(r.Context(), db, p.UserID); err != nil {
			return err
		}
		if out.PushPublicKey, _, err = vapidKeys(r.Context(), db, cfg); err != nil {
			return err
		}
		if err := db.QueryRow(r.Context(), `SELECT u.email, (SELECT count(*) FROM push_subscriptions s WHERE s.user_id = u.id)
			FROM users u WHERE u.id = $1`, p.UserID).Scan(&out.EmailAddress, &out.PushSubscriptions); err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, out)
		return nil
	}))
	r.Put("/notifications/preferences", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, err := authz.Require(r.Context())
		if err != nil {
			return err
		}
		var in Prefs
		if err := httpx.DecodeJSON(r, &in); err != nil {
			return err
		}
		bad := map[string]string{}
		for k, v := range map[string]string{"quietHoursStart": in.QuietHoursStart, "quietHoursEnd": in.QuietHoursEnd} {
			if _, ok := minutes(v); v != "" && !ok {
				bad[k] = "HH:MM (24h) or empty"
			}
		}
		if (in.QuietHoursStart == "") != (in.QuietHoursEnd == "") {
			bad["quietHoursEnd"] = "set both or neither"
		}
		if in.Email.Enabled && !emailConfigured(cfg) {
			bad["email.enabled"] = "email delivery is not configured on this server (SMTP_HOST)"
		}
		if len(bad) > 0 {
			return httpx.Validation(bad)
		}
		raw, _ := json.Marshal(in)
		if _, err := db.Exec(r.Context(), `INSERT INTO settings (scope, owner_id, key, value, updated_at) VALUES ('user', $1, 'notification_preferences', $2, now())
			ON CONFLICT (scope, owner_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, p.UserID, raw); err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, in)
		return nil
	}))
	r.Post("/notifications/push-subscriptions", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, err := authz.Require(r.Context())
		if err != nil {
			return err
		}
		var in subscriptionIn
		if err := httpx.DecodeJSON(r, &in); err != nil {
			return err
		}
		if !validEndpoint(in.Endpoint) || len(in.Keys.P256dh) < 80 || len(in.Keys.P256dh) > 100 || len(in.Keys.Auth) < 16 || len(in.Keys.Auth) > 32 {
			return httpx.Validation(map[string]string{"endpoint": "a PushSubscription (https endpoint, keys.p256dh, keys.auth)"})
		}
		if _, err := db.Exec(r.Context(), `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1,$2,$3,$4)
			ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
			p.UserID, in.Endpoint, in.Keys.P256dh, in.Keys.Auth); err != nil {
			return err
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	}))
	r.Delete("/notifications/push-subscriptions", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, err := authz.Require(r.Context())
		if err != nil {
			return err
		}
		var in subscriptionIn
		if err := httpx.DecodeJSON(r, &in); err != nil {
			return err
		}
		if _, err := db.Exec(r.Context(), `DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2`, p.UserID, in.Endpoint); err != nil {
			return err
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	}))
	// Sends a test message on one channel to the caller right away (ignores quiet hours and type filters).
	r.Post("/notifications/test", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, err := authz.Require(r.Context())
		if err != nil {
			return err
		}
		var in struct {
			Channel string `json:"channel"`
		}
		if err := httpx.DecodeJSON(r, &in); err != nil {
			return err
		}
		if in.Channel != "email" && in.Channel != "push" {
			return httpx.Validation(map[string]string{"channel": "email or push"})
		}
		var u recipient
		if err := db.QueryRow(r.Context(), `SELECT id, email, locale, timezone FROM users WHERE id = $1`, p.UserID).Scan(&u.id, &u.email, &u.locale, &u.tz); err != nil {
			return err
		}
		title, body := "Finance Platform test notification", "Delivery works. You will get bill reminders and alerts here."
		if u.locale == "bs" {
			title, body = "Probno obavještenje", "Dostava radi. Ovdje ćete dobijati podsjetnike za račune i upozorenja."
		}
		if err := deliverOne(r.Context(), db, cfg, in.Channel, u, uuid.New(), title, body); err != nil {
			return httpx.NewError(http.StatusBadGateway, "delivery_failed", err.Error())
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	}))
}

type recipient struct {
	id                uuid.UUID
	email, locale, tz string
}

// enqueue adds email/push outbox rows for a newly created in-app notification when the user wants them.
func enqueue(ctx context.Context, db fin.DB, user uuid.UUID, prefs Prefs, hasPush bool, profile uuid.UUID, c candidate, data []byte, dedupe string) error {
	for _, ch := range []string{"email", "push"} {
		if !prefs.channel(ch).wants(c.kind) || (ch == "push" && !hasPush) {
			continue
		}
		if _, err := db.Exec(ctx, `INSERT INTO notifications (user_id, profile_id, kind, severity, title, body, data, dedupe_key, channel)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
			user, profile, c.kind, c.severity, c.title, c.body, data, ch+":"+dedupe, ch); err != nil {
			return err
		}
	}
	return nil
}

const maxAttempts = 5

// deliverOne sends a message on one channel. Push goes to every subscription of the user; expired ones
// are removed; it succeeds when at least one browser accepted it.
func deliverOne(ctx context.Context, db fin.DB, cfg *config.Config, channel string, u recipient, id uuid.UUID, title, body string) error {
	if channel == "email" {
		return sendMail(cfg, u.email, u.locale, title, body)
	}
	pub, priv, err := vapidKeys(ctx, db, cfg)
	if err != nil {
		return err
	}
	rows, err := db.Query(ctx, `SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`, u.id)
	if err != nil {
		return err
	}
	subs, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (webpush.Subscription, error) {
		var s webpush.Subscription
		return s, row.Scan(&s.Endpoint, &s.Keys.P256dh, &s.Keys.Auth)
	})
	if err != nil {
		return err
	}
	if len(subs) == 0 {
		return errors.New("no push subscription (enable push in this browser first)")
	}
	var errs []string
	ok := false
	for _, s := range subs {
		err := sendPush(ctx, cfg, pub, priv, s, pushMessage{Title: title, Body: body, URL: "/notifications", Tag: id.String()})
		switch {
		case err == nil:
			ok = true
			_, _ = db.Exec(ctx, `UPDATE push_subscriptions SET last_success_at = now() WHERE endpoint = $1`, s.Endpoint)
		case errors.Is(err, errGone):
			_, _ = db.Exec(ctx, `DELETE FROM push_subscriptions WHERE endpoint = $1`, s.Endpoint)
		default:
			errs = append(errs, err.Error())
		}
	}
	if !ok {
		if len(errs) == 0 {
			return errors.New("all push subscriptions expired")
		}
		return errors.New(strings.Join(errs, "; "))
	}
	return nil
}

// Deliver sends pending email/push outbox rows (up to maxAttempts each, for at most two days),
// holding back users in their quiet hours and dropping rows whose channel/type was turned off since.
func Deliver(ctx context.Context, db fin.DB, cfg *config.Config) (int, error) {
	rows, err := db.Query(ctx, `SELECT n.id, n.channel, n.kind, n.title, n.body, u.id, u.email, u.locale, u.timezone
		FROM notifications n JOIN users u ON u.id = n.user_id AND u.deleted_at IS NULL AND u.status = 'active'
		WHERE n.channel <> 'in_app' AND n.delivered_at IS NULL AND n.attempts < $1 AND n.created_at > now() - interval '2 days'
		ORDER BY n.created_at LIMIT 500`, maxAttempts)
	if err != nil {
		return 0, err
	}
	type item struct {
		id                         uuid.UUID
		channel, kind, title, body string
		u                          recipient
	}
	items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (item, error) {
		var i item
		return i, row.Scan(&i.id, &i.channel, &i.kind, &i.title, &i.body, &i.u.id, &i.u.email, &i.u.locale, &i.u.tz)
	})
	if err != nil {
		return 0, err
	}
	prefs := map[uuid.UUID]Prefs{}
	sent := 0
	now := time.Now()
	for _, it := range items {
		p, ok := prefs[it.u.id]
		if !ok {
			if p, err = loadPrefs(ctx, db, it.u.id); err != nil {
				return sent, err
			}
			prefs[it.u.id] = p
		}
		if !p.channel(it.channel).wants(it.kind) {
			_, err = db.Exec(ctx, `UPDATE notifications SET attempts = $2, last_error = 'turned off' WHERE id = $1`, it.id, maxAttempts)
			if err != nil {
				return sent, err
			}
			continue
		}
		if p.quiet(now, it.u.tz) {
			continue
		}
		if err := deliverOne(ctx, db, cfg, it.channel, it.u, it.id, it.title, it.body); err != nil {
			msg := err.Error()
			if len(msg) > 500 {
				msg = msg[:500]
			}
			if _, err := db.Exec(ctx, `UPDATE notifications SET attempts = attempts + 1, last_error = $2 WHERE id = $1`, it.id, msg); err != nil {
				return sent, err
			}
			continue
		}
		if _, err := db.Exec(ctx, `UPDATE notifications SET delivered_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = $1`, it.id); err != nil {
			return sent, fmt.Errorf("mark delivered: %w", err)
		}
		sent++
	}
	return sent, nil
}
