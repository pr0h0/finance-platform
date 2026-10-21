-- +goose Up
-- Original uploaded statement bytes per import batch: immutable evidence (PLAN §9, Feature 128) and
-- the input for reprocessing with a newer parser (Feature 130). Not synced (no server_version).
CREATE TABLE import_batch_sources (
  import_batch_id uuid PRIMARY KEY REFERENCES import_batches(id),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  file_name text NOT NULL,
  encoding text NOT NULL DEFAULT '',
  content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER import_batch_sources_immutable BEFORE UPDATE ON import_batch_sources
  FOR EACH ROW EXECUTE FUNCTION forbid_update();

CREATE INDEX imported_raw_records_account_fp ON imported_raw_records (profile_id, account_id, dedupe_fingerprint);

-- +goose Down
DROP INDEX IF EXISTS imported_raw_records_account_fp;
DROP TABLE IF EXISTS import_batch_sources;
