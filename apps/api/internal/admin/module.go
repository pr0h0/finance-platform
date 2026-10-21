// Package admin: Self-hosted administration (server settings, users, registration policy).
//
// Owned routes under /api/v1: /admin
// See docs/api/openapi.yaml for the contract. Every route requires a server administrator
// (users.is_admin, human session).
package admin

import (
	"context"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pr0h0/finance-platform/apps/api/internal/app"
	"github.com/pr0h0/finance-platform/apps/api/internal/audit"
	"github.com/pr0h0/finance-platform/apps/api/internal/auth"
	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/changes"
	"github.com/pr0h0/finance-platform/apps/api/internal/database"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/users"
)

var policies = map[string]bool{"open": true, "invite_only": true, "closed": true, "first_user": true}

type settingsOut struct {
	RegistrationPolicy string   `json:"registrationPolicy"`
	MCPEnabled         bool     `json:"mcpEnabled"`
	FXProviders        []string `json:"fxProviders"`
	BackupSchedule     string   `json:"backupSchedule"`
}

// Register mounts this module's routes on the /api/v1 router.
func Register(r chi.Router, deps *app.Deps) {
	db := deps.DB
	r.Route("/admin", func(a chi.Router) {
		a.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if _, err := authz.RequireAdmin(r.Context()); err != nil {
					httpx.WriteError(w, r, err)
					return
				}
				next.ServeHTTP(w, r)
			})
		})

		current := func(ctx context.Context) (settingsOut, error) {
			pol, err := auth.EffectivePolicy(ctx, db, deps.Config)
			return settingsOut{RegistrationPolicy: pol, MCPEnabled: deps.Config.MCPEnabled, FXProviders: deps.Config.FXProviders,
				BackupSchedule: deps.Config.BackupSchedule}, err
		}

		a.Get("/settings", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
			s, err := current(r.Context())
			if err != nil {
				return err
			}
			httpx.WriteJSON(w, http.StatusOK, s)
			return nil
		}))

		// Only the registration policy is changeable at runtime; the others come from the environment
		// (restart to change) and are rejected when they differ.
		a.Put("/settings", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
			var in struct {
				RegistrationPolicy *string   `json:"registrationPolicy"`
				MCPEnabled         *bool     `json:"mcpEnabled"`
				FXProviders        *[]string `json:"fxProviders"`
				BackupSchedule     *string   `json:"backupSchedule"`
			}
			if err := httpx.DecodeJSON(r, &in); err != nil {
				return err
			}
			f := map[string]string{}
			if in.RegistrationPolicy != nil && !policies[*in.RegistrationPolicy] {
				f["registrationPolicy"] = "open, invite_only, closed or first_user"
			}
			envOnly := "set via environment variable; restart the server to change"
			if in.MCPEnabled != nil && *in.MCPEnabled != deps.Config.MCPEnabled {
				f["mcpEnabled"] = envOnly
			}
			if in.FXProviders != nil && strings.Join(*in.FXProviders, ",") != strings.Join(deps.Config.FXProviders, ",") {
				f["fxProviders"] = envOnly
			}
			if in.BackupSchedule != nil && *in.BackupSchedule != deps.Config.BackupSchedule {
				f["backupSchedule"] = envOnly
			}
			if len(f) > 0 {
				return httpx.Validation(f)
			}
			before, err := current(r.Context())
			if err != nil {
				return err
			}
			if in.RegistrationPolicy != nil {
				if _, err := db.Exec(r.Context(), `INSERT INTO settings (scope, owner_id, key, value) VALUES ('server', NULL, 'registration_policy', to_jsonb($1::text))
					ON CONFLICT (scope, owner_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, *in.RegistrationPolicy); err != nil {
					return err
				}
			}
			after, err := current(r.Context())
			if err != nil {
				return err
			}
			if err := changes.Audit(r.Context(), db, changes.Entry{Action: "admin.settings_update", EntityType: "settings", Before: before, After: after}); err != nil {
				return err
			}
			httpx.WriteJSON(w, http.StatusOK, after)
			return nil
		}))

		a.Get("/users", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
			page, err := httpx.ParsePage(r, 50, 500)
			if err != nil {
				return err
			}
			var cur struct {
				At time.Time `json:"t"`
				ID uuid.UUID `json:"i"`
			}
			if page.Cursor != "" {
				if err := httpx.DecodeCursor(page.Cursor, &cur); err != nil {
					return err
				}
			}
			var after *time.Time
			if !cur.At.IsZero() {
				after = &cur.At
			}
			rows, err := db.Query(r.Context(), `SELECT `+users.Columns+` FROM users WHERE deleted_at IS NULL
				AND ($1::timestamptz IS NULL OR (created_at, id) > ($1, $2)) ORDER BY created_at, id LIMIT $3`, after, cur.ID, page.Limit+1)
			if err != nil {
				return err
			}
			items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (users.User, error) { return users.Scan(row) })
			if err != nil {
				return err
			}
			out := httpx.List[users.User]{Items: items}
			if len(items) > page.Limit {
				out.Items = items[:page.Limit]
				last := out.Items[page.Limit-1]
				out.NextCursor = httpx.EncodeCursor(struct {
					At time.Time `json:"t"`
					ID uuid.UUID `json:"i"`
				}{last.CreatedAt, last.ID})
			}
			if out.Items == nil {
				out.Items = []users.User{}
			}
			httpx.WriteJSON(w, http.StatusOK, out)
			return nil
		}))

		// Create a user regardless of the registration policy (the invite_only path).
		a.Post("/users", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
			var in struct {
				Email       string `json:"email"`
				Password    string `json:"password"`
				DisplayName string `json:"displayName"`
			}
			if err := httpx.DecodeJSON(r, &in); err != nil {
				return err
			}
			if err := auth.ValidateRegistration(&in.Email, in.Password, &in.DisplayName); err != nil {
				return err
			}
			ctx := r.Context()
			tx, err := db.Begin(ctx)
			if err != nil {
				return err
			}
			defer tx.Rollback(ctx)
			u, err := auth.CreateUser(ctx, tx, in.Email, in.Password, in.DisplayName, false)
			if err != nil {
				return err
			}
			if err := changes.Audit(ctx, tx, changes.Entry{Action: "admin.user_create", EntityType: "users", EntityID: &u.ID}); err != nil {
				return err
			}
			if err := tx.Commit(ctx); err != nil {
				return err
			}
			httpx.WriteJSON(w, http.StatusCreated, u)
			return nil
		}))

		a.Patch("/users/{id}", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
			p, _ := authz.FromContext(r.Context())
			id, err := uuid.Parse(chi.URLParam(r, "id"))
			if err != nil {
				return httpx.NotFound("user")
			}
			var in struct {
				Status  *string `json:"status"`
				IsAdmin *bool   `json:"isAdmin"`
			}
			if err := httpx.DecodeJSON(r, &in); err != nil {
				return err
			}
			if in.Status != nil && *in.Status != "active" && *in.Status != "disabled" {
				return httpx.Validation(map[string]string{"status": "active or disabled"})
			}
			if id == p.UserID && ((in.Status != nil && *in.Status != "active") || (in.IsAdmin != nil && !*in.IsAdmin)) {
				return httpx.NewError(http.StatusConflict, "self_lockout", "you cannot disable or demote yourself")
			}
			ctx := r.Context()
			tx, err := db.Begin(ctx)
			if err != nil {
				return err
			}
			defer tx.Rollback(ctx)
			before, err := users.Get(ctx, tx, id)
			if err != nil {
				return err
			}
			u, err := users.Scan(tx.QueryRow(ctx, `UPDATE users SET status = COALESCE($2, status), is_admin = COALESCE($3, is_admin)
				WHERE id = $1 RETURNING `+users.Columns, id, in.Status, in.IsAdmin))
			if err != nil {
				return err
			}
			if u.Status == "disabled" {
				if _, err := tx.Exec(ctx, `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, id); err != nil {
					return err
				}
			}
			if err := changes.Audit(ctx, tx, changes.Entry{Action: "admin.user_update", EntityType: "users", EntityID: &id,
				Before: map[string]any{"status": before.Status, "isAdmin": before.IsAdmin}, After: map[string]any{"status": u.Status, "isAdmin": u.IsAdmin}}); err != nil {
				return err
			}
			if err := tx.Commit(ctx); err != nil {
				return err
			}
			httpx.WriteJSON(w, http.StatusOK, u)
			return nil
		}))

		a.Get("/stats", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
			s, err := stats(r.Context(), db)
			if err != nil {
				return err
			}
			httpx.WriteJSON(w, http.StatusOK, s)
			return nil
		}))

		a.Get("/diagnostics", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
			httpx.WriteJSON(w, http.StatusOK, diagnostics(r.Context(), deps))
			return nil
		}))

		a.Get("/audit", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
			f, err := audit.ParseFilter(r)
			if err != nil {
				return err
			}
			page, err := httpx.ParsePage(r, 50, 500)
			if err != nil {
				return err
			}
			out, err := audit.Query(r.Context(), db, f, page)
			if err != nil {
				return err
			}
			httpx.WriteJSON(w, http.StatusOK, out)
			return nil
		}))
	})
}

type statsOut struct {
	Users            int64  `json:"users"`
	Profiles         int64  `json:"profiles"`
	Transactions     int64  `json:"transactions"`
	DatabaseBytes    int64  `json:"databaseBytes"`
	AttachmentsBytes int64  `json:"attachmentsBytes"`
	BackupsBytes     int64  `json:"backupsBytes"`
	SchemaVersion    int64  `json:"schemaVersion"`
	Version          string `json:"version"`
}

func stats(ctx context.Context, db *pgxpool.Pool) (statsOut, error) {
	var s statsOut
	s.Version = app.APIVersion
	err := db.QueryRow(ctx, `SELECT (SELECT count(*) FROM users WHERE deleted_at IS NULL),
		(SELECT count(*) FROM profiles WHERE deleted_at IS NULL),
		(SELECT count(*) FROM transactions WHERE deleted_at IS NULL),
		pg_database_size(current_database()),
		(SELECT COALESCE(sum(size_bytes), 0) FROM encrypted_backups)`).Scan(&s.Users, &s.Profiles, &s.Transactions, &s.DatabaseBytes, &s.BackupsBytes)
	if err != nil {
		return s, err
	}
	// attachments.size_bytes is owned by the attachments module; tolerate its absence.
	if err := db.QueryRow(ctx, `SELECT COALESCE(sum(size_bytes), 0) FROM attachments WHERE deleted_at IS NULL`).Scan(&s.AttachmentsBytes); err != nil {
		s.AttachmentsBytes = 0
	}
	s.SchemaVersion, err = database.SchemaVersion(ctx, db)
	return s, err
}

type check struct {
	Name   string `json:"name"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail,omitempty"`
}

// diagnostics reports configuration and runtime checks an operator needs (Feature 120).
func diagnostics(ctx context.Context, deps *app.Deps) map[string]any {
	cfg := deps.Config
	var checks []check
	add := func(name string, ok bool, detail string) { checks = append(checks, check{name, ok, detail}) }

	err := deps.DB.Ping(ctx)
	add("database", err == nil, errString(err))
	sv, err := database.SchemaVersion(ctx, deps.DB)
	add("migrations", err == nil, "schema version "+strconv.FormatInt(sv, 10))
	add("public_url_https", strings.HasPrefix(cfg.PublicURL, "https://"), cfg.PublicURL)
	add("secure_cookies", cfg.CookieSecure, "cookies are Secure when PUBLIC_URL is https")
	add("backup_encryption", cfg.BackupKey != "", "BACKUP_ENCRYPTION_KEY configured")
	_, schedErr := time.ParseDuration(cfg.BackupSchedule)
	add("backup_schedule", schedErr == nil && cfg.JobsEnabled, "BACKUP_SCHEDULE="+cfg.BackupSchedule)
	add("backup_dir_writable", writable(cfg.BackupDir), cfg.BackupDir)
	add("attachments_dir_writable", cfg.StorageBackend != "local" || writable(cfg.AttachmentsDir), cfg.AttachmentsDir)
	var last *time.Time
	_ = deps.DB.QueryRow(ctx, `SELECT max(created_at) FROM encrypted_backups WHERE kind = 'scheduled' AND status = 'complete'`).Scan(&last)
	var openConflicts, activeSessions int64
	_ = deps.DB.QueryRow(ctx, `SELECT (SELECT count(*) FROM sync_conflicts WHERE status = 'open'),
		(SELECT count(*) FROM sessions WHERE revoked_at IS NULL AND expires_at > now())`).Scan(&openConflicts, &activeSessions)
	pol, _ := auth.EffectivePolicy(ctx, deps.DB, cfg)
	return map[string]any{
		"checks": checks, "apiVersion": app.APIVersion, "syncProtocolVersion": app.SyncProtocolVersion, "schemaVersion": sv,
		"environment": cfg.Env, "registrationPolicy": pol, "mcpEnabled": cfg.MCPEnabled, "jobsEnabled": cfg.JobsEnabled,
		"lastScheduledBackupAt": last, "openSyncConflicts": openConflicts, "activeSessions": activeSessions,
		"serverTime": time.Now().UTC(),
	}
}

func writable(dir string) bool {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return false
	}
	f, err := os.CreateTemp(dir, ".probe-*")
	if err != nil {
		return false
	}
	f.Close()
	return os.Remove(f.Name()) == nil
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
