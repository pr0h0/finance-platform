-- +goose Up
-- Planning/analytics support (modules planning, analytics).

-- Subscription price history: a price change ends the old plan series and starts a new plan that
-- points back to the one it supersedes.
ALTER TABLE planned_transactions ADD COLUMN supersedes_id uuid REFERENCES planned_transactions(id);

-- A transaction can satisfy at most one planned occurrence (financial invariant 19: no double counting).
CREATE UNIQUE INDEX planned_occurrences_matched_txn_uq ON planned_occurrences (matched_transaction_id)
  WHERE matched_transaction_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX planned_occurrences_plan ON planned_occurrences (profile_id, planned_transaction_id);

-- User dismissals of unusual-expense flags (syncable user state).
CREATE TABLE anomaly_dismissals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  transaction_id uuid NOT NULL REFERENCES transactions(id),
  rule text NOT NULL,
  dismissed_by uuid REFERENCES users(id),
  version int NOT NULL DEFAULT 1,
  server_version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX anomaly_dismissals_uq ON anomaly_dismissals (profile_id, transaction_id, rule) WHERE deleted_at IS NULL;
CREATE TRIGGER anomaly_dismissals_updated_at BEFORE UPDATE ON anomaly_dismissals FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX audit_log_rule_application ON audit_log ((metadata->>'rule_application_id')) WHERE metadata ? 'rule_application_id';

-- +goose Down
DROP INDEX IF EXISTS audit_log_rule_application;
DROP TABLE IF EXISTS anomaly_dismissals;
DROP INDEX IF EXISTS planned_occurrences_plan;
DROP INDEX IF EXISTS planned_occurrences_matched_txn_uq;
ALTER TABLE planned_transactions DROP COLUMN IF EXISTS supersedes_id;
