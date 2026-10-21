-- +goose Up
-- E2EE profiles (ADR 0005): the server stores opaque ciphertext envelopes per entity instead of
-- plaintext rows. version = per-entity optimistic counter; deleted_at = tombstone.
CREATE TABLE encrypted_records (
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  envelope jsonb NOT NULL,                   -- {v, alg, keyId, nonce, ct}; never decrypted server-side
  version int NOT NULL DEFAULT 1,
  server_version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  PRIMARY KEY (profile_id, entity_type, entity_id)
);
CREATE TRIGGER encrypted_records_updated_at BEFORE UPDATE ON encrypted_records FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Which client operation produced a conflict (resolution "client" replays it).
ALTER TABLE sync_conflicts ADD COLUMN op text NOT NULL DEFAULT 'upsert' CHECK (op IN ('upsert','delete'));
CREATE INDEX sync_conflicts_open ON sync_conflicts (profile_id, created_at) WHERE status = 'open';

-- Pending household invitations expire.
ALTER TABLE household_members ADD COLUMN invite_expires_at timestamptz;
CREATE UNIQUE INDEX household_members_invite_uq ON household_members (invite_token_hash) WHERE invite_token_hash IS NOT NULL;

-- +goose Down
DROP INDEX household_members_invite_uq;
ALTER TABLE household_members DROP COLUMN invite_expires_at;
DROP INDEX sync_conflicts_open;
ALTER TABLE sync_conflicts DROP COLUMN op;
DROP TABLE encrypted_records;
