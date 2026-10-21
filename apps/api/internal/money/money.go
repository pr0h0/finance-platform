package money

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"sort"

	"github.com/jackc/pgx/v5/pgtype"
)

// Money is an exact amount in minor units of an ISO 4217 currency. The zero value is invalid;
// construct with Parse, FromMinor or FromNumeric. Wire format (JSON):
// {"amount":"150.00","currency":"BAM"} — amount always has exactly the currency's scale.
type Money struct {
	units    *big.Int
	currency string
}

var ErrCurrencyMismatch = errors.New("money: currency mismatch")

func scaleOf(currency string) (int, error) {
	s, ok := Scale(currency)
	if !ok {
		return 0, fmt.Errorf("money: unknown currency %q", currency)
	}
	return s, nil
}

// Parse validates a decimal string for the currency. Extra fraction digits are rejected unless zero.
func Parse(amount, currency string) (Money, error) {
	scale, err := scaleOf(currency)
	if err != nil {
		return Money{}, err
	}
	u, s, err := parseDecimal(amount)
	if err != nil {
		return Money{}, err
	}
	r, err := rescale(u, s, scale)
	if err != nil {
		return Money{}, fmt.Errorf("money: %q has more than %d fraction digits for %s", amount, scale, currency)
	}
	return Money{units: r, currency: currency}, nil
}

// MustParse is for tests and constants.
func MustParse(amount, currency string) Money {
	m, err := Parse(amount, currency)
	if err != nil {
		panic(err)
	}
	return m
}

// FromMinor builds Money from integer minor units.
func FromMinor(units *big.Int, currency string) (Money, error) {
	if _, err := scaleOf(currency); err != nil {
		return Money{}, err
	}
	return Money{units: new(big.Int).Set(units), currency: currency}, nil
}

// FromNumeric converts a scanned PostgreSQL NUMERIC (amount column) into Money.
func FromNumeric(n pgtype.Numeric, currency string) (Money, error) {
	if !n.Valid || n.NaN || n.InfinityModifier != pgtype.Finite {
		return Money{}, errors.New("money: invalid numeric")
	}
	scale, err := scaleOf(currency)
	if err != nil {
		return Money{}, err
	}
	// value = Int * 10^Exp
	var u *big.Int
	if n.Exp >= 0 {
		u = new(big.Int).Mul(n.Int, pow10(int(n.Exp)))
		u.Mul(u, pow10(scale))
	} else if u, err = rescale(n.Int, int(-n.Exp), scale); err != nil {
		return Money{}, fmt.Errorf("money: stored amount exceeds %s scale", currency)
	}
	return Money{units: u, currency: currency}, nil
}

// Numeric returns the amount as a pgtype.Numeric for writes (or pass m.Amount() as text).
func (m Money) Numeric() pgtype.Numeric {
	s, _ := Scale(m.currency)
	return pgtype.Numeric{Int: new(big.Int).Set(m.units), Exp: int32(-s), Valid: true}
}

func (m Money) Currency() string { return m.currency }
func (m Money) Minor() *big.Int  { return new(big.Int).Set(m.units) }
func (m Money) Sign() int        { return m.units.Sign() }
func (m Money) IsZero() bool     { return m.units.Sign() == 0 }

// Amount is the canonical decimal string ("150.00").
func (m Money) Amount() string {
	s, _ := Scale(m.currency)
	return formatDecimal(m.units, s)
}

func (m Money) String() string { return m.Amount() + " " + m.currency }

func (m Money) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		Amount   string `json:"amount"`
		Currency string `json:"currency"`
	}{m.Amount(), m.currency})
}

func (m *Money) UnmarshalJSON(b []byte) error {
	var w struct {
		Amount   string `json:"amount"`
		Currency string `json:"currency"`
	}
	if err := json.Unmarshal(b, &w); err != nil {
		return err
	}
	p, err := Parse(w.Amount, w.Currency)
	if err != nil {
		return err
	}
	*m = p
	return nil
}

func (m Money) same(o Money) error {
	if m.currency != o.currency {
		return fmt.Errorf("%w: %s vs %s", ErrCurrencyMismatch, m.currency, o.currency)
	}
	return nil
}

func (m Money) Add(o Money) (Money, error) {
	if err := m.same(o); err != nil {
		return Money{}, err
	}
	return Money{new(big.Int).Add(m.units, o.units), m.currency}, nil
}

func (m Money) Sub(o Money) (Money, error) {
	if err := m.same(o); err != nil {
		return Money{}, err
	}
	return Money{new(big.Int).Sub(m.units, o.units), m.currency}, nil
}

func (m Money) Neg() Money { return Money{new(big.Int).Neg(m.units), m.currency} }
func (m Money) Abs() Money { return Money{new(big.Int).Abs(m.units), m.currency} }

func (m Money) Cmp(o Money) (int, error) {
	if err := m.same(o); err != nil {
		return 0, err
	}
	return m.units.Cmp(o.units), nil
}

// Zero returns 0 in the currency.
func Zero(currency string) (Money, error) { return FromMinor(new(big.Int), currency) }

// Sum adds same-currency amounts.
func Sum(currency string, items ...Money) (Money, error) {
	t := new(big.Int)
	for _, x := range items {
		if x.currency != currency {
			return Money{}, fmt.Errorf("%w: %s vs %s", ErrCurrencyMismatch, x.currency, currency)
		}
		t.Add(t, x.units)
	}
	return FromMinor(t, currency)
}

// Multiply returns amount * factor rounded once to the currency scale.
func (m Money) Multiply(factor string, mode RoundingMode) (Money, error) {
	return mulInto(m, m.currency, factor, mode)
}

// Convert: rate = units of `to` per 1 unit of m's currency. Rounded once to `to` scale.
func (m Money) Convert(to, rate string, mode RoundingMode) (Money, error) {
	return mulInto(m, to, rate, mode)
}

func mulInto(m Money, to, factor string, mode RoundingMode) (Money, error) {
	fu, fs, err := parseDecimal(factor)
	if err != nil {
		return Money{}, err
	}
	ms, _ := Scale(m.currency)
	ts, err := scaleOf(to)
	if err != nil {
		return Money{}, err
	}
	// result(at ts) = units*10^-ms * fu*10^-fs * 10^ts
	num := new(big.Int).Mul(m.units, fu)
	exp := ms + fs - ts
	if exp < 0 {
		return Money{num.Mul(num, pow10(-exp)), to}, nil
	}
	return Money{DivRound(num, pow10(exp), mode), to}, nil
}

// ConvertInverse: rate quoted as units of m's currency per 1 `to` (amount / rate).
func (m Money) ConvertInverse(to, rate string, mode RoundingMode) (Money, error) {
	ru, rs, err := parseDecimal(rate)
	if err != nil {
		return Money{}, err
	}
	if ru.Sign() == 0 {
		return Money{}, errors.New("money: rate must be non-zero")
	}
	ms, _ := Scale(m.currency)
	ts, err := scaleOf(to)
	if err != nil {
		return Money{}, err
	}
	num := new(big.Int).Mul(m.units, pow10(rs+ts))
	den := new(big.Int).Mul(ru, pow10(ms))
	return Money{DivRound(num, den, mode), to}, nil
}

// Allocate splits m by non-negative decimal weights using the largest-remainder method.
// Parts sum exactly to m; ties go to the lower index; negatives are allocated by magnitude.
func (m Money) Allocate(weights []string) ([]Money, error) {
	if len(weights) == 0 {
		return nil, errors.New("money: allocate needs weights")
	}
	ws := make([]*big.Int, len(weights))
	scales := make([]int, len(weights))
	maxS := 0
	for i, w := range weights {
		u, s, err := parseDecimal(w)
		if err != nil {
			return nil, err
		}
		if u.Sign() < 0 {
			return nil, errors.New("money: negative weight")
		}
		ws[i], scales[i] = u, s
		maxS = max(maxS, s)
	}
	total := new(big.Int)
	for i := range ws {
		ws[i], _ = rescale(ws[i], scales[i], maxS)
		total.Add(total, ws[i])
	}
	if total.Sign() == 0 {
		return nil, errors.New("money: weights sum to zero")
	}
	abs := new(big.Int).Abs(m.units)
	parts := make([]*big.Int, len(ws))
	type rem struct {
		i int
		r *big.Int
	}
	rems := make([]rem, len(ws))
	left := new(big.Int).Set(abs)
	for i, w := range ws {
		q, r := new(big.Int).QuoRem(new(big.Int).Mul(abs, w), total, new(big.Int))
		parts[i] = q
		rems[i] = rem{i, r}
		left.Sub(left, q)
	}
	sort.SliceStable(rems, func(a, b int) bool { return rems[a].r.Cmp(rems[b].r) > 0 })
	for k := 0; left.Sign() > 0; k++ {
		parts[rems[k%len(rems)].i].Add(parts[rems[k%len(rems)].i], big.NewInt(1))
		left.Sub(left, big.NewInt(1))
	}
	out := make([]Money, len(parts))
	for i, p := range parts {
		if m.units.Sign() < 0 {
			p.Neg(p)
		}
		out[i] = Money{p, m.currency}
	}
	return out, nil
}
