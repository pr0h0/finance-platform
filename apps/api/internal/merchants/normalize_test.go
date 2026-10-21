package merchants

import "testing"

func TestNormalize(t *testing.T) {
	for in, want := range map[string]string{
		"KONZUM d.d. 1234 Sarajevo":   "konzum d d sarajevo",
		"Đurđevak ČEVABDŽINICA":       "djurdjevak cevabdzinica",
		"  POS 4111-1111 *AMAZON.DE ": "pos amazon de",
		"12/03/2026 0000":             "",
		"Mercator2go":                 "mercator2go",
	} {
		if got := Normalize(in); got != want {
			t.Errorf("Normalize(%q) = %q, want %q", in, got, want)
		}
	}
}
