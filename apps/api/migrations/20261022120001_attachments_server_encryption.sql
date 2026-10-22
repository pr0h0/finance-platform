-- +goose Up
-- Server-side encryption at rest of the stored file (ATTACHMENT_ENCRYPTION_KEY, AES-256-GCM). Independent
-- of is_encrypted (client-side/E2EE content).
ALTER TABLE attachments ADD COLUMN server_encrypted boolean NOT NULL DEFAULT false;

-- +goose Down
ALTER TABLE attachments DROP COLUMN IF EXISTS server_encrypted;
