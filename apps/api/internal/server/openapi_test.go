package server_test

import (
	"bufio"
	"io"
	"log/slog"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/pr0h0/finance-platform/apps/api/internal/app"
	"github.com/pr0h0/finance-platform/apps/api/internal/config"
	"github.com/pr0h0/finance-platform/apps/api/internal/server"
)

var (
	specPath   = regexp.MustCompile(`^  (/[^\s:]*):\s*$`)
	specMethod = regexp.MustCompile(`^    (get|put|post|patch|delete|head|options):\s*$`)
	pathParam  = regexp.MustCompile(`\{[^}]*\}`)
)

// norm makes "/a/{id}" and "/a/{transactionId}" compare equal and drops a trailing slash.
func norm(method, path string) string {
	p := pathParam.ReplaceAllString(path, "{}")
	if len(p) > 1 {
		p = strings.TrimSuffix(p, "/")
	}
	return strings.ToUpper(method) + " " + p
}

// specOperations reads "  /path:" / "    method:" lines of the hand-maintained spec (stdlib only;
// the file keeps the two-space indentation openapi tools emit).
func specOperations(t *testing.T) map[string]bool {
	f, err := os.Open("../../../../docs/api/openapi.yaml")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	ops := map[string]bool{}
	inPaths, cur := false, ""
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, " ") && line != "" {
			inPaths = line == "paths:"
			continue
		}
		if !inPaths {
			continue
		}
		if m := specPath.FindStringSubmatch(line); m != nil {
			cur = m[1]
		} else if m := specMethod.FindStringSubmatch(line); m != nil && cur != "" {
			ops[norm(m[1], cur)] = true
		}
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	return ops
}

// Every route the server mounts must be documented in docs/api/openapi.yaml and vice versa.
func TestOpenAPICoversEveryRoute(t *testing.T) {
	h := server.New(&app.Deps{Config: &config.Config{}, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	spec := specOperations(t)
	routes := map[string]bool{}
	methods := map[string]int{} // path -> registered methods
	err := chi.Walk(h.(chi.Routes), func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if method == http.MethodOptions {
			return nil // CORS preflights are not API operations
		}
		routes[norm(method, route)] = true
		methods[norm("", route)]++
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	var missing, stale []string
	for r := range routes {
		// r.Handle registers every method (the /mcp transport): only the documented ones count.
		if methods[" "+strings.SplitN(r, " ", 2)[1]] >= 9 {
			continue
		}
		if !spec[r] {
			missing = append(missing, r)
		}
	}
	for s := range spec {
		if !routes[s] {
			stale = append(stale, s)
		}
	}
	sort.Strings(missing)
	sort.Strings(stale)
	for _, r := range missing {
		t.Errorf("route not in openapi.yaml: %s", r)
	}
	for _, s := range stale {
		t.Errorf("openapi.yaml documents a route the server does not mount: %s", s)
	}
}
