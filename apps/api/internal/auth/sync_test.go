package auth_test

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	stdsync "sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/chacha20poly1305"
	"golang.org/x/crypto/nacl/box"

	"github.com/pr0h0/finance-platform/apps/api/internal/changes"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/money"
	"github.com/pr0h0/finance-platform/apps/api/internal/sync"
)

// itemEntity is a test-only syncable entity with a money total and splits that must sum to it,
// registered exactly the way real modules register (sync.RegisterEntity).
type item struct {
	ID      uuid.UUID     `json:"id"`
	Name    string        `json:"name"`
	Note    string        `json:"note"`
	Total   money.Money   `json:"total"`
	Splits  []money.Money `json:"splits"`
	Version int           `json:"version"`
}

func setupItems(t *testing.T, e *env) {
	t.Helper()
	if _, err := e.pool.Exec(context.Background(), `CREATE TABLE sync_test_items (
		id uuid PRIMARY KEY, profile_id uuid NOT NULL REFERENCES profiles(id), name text NOT NULL, note text NOT NULL DEFAULT '',
		total jsonb NOT NULL, splits jsonb NOT NULL, version int NOT NULL DEFAULT 1, server_version bigint NOT NULL DEFAULT 0,
		deleted_at timestamptz)`); err != nil {
		t.Fatal(err)
	}
	load := func(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID) (any, bool, error) {
		var it item
		var deleted *time.Time
		err := tx.QueryRow(ctx, `SELECT id, name, note, total, splits, version, deleted_at FROM sync_test_items WHERE id = $1 AND profile_id = $2`,
			id, profileID).Scan(&it.ID, &it.Name, &it.Note, &it.Total, &it.Splits, &it.Version, &deleted)
		return it, deleted != nil, err
	}
	sync.RegisterEntity("sync_test_items", sync.Entity{
		Load: load,
		Upsert: func(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID, data json.RawMessage, create bool, opID *uuid.UUID) error {
			var in item
			if err := json.Unmarshal(data, &in); err != nil {
				return httpx.Validation(map[string]string{"body": err.Error()})
			}
			if strings.TrimSpace(in.Name) == "" {
				return httpx.Validation(map[string]string{"name": "required"})
			}
			if !money.SplitsBalance(in.Total.Abs(), in.Splits) {
				return httpx.Unprocessable("splits must sum to the total")
			}
			var err error
			if create {
				_, err = tx.Exec(ctx, `INSERT INTO sync_test_items (id, profile_id, name, note, total, splits) VALUES ($1,$2,$3,$4,$5,$6)`,
					id, profileID, in.Name, in.Note, in.Total, in.Splits)
			} else {
				_, err = tx.Exec(ctx, `UPDATE sync_test_items SET name=$3, note=$4, total=$5, splits=$6, version=version+1, deleted_at=NULL
					WHERE id=$1 AND profile_id=$2`, id, profileID, in.Name, in.Note, in.Total, in.Splits)
			}
			if err != nil {
				return err
			}
			snap, _, err := load(ctx, tx, profileID, id)
			if err != nil {
				return err
			}
			_, err = changes.Record(ctx, tx, changes.Change{ProfileID: profileID, EntityType: "sync_test_items", EntityID: id,
				Op: changes.OpUpsert, Data: snap, OpID: opID, Action: "item.upsert"})
			return err
		},
		Delete: func(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID, opID *uuid.UUID) error {
			if _, err := tx.Exec(ctx, `UPDATE sync_test_items SET deleted_at = now(), version = version + 1 WHERE id=$1 AND profile_id=$2`, id, profileID); err != nil {
				return err
			}
			_, err := changes.Record(ctx, tx, changes.Change{ProfileID: profileID, EntityType: "sync_test_items", EntityID: id,
				Op: changes.OpDelete, OpID: opID, Action: "item.delete"})
			return err
		},
		MoneyFields: []string{"total", "splits"},
	})
}

func itemData(id uuid.UUID, name, note, total string, splits ...string) map[string]any {
	ss := []any{}
	for _, s := range splits {
		ss = append(ss, map[string]any{"amount": s, "currency": "BAM"})
	}
	return map[string]any{"id": id, "name": name, "note": note, "total": map[string]any{"amount": total, "currency": "BAM"}, "splits": ss}
}

func op(entity uuid.UUID, base any, data map[string]any, fields ...string) map[string]any {
	o := map[string]any{"opId": uuid.Must(uuid.NewV7()), "entityType": "sync_test_items", "entityId": entity, "op": "upsert",
		"baseVersion": base, "data": data, "clientTime": time.Now().UTC().Format(time.RFC3339)}
	if data == nil {
		o["op"] = "delete"
	}
	if len(fields) > 0 {
		o["changedFields"] = fields
	}
	return o
}

func push(c *client, profile, device string, ops ...map[string]any) resp {
	c.e.t.Helper()
	return c.must(200, "POST", "/api/v1/sync/push", map[string]any{"protocolVersion": 1, "deviceId": device, "profileId": profile, "operations": ops},
		"X-Profile-ID", profile)
}

func result(r resp, i int) map[string]any { return r.Body["results"].([]any)[i].(map[string]any) }

func dbItem(t *testing.T, e *env, id uuid.UUID) item {
	t.Helper()
	var it item
	if err := e.pool.QueryRow(context.Background(), `SELECT id, name, note, total, splits, version FROM sync_test_items WHERE id = $1`, id).
		Scan(&it.ID, &it.Name, &it.Note, &it.Total, &it.Splits, &it.Version); err != nil {
		t.Fatal(err)
	}
	return it
}

func assertBalanced(t *testing.T, it item) {
	t.Helper()
	if !money.SplitsBalance(it.Total.Abs(), it.Splits) {
		t.Fatalf("split total invariant broken: %v vs %v", it.Total, it.Splits)
	}
}

// PLAN §46 case 20: concurrent sync updates do not corrupt financial totals.
func TestSyncConcurrentEditsMergeOrConflict(t *testing.T) {
	e := newEnv(t, nil)
	setupItems(t, e)
	a := e.signup("a@example.com")
	pid := a.firstProfile()
	phone, phoneID := e.device("a@example.com", "Phone")
	laptop, laptopID := e.device("a@example.com", "Laptop")
	id := uuid.Must(uuid.NewV7())

	r := push(phone, pid, phoneID, op(id, nil, itemData(id, "Groceries", "", "100.00", "60.00", "40.00")))
	if result(r, 0)["status"] != "applied" || result(r, 0)["version"] != float64(1) {
		t.Fatalf("create: %s", r.Raw)
	}
	// both devices edit from version 1: phone changes the note, laptop the name → disjoint metadata, merged
	push(phone, pid, phoneID, op(id, 1, itemData(id, "Groceries", "weekly shop", "100.00", "60.00", "40.00"), "note"))
	r = push(laptop, pid, laptopID, op(id, 1, itemData(id, "Food", "", "100.00", "60.00", "40.00"), "name"))
	if result(r, 0)["status"] != "applied" {
		t.Fatalf("disjoint metadata edit not merged: %s", r.Raw)
	}
	it := dbItem(t, e, id)
	if it.Name != "Food" || it.Note != "weekly shop" || it.Version != 3 {
		t.Fatalf("merge lost a field: %+v", it)
	}
	// laptop re-splits from stale version 1 → money-bearing → conflict, nothing applied
	r = push(laptop, pid, laptopID, op(id, 1, itemData(id, "Food", "", "100.00", "70.00", "30.00"), "splits"))
	res := result(r, 0)
	if res["status"] != "conflict" || res["conflictId"] == nil || fmt.Sprint(res["fields"]) != "[splits]" {
		t.Fatalf("money edit on stale base not a conflict: %s", r.Raw)
	}
	it = dbItem(t, e, id)
	if it.Splits[0].Amount() != "60.00" || it.Version != 3 {
		t.Fatalf("conflicting money edit was applied: %+v", it)
	}
	// overlapping metadata edit → conflict too (never last-write-wins)
	r = push(phone, pid, phoneID, op(id, 2, itemData(id, "Supermarket", "weekly shop", "100.00", "60.00", "40.00"), "name"))
	if result(r, 0)["status"] != "conflict" {
		t.Fatalf("overlapping edit not a conflict: %s", r.Raw)
	}
	// a current-base edit that breaks the split total is rejected by the entity's validation
	r = push(phone, pid, phoneID, op(id, 3, itemData(id, "Food", "", "100.00", "70.00", "40.00")))
	if result(r, 0)["status"] != "rejected" || result(r, 0)["code"] != "invariant_violation" {
		t.Fatalf("unbalanced splits accepted: %s", r.Raw)
	}

	conflicts := a.must(200, "GET", "/api/v1/sync/conflicts", nil, "X-Profile-ID", pid).items()
	if len(conflicts) != 2 {
		t.Fatalf("open conflicts: %d", len(conflicts))
	}
	splitConflict := conflicts[0].(map[string]any)
	cid := splitConflict["id"].(string)
	if splitConflict["serverData"].(map[string]any)["name"] != "Food" || splitConflict["clientData"].(map[string]any)["splits"] == nil {
		t.Fatalf("conflict does not preserve both sides: %v", splitConflict)
	}
	// a merged resolution that breaks the total is refused and the conflict stays open
	bad := a.do("POST", "/api/v1/sync/conflicts/"+cid+"/resolve", map[string]any{"choice": "merged",
		"data": itemData(id, "Food", "weekly shop", "100.00", "70.00", "40.00")}, "X-Profile-ID", pid)
	if bad.Status != 422 {
		t.Fatalf("invalid merged resolution: %d %s", bad.Status, bad.Raw)
	}
	a.must(200, "POST", "/api/v1/sync/conflicts/"+cid+"/resolve", map[string]any{"choice": "client"}, "X-Profile-ID", pid)
	it = dbItem(t, e, id)
	if it.Splits[0].Amount() != "70.00" || it.Version != 4 {
		t.Fatalf("client resolution not applied: %+v", it)
	}
	assertBalanced(t, it)
	if r := a.do("POST", "/api/v1/sync/conflicts/"+cid+"/resolve", map[string]any{"choice": "server"}, "X-Profile-ID", pid); r.Status != 409 {
		t.Fatalf("resolved twice: %d", r.Status)
	}
	other := conflicts[1].(map[string]any)["id"].(string)
	a.must(200, "POST", "/api/v1/sync/conflicts/"+other+"/resolve", map[string]any{"choice": "server"}, "X-Profile-ID", pid)
	if n := len(a.must(200, "GET", "/api/v1/sync/conflicts", nil, "X-Profile-ID", pid).items()); n != 0 {
		t.Fatalf("conflicts left: %d", n)
	}

	// many devices racing on the same entity: every accepted state is balanced, versions are unique
	var wg stdsync.WaitGroup
	for i := range 8 {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			c, dev := phone, phoneID
			if i%2 == 1 {
				c, dev = laptop, laptopID
			}
			a, b := fmt.Sprintf("%d.00", 50+i), fmt.Sprintf("%d.00", 50-i)
			c.do("POST", "/api/v1/sync/push", map[string]any{"protocolVersion": 1, "deviceId": dev, "profileId": pid,
				"operations": []any{op(id, 4, itemData(id, "Food", fmt.Sprint(i), "100.00", a, b))}})
		}(i)
	}
	wg.Wait()
	it = dbItem(t, e, id)
	assertBalanced(t, it)
	if it.Version != 5 {
		t.Fatalf("exactly one racing edit on base 4 may win, version=%d", it.Version)
	}
	var dupes int
	_ = e.pool.QueryRow(context.Background(), `SELECT count(*) - count(DISTINCT server_version) FROM sync_changes WHERE profile_id = $1`, pid).Scan(&dupes)
	if dupes != 0 {
		t.Fatal("duplicate server versions")
	}
	var open int
	_ = e.pool.QueryRow(context.Background(), `SELECT count(*) FROM sync_conflicts WHERE status = 'open'`).Scan(&open)
	if open != 7 {
		t.Fatalf("losing racers must become conflicts, got %d", open)
	}

	// delete vs. stale money edit → conflict; plain delete → tombstone
	r = push(phone, pid, phoneID, op(id, 4, nil))
	if result(r, 0)["status"] != "conflict" {
		t.Fatalf("delete over concurrent money edit: %s", r.Raw)
	}
	r = push(phone, pid, phoneID, op(id, 5, nil))
	if result(r, 0)["status"] != "applied" {
		t.Fatalf("delete: %s", r.Raw)
	}
	if r := push(phone, pid, phoneID, op(id, 6, nil)); result(r, 0)["status"] != "applied" {
		t.Fatal("deleting a tombstone must be idempotent")
	}
}

// PLAN §46 case 21: interrupted sync operations recover (idempotent retries, resumable pull, checkpoints).
func TestSyncInterruptedRecovery(t *testing.T) {
	e := newEnv(t, nil)
	setupItems(t, e)
	a := e.signup("a@example.com")
	pid := a.firstProfile()
	phone, phoneID := e.device("a@example.com", "Phone")
	tablet, tabletID := e.device("a@example.com", "Tablet")

	var ops []map[string]any
	for i := range 30 {
		id := uuid.Must(uuid.NewV7())
		ops = append(ops, op(id, nil, itemData(id, fmt.Sprintf("item %d", i), "", "10.00", "10.00")))
	}
	ops[7] = op(uuid.New(), nil, map[string]any{"name": ""}) // invalid: rejected without stopping the batch
	ops[8]["entityType"] = "no_such_table"
	first := push(phone, pid, phoneID, ops...)
	head := first.Body["serverVersion"].(float64)
	if head != 28 || result(first, 7)["status"] != "rejected" || result(first, 8)["code"] != "unsupported_entity" || result(first, 29)["status"] != "applied" {
		t.Fatalf("batch: head=%v %s", head, first.Raw)
	}
	// the response was "lost": the client retries the whole batch → same results, nothing duplicated
	again := push(phone, pid, phoneID, ops...)
	if fmt.Sprint(again.Body["results"]) != fmt.Sprint(first.Body["results"]) || again.Body["serverVersion"] != head {
		t.Fatalf("retry not idempotent:\n%s\n%s", first.Raw, again.Raw)
	}
	var n int
	_ = e.pool.QueryRow(context.Background(), `SELECT count(*) FROM sync_test_items`).Scan(&n)
	if n != 28 {
		t.Fatalf("duplicated rows: %d", n)
	}
	// a partially-applied push (interrupted mid-batch) resumes: replaying all ops applies only the rest
	tail := []map[string]any{}
	for i := range 5 {
		id := uuid.Must(uuid.NewV7())
		tail = append(tail, op(id, nil, itemData(id, fmt.Sprintf("tail %d", i), "", "1.00", "1.00")))
	}
	push(phone, pid, phoneID, tail[:2]...)
	r := push(phone, pid, phoneID, tail...)
	if r.Body["serverVersion"] != float64(33) {
		t.Fatalf("resume: %s", r.Raw)
	}

	// another device pulls in small pages, "crashes" after page 2 and resumes from its checkpoint
	pull := func(since float64) resp {
		return tablet.must(200, "GET", fmt.Sprintf("/api/v1/sync/pull?since=%d&limit=10&deviceId=%s", int(since), tabletID), nil, "X-Profile-ID", pid)
	}
	p1 := pull(0)
	p2 := pull(p1.Body["nextSince"].(float64))
	if !p2.Body["hasMore"].(bool) {
		t.Fatal("expected more pages")
	}
	var checkpoint int64
	_ = e.pool.QueryRow(context.Background(), `SELECT last_pulled_version FROM sync_checkpoints WHERE device_id = $1 AND profile_id = $2`,
		tabletID, pid).Scan(&checkpoint)
	if checkpoint != 10 {
		t.Fatalf("checkpoint %d", checkpoint)
	}
	seen := map[float64]bool{}
	for _, c := range append(p1.Body["changes"].([]any), p2.Body["changes"].([]any)...) {
		seen[c.(map[string]any)["serverVersion"].(float64)] = true
	}
	// resume from the last applied page (re-pulling page 2 is harmless: snapshots are idempotent)
	since := p1.Body["nextSince"].(float64)
	for {
		p := pull(since)
		for _, c := range p.Body["changes"].([]any) {
			m := c.(map[string]any)
			seen[m["serverVersion"].(float64)] = true
			if m["deviceId"] != phoneID || m["opId"] == nil || m["data"] == nil {
				t.Fatalf("change lacks origin: %v", m)
			}
		}
		since = p.Body["nextSince"].(float64)
		if !p.Body["hasMore"].(bool) {
			break
		}
	}
	if len(seen) != 33 || since != 33 {
		t.Fatalf("pulled %d changes, since=%v", len(seen), since)
	}
	st := a.must(200, "GET", "/api/v1/sync/status", nil, "X-Profile-ID", pid)
	if st.Body["serverVersion"] != float64(33) || len(st.Body["devices"].([]any)) != 2 {
		t.Fatalf("status: %s", st.Raw)
	}

	// initial download via snapshot pages: current state only (deleted rows excluded)
	victim := ops[0]["entityId"].(uuid.UUID)
	push(phone, pid, phoneID, op(victim, 1, nil))
	total := 0
	cursor := ""
	for {
		s := tablet.must(200, "GET", "/api/v1/sync/snapshot?limit=7&cursor="+cursor, nil, "X-Profile-ID", pid)
		for _, c := range s.Body["changes"].([]any) {
			if c.(map[string]any)["entityId"] == victim.String() {
				t.Fatal("tombstoned entity in snapshot")
			}
			total++
		}
		if !s.Body["hasMore"].(bool) {
			if s.Body["serverVersion"] != float64(34) {
				t.Fatalf("snapshot head: %s", s.Raw)
			}
			break
		}
		cursor = s.str("nextCursor")
	}
	if total != 32 {
		t.Fatalf("snapshot entities: %d", total)
	}

	// protocol and device checks
	if r := phone.do("POST", "/api/v1/sync/push", map[string]any{"protocolVersion": 2, "deviceId": phoneID, "profileId": pid, "operations": []any{}}); r.Status != 409 || r.errCode() != "protocol_version_mismatch" {
		t.Fatalf("protocol mismatch: %d %s", r.Status, r.Raw)
	}
	b := e.signup("b@example.com")
	bDev, bDevID := e.device("b@example.com", "B phone")
	if r := bDev.do("POST", "/api/v1/sync/push", map[string]any{"protocolVersion": 1, "deviceId": bDevID, "profileId": pid, "operations": []any{}}); r.Status != 403 {
		t.Fatalf("push into foreign profile: %d", r.Status)
	}
	if r := phone.do("POST", "/api/v1/sync/push", map[string]any{"protocolVersion": 1, "deviceId": bDevID, "profileId": pid, "operations": []any{}}); r.Status != 403 {
		t.Fatalf("push with someone else's device: %d", r.Status)
	}
	// an opId reused by another profile is not replayed across profiles
	bp := b.firstProfile()
	r = bDev.must(200, "POST", "/api/v1/sync/push", map[string]any{"protocolVersion": 1, "deviceId": bDevID, "profileId": bp,
		"operations": []any{ops[1]}}, "X-Profile-ID", bp)
	if result(r, 0)["code"] != "op_id_conflict" {
		t.Fatalf("cross-profile opId: %s", r.Raw)
	}
	_ = http.StatusOK
}

// PLAN §46 case 23 (server part): an e2ee profile stores only ciphertext envelopes; a second
// device unwraps the profile key from its key envelope and decrypts what the first device pushed.
func TestSyncE2EEAcrossDevices(t *testing.T) {
	e := newEnv(t, nil)
	a := e.signup("a@example.com")
	pid := a.must(201, "POST", "/api/v1/profiles", map[string]any{"name": "Private", "privacyMode": "e2ee"}).str("id")

	// device keys (X25519); public keys registered at enrollment
	pub1, _, _ := box.GenerateKey(rand.Reader)
	pub2, priv2, _ := box.GenerateKey(rand.Reader)
	reg := func(name string, pub *[32]byte) (*client, string) {
		c := e.anon()
		r := c.must(200, "POST", "/api/v1/auth/login", map[string]any{"email": "a@example.com", "password": pw,
			"device": map[string]any{"name": name, "platform": "linux", "publicKey": base64.StdEncoding.EncodeToString(pub[:])}})
		c.bearer = r.str("token")
		return c, r.str("deviceId")
	}
	d1, d1ID := reg("Desktop", pub1)
	d2, d2ID := reg("Laptop", pub2)

	// device 1 creates the profile data key and seals it to device 2 (crypto_box_seal compatible)
	pdk := make([]byte, 32)
	_, _ = rand.Read(pdk)
	sealed, err := box.SealAnonymous(nil, pdk, pub2, rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	d1.must(201, "POST", "/api/v1/sync/keys", map[string]any{"keyId": "k1", "kind": "device", "deviceId": d2ID,
		"wrappedKey": base64.StdEncoding.EncodeToString(sealed)}, "X-Profile-ID", pid)

	entityID := uuid.Must(uuid.NewV7())
	plaintext := `{"description":"Rent","amount":{"amount":"750.00","currency":"BAM"}}`
	aad := []byte(pid + "|transactions|" + entityID.String() + "|k1|1")
	aead, _ := chacha20poly1305.NewX(pdk)
	nonce := make([]byte, chacha20poly1305.NonceSizeX)
	_, _ = rand.Read(nonce)
	env := map[string]any{"v": 1, "alg": "xchacha20poly1305-ietf", "keyId": "k1",
		"nonce": base64.StdEncoding.EncodeToString(nonce), "ct": base64.StdEncoding.EncodeToString(aead.Seal(nil, nonce, []byte(plaintext), aad))}
	encOp := func(base any, data any) map[string]any {
		o := map[string]any{"opId": uuid.Must(uuid.NewV7()), "entityType": "transactions", "entityId": entityID, "op": "upsert",
			"baseVersion": base, "data": data, "clientTime": time.Now().UTC().Format(time.RFC3339)}
		if data == nil {
			o["op"] = "delete"
		}
		return o
	}
	r := push(d1, pid, d1ID, encOp(nil, env))
	if result(r, 0)["status"] != "applied" {
		t.Fatalf("encrypted push: %s", r.Raw)
	}
	// plaintext is refused for an e2ee profile
	r = push(d1, pid, d1ID, encOp(nil, map[string]any{"description": "Rent"}))
	if result(r, 0)["code"] != "invalid_envelope" {
		t.Fatalf("plaintext accepted on e2ee profile: %s", r.Raw)
	}
	// the server holds no plaintext anywhere
	var leaked int
	_ = e.pool.QueryRow(context.Background(), `SELECT (SELECT count(*) FROM sync_changes WHERE data::text LIKE '%Rent%')
		+ (SELECT count(*) FROM audit_log WHERE coalesce(after::text,'') LIKE '%Rent%' OR coalesce(after::text,'') LIKE '%"ct"%')
		+ (SELECT count(*) FROM encrypted_records WHERE envelope::text LIKE '%Rent%')`).Scan(&leaked)
	if leaked != 0 {
		t.Fatal("plaintext or ciphertext copied into logs")
	}

	// device 2: fetch its envelope, unwrap, pull, decrypt
	keys := d2.must(200, "GET", "/api/v1/sync/keys", nil, "X-Profile-ID", pid).items()
	if len(keys) != 1 {
		t.Fatalf("keys: %v", keys)
	}
	wrapped, _ := base64.StdEncoding.DecodeString(keys[0].(map[string]any)["wrappedKey"].(string))
	gotKey, ok := box.OpenAnonymous(nil, wrapped, pub2, priv2)
	if !ok {
		t.Fatal("device 2 cannot unwrap the profile key")
	}
	pulled := d2.must(200, "GET", "/api/v1/sync/pull?since=0&deviceId="+d2ID, nil, "X-Profile-ID", pid).Body["changes"].([]any)
	data := pulled[0].(map[string]any)["data"].(map[string]any)
	n, _ := base64.StdEncoding.DecodeString(data["nonce"].(string))
	ct, _ := base64.StdEncoding.DecodeString(data["ct"].(string))
	aead2, _ := chacha20poly1305.NewX(gotKey)
	plain, err := aead2.Open(nil, n, ct, aad)
	if err != nil || string(plain) != plaintext || data["version"] != float64(1) {
		t.Fatalf("decrypt on device 2: %v %q", err, plain)
	}
	// swapping the ciphertext onto another id fails authentication (AAD binds the row)
	if _, err := aead2.Open(nil, n, ct, []byte(pid+"|transactions|"+uuid.NewString()+"|k1|1")); err == nil {
		t.Fatal("AAD not binding")
	}

	// stale-base encrypted update → conflict (server cannot merge ciphertext)
	push(d1, pid, d1ID, encOp(1, env))
	if r := push(d2, pid, d2ID, encOp(1, env)); result(r, 0)["status"] != "conflict" {
		t.Fatalf("stale encrypted update: %s", r.Raw)
	}
	// revoking device 2 revokes its key envelope
	a.must(204, "DELETE", "/api/v1/devices/"+d2ID, nil)
	if keys := a.must(200, "GET", "/api/v1/sync/keys", nil, "X-Profile-ID", pid).items(); len(keys) != 0 {
		t.Fatal("revoked device's envelope still served")
	}
	if r := push(d1, pid, d1ID, encOp(2, nil)); result(r, 0)["status"] != "applied" {
		t.Fatalf("encrypted delete: %s", r.Raw)
	}
}
