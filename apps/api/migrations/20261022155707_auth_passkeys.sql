-- +goose Up
-- Passkeys (WebAuthn credentials) as a second way to sign in (internal/auth/passkeys.go).
-- The user handle given to authenticators is the user's uuid (16 bytes), never the email.
CREATE TABLE user_passkeys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id bytea NOT NULL UNIQUE,
  public_key bytea NOT NULL,                  -- COSE key
  attestation_type text NOT NULL DEFAULT '',
  attestation_format text NOT NULL DEFAULT '',
  aaguid bytea,
  sign_count bigint NOT NULL DEFAULT 0,
  transports text[] NOT NULL DEFAULT '{}',
  attachment text NOT NULL DEFAULT '',
  user_present boolean NOT NULL DEFAULT false,
  user_verified boolean NOT NULL DEFAULT false,
  backup_eligible boolean NOT NULL DEFAULT false,
  backup_state boolean NOT NULL DEFAULT false,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX ON user_passkeys (user_id);

-- One row per begun ceremony; finish deletes it (single use). Registration is bound to the session
-- that began it; login to the ceremony id handed to the browser.
CREATE TABLE webauthn_ceremonies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('register','login')),
  session_id uuid REFERENCES sessions(id) ON DELETE CASCADE,
  expected_user uuid,                         -- email-first login: only this user may finish (no FK: unknown emails get a random id)
  data jsonb NOT NULL,                        -- go-webauthn SessionData (challenge, user handle, ...)
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON webauthn_ceremonies (expires_at);

-- +goose Down
DROP TABLE webauthn_ceremonies;
DROP TABLE user_passkeys;
