package auth_test

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

func TestProfilesCRUDAndValidation(t *testing.T) {
	e := newEnv(t, nil)
	a := e.signup("a@example.com")
	clientID := uuid.NewString()
	p := a.must(201, "POST", "/api/v1/profiles", map[string]any{"id": clientID, "name": "Business", "baseCurrency": "EUR",
		"timezone": "Europe/Berlin", "weekStart": 0})
	if p.str("id") != clientID || p.str("role") != "owner" || p.str("baseCurrency") != "EUR" || p.str("privacyMode") != "server_readable" {
		t.Fatalf("create: %s", p.Raw)
	}
	if r := a.do("POST", "/api/v1/profiles", map[string]any{"id": clientID, "name": "Dup"}); r.Status != 409 {
		t.Fatalf("duplicate id: %d", r.Status)
	}
	if r := a.do("POST", "/api/v1/profiles", map[string]any{"name": "", "baseCurrency": "XXX", "weekStart": 9}); r.Status != 422 {
		t.Fatalf("validation: %d", r.Status)
	}
	if len(a.must(200, "GET", "/api/v1/profiles", nil).items()) != 2 {
		t.Fatal("list")
	}
	a.must(200, "PATCH", "/api/v1/profiles/"+clientID, map[string]any{"name": "Biz", "privacyMode": "e2ee"}) // empty profile: allowed
	if _, err := e.pool.Exec(context.Background(), `UPDATE profiles SET sync_version = 5 WHERE id = $1`, clientID); err != nil {
		t.Fatal(err)
	}
	if r := a.do("PATCH", "/api/v1/profiles/"+clientID, map[string]any{"privacyMode": "server_readable"}); r.Status != 409 {
		t.Fatalf("privacy mode switch with data: %d", r.Status)
	}
	a.must(200, "PUT", "/api/v1/profiles/"+clientID+"/settings", map[string]any{"dashboard": []any{"balance", "forecast"}})
	if r := a.must(200, "GET", "/api/v1/profiles/"+clientID+"/settings", nil); r.Body["dashboard"] == nil {
		t.Fatal("profile settings")
	}
	a.must(204, "DELETE", "/api/v1/profiles/"+clientID, nil)
	if r := a.do("GET", "/api/v1/profiles/"+clientID, nil); r.Status != 403 {
		t.Fatalf("deleted profile still readable: %d", r.Status)
	}
	if len(a.must(200, "GET", "/api/v1/profiles", nil).items()) != 1 {
		t.Fatal("deleted profile listed")
	}
}

// TestObjectLevelAuthorization: every id-taking endpoint refuses another user's objects (IDOR).
func TestObjectLevelAuthorization(t *testing.T) {
	e := newEnv(t, nil)
	a := e.signup("a@example.com")
	b := e.signup("b@example.com")
	pa := a.firstProfile()
	hh := a.must(201, "POST", "/api/v1/households", map[string]any{"name": "Home"}).str("id")
	backup := a.must(201, "POST", "/api/v1/backups", map[string]any{"profileId": pa}).str("id")
	hdr := []string{"X-Profile-ID", pa}

	for _, c := range []struct {
		method, path string
		body         any
		want         int
	}{
		{"GET", "/api/v1/profiles/" + pa, nil, 403},
		{"PATCH", "/api/v1/profiles/" + pa, map[string]any{"name": "pwned"}, 403},
		{"DELETE", "/api/v1/profiles/" + pa, nil, 403},
		{"GET", "/api/v1/profiles/" + pa + "/members", nil, 403},
		{"PUT", "/api/v1/profiles/" + pa + "/members/" + b.userID, map[string]any{"role": "owner"}, 403},
		{"GET", "/api/v1/profiles/" + pa + "/settings", nil, 403},
		{"GET", "/api/v1/households/" + hh, nil, 404},
		{"PATCH", "/api/v1/households/" + hh, map[string]any{"name": "x"}, 404},
		{"POST", "/api/v1/households/" + hh + "/invitations", map[string]any{"email": "b@example.com"}, 404},
		{"GET", "/api/v1/backups/" + backup + "/download", nil, 404},
		{"DELETE", "/api/v1/backups/" + backup, nil, 404},
		{"POST", "/api/v1/backups", map[string]any{"profileId": pa}, 403},
		{"GET", "/api/v1/sync/pull?since=0", nil, 403},
		{"GET", "/api/v1/sync/status", nil, 403},
		{"GET", "/api/v1/sync/conflicts", nil, 403},
		{"GET", "/api/v1/sync/snapshot", nil, 403},
		{"GET", "/api/v1/sync/keys", nil, 403},
		{"GET", "/api/v1/audit", nil, 403},
		{"GET", "/api/v1/export", nil, 403},
		{"GET", "/api/v1/admin/users", nil, 403},
	} {
		if r := b.do(c.method, c.path, c.body, hdr...); r.Status != c.want {
			t.Errorf("%s %s by other user: want %d got %d %s", c.method, c.path, c.want, r.Status, r.Raw)
		}
	}
	// unknown profile id gives the same answer as a foreign one
	if r := b.do("GET", "/api/v1/profiles/"+uuid.NewString(), nil); r.Status != 403 {
		t.Errorf("unknown profile: %d", r.Status)
	}
	if r := b.do("GET", "/api/v1/sync/pull?since=0", nil); r.Status != 400 {
		t.Errorf("missing profile header: %d", r.Status)
	}
	// B's own resources are unaffected by A's
	if len(b.must(200, "GET", "/api/v1/backups", nil).items()) != 0 {
		t.Error("B sees A's backups")
	}
	if len(b.must(200, "GET", "/api/v1/households", nil).items()) != 0 {
		t.Error("B sees A's household")
	}
}

func TestHouseholdSharing(t *testing.T) {
	e := newEnv(t, nil)
	a := e.signup("a@example.com")
	b := e.signup("b@example.com")
	c := e.signup("c@example.com")
	pa := a.firstProfile()
	hh := a.must(201, "POST", "/api/v1/households", map[string]any{"name": "Home"}).str("id")

	// profiles can only be shared with household members
	if r := a.do("PUT", "/api/v1/profiles/"+pa+"/members/"+b.userID, map[string]any{"role": "viewer"}); r.Status != 404 {
		t.Fatalf("shared with a non-member: %d", r.Status)
	}
	a.must(200, "PATCH", "/api/v1/profiles/"+pa, map[string]any{"householdId": hh})
	inv := a.must(201, "POST", "/api/v1/households/"+hh+"/invitations", map[string]any{"email": "B@example.com", "role": "member"})
	token := inv.str("inviteToken")
	if token == "" || inv.Body["member"].(map[string]any)["status"] != "invited" {
		t.Fatalf("invite: %s", inv.Raw)
	}
	// the token is bound to the invited email
	if r := c.do("POST", "/api/v1/household-invitations/accept", map[string]any{"token": token}); r.Status != 404 {
		t.Fatalf("invite accepted by wrong account: %d", r.Status)
	}
	h := b.must(200, "POST", "/api/v1/household-invitations/accept", map[string]any{"token": token})
	if len(h.Body["members"].([]any)) != 2 {
		t.Fatalf("members after accept: %s", h.Raw)
	}
	if r := b.do("POST", "/api/v1/household-invitations/accept", map[string]any{"token": token}); r.Status != 404 {
		t.Fatal("invitation reusable")
	}
	// a member cannot invite (admin+ only) nor escalate
	if r := b.do("POST", "/api/v1/households/"+hh+"/invitations", map[string]any{"email": "c@example.com"}); r.Status != 403 {
		t.Fatalf("member invited: %d", r.Status)
	}

	a.must(200, "PUT", "/api/v1/profiles/"+pa+"/members/"+b.userID, map[string]any{"role": "viewer"})
	if r := b.must(200, "GET", "/api/v1/profiles/"+pa, nil); r.str("role") != "viewer" {
		t.Fatalf("viewer role: %s", r.Raw)
	}
	if r := b.do("PATCH", "/api/v1/profiles/"+pa, map[string]any{"name": "x"}); r.Status != 403 {
		t.Fatalf("viewer patched profile: %d", r.Status)
	}
	if r := b.do("PUT", "/api/v1/profiles/"+pa+"/settings", map[string]any{"x": 1}); r.Status != 403 {
		t.Fatalf("viewer wrote settings: %d", r.Status)
	}
	members := a.must(200, "GET", "/api/v1/profiles/"+pa+"/members", nil).items()
	if len(members) != 2 {
		t.Fatalf("profile members: %v", members)
	}
	// last owner cannot leave / be demoted
	if r := a.do("DELETE", "/api/v1/profiles/"+pa+"/members/"+a.userID, nil); r.Status != 409 {
		t.Fatalf("last owner removed: %d", r.Status)
	}
	if r := a.do("PUT", "/api/v1/profiles/"+pa+"/members/"+a.userID, map[string]any{"role": "viewer"}); r.Status != 409 {
		t.Fatalf("last owner demoted: %d", r.Status)
	}

	// removing B from the household ends access to its shared profiles
	var memberID string
	for _, m := range h.Body["members"].([]any) {
		if mm := m.(map[string]any); mm["userId"] == b.userID {
			memberID = mm["id"].(string)
		}
	}
	a.must(204, "DELETE", "/api/v1/households/"+hh+"/members/"+memberID, nil)
	if r := b.do("GET", "/api/v1/profiles/"+pa, nil); r.Status != 403 {
		t.Fatalf("access survived household removal: %d", r.Status)
	}
	// re-invite after removal works (reactivates the old membership row)
	tok2 := a.must(201, "POST", "/api/v1/households/"+hh+"/invitations", map[string]any{"email": "b@example.com", "role": "viewer"}).str("inviteToken")
	b.must(200, "POST", "/api/v1/household-invitations/accept", map[string]any{"token": tok2})
	// the owner of the household cannot be removed while being the last owner
	var ownerMember string
	for _, m := range a.must(200, "GET", "/api/v1/households/"+hh, nil).Body["members"].([]any) {
		if mm := m.(map[string]any); mm["userId"] == a.userID {
			ownerMember = mm["id"].(string)
		}
	}
	if r := a.do("DELETE", "/api/v1/households/"+hh+"/members/"+ownerMember, nil); r.Status != 409 {
		t.Fatalf("last household owner removed: %d", r.Status)
	}
	// B may leave on their own
	for _, m := range b.must(200, "GET", "/api/v1/households/"+hh, nil).Body["members"].([]any) {
		if mm := m.(map[string]any); mm["userId"] == b.userID {
			b.must(204, "DELETE", "/api/v1/households/"+hh+"/members/"+mm["id"].(string), nil)
		}
	}
	a.must(204, "DELETE", "/api/v1/households/"+hh, nil)
	if r := a.must(200, "GET", "/api/v1/profiles/"+pa, nil); r.Body["householdId"] != nil {
		t.Fatal("profile still attached to deleted household")
	}
}

func TestAuditAndAdmin(t *testing.T) {
	e := newEnv(t, nil)
	a := e.signup("admin@example.com") // first user on a fresh server becomes admin
	b := e.signup("b@example.com")
	if r := b.do("GET", "/api/v1/admin/stats", nil); r.Status != 403 {
		t.Fatalf("non-admin stats: %d", r.Status)
	}
	if r := a.must(200, "GET", "/api/v1/admin/stats", nil); r.Body["users"] != float64(2) || r.Body["profiles"] != float64(2) || r.Body["schemaVersion"] == float64(0) {
		t.Fatalf("stats: %s", r.Raw)
	}
	if d := a.must(200, "GET", "/api/v1/admin/diagnostics", nil); len(d.Body["checks"].([]any)) < 5 {
		t.Fatalf("diagnostics: %s", d.Raw)
	}
	page := a.must(200, "GET", "/api/v1/admin/users?limit=1", nil)
	if len(page.items()) != 1 || page.str("nextCursor") == "" {
		t.Fatalf("users page: %s", page.Raw)
	}
	if next := a.must(200, "GET", "/api/v1/admin/users?limit=1&cursor="+page.str("nextCursor"), nil); next.items()[0].(map[string]any)["id"] != b.userID {
		t.Fatalf("users page 2: %s", next.Raw)
	}
	if r := a.do("PATCH", "/api/v1/admin/users/"+a.userID, map[string]any{"isAdmin": false}); r.Status != 409 {
		t.Fatalf("self demotion: %d", r.Status)
	}
	a.must(200, "PATCH", "/api/v1/admin/users/"+b.userID, map[string]any{"status": "disabled"})
	if r := b.do("GET", "/api/v1/users/me", nil); r.Status != 401 {
		t.Fatalf("disabled user still logged in: %d", r.Status)
	}
	if r := e.anon().do("POST", "/api/v1/auth/login", map[string]any{"email": "b@example.com", "password": pw}); r.Status != 401 {
		t.Fatalf("disabled user can log in: %d", r.Status)
	}

	pa := a.firstProfile()
	a.must(200, "PATCH", "/api/v1/profiles/"+pa, map[string]any{"name": "Main"})
	log := a.must(200, "GET", "/api/v1/audit?action=profile.update", nil, "X-Profile-ID", pa).items()
	if len(log) != 1 || log[0].(map[string]any)["actorType"] != "user" || log[0].(map[string]any)["after"] == nil {
		t.Fatalf("audit: %v", log)
	}
	if all := a.must(200, "GET", "/api/v1/audit?limit=1", nil, "X-Profile-ID", pa); all.str("nextCursor") == "" {
		t.Fatal("audit pagination")
	}
	if r := a.do("GET", "/api/v1/audit?from=yesterday", nil, "X-Profile-ID", pa); r.Status != 422 {
		t.Fatalf("bad from: %d", r.Status)
	}
	found := false
	for _, it := range a.must(200, "GET", "/api/v1/admin/audit?action=admin.user_update", nil).items() {
		found = found || it.(map[string]any)["entityId"] == b.userID
	}
	if !found {
		t.Fatal("admin action not audited")
	}
}
