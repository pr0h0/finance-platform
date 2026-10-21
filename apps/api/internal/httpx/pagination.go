package httpx

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strconv"
)

// Page is cursor pagination input: ?limit=50&cursor=<opaque>.
type Page struct {
	Limit  int
	Cursor string
}

// List is the response envelope for paginated collections.
type List[T any] struct {
	Items      []T    `json:"items"`
	NextCursor string `json:"nextCursor,omitempty"`
}

// ParsePage reads limit (default def, capped at max) and cursor.
func ParsePage(r *http.Request, def, max int) (Page, error) {
	p := Page{Limit: def, Cursor: r.URL.Query().Get("cursor")}
	if s := r.URL.Query().Get("limit"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n < 1 {
			return p, BadRequest("limit must be a positive integer")
		}
		p.Limit = min(n, max)
	}
	return p, nil
}

// EncodeCursor makes an opaque cursor from a keyset value (e.g. struct{Date string; ID uuid.UUID}).
func EncodeCursor(v any) string {
	b, _ := json.Marshal(v)
	return base64.RawURLEncoding.EncodeToString(b)
}

// DecodeCursor parses a cursor produced by EncodeCursor. Empty cursor leaves v untouched.
func DecodeCursor(s string, v any) error {
	if s == "" {
		return nil
	}
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil || json.Unmarshal(b, v) != nil {
		return BadRequest("invalid cursor")
	}
	return nil
}
