package attachments

import "testing"

func TestSafeFileName(t *testing.T) {
	for in, want := range map[string]string{
		"../../etc/passwd":      "passwd",
		`..\..\windows\win.ini`: "win.ini",
		"receipt\x00\n.pdf":     "receipt.pdf",
		"..":                    "attachment",
		"":                      "attachment",
		`a"b.png`:               "ab.png",
		"račun-ćevapi.jpg":      "račun-ćevapi.jpg",
	} {
		if got := SafeFileName(in); got != want {
			t.Errorf("SafeFileName(%q) = %q, want %q", in, got, want)
		}
	}
	if !keyRE.MatchString("0b0b0b0b-0000-4000-8000-000000000000/1c1c1c1c-0000-4000-8000-000000000000") || keyRE.MatchString("../x/../y") {
		t.Fatal("storage key pattern")
	}
}
