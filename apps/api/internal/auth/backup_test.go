package auth_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"mime/multipart"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/pr0h0/finance-platform/apps/api/internal/backups"
	"github.com/pr0h0/finance-platform/apps/api/internal/config"
)

func upload(c *client, raw []byte, target string) resp {
	c.e.t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", "backup.json.gz")
	fw.Write(raw)
	if target != "" {
		mw.WriteField("targetProfileId", target)
	}
	mw.Close()
	return c.do("POST", "/api/v1/backups/restore", &buf, "Content-Type", mw.FormDataContentType())
}

func TestBackupExportRestore(t *testing.T) {
	key := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))
	e := newEnv(t, func(c *config.Config) { c.BackupKey = key })
	setupItems(t, e)
	a := e.signup("a@example.com")
	pid := a.firstProfile()
	phone, phoneID := e.device("a@example.com", "Phone")
	ids := []uuid.UUID{uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())}
	push(phone, pid, phoneID, op(ids[0], nil, itemData(ids[0], "Rent", "", "750.00", "750.00")),
		op(ids[1], nil, itemData(ids[1], "Food", "x", "100.00", "60.00", "40.00")))
	a.must(200, "PUT", "/api/v1/profiles/"+pid+"/settings", map[string]any{"theme": "dark"})

	exp := a.must(200, "GET", "/api/v1/export", nil, "X-Profile-ID", pid)
	if exp.str("format") != "finplat-export" || len(exp.Body["tables"].(map[string]any)["sync_test_items"].([]any)) != 2 ||
		len(exp.Body["snapshots"].([]any)) != 2 {
		t.Fatalf("export: %s", exp.Raw)
	}

	b := a.must(201, "POST", "/api/v1/backups", map[string]any{"profileId": pid})
	if b.Body["encryption"].(map[string]any)["alg"] != "aes-256-gcm" || b.Body["sizeBytes"].(float64) <= 0 {
		t.Fatalf("backup: %s", b.Raw)
	}
	file, _ := os.ReadFile(filepath.Join(e.cfg.BackupDir, b.str("id")+".fpb"))
	if !bytes.HasPrefix(file, []byte("FPB1")) || bytes.Contains(file, []byte("Rent")) {
		t.Fatal("backup file not encrypted at rest")
	}
	dl := a.must(200, "GET", "/api/v1/backups/"+b.str("id")+"/download", nil)
	if dl.Header.Get("Content-Type") != "application/gzip" {
		t.Fatalf("download: %s", dl.Header)
	}
	parsed, err := backups.ParseExport(dl.Raw)
	if err != nil || len(parsed.Tables["sync_test_items"]) != 2 {
		t.Fatalf("downloaded backup unreadable: %v", err)
	}

	// restore as a new profile: new ids, same data, sync log rebuilt for devices
	rr := upload(a, dl.Raw, "")
	if rr.Status != 200 {
		t.Fatalf("restore: %d %s", rr.Status, rr.Raw)
	}
	np := rr.str("profileId")
	if np == pid || rr.Body["counts"].(map[string]any)["sync_test_items"] != float64(2) {
		t.Fatalf("restore result: %s", rr.Raw)
	}
	var names []string
	rows, _ := e.pool.Query(context.Background(), `SELECT name FROM sync_test_items WHERE profile_id = $1 ORDER BY name`, np)
	for rows.Next() {
		var n string
		rows.Scan(&n)
		names = append(names, n)
	}
	if len(names) != 2 || names[0] != "Food" {
		t.Fatalf("restored rows: %v", names)
	}
	var reused int
	_ = e.pool.QueryRow(context.Background(), `SELECT count(*) FROM sync_test_items WHERE profile_id = $1 AND id = ANY($2)`, np, ids).Scan(&reused)
	if reused != 0 {
		t.Fatal("restore reused original ids")
	}
	pulled := phone.must(200, "GET", "/api/v1/sync/pull?since=0", nil, "X-Profile-ID", np).Body["changes"].([]any)
	if len(pulled) != 2 {
		t.Fatalf("restored profile has no sync log: %d", len(pulled))
	}
	if d := pulled[0].(map[string]any)["data"].(map[string]any); d["id"] == ids[0].String() || d["id"] == ids[1].String() {
		t.Fatal("snapshot ids not remapped")
	}
	if s := a.must(200, "GET", "/api/v1/profiles/"+np+"/settings", nil); s.Body["theme"] != "dark" {
		t.Fatal("settings not restored")
	}
	// restoring over a profile that has data is refused; into an empty one is allowed
	if r := upload(a, dl.Raw, np); r.Status != 409 || r.errCode() != "profile_not_empty" {
		t.Fatalf("restore into non-empty: %d %s", r.Status, r.Raw)
	}
	empty := a.must(201, "POST", "/api/v1/profiles", map[string]any{"name": "Empty"}).str("id")
	if r := upload(a, dl.Raw, empty); r.Status != 200 || r.str("profileId") != empty {
		t.Fatalf("restore into empty: %d %s", r.Status, r.Raw)
	}
	if r := upload(a, []byte(`{"format":"something-else"}`), ""); r.Status != 422 {
		t.Fatalf("foreign file: %d", r.Status)
	}
	// list contains manual and pre-restore backups; delete removes the file
	list := a.must(200, "GET", "/api/v1/backups", nil).items()
	if len(list) != 2 {
		t.Fatalf("backups: %d", len(list))
	}
	a.must(204, "DELETE", "/api/v1/backups/"+b.str("id"), nil)
	if _, err := os.Stat(filepath.Join(e.cfg.BackupDir, b.str("id")+".fpb")); !os.IsNotExist(err) {
		t.Fatal("backup file not deleted")
	}

	// a server with a different key cannot read the backup; a tampered file is detected
	b2 := a.must(201, "POST", "/api/v1/backups", map[string]any{"profileId": pid}).str("id")
	path := filepath.Join(e.cfg.BackupDir, b2+".fpb")
	data, _ := os.ReadFile(path)
	data[len(data)-1] ^= 1
	os.WriteFile(path, data, 0o600)
	if r := a.do("GET", "/api/v1/backups/"+b2+"/download", nil); r.Status != 409 || r.errCode() != "backup_corrupt" {
		t.Fatalf("tampered backup: %d %s", r.Status, r.Raw)
	}
}

func TestScheduledBackups(t *testing.T) {
	e := newEnv(t, nil) // no key: stored compressed, metadata says so
	a := e.signup("a@example.com")
	e.signup("b@example.com")
	s, err := backups.NewService(e.deps)
	if err != nil {
		t.Fatal(err)
	}
	n, err := s.RunScheduled(context.Background(), 24*time.Hour, 30)
	if err != nil || n != 2 {
		t.Fatalf("scheduled run: %d %v", n, err)
	}
	if n, _ := s.RunScheduled(context.Background(), 24*time.Hour, 30); n != 0 {
		t.Fatalf("backups not due yet were repeated: %d", n)
	}
	list := a.must(200, "GET", "/api/v1/backups", nil).items()
	if len(list) != 1 || list[0].(map[string]any)["kind"] != "scheduled" || list[0].(map[string]any)["encryption"].(map[string]any)["alg"] != "none" {
		t.Fatalf("scheduled backup list: %v", list)
	}
	// retention prunes old scheduled backups (row + file)
	if _, err := e.pool.Exec(context.Background(), `UPDATE encrypted_backups SET created_at = now() - interval '40 days'`); err != nil {
		t.Fatal(err)
	}
	if n, err := s.RunScheduled(context.Background(), 24*time.Hour, 30); err != nil || n != 2 {
		t.Fatalf("second run: %d %v", n, err)
	}
	var count int
	_ = e.pool.QueryRow(context.Background(), `SELECT count(*) FROM encrypted_backups`).Scan(&count)
	files, _ := os.ReadDir(e.cfg.BackupDir)
	if count != 2 || len(files) != 2 {
		t.Fatalf("retention: rows=%d files=%d", count, len(files))
	}
}
