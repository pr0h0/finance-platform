package money

import (
	"math/big"
	"sort"
)

// Posting is the minimal ledger line needed to reconstruct balances.
type Posting struct {
	AccountID string
	Amount    Money
}

// Balance of one account in one currency.
type Balance struct {
	AccountID string
	Amount    Money
}

// Balances reconstructs per-account, per-currency balances. Sorted by account, then currency.
func Balances(postings []Posting) []Balance {
	type key struct{ acc, cur string }
	sums := map[key]*big.Int{}
	for _, p := range postings {
		k := key{p.AccountID, p.Amount.currency}
		if sums[k] == nil {
			sums[k] = new(big.Int)
		}
		sums[k].Add(sums[k], p.Amount.units)
	}
	out := make([]Balance, 0, len(sums))
	for k, v := range sums {
		out = append(out, Balance{k.acc, Money{v, k.cur}})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].AccountID != out[j].AccountID {
			return out[i].AccountID < out[j].AccountID
		}
		return out[i].Amount.currency < out[j].Amount.currency
	})
	return out
}

// SplitsBalance: split amounts are positive magnitudes in the total's currency summing to |total|.
func SplitsBalance(total Money, splits []Money) bool {
	s := new(big.Int)
	for _, x := range splits {
		if x.currency != total.currency || x.units.Sign() <= 0 {
			return false
		}
		s.Add(s, x.units)
	}
	return s.Cmp(new(big.Int).Abs(total.units)) == 0
}
