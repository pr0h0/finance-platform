-- +goose Up
-- OAuth 2.1 for the remote MCP endpoint (docs/mcp/README.md). A dynamically registered public client
-- (RFC 7591) becomes an mcp_clients row (a "connection") when a user consents; grants, approvals and
-- audit are then the same as for static-token clients. Codes and tokens are stored as sha256 only.
CREATE TABLE mcp_oauth_clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),   -- client_id
  client_name text NOT NULL,
  client_uri text,
  redirect_uris text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE mcp_clients ADD COLUMN oauth_client_id uuid REFERENCES mcp_oauth_clients(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX mcp_clients_oauth_uq ON mcp_clients (user_id, oauth_client_id)
  WHERE oauth_client_id IS NOT NULL AND revoked_at IS NULL;

CREATE TABLE mcp_oauth_codes (
  code_hash bytea PRIMARY KEY,
  mcp_client_id uuid NOT NULL REFERENCES mcp_clients(id) ON DELETE CASCADE,
  family_id uuid NOT NULL,                   -- tokens issued from this code (revoked on code reuse)
  redirect_uri text NOT NULL,
  code_challenge text NOT NULL,              -- PKCE S256
  resource text NOT NULL,                    -- RFC 8707 audience
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mcp_oauth_tokens (
  token_hash bytea PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('access','refresh')),
  mcp_client_id uuid NOT NULL REFERENCES mcp_clients(id) ON DELETE CASCADE,
  family_id uuid NOT NULL,
  resource text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,                       -- refresh: rotated; presenting it again revokes the family
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON mcp_oauth_tokens (mcp_client_id);
CREATE INDEX ON mcp_oauth_tokens (family_id);

-- +goose Down
DROP TABLE IF EXISTS mcp_oauth_tokens;
DROP TABLE IF EXISTS mcp_oauth_codes;
DROP INDEX IF EXISTS mcp_clients_oauth_uq;
ALTER TABLE mcp_clients DROP COLUMN IF EXISTS oauth_client_id;
DROP TABLE IF EXISTS mcp_oauth_clients;
