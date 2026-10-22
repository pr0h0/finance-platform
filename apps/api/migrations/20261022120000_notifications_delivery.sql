-- +goose Up
-- Email/push delivery (features 31, 43, 81): rows with channel email|push are an outbox, sent by the
-- notification job (delivered_at set on success; attempts/last_error on failure, capped).
ALTER TABLE notifications ADD COLUMN attempts int NOT NULL DEFAULT 0, ADD COLUMN last_error text;
CREATE INDEX notifications_outbox ON notifications (created_at) WHERE channel <> 'in_app' AND delivered_at IS NULL;

-- Web Push subscriptions of a user's browsers (PWA). The endpoint is unique per browser; a new login on
-- the same browser takes it over.
CREATE TABLE push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz
);
CREATE INDEX ON push_subscriptions (user_id);

-- +goose Down
DROP TABLE IF EXISTS push_subscriptions;
DROP INDEX IF EXISTS notifications_outbox;
ALTER TABLE notifications DROP COLUMN IF EXISTS last_error, DROP COLUMN IF EXISTS attempts;
