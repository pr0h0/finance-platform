-- +goose Up
-- Server-generated notifications carry a stable code + params so clients render them in the UI
-- language (title/body stay as the fallback text in the user's locale at creation time).
ALTER TABLE notifications ADD COLUMN code text, ADD COLUMN params jsonb NOT NULL DEFAULT '{}';

-- +goose Down
ALTER TABLE notifications DROP COLUMN IF EXISTS params, DROP COLUMN IF EXISTS code;
