-- +goose Up
-- Normalized alias strings (see merchants.Normalize) used to recognise a merchant in bank descriptions.
ALTER TABLE merchants ADD COLUMN aliases text[] NOT NULL DEFAULT '{}';
CREATE UNIQUE INDEX merchants_normalized_uq ON merchants (profile_id, normalized_name) WHERE deleted_at IS NULL;

-- +goose Down
DROP INDEX merchants_normalized_uq;
ALTER TABLE merchants DROP COLUMN aliases;
