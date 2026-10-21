// Package merchants: Merchants, aliases and description normalization.
//
// Owned routes under /api/v1: /merchants
// See docs/api/openapi.yaml for the contract.
package merchants

import (
	"context"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"unicode"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pr0h0/finance-platform/apps/api/internal/app"
	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/ledger"
)

type Merchant struct {
	ledger.Meta
	Name              string     `json:"name"`
	NormalizedName    string     `json:"normalizedName"`
	DefaultCategoryID *uuid.UUID `json:"defaultCategoryId"`
	Website           string     `json:"website"`
	Notes             string     `json:"notes"`
	Aliases           []string   `json:"aliases"`
}

var fold = strings.NewReplacer("č", "c", "ć", "c", "š", "s", "ž", "z", "đ", "dj", "ä", "a", "ö", "o", "ü", "u", "ß", "ss",
	"é", "e", "è", "e", "á", "a", "à", "a", "í", "i", "ó", "o", "ú", "u", "ñ", "n", "ç", "c", "ł", "l", "ő", "o", "ű", "u")

// Normalize canonicalizes a merchant name or bank description for matching: lower case, common Latin
// diacritics folded (č->c, đ->dj), punctuation to spaces, purely numeric tokens dropped (terminal ids,
// card numbers, dates), whitespace collapsed. "KONZUM d.d. 1234 Sarajevo" -> "konzum d d sarajevo".
func Normalize(s string) string {
	s = fold.Replace(strings.ToLower(s))
	var b strings.Builder
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
		} else {
			b.WriteByte(' ')
		}
	}
	var words []string
	for _, w := range strings.Fields(b.String()) {
		if strings.IndexFunc(w, func(r rune) bool { return !unicode.IsDigit(r) }) >= 0 {
			words = append(words, w)
		}
	}
	return strings.Join(words, " ")
}

func write(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID, in, cur *Merchant) error {
	in.Name = strings.TrimSpace(in.Name)
	in.NormalizedName = Normalize(in.Name)
	bad := map[string]string{}
	if in.Name == "" || len(in.Name) > 200 || in.NormalizedName == "" {
		bad["name"] = "required (letters), at most 200 characters"
	}
	if len(in.Website) > 500 || len(in.Notes) > 5000 {
		bad["notes"] = "too long"
	}
	if len(in.Aliases) > 50 {
		bad["aliases"] = "at most 50 aliases"
	}
	if len(bad) > 0 {
		return httpx.Validation(bad)
	}
	var aliases []string
	for _, a := range in.Aliases {
		if n := Normalize(a); n != "" && n != in.NormalizedName && len(n) <= 200 {
			aliases = append(aliases, n)
		}
	}
	slices.Sort(aliases)
	in.Aliases = slices.Compact(aliases)
	if in.Aliases == nil {
		in.Aliases = []string{}
	}
	if in.DefaultCategoryID != nil {
		if ok, err := ledger.Owned(ctx, tx, "categories", profileID, []uuid.UUID{*in.DefaultCategoryID}); err != nil || !ok {
			if err != nil {
				return err
			}
			return httpx.Validation(map[string]string{"defaultCategoryId": "unknown category"})
		}
	}
	args := []any{id, profileID, in.Name, in.NormalizedName, in.DefaultCategoryID, in.Website, in.Notes, in.Aliases}
	var err error
	if cur == nil {
		_, err = tx.Exec(ctx, `INSERT INTO merchants (id, profile_id, name, normalized_name, default_category_id, website, notes, aliases)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, args...)
	} else {
		_, err = tx.Exec(ctx, `UPDATE merchants SET name=$3, normalized_name=$4, default_category_id=$5, website=$6, notes=$7, aliases=$8,
			version = version + 1 WHERE id=$1 AND profile_id=$2`, args...)
	}
	if ledger.IsUnique(err) {
		return httpx.Conflict("a merchant with this name exists")
	}
	return err
}

// Entity is the merchant CRUD definition. GET /merchants?q= filters by name/alias substring.
var Entity = ledger.Entity[Merchant]{
	Table: "merchants", Path: "/merchants", Name: "merchant",
	Cols:    "name, normalized_name, default_category_id, website, notes, aliases",
	Order:   "normalized_name, id",
	GetMeta: func(m *Merchant) *ledger.Meta { return &m.Meta },
	Scan: func(row pgx.Row) (*Merchant, error) {
		m := &Merchant{}
		return m, row.Scan(append(m.Dest(), &m.Name, &m.NormalizedName, &m.DefaultCategoryID, &m.Website, &m.Notes, &m.Aliases)...)
	},
	Write: write,
	ListWhere: func(q url.Values) (string, []any) {
		n := Normalize(q.Get("q"))
		if n == "" {
			return "", nil
		}
		return `(normalized_name LIKE $4 OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE a LIKE $4))`,
			[]any{"%" + strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(n) + "%"}
	},
}

// Match finds the merchant whose name or alias occurs (as whole words) in a bank description;
// the longest match wins. ok=false when none matches. Used by imports/automation for suggestions.
func Match(ctx context.Context, db ledger.DB, profileID uuid.UUID, description string) (*Merchant, bool, error) {
	d := " " + Normalize(description) + " "
	if strings.TrimSpace(d) == "" {
		return nil, false, nil
	}
	rows, err := db.Query(ctx, `SELECT `+ledger.MetaCols+`, `+Entity.Cols+` FROM merchants m
		WHERE profile_id = $1 AND deleted_at IS NULL AND (
		  $2 LIKE '% ' || normalized_name || ' %' OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE $2 LIKE '% ' || a || ' %'))`,
		profileID, d)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	var best *Merchant
	bestLen := 0
	for rows.Next() {
		m, err := Entity.Scan(rows)
		if err != nil {
			return nil, false, err
		}
		for _, n := range append([]string{m.NormalizedName}, m.Aliases...) {
			if strings.Contains(d, " "+n+" ") && len(n) > bestLen {
				best, bestLen = m, len(n)
			}
		}
	}
	return best, best != nil, rows.Err()
}

// Register mounts this module's routes on the /api/v1 router.
func Register(r chi.Router, deps *app.Deps) {
	// Static path before Mount's /merchants/{id}.
	r.Get("/merchants/match", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		profileID, _, err := authz.ProfileFromRequest(r, deps.DB, authz.RoleViewer)
		if err != nil {
			return err
		}
		desc := r.URL.Query().Get("description")
		if desc == "" || len(desc) > 1000 {
			return httpx.Validation(map[string]string{"description": "required, at most 1000 characters"})
		}
		m, ok, err := Match(r.Context(), deps.DB, profileID, desc)
		if err != nil {
			return err
		}
		if !ok {
			return httpx.NotFound("matching merchant")
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"merchant": m, "normalized": Normalize(desc)})
		return nil
	}))
	Entity.Mount(r, deps.DB)
}
