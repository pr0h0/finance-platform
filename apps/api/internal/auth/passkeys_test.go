package auth_test

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"testing"

	"github.com/go-webauthn/webauthn/protocol/webauthncbor"

	"github.com/pr0h0/finance-platform/apps/api/internal/config"
)

const rpOrigin = "https://fin.example.test"

var b64 = base64.RawURLEncoding

// softAuthenticator is a minimal ES256 platform authenticator (attestation "none", resident key).
type softAuthenticator struct {
	key        *ecdsa.PrivateKey
	credID     []byte
	userHandle []byte
	count      uint32
	origin     string
}

func newAuthenticator(t *testing.T) *softAuthenticator {
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	id := make([]byte, 32)
	_, _ = rand.Read(id)
	return &softAuthenticator{key: k, credID: id, origin: rpOrigin}
}

func (a *softAuthenticator) authData(rpID string, attested bool) []byte {
	h := sha256.Sum256([]byte(rpID))
	flags := byte(0x01 | 0x04 | 0x08 | 0x10) // UP, UV, BE, BS
	if attested {
		flags |= 0x40
	}
	a.count++
	out := append(h[:], flags)
	out = binary.BigEndian.AppendUint32(out, a.count)
	if attested {
		out = append(out, make([]byte, 16)...) // AAGUID
		out = binary.BigEndian.AppendUint16(out, uint16(len(a.credID)))
		out = append(out, a.credID...)
		x, y := a.key.X.FillBytes(make([]byte, 32)), a.key.Y.FillBytes(make([]byte, 32))
		cose, _ := webauthncbor.Marshal(map[int]any{1: 2, 3: -7, -1: 1, -2: x, -3: y})
		out = append(out, cose...)
	}
	return out
}

func clientData(typ, challenge, origin string) []byte {
	b, _ := json.Marshal(map[string]any{"type": typ, "challenge": challenge, "origin": origin, "crossOrigin": false})
	return b
}

type ceremony struct {
	ID      string `json:"ceremonyId"`
	Options struct {
		Challenge string `json:"challenge"`
		RPID      string `json:"rpId"`
		RP        struct {
			ID string `json:"id"`
		} `json:"rp"`
		User struct {
			ID string `json:"id"`
		} `json:"user"`
		AuthenticatorSelection struct {
			ResidentKey      string `json:"residentKey"`
			UserVerification string `json:"userVerification"`
		} `json:"authenticatorSelection"`
		UserVerification string `json:"userVerification"`
	} `json:"options"`
}

func parseCeremony(t *testing.T, r resp) ceremony {
	t.Helper()
	var c ceremony
	if err := json.Unmarshal(r.Raw, &c); err != nil || c.ID == "" || c.Options.Challenge == "" {
		t.Fatalf("bad ceremony %s", r.Raw)
	}
	return c
}

func (a *softAuthenticator) attest(c ceremony) map[string]any {
	a.userHandle, _ = b64.DecodeString(c.Options.User.ID)
	att, _ := webauthncbor.Marshal(map[string]any{"fmt": "none", "attStmt": map[string]any{}, "authData": a.authData(c.Options.RP.ID, true)})
	return map[string]any{"id": b64.EncodeToString(a.credID), "rawId": b64.EncodeToString(a.credID), "type": "public-key",
		"authenticatorAttachment": "platform", "clientExtensionResults": map[string]any{},
		"response": map[string]any{"clientDataJSON": b64.EncodeToString(clientData("webauthn.create", c.Options.Challenge, a.origin)),
			"attestationObject": b64.EncodeToString(att), "transports": []string{"internal", "hybrid"}}}
}

func (a *softAuthenticator) assert(t *testing.T, c ceremony, userHandle []byte) map[string]any {
	ad := a.authData(c.Options.RPID, false)
	cd := clientData("webauthn.get", c.Options.Challenge, a.origin)
	h := sha256.Sum256(cd)
	digest := sha256.Sum256(append(append([]byte{}, ad...), h[:]...))
	sig, err := ecdsa.SignASN1(rand.Reader, a.key, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	return map[string]any{"id": b64.EncodeToString(a.credID), "rawId": b64.EncodeToString(a.credID), "type": "public-key",
		"authenticatorAttachment": "platform", "clientExtensionResults": map[string]any{},
		"response": map[string]any{"clientDataJSON": b64.EncodeToString(cd), "authenticatorData": b64.EncodeToString(ad),
			"signature": b64.EncodeToString(sig), "userHandle": b64.EncodeToString(userHandle)}}
}

func passkeyEnv(t *testing.T) *env {
	return newEnv(t, func(c *config.Config) {
		c.WebAuthnRPID = "fin.example.test"
		c.WebAuthnOrigins = []string{rpOrigin}
	})
}

// addPasskey registers a new soft authenticator for c and returns it.
func (c *client) addPasskey(name string) *softAuthenticator {
	c.e.t.Helper()
	a := newAuthenticator(c.e.t)
	cer := parseCeremony(c.e.t, c.must(200, "POST", "/api/v1/auth/passkeys/register/begin", map[string]any{}))
	c.must(201, "POST", "/api/v1/auth/passkeys/register/finish", map[string]any{"ceremonyId": cer.ID, "name": name, "credential": a.attest(cer)})
	return a
}

func (e *env) passkeyLogin(a *softAuthenticator, email string, want int) (*client, resp) {
	e.t.Helper()
	c := e.anon()
	cer := parseCeremony(e.t, c.must(200, "POST", "/api/v1/auth/passkeys/login/begin", map[string]any{"email": email}))
	r := c.do("POST", "/api/v1/auth/passkeys/login/finish", map[string]any{"ceremonyId": cer.ID, "credential": a.assert(e.t, cer, a.userHandle)})
	if r.Status != want {
		e.t.Fatalf("passkey login: want %d got %d %s", want, r.Status, r.Raw)
	}
	c.csrf = r.str("csrfToken")
	return c, r
}

func TestPasskeyRegisterLoginManage(t *testing.T) {
	e := passkeyEnv(t)
	u := e.signup("pk@example.test")
	cer := parseCeremony(t, u.must(200, "POST", "/api/v1/auth/passkeys/register/begin", nil))
	if cer.Options.RP.ID != "fin.example.test" || cer.Options.AuthenticatorSelection.ResidentKey != "required" ||
		cer.Options.AuthenticatorSelection.UserVerification != "preferred" {
		t.Fatalf("registration options: %+v", cer.Options)
	}
	a := newAuthenticator(t)
	k := u.must(201, "POST", "/api/v1/auth/passkeys/register/finish", map[string]any{"ceremonyId": cer.ID, "name": " Laptop ", "credential": a.attest(cer)})
	if k.str("name") != "Laptop" || k.Body["backupEligible"] != true || k.Body["lastUsedAt"] != nil {
		t.Fatalf("created %s", k.Raw)
	}
	// the registration ceremony is single use
	u.must(400, "POST", "/api/v1/auth/passkeys/register/finish", map[string]any{"ceremonyId": cer.ID, "name": "again", "credential": a.attest(cer)})

	// usernameless login: same cookie session + CSRF as password login
	c, r := e.passkeyLogin(a, "", 200)
	if c.cookie == "" || c.csrf == "" || r.Body["user"].(map[string]any)["email"] != "pk@example.test" {
		t.Fatalf("login %s", r.Raw)
	}
	if s := c.must(200, "GET", "/api/v1/auth/session", nil); s.str("csrfToken") != c.csrf {
		t.Fatal("csrf mismatch")
	}
	// email-first works too
	e.passkeyLogin(a, "PK@example.test", 200)
	var n int
	_ = e.pool.QueryRow(context.Background(), `SELECT count(*) FROM audit_log WHERE action = 'auth.login' AND metadata->>'method' = 'passkey'`).Scan(&n)
	if n != 2 {
		t.Fatalf("audited passkey logins: %d", n)
	}

	items := c.must(200, "GET", "/api/v1/auth/passkeys", nil).items()
	if len(items) != 1 || items[0].(map[string]any)["lastUsedAt"] == nil {
		t.Fatalf("list %v", items)
	}
	id := items[0].(map[string]any)["id"].(string)
	if c.must(200, "PATCH", "/api/v1/auth/passkeys/"+id, map[string]any{"name": "Phone"}).str("name") != "Phone" {
		t.Fatal("rename")
	}
	c.must(422, "PATCH", "/api/v1/auth/passkeys/"+id, map[string]any{"name": " "})
	// another user cannot see, rename or delete it
	other := e.signup("other@example.test")
	if len(other.must(200, "GET", "/api/v1/auth/passkeys", nil).items()) != 0 {
		t.Fatal("foreign passkey listed")
	}
	other.must(404, "PATCH", "/api/v1/auth/passkeys/"+id, map[string]any{"name": "x"})
	other.must(404, "DELETE", "/api/v1/auth/passkeys/"+id, nil)
	// the password still counts as a credential, so the only passkey can go
	c.must(204, "DELETE", "/api/v1/auth/passkeys/"+id, nil)
	e.passkeyLogin(a, "", 401)
	// management needs a session
	e.anon().must(401, "GET", "/api/v1/auth/passkeys", nil)
}

func TestPasskeyLoginChallengeReuseAndOrigin(t *testing.T) {
	e := passkeyEnv(t)
	u := e.signup("reuse@example.test")
	a := u.addPasskey("Key")
	c := e.anon()
	cer := parseCeremony(t, c.must(200, "POST", "/api/v1/auth/passkeys/login/begin", nil))
	body := map[string]any{"ceremonyId": cer.ID, "credential": a.assert(t, cer, a.userHandle)}
	c.must(200, "POST", "/api/v1/auth/passkeys/login/finish", body)
	if r := e.anon().must(400, "POST", "/api/v1/auth/passkeys/login/finish", body); r.errCode() != "passkey_ceremony_invalid" {
		t.Fatalf("replay: %s", r.Raw)
	}
	// a fresh ceremony with a stale challenge (answering the old one) fails verification
	cer2 := parseCeremony(t, e.anon().must(200, "POST", "/api/v1/auth/passkeys/login/begin", nil))
	e.anon().must(401, "POST", "/api/v1/auth/passkeys/login/finish", map[string]any{"ceremonyId": cer2.ID, "credential": a.assert(t, cer, a.userHandle)})

	// wrong origin: login and registration
	a.origin = "https://evil.example"
	e.passkeyLogin(a, "", 401)
	evil := newAuthenticator(t)
	evil.origin = "https://evil.example"
	reg := parseCeremony(t, u.must(200, "POST", "/api/v1/auth/passkeys/register/begin", nil))
	u.must(400, "POST", "/api/v1/auth/passkeys/register/finish", map[string]any{"ceremonyId": reg.ID, "name": "x", "credential": evil.attest(reg)})
	a.origin = rpOrigin

	// a registration ceremony belongs to the session that began it
	reg = parseCeremony(t, u.must(200, "POST", "/api/v1/auth/passkeys/register/begin", nil))
	u2 := e.login("reuse@example.test", pw)
	u2.must(400, "POST", "/api/v1/auth/passkeys/register/finish", map[string]any{"ceremonyId": reg.ID, "name": "x", "credential": newAuthenticator(t).attest(reg)})

	// sign count going backwards (cloned key) is refused
	a.count = 0
	e.passkeyLogin(a, "", 401)
	var reason string
	_ = e.pool.QueryRow(context.Background(), `SELECT metadata->>'reason' FROM audit_log WHERE action = 'auth.login_failed' ORDER BY id DESC LIMIT 1`).Scan(&reason)
	if reason != "clone_warning" {
		t.Fatalf("last failure reason %q", reason)
	}
}

func TestPasskeyCrossUser(t *testing.T) {
	e := passkeyEnv(t)
	alice := e.signup("alice@example.test")
	bob := e.signup("bob@example.test")
	ka := alice.addPasskey("A")
	kb := bob.addPasskey("B")
	// Alice's key presented with Bob's user handle
	c := e.anon()
	cer := parseCeremony(t, c.must(200, "POST", "/api/v1/auth/passkeys/login/begin", nil))
	c.must(401, "POST", "/api/v1/auth/passkeys/login/finish", map[string]any{"ceremonyId": cer.ID, "credential": ka.assert(t, cer, kb.userHandle)})
	// email-first for Bob, answered with Alice's passkey
	e.passkeyLogin(ka, "bob@example.test", 401)
	// unknown email: same response shape as a known one, and nobody can finish it
	e.passkeyLogin(ka, "nobody@example.test", 401)
	// the same authenticator credential cannot be registered by a second account
	cer = parseCeremony(t, bob.must(200, "POST", "/api/v1/auth/passkeys/register/begin", nil))
	bob.must(409, "POST", "/api/v1/auth/passkeys/register/finish", map[string]any{"ceremonyId": cer.ID, "name": "dup", "credential": ka.attest(cer)})
}

func TestPasskeyReauthAndLastCredential(t *testing.T) {
	e := passkeyEnv(t)
	u := e.signup("last@example.test")
	ctx := context.Background()
	// an old session must re-enter the password to add a passkey
	if _, err := e.pool.Exec(ctx, `UPDATE sessions SET created_at = now() - interval '1 hour'`); err != nil {
		t.Fatal(err)
	}
	if r := u.must(401, "POST", "/api/v1/auth/passkeys/register/begin", nil); r.errCode() != "reauth_required" {
		t.Fatalf("%s", r.Raw)
	}
	u.must(401, "POST", "/api/v1/auth/passkeys/register/begin", map[string]any{"password": "wrong password!!"})
	u.must(200, "POST", "/api/v1/auth/passkeys/register/begin", map[string]any{"password": pw})
	if _, err := e.pool.Exec(ctx, `UPDATE sessions SET created_at = now()`); err != nil {
		t.Fatal(err)
	}
	u.addPasskey("One")
	// passkey-only account (no password): the last passkey cannot be removed
	if _, err := e.pool.Exec(ctx, `UPDATE users SET password_hash = NULL`); err != nil {
		t.Fatal(err)
	}
	id := u.must(200, "GET", "/api/v1/auth/passkeys", nil).items()[0].(map[string]any)["id"].(string)
	if r := u.must(409, "DELETE", "/api/v1/auth/passkeys/"+id, nil); r.errCode() != "last_credential" {
		t.Fatalf("%s", r.Raw)
	}
	u.addPasskey("Two")
	u.must(204, "DELETE", "/api/v1/auth/passkeys/"+id, nil)
	if n := len(u.must(200, "GET", "/api/v1/auth/passkeys", nil).items()); n != 1 {
		t.Fatalf("left %d", n)
	}
}
