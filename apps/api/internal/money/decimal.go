// Package money implements exact decimal money arithmetic on math/big.
// The algorithms mirror packages/finance-engine and are checked by the shared conformance fixtures.
package money

import (
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"strings"
)

// RoundingMode names match the TypeScript engine.
type RoundingMode string

const (
	HalfUp   RoundingMode = "half_up"   // half away from zero (default for money)
	HalfEven RoundingMode = "half_even" // banker's rounding
	Down     RoundingMode = "down"      // toward zero
	Up       RoundingMode = "up"        // away from zero
	Floor    RoundingMode = "floor"
	Ceiling  RoundingMode = "ceiling"
)

// DefaultRounding is applied at accounting boundaries unless a policy says otherwise.
const DefaultRounding = HalfUp

var decimalRE = regexp.MustCompile(`^-?\d+(\.\d+)?$`)

// ValidMode reports whether m is a known rounding mode.
func ValidMode(m RoundingMode) bool {
	switch m {
	case HalfUp, HalfEven, Down, Up, Floor, Ceiling:
		return true
	}
	return false
}

func pow10(n int) *big.Int { return new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(n)), nil) }

// parseDecimal returns units and scale such that value = units * 10^-scale.
func parseDecimal(s string) (*big.Int, int, error) {
	if !decimalRE.MatchString(s) {
		return nil, 0, fmt.Errorf("invalid decimal string %q", s)
	}
	scale := 0
	if i := strings.IndexByte(s, '.'); i >= 0 {
		scale = len(s) - i - 1
	}
	u, _ := new(big.Int).SetString(strings.Replace(s, ".", "", 1), 10)
	return u, scale, nil
}

// rescale converts units at scale `from` to scale `to` exactly; errors if digits would be lost.
func rescale(u *big.Int, from, to int) (*big.Int, error) {
	if to >= from {
		return new(big.Int).Mul(u, pow10(to-from)), nil
	}
	q, r := new(big.Int).QuoRem(u, pow10(from-to), new(big.Int))
	if r.Sign() != 0 {
		return nil, errors.New("value has more fraction digits than allowed")
	}
	return q, nil
}

func formatDecimal(u *big.Int, scale int) string {
	neg := u.Sign() < 0
	digits := new(big.Int).Abs(u).String()
	if scale > 0 {
		if len(digits) < scale+1 {
			digits = strings.Repeat("0", scale+1-len(digits)) + digits
		}
		digits = digits[:len(digits)-scale] + "." + digits[len(digits)-scale:]
	}
	if neg {
		return "-" + digits
	}
	return digits
}

// DivRound returns num/den rounded with mode. Exact; panics on den == 0.
func DivRound(num, den *big.Int, mode RoundingMode) *big.Int {
	if den.Sign() == 0 {
		panic("money: division by zero")
	}
	n, d := new(big.Int).Set(num), new(big.Int).Set(den)
	if d.Sign() < 0 {
		n.Neg(n)
		d.Neg(d)
	}
	q, r := new(big.Int).QuoRem(n, d, new(big.Int)) // truncated toward zero
	if r.Sign() == 0 {
		return q
	}
	sign := int64(n.Sign())
	twice := new(big.Int).Mul(new(big.Int).Abs(r), big.NewInt(2))
	bump := func() *big.Int { return q.Add(q, big.NewInt(sign)) }
	switch mode {
	case Down:
		return q
	case Up:
		return bump()
	case Floor:
		if sign < 0 {
			return bump()
		}
		return q
	case Ceiling:
		if sign > 0 {
			return bump()
		}
		return q
	case HalfUp:
		if twice.Cmp(d) >= 0 {
			return bump()
		}
		return q
	case HalfEven:
		c := twice.Cmp(d)
		if c > 0 || (c == 0 && q.Bit(0) == 1) {
			return bump()
		}
		return q
	}
	panic("money: unknown rounding mode " + string(mode))
}

// RoundDecimal rounds a decimal string to `scale` fraction digits.
func RoundDecimal(value string, scale int, mode RoundingMode) (string, error) {
	u, s, err := parseDecimal(value)
	if err != nil {
		return "", err
	}
	if s <= scale {
		r, _ := rescale(u, s, scale)
		return formatDecimal(r, scale), nil
	}
	return formatDecimal(DivRound(u, pow10(s-scale), mode), scale), nil
}
