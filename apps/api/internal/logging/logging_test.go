package logging

import (
	"bytes"
	"strings"
	"testing"
)

func TestRedaction(t *testing.T) {
	var buf bytes.Buffer
	l := New(&buf, "info", "json")
	l.Info("x", "password", "hunter2", "Authorization", "Bearer abc", "session_token", "t", "user_id", "u1")
	out := buf.String()
	for _, s := range []string{"hunter2", "Bearer abc", `"t"`} {
		if strings.Contains(out, s) {
			t.Fatalf("leaked %q: %s", s, out)
		}
	}
	if !strings.Contains(out, "u1") {
		t.Fatalf("over-redacted: %s", out)
	}
}
