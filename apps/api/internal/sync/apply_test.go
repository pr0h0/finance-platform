package sync

import (
	"fmt"
	"testing"
)

func TestMergePlan(t *testing.T) {
	base := map[string]any{"name": "A", "note": "", "splits": []any{"60", "40"}, "version": float64(1)}
	current := map[string]any{"name": "A", "note": "server", "splits": []any{"60", "40"}, "version": float64(2)}
	for _, c := range []struct {
		client map[string]any
		fields []string
		merged string
		bad    string
	}{
		// disjoint metadata: merged on top of the server state
		{map[string]any{"name": "B", "note": "", "splits": []any{"60", "40"}}, nil, "B/server", ""},
		{map[string]any{"name": "B", "note": "ignored", "splits": []any{"60", "40"}}, []string{"name"}, "B/server", ""},
		// same field on both sides
		{map[string]any{"name": "A", "note": "client", "splits": []any{"60", "40"}}, nil, "", "[note]"},
		// money-bearing field on a stale base, even if the server did not touch it
		{map[string]any{"name": "A", "note": "", "splits": []any{"70", "30"}}, nil, "", "[splits]"},
	} {
		m, bad := mergePlan(base, current, c.client, c.fields, []string{"splits"})
		if got := fmt.Sprint(bad); c.bad != "" && got != c.bad {
			t.Errorf("bad fields: want %s got %s", c.bad, got)
		}
		if c.merged != "" && (bad != nil || fmt.Sprintf("%v/%v", m["name"], m["note"]) != c.merged || m["version"] != float64(2)) {
			t.Errorf("merge: want %s got %v (%v)", c.merged, m, bad)
		}
	}
	if k := changedKeys(map[string]any{"a": 1.0, "version": 1.0, "updatedAt": "x"}, map[string]any{"a": 1.0, "b": 2.0, "version": 2.0}); fmt.Sprint(k) != "[b]" {
		t.Errorf("changedKeys ignores volatile fields: %v", k)
	}
}

func TestParseEnvelope(t *testing.T) {
	ok := `{"v":1,"alg":"xchacha20poly1305-ietf","keyId":"k1","nonce":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","ct":"AAAAAAAAAAAAAAAAAAAAAA=="}`
	if _, err := parseEnvelope([]byte(ok)); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{`{"description":"Rent"}`, `{"v":2,"alg":"xchacha20poly1305-ietf","keyId":"k","nonce":"AAAA","ct":"AAAA"}`,
		`{"v":1,"alg":"xchacha20poly1305-ietf","keyId":"k1","nonce":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","ct":"AAAAAAAAAAAAAAAAAAAAAA==","plain":"x"}`} {
		if _, err := parseEnvelope([]byte(bad)); err == nil {
			t.Errorf("accepted %s", bad)
		}
	}
}
