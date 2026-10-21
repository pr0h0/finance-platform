package auth

import (
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
)

// Limiter is a fixed-window counter per key (requests per minute).
// ponytail: in-process only; with several API replicas each enforces its own window. Move to
// postgres/redis if the API is ever scaled horizontally.
type Limiter struct {
	perMin int
	mu     sync.Mutex
	win    time.Time
	counts map[string]int
	now    func() time.Time
}

func NewLimiter(perMin int) *Limiter {
	return &Limiter{perMin: perMin, counts: map[string]int{}, now: time.Now}
}

// Allow counts one hit for key and reports whether it is within the limit, plus seconds until reset.
func (l *Limiter) Allow(key string) (bool, int) {
	if l.perMin <= 0 {
		return true, 0
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	if w := now.Truncate(time.Minute); !w.Equal(l.win) {
		l.win, l.counts = w, map[string]int{}
	}
	l.counts[key]++
	return l.counts[key] <= l.perMin, int(l.win.Add(time.Minute).Sub(now).Seconds()) + 1
}

// TooMany is the 429 error.
func TooMany(w http.ResponseWriter, retryAfter int) *httpx.Error {
	w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
	return httpx.NewError(http.StatusTooManyRequests, "rate_limited", "too many requests; retry later")
}

// ClientIP is the request's remote IP ("" if unparseable); chi RealIP has already applied trusted proxy headers.
func ClientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if net.ParseIP(host) == nil {
		return ""
	}
	return host
}

// RateLimit is middleware limiting per authenticated user (or per IP when anonymous).
func RateLimit(l *Limiter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			key := "ip:" + ClientIP(r)
			if p, ok := authz.FromContext(r.Context()); ok {
				key = "user:" + p.UserID.String()
			}
			if ok, retry := l.Allow(key); !ok {
				httpx.WriteError(w, r, TooMany(w, retry))
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
