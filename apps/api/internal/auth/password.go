package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

// Argon2id parameters (OWASP 2024 minimum: m=19 MiB, t=2, p=1). Stored in the PHC string, so they
// can be raised later without invalidating existing hashes.
const (
	argonMemory  = 19 * 1024
	argonTime    = 2
	argonThreads = 1
	argonKeyLen  = 32
)

const (
	MinPasswordLen = 12
	MaxPasswordLen = 1024
)

// HashPassword returns an Argon2id PHC string: $argon2id$v=19$m=..,t=..,p=..$salt$hash.
func HashPassword(pw string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(pw), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	b64 := base64.RawStdEncoding
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s", argon2.Version, argonMemory, argonTime, argonThreads,
		b64.EncodeToString(salt), b64.EncodeToString(key)), nil
}

// VerifyPassword checks pw against a PHC string in constant time.
func VerifyPassword(pw, phc string) (bool, error) {
	parts := strings.Split(phc, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false, errors.New("unsupported password hash")
	}
	var v int
	var m, t uint32
	var p uint8
	if _, err := fmt.Sscanf(parts[2], "v=%d", &v); err != nil || v != argon2.Version {
		return false, errors.New("unsupported argon2 version")
	}
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &m, &t, &p); err != nil {
		return false, errors.New("bad argon2 params")
	}
	b64 := base64.RawStdEncoding
	salt, err := b64.DecodeString(parts[4])
	if err != nil {
		return false, err
	}
	want, err := b64.DecodeString(parts[5])
	if err != nil {
		return false, err
	}
	got := argon2.IDKey([]byte(pw), salt, t, m, p, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}

// dummyHash is verified when the user does not exist, so login timing does not reveal accounts.
var dummyHash, _ = HashPassword("not-a-real-password-just-timing")

// NewToken returns a random 256-bit URL-safe token and its sha256 (what the DB stores).
func NewToken() (string, []byte) {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	tok := base64.RawURLEncoding.EncodeToString(b)
	return tok, HashToken(tok)
}

func HashToken(tok string) []byte {
	h := sha256.Sum256([]byte(tok))
	return h[:]
}

// CSRFToken is derived from the session token, so it needs no storage and cannot be computed
// without the (HttpOnly) cookie value.
func CSRFToken(sessionToken string) string {
	h := sha256.Sum256([]byte("finplat-csrf:" + sessionToken))
	return base64.RawURLEncoding.EncodeToString(h[:])
}

var recoveryEnc = base32.StdEncoding.WithPadding(base32.NoPadding)

// newRecoveryCode returns a human-typable 100-bit code like ABCDE-FGHIJ-KLMNO-PQRST.
func newRecoveryCode() string {
	b := make([]byte, 13)
	_, _ = rand.Read(b)
	s := recoveryEnc.EncodeToString(b)[:20]
	return s[0:5] + "-" + s[5:10] + "-" + s[10:15] + "-" + s[15:20]
}

// normalizeRecoveryCode makes entry forgiving (case, spaces, dashes).
func normalizeRecoveryCode(c string) string {
	c = strings.ToUpper(strings.NewReplacer("-", "", " ", "").Replace(c))
	return c
}

func hashRecoveryCode(c string) string {
	h := sha256.Sum256([]byte("finplat-recovery:" + normalizeRecoveryCode(c)))
	return base64.RawStdEncoding.EncodeToString(h[:])
}
