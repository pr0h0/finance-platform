-- +goose Up
-- Initial schema for the finance platform. See docs/architecture/financial-invariants.md
-- and docs/architecture/decisions/0003-ledger-model.md.
--
-- Conventions
--   * ids: uuid, client-generatable (UUIDv7 preferred, any v4/v7 accepted); default gen_random_uuid().
--   * money: NUMERIC + char(3) currency. Never float. Amount scale enforced in app (internal/money).
--   * instants: timestamptz (UTC). Financial calendar dates: date (local, never shifted by TZ).
--   * syncable rows: profile_id, version (optimistic concurrency), server_version (profile change
--     counter at last change), deleted_at (tombstone; rows are never hard-deleted while syncable).
--   * enums: text + CHECK so later migrations can extend them with a constraint swap.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- +goose StatementBegin
CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
-- +goose StatementEnd

-- ===== identity =====
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  display_name text NOT NULL DEFAULT '',
  password_hash text,                       -- argon2id PHC string; null for disabled password login
  is_admin boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','pending')),
  locale text NOT NULL DEFAULT 'en',
  timezone text NOT NULL DEFAULT 'UTC',
  email_verified_at timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email)) WHERE deleted_at IS NULL;

CREATE TABLE user_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON user_recovery_codes (user_id);

CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('web','android','ios','macos','windows','linux','cli','other')),
  client_version text NOT NULL DEFAULT '',
  public_key bytea,                          -- device X25519 public key for E2EE key envelopes
  last_seen_at timestamptz,
  last_sync_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON devices (user_id);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  token_hash bytea NOT NULL UNIQUE,          -- sha256(token); raw token never stored
  kind text NOT NULL DEFAULT 'cookie' CHECK (kind IN ('cookie','bearer')),
  ip inet,
  user_agent text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX ON sessions (user_id);

-- ===== households & profiles =====
CREATE TABLE households (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE household_members (
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  invited_email text,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member','viewer')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','removed')),
  invited_by uuid REFERENCES users(id),
  invite_token_hash bytea,
  joined_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  CHECK (user_id IS NOT NULL OR invited_email IS NOT NULL)
);
CREATE UNIQUE INDEX household_members_user_uq ON household_members (household_id, user_id) WHERE user_id IS NOT NULL;

CREATE TABLE profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  household_id uuid REFERENCES households(id),
  base_currency char(3) NOT NULL DEFAULT 'BAM',   -- primary reporting currency
  timezone text NOT NULL DEFAULT 'Europe/Sarajevo',
  locale text NOT NULL DEFAULT 'en',
  week_start smallint NOT NULL DEFAULT 1 CHECK (week_start BETWEEN 0 AND 6),
  privacy_mode text NOT NULL DEFAULT 'server_readable' CHECK (privacy_mode IN ('server_readable','e2ee')),
  sync_version bigint NOT NULL DEFAULT 0,          -- monotonically increasing change counter
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

-- Authorization source of truth for every profile-scoped row.
CREATE TABLE profile_members (
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','editor','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, user_id)
);
CREATE INDEX ON profile_members (user_id);

-- ===== currencies & exchange rates =====
CREATE TABLE currencies (
  code char(3) PRIMARY KEY,
  name text NOT NULL DEFAULT '',          -- UI localizes via Intl.DisplayNames when empty
  minor_units smallint NOT NULL CHECK (minor_units BETWEEN 0 AND 4),
  symbol text NOT NULL DEFAULT '',
  is_active boolean NOT NULL DEFAULT true,
  is_custom boolean NOT NULL DEFAULT false
);

CREATE TABLE exchange_rate_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,                 -- 'ecb', 'cbbh', 'manual', 'fixed'
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('http','manual','fixed')),
  config jsonb NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true,
  priority int NOT NULL DEFAULT 100,
  last_fetched_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Snapshot: 1 base = rate quote, valid for rate_date. Never updated in place once used; a correction
-- is a new row with a later fetched_at. profile_id set => manual override scoped to that profile.
CREATE TABLE exchange_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid REFERENCES exchange_rate_providers(id),
  profile_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
  base_currency char(3) NOT NULL REFERENCES currencies(code),
  quote_currency char(3) NOT NULL REFERENCES currencies(code),
  rate numeric(38,18) NOT NULL CHECK (rate > 0),
  rate_date date NOT NULL,
  source text NOT NULL CHECK (source IN ('provider','manual','fixed')),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (base_currency <> quote_currency)
);
CREATE INDEX exchange_rates_lookup ON exchange_rates (base_currency, quote_currency, rate_date DESC);
CREATE UNIQUE INDEX exchange_rates_uq ON exchange_rates (provider_id, profile_id, base_currency, quote_currency, rate_date) NULLS NOT DISTINCT;

-- ===== accounts =====
CREATE TABLE account_types (
  code text PRIMARY KEY,
  name text NOT NULL,
  classification text NOT NULL CHECK (classification IN ('asset','liability')),
  sort_order int NOT NULL DEFAULT 0
);

CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name text NOT NULL,
  account_type text NOT NULL REFERENCES account_types(code),
  currency char(3) NOT NULL REFERENCES currencies(code),   -- default/primary currency
  is_multi_currency boolean NOT NULL DEFAULT false,
  institution text NOT NULL DEFAULT '',
  account_number_masked text NOT NULL DEFAULT '',
  opening_date date,
  credit_limit numeric(30,10),
  include_in_net_worth boolean NOT NULL DEFAULT true,
  include_in_safe_to_spend boolean NOT NULL DEFAULT true,
  is_archived boolean NOT NULL DEFAULT false,
  color text NOT NULL DEFAULT '',
  icon text NOT NULL DEFAULT '',
  sort_order int NOT NULL DEFAULT 0,
  notes text NOT NULL DEFAULT '',
  version int NOT NULL DEFAULT 1,
  server_version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX ON accounts (profile_id);

CREATE TABLE bank_connections (            -- extension point for authorized automated bank feeds (#102)
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  account_id uuid REFERENCES accounts(id),
  provider text NOT NULL,
  external_ref text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'disabled' CHECK (status IN ('active','disabled','error','expired')),
  credentials_ref text,                      -- reference into a secret store, never raw credentials
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

-- ===== categories, tags, merchants =====
CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES categories(id),
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense','income','transfer')),
  color text NOT NULL DEFAULT '',
  icon text NOT NULL DEFAULT '',
  sort_order int NOT NULL DEFAULT 0,
  is_system boolean NOT NULL DEFAULT false,
  is_archived boolean NOT NULL DEFAULT false,
  version int NOT NULL DEFAULT 1,
  server_version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX ON categories (profile_id);

CREATE TABLE tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name text NOT NULL,
  color text NOT NULL DEFAULT '',
  version int NOT NULL DEFAULT 1,
  server_version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX tags_name_uq ON tags (profile_id, lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE merchants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name text NOT NULL,
  normalized_name text NOT NULL,
  default_category_id uuid REFERENCES categories(id),
  website text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  version int NOT NULL DEFAULT 1,
  server_version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX ON merchants (profile_id, normalized_name);

-- ===== imports (immutable evidence) =====
CREATE TABLE attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  transaction_id uuid,                       -- FK added after transactions
  file_name text NOT NULL,
  content_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  sha256 bytea NOT NULL,
  storage_backend text NOT NULL DEFAULT 'local' CHECK (storage_backend IN ('local','s3')),
  storage_key text NOT NULL,
  is_encrypted boolean NOT NULL DEFAULT false,
  purpose text NOT NULL DEFAULT 'receipt' CHECK (purpose IN ('receipt','statement','document','other')),
  uploaded_by uuid REFERENCES users(id),
  version int NOT NULL DEFAULT 1,
  server_version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX ON attachments (profile_id);
CREATE INDEX ON attachments (transaction_id);

CREATE TABLE import_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid REFERENCES profiles(id) ON DELETE CASCADE,   -- null = server-wide/community
  importer_id text NOT NULL,
  name text NOT NULL,
  bank_name text NOT NULL DEFAULT '',
  country char(2),
  schema_version int NOT NULL DEFAULT 1,
  template_version text NOT NULL DEFAULT '1.0.0',
  format text NOT NULL CHECK (format IN ('csv','tsv','xlsx','ofx','qif','camt053','mt940','pdf','json','other')),
  definition jsonb NOT NULL,                  -- declarative mapping (importer-sdk template schema)
  is_community boolean NOT NULL DEFAULT false,
  version int NOT NULL DEFAULT 1,
  server_version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  account_id uuid REFERENCES accounts(id),
  importer_id text NOT NULL,
  importer_version text NOT NULL,
  template_id uuid REFERENCES import_templates(id),
  file_name text NOT NULL,
  file_sha256 bytea NOT NULL,
  file_size bigint NOT NULL,
  attachment_id uuid REFERENCES attachments(id),
  status text NOT NULL DEFAULT 'staged' CHECK (status IN ('staged','committing','committed','rolled_back','failed')),
  coverage_start date,
  coverage_end date,
  stats jsonb NOT NULL DEFAULT '{}',
  error text,
  created_by uuid REFERENCES users(id),
  reprocessed_from_batch_id uuid REFERENCES import_batches(id),
  version int NOT NULL DEFAULT 1,
  server_version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz,
  rolled_back_at timestamptz,
  deleted_at timestamptz
);
CREATE INDEX ON import_batches (profile_id, created_at DESC);

CREATE TABLE bank_statements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  account_id uuid REFERENCES accounts(id),
  import_batch_id uuid NOT NULL REFERENCES import_batches(id),
  statement_ref text NOT NULL DEFAULT '',
  period_start date,
  period_end date,
  opening_balance numeric(30,10),
  closing_balance numeric(30,10),
  currency char(3) REFERENCES currencies(code),
  file_sha256 bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Immutable source record (PLAN §9). Never updated; see trigger below.
CREATE TABLE imported_raw_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  import_batch_id uuid NOT NULL REFERENCES import_batches(id),
  bank_statement_id uuid REFERENCES bank_statements(id),
  account_id uuid REFERENCES accounts(id),
  row_number int NOT NULL,
  source_description text NOT NULL,
  posting_date date NOT NULL,
  value_date date,
  amount numeric(30,10) NOT NULL,            -- signed: negative = debit
  direction text NOT NULL CHECK (direction IN ('debit','credit')),
  currency char(3) NOT NULL,
  original_amount numeric(30,10),            -- foreign amount if the bank reported one
  original_currency char(3),
  exchange_rate numeric(38,18),
  running_balance numeric(30,10),
  bank_reference text NOT NULL DEFAULT '',
  statement_ref text NOT NULL DEFAULT '',
  source_account text NOT NULL DEFAULT '',
  counterparty text NOT NULL DEFAULT '',
  raw jsonb NOT NULL,
  dedupe_fingerprint text NOT NULL,          -- importer-defined stable hash for duplicate detection
  file_sha256 bytea NOT NULL,
  importer_id text NOT NULL,
  importer_version text NOT NULL,
  warnings jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON imported_raw_records (profile_id, dedupe_fingerprint);
CREATE INDEX ON imported_raw_records (import_batch_id);

-- +goose StatementBegin
CREATE FUNCTION forbid_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = 'restrict_violation'; END $$;
-- +goose StatementEnd
CREATE TRIGGER imported_raw_records_immutable BEFORE UPDATE ON imported_raw_records
  FOR EACH ROW EXECUTE FUNCTION forbid_update();

-- ===== planning =====
CREATE TABLE recurrence_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  rrule text NOT NULL,                       -- RFC 5545 RRULE (FREQ=MONTHLY;BYMONTHDAY=-1 ...)
  start_date date NOT NULL,
  end_date date,
  occurrence_count int,
  timezone text NOT NULL DEFAULT 'UTC',
  business_day_adjustment text NOT NULL DEFAULT 'none' CHECK (business_day_adjustment IN ('none','previous','next')),
  version int NOT NULL DEFAULT 1,
  server_version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

-- One-off plan (recurrence_id null) or series template (recurrence_id set).
CREATE TABLE planned_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('income','expense','transfer')),
  account_id uuid REFERENCES accounts(id),
  to_account_id uuid REFERENCES accounts(id),
  category_id uuid REFERENCES categories(id),
  merchant_id uuid REFERENCES merchants(id),
  description text NOT NULL DEFAULT '',
  amount numeric(30,10) NOT NULL CHECK (amount > 0),
  amount_min numeric(30,10),                 -- variable bills: expected range
  amount_max numeric(30,10),
  currency char(3) NOT NULL REFERENCES currencies(code),
  due_date date NOT NULL,                    -- first/only due date
  recurrence_id uuid REFERENCES recurrence_schedules(id),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('essential','high','normal','low','optional')),
  confidence text NOT NULL DEFAULT 'expected' CHECK (confidence IN ('certain','expected','possible','speculative')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','completed','cancelled')),
  installment_total int CHECK (installment_total > 0),
  installment_start int CHECK (installment_start > 0),
  reminder_days_before int,
  notes text NOT NULL DEFAULT '',
  version int NOT NULL DEFAULT 1,
  server_version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX ON planned_transactions (profile_id, due_date);

-- Materialized state of individual occurrences (matches, skips, overrides). Unmentioned
-- occurrences are derived by expanding the recurrence; never stored speculatively.
CREATE TABLE planned_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  planned_transaction_id uuid NOT NULL REFERENCES planned_transactions(id),
  occurrence_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','matched','skipped','paid_manual')),
  amount_override numeric(30,10),
  date_override date,
  matched_transaction_id uuid,               -- FK added after transactions
  version int NOT NULL DEFAULT 1,
  server_version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (planned_transaction_id, occurrence_date)
);

CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  planned_transaction_id uuid REFERENCES planned_transactions(id),
  merchant_id uuid REFERENCES merchants(id),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('trial','active','paused','cancelled')),
  trial_ends_at date,
  cancelled_at date,
  url text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  version int NOT NULL DEFAULT 1,
  server_version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

-- ===== transactions (ledger) =====
-- Header = editable user interpretation. Postings = money movement per account (immutable).
CREATE TABLE transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('income','expense','transfer','refund','adjustment','opening_balance','fx')),
  status text NOT NULL DEFAULT 'cleared' CHECK (status IN ('pending','cleared','reconciled','void')),
  booking_date date NOT NULL,                -- local calendar date of the movement
  value_date date,
  occurred_at timestamptz,                   -- instant if known (card time); never server receipt time
  description text NOT NULL DEFAULT '',      -- display description (editable)
  notes text NOT NULL DEFAULT '',
  merchant_id uuid REFERENCES merchants(id),
  payee text NOT NULL DEFAULT '',
  reference text NOT NULL DEFAULT '',
  exclude_from_reports boolean NOT NULL DEFAULT false,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import','recurring','mcp','sync','bank_feed','system')),
  import_record_id uuid REFERENCES imported_raw_records(id),
  related_transaction_id uuid REFERENCES transactions(id),  -- refund -> original, reimbursement link
  corrects_transaction_id uuid REFERENCES transactions(id), -- adjustment correcting another txn
  categorization_source text NOT NULL DEFAULT 'none' CHECK (categorization_source IN ('none','user','rule','import','suggestion','mcp')),
  created_by uuid REFERENCES users(id),
  version int NOT NULL DEFAULT 1,
  server_version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX transactions_profile_date ON transactions (profile_id, booking_date DESC, id);
CREATE UNIQUE INDEX transactions_import_record_uq ON transactions (import_record_id) WHERE import_record_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX transactions_search ON transactions USING gin (to_tsvector('simple', description || ' ' || notes || ' ' || payee));

CREATE TABLE postings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  transaction_id uuid NOT NULL REFERENCES transactions(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  amount numeric(30,10) NOT NULL,            -- signed, in account settlement currency
  currency char(3) NOT NULL REFERENCES currencies(code),
  original_amount numeric(30,10),            -- source amount when different currency (card abroad)
  original_currency char(3) REFERENCES currencies(code),
  exchange_rate_id uuid REFERENCES exchange_rates(id),
  line_no smallint NOT NULL DEFAULT 0,
  memo text NOT NULL DEFAULT '',
  server_version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz                     -- the only mutable column (manual-entry replacement)
);
CREATE INDEX ON postings (transaction_id);
CREATE INDEX postings_account ON postings (account_id) WHERE deleted_at IS NULL;

-- +goose StatementBegin
CREATE FUNCTION postings_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.amount IS DISTINCT FROM OLD.amount OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.transaction_id IS DISTINCT FROM OLD.transaction_id
     OR NEW.original_amount IS DISTINCT FROM OLD.original_amount OR NEW.original_currency IS DISTINCT FROM OLD.original_currency THEN
    RAISE EXCEPTION 'postings are immutable; record a correction instead' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
-- +goose StatementEnd
CREATE TRIGGER postings_immutable BEFORE UPDATE ON postings FOR EACH ROW EXECUTE FUNCTION postings_guard();

-- Category allocation of a transaction. Amount = positive magnitude; sum = |transaction amount|.
CREATE TABLE transaction_splits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  transaction_id uuid NOT NULL REFERENCES transactions(id),
  category_id uuid REFERENCES categories(id),  -- null = uncategorized
  amount numeric(30,10) NOT NULL CHECK (amount > 0),
  currency char(3) NOT NULL REFERENCES currencies(code),
  description text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  sort_order int NOT NULL DEFAULT 0,
  version int NOT NULL DEFAULT 1,
  server_version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX ON transaction_splits (transaction_id);
CREATE INDEX ON transaction_splits (profile_id, category_id);

CREATE TABLE transaction_tags (
  transaction_id uuid NOT NULL REFERENCES transactions(id),
  tag_id uuid NOT NULL REFERENCES tags(id),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (transaction_id, tag_id)
);

-- Audit link between an original transaction and the adjustment transaction that corrects it.
CREATE TABLE transaction_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  transaction_id uuid NOT NULL REFERENCES transactions(id),
  adjustment_transaction_id uuid NOT NULL REFERENCES transactions(id),
  reason text NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE currency_conversions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  transaction_id uuid REFERENCES transactions(id),
  from_amount numeric(30,10) NOT NULL,
  from_currency char(3) NOT NULL REFERENCES currencies(code),
  to_amount numeric(30,10) NOT NULL,
  to_currency char(3) NOT NULL REFERENCES currencies(code),
  rate numeric(38,18) NOT NULL,
  exchange_rate_id uuid REFERENCES exchange_rates(id),
  rate_date date NOT NULL,
  method text NOT NULL CHECK (method IN ('market','manual','fixed','bank_actual')),
  fee_amount numeric(30,10),
  fee_currency char(3) REFERENCES currencies(code),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE transaction_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('income','expense','transfer')),
  account_id uuid REFERENCES accounts(id),
  to_account_id uuid REFERENCES accounts(id),
  amount numeric(30,10),
  currency char(3) REFERENCES currencies(code),
  category_id uuid REFERENCES categories(id),
  merchant_id uuid REFERENCES merchants(id),
  description text NOT NULL DEFAULT '',
  tag_ids uuid[] NOT NULL DEFAULT '{}',
  sort_order int NOT NULL DEFAULT 0,
  version int NOT NULL DEFAULT 1,
  server_version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

-- Reusable split templates: lines = [{category_id, weight (decimal string) | amount, description}]
CREATE TABLE split_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name text NOT NULL,
  merchant_id uuid REFERENCES merchants(id),
  lines jsonb NOT NULL,
  version int NOT NULL DEFAULT 1,
  server_version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

ALTER TABLE attachments ADD FOREIGN KEY (transaction_id) REFERENCES transactions(id);
ALTER TABLE planned_occurrences ADD FOREIGN KEY (matched_transaction_id) REFERENCES transactions(id);

CREATE TABLE import_reconciliation_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  import_batch_id uuid NOT NULL REFERENCES import_batches(id),
  raw_record_id uuid NOT NULL REFERENCES imported_raw_records(id),
  transaction_id uuid REFERENCES transactions(id),
  outcome text NOT NULL CHECK (outcome IN ('new','duplicate','matched','conflict','skipped','error')),
  match_score numeric(5,4),
  details jsonb NOT NULL DEFAULT '{}',
  resolved_by uuid REFERENCES users(id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON import_reconciliation_results (import_batch_id);

-- ===== budgets =====
CREATE TABLE budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name text NOT NULL,
  period_type text NOT NULL CHECK (period_type IN ('weekly','monthly','quarterly','yearly','custom')),
  period_anchor_day smallint NOT NULL DEFAULT 1,   -- e.g. salary-day month start
  start_date date NOT NULL,
  end_date date,
  currency char(3) NOT NULL REFERENCES currencies(code),
  rollover_policy text NOT NULL DEFAULT 'none' CHECK (rollover_policy IN ('none','carry_surplus','carry_deficit','carry_both')),
  include_planned boolean NOT NULL DEFAULT true,
  alert_thresholds numeric(5,4)[] NOT NULL DEFAULT '{0.8,1.0}',
  is_template boolean NOT NULL DEFAULT false,
  template_id uuid REFERENCES budgets(id),
  is_archived boolean NOT NULL DEFAULT false,
  version int NOT NULL DEFAULT 1,
  server_version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE budget_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  budget_id uuid NOT NULL REFERENCES budgets(id),
  start_date date NOT NULL,
  end_date date NOT NULL CHECK (end_date >= start_date),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  closed_at timestamptz,
  version int NOT NULL DEFAULT 1,
  server_version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (budget_id, start_date)
);

-- budget_period_id null = default allocation for every period of the budget.
CREATE TABLE budget_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  budget_id uuid NOT NULL REFERENCES budgets(id),
  budget_period_id uuid REFERENCES budget_periods(id),
  category_id uuid REFERENCES categories(id),       -- null = whole-budget limit
  amount numeric(30,10) NOT NULL CHECK (amount >= 0),
  currency char(3) NOT NULL REFERENCES currencies(code),
  rollover_amount numeric(30,10) NOT NULL DEFAULT 0, -- carried in from previous period (closed periods)
  rollover_policy text CHECK (rollover_policy IN ('none','carry_surplus','carry_deficit','carry_both')),
  version int NOT NULL DEFAULT 1,
  server_version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX budget_allocations_uq ON budget_allocations (budget_id, budget_period_id, category_id) NULLS NOT DISTINCT WHERE deleted_at IS NULL;

-- ===== savings =====
CREATE TABLE savings_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'general' CHECK (kind IN ('general','emergency_fund','purchase','debt_payoff')),
  target_amount numeric(30,10) NOT NULL CHECK (target_amount > 0),
  currency char(3) NOT NULL REFERENCES currencies(code),
  starting_amount numeric(30,10) NOT NULL DEFAULT 0,
  target_date date,
  account_id uuid REFERENCES accounts(id),   -- dedicated account (balance-tracked) or null
  emergency_months smallint,                  -- emergency fund: months of expenses target
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('essential','high','normal','low','optional')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','completed','cancelled')),
  completed_at timestamptz,
  color text NOT NULL DEFAULT '',
  icon text NOT NULL DEFAULT '',
  version int NOT NULL DEFAULT 1,
  server_version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE savings_contributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  goal_id uuid NOT NULL REFERENCES savings_goals(id),
  amount numeric(30,10) NOT NULL CHECK (amount <> 0),  -- negative = withdrawal
  currency char(3) NOT NULL REFERENCES currencies(code),
  contribution_date date NOT NULL,
  transaction_id uuid REFERENCES transactions(id),
  notes text NOT NULL DEFAULT '',
  version int NOT NULL DEFAULT 1,
  server_version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

-- ===== automation =====
CREATE TABLE categorization_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name text NOT NULL,
  priority int NOT NULL DEFAULT 100,
  conditions jsonb NOT NULL,                 -- declarative only; never evaluated as code
  actions jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  stop_processing boolean NOT NULL DEFAULT false,
  match_count bigint NOT NULL DEFAULT 0,
  last_matched_at timestamptz,
  version int NOT NULL DEFAULT 1,
  server_version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

-- Derived caches (never authoritative). Safe to delete and recompute.
CREATE TABLE financial_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('net_worth','account_balance','monthly_summary')),
  snapshot_date date NOT NULL,
  account_id uuid REFERENCES accounts(id),
  currency char(3) NOT NULL REFERENCES currencies(code),
  total numeric(30,10) NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  source_server_version bigint NOT NULL,     -- profile sync_version the cache was computed at
  computed_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX financial_snapshots_uq ON financial_snapshots (profile_id, kind, snapshot_date, account_id, currency) NULLS NOT DISTINCT;

-- ===== notifications & settings =====
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
  kind text NOT NULL,                        -- budget_threshold, bill_due, low_balance, import_done, ...
  severity text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')),
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  data jsonb NOT NULL DEFAULT '{}',
  dedupe_key text,
  channel text NOT NULL DEFAULT 'in_app' CHECK (channel IN ('in_app','email','push')),
  scheduled_for timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  dismissed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX notifications_dedupe ON notifications (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX ON notifications (user_id, created_at DESC);

-- scope: server (owner_id null) | user | profile. Value is JSON.
CREATE TABLE settings (
  scope text NOT NULL CHECK (scope IN ('server','user','profile')),
  owner_id uuid,
  key text NOT NULL,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (scope, owner_id, key)
);

-- ===== sync =====
-- Append-only change log. server_version is per-profile, strictly increasing, allocated by
-- UPDATE profiles SET sync_version = sync_version + 1 in the writing transaction (row lock
-- serializes writers per profile, so versions commit in order with no gaps visible to readers).
CREATE TABLE sync_changes (
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  server_version bigint NOT NULL,
  entity_type text NOT NULL,                 -- table name, e.g. 'transactions'
  entity_id uuid NOT NULL,
  op text NOT NULL CHECK (op IN ('upsert','delete')),
  data jsonb,                                -- full entity snapshot (API shape) or E2EE envelope
  op_id uuid,                                -- client operation id (null for server-originated)
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, server_version)
);
CREATE INDEX ON sync_changes (profile_id, entity_type, entity_id);

-- Idempotency of pushed operations: one row per client op id.
CREATE TABLE sync_operations (
  op_id uuid PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  status text NOT NULL CHECK (status IN ('applied','conflict','rejected')),
  result jsonb NOT NULL DEFAULT '{}',
  server_version bigint,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sync_checkpoints (
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  last_pulled_version bigint NOT NULL DEFAULT 0,
  last_pushed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, profile_id)
);

CREATE TABLE sync_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  op_id uuid NOT NULL,
  base_version int NOT NULL,
  fields text[] NOT NULL,
  server_data jsonb NOT NULL,
  client_data jsonb NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  resolution jsonb,
  resolved_by uuid REFERENCES users(id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ===== E2EE key material (wrapped keys only; server never sees plaintext keys) =====
CREATE TABLE key_envelopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
  device_id uuid REFERENCES devices(id) ON DELETE CASCADE,
  key_id text NOT NULL,                      -- id of the wrapped data key (rotation generation)
  kind text NOT NULL CHECK (kind IN ('password','recovery','device','member')),
  wrapped_key bytea NOT NULL,
  kdf_params jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

-- ===== MCP =====
CREATE TABLE mcp_clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  token_hash bytea NOT NULL UNIQUE,
  token_prefix text NOT NULL,                -- first chars for identification in UI
  enabled boolean NOT NULL DEFAULT true,
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mcp_permission_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mcp_client_id uuid NOT NULL REFERENCES mcp_clients(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('read_aggregates','read_transactions','read_merchants','read_attachments',
    'edit_categories','edit_splits','edit_metadata','create_planned','edit_budgets','edit_goals','edit_rules')),
  account_ids uuid[],                        -- null = all accounts in profile
  date_from date,
  date_to date,
  approval text NOT NULL DEFAULT 'required' CHECK (approval IN ('required','auto')),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE UNIQUE INDEX mcp_grants_uq ON mcp_permission_grants (mcp_client_id, profile_id, scope) WHERE revoked_at IS NULL;

CREATE TABLE mcp_proposed_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  mcp_client_id uuid NOT NULL REFERENCES mcp_clients(id) ON DELETE CASCADE,
  batch_id uuid,
  tool text NOT NULL,
  input jsonb NOT NULL,
  preview jsonb NOT NULL DEFAULT '{}',
  idempotency_key text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','applied','failed','expired')),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  applied_at timestamptz,
  result jsonb,
  error text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON mcp_proposed_changes (profile_id, status);
CREATE UNIQUE INDEX mcp_proposed_idem ON mcp_proposed_changes (mcp_client_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ===== audit, backups, idempotency, jobs =====
CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL CHECK (actor_type IN ('user','mcp','system','import','sync','admin')),
  actor_id uuid,                             -- user id or mcp client id
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  profile_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  action text NOT NULL,                      -- e.g. 'transaction.update', 'auth.login'
  entity_type text,
  entity_id uuid,
  before jsonb,
  after jsonb,
  request_id text,
  ip inet,
  metadata jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX ON audit_log (profile_id, occurred_at DESC);
CREATE INDEX ON audit_log (entity_type, entity_id);
CREATE TRIGGER audit_log_immutable BEFORE UPDATE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_update();

CREATE TABLE encrypted_backups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('manual','scheduled','pre_migration')),
  format_version int NOT NULL,
  schema_version bigint NOT NULL,
  storage_backend text NOT NULL DEFAULT 'local',
  storage_key text NOT NULL,
  size_bytes bigint NOT NULL,
  sha256 bytea NOT NULL,
  encryption jsonb NOT NULL,                 -- {alg, kdf, kdf_params, key_id} — never key material
  status text NOT NULL DEFAULT 'complete' CHECK (status IN ('in_progress','complete','failed','expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz
);

CREATE TABLE idempotency_keys (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key text NOT NULL,
  method text NOT NULL,
  path text NOT NULL,
  request_hash bytea NOT NULL,
  status_code int,                           -- null while in flight
  response bytea,                            -- exact response body replayed on retry
  content_type text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (user_id, key)
);

CREATE TABLE background_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  run_at timestamptz NOT NULL DEFAULT now(),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  locked_at timestamptz,
  locked_by text,
  last_error text,
  dedupe_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX background_jobs_ready ON background_jobs (run_at) WHERE status = 'queued';

-- updated_at triggers
-- +goose StatementBegin
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'updated_at' AND table_name <> 'settings'
  LOOP
    EXECUTE format('CREATE TRIGGER %I_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;
-- +goose StatementEnd

-- ===== seed reference data =====
INSERT INTO account_types (code, name, classification, sort_order) VALUES
  ('checking','Checking / current account','asset',10),
  ('savings','Savings account','asset',20),
  ('cash','Cash','asset',30),
  ('wallet','Digital wallet','asset',40),
  ('prepaid','Prepaid card','asset',50),
  ('investment','Investment','asset',60),
  ('other_asset','Other asset','asset',70),
  ('credit_card','Credit card','liability',100),
  ('loan','Loan','liability',110),
  ('mortgage','Mortgage','liability',120),
  ('other_liability','Other liability','liability',130);

INSERT INTO exchange_rate_providers (code, name, kind, priority) VALUES
  ('fixed','Legally fixed rates (EUR/BAM currency board)','fixed',0),
  ('manual','Manual rates','manual',10);

INSERT INTO currencies (code, minor_units) VALUES
  ('AED',2),
  ('AFN',2),
  ('ALL',2),
  ('AMD',2),
  ('ANG',2),
  ('AOA',2),
  ('ARS',2),
  ('AUD',2),
  ('AWG',2),
  ('AZN',2),
  ('BAM',2),
  ('BBD',2),
  ('BDT',2),
  ('BGN',2),
  ('BHD',3),
  ('BIF',0),
  ('BMD',2),
  ('BND',2),
  ('BOB',2),
  ('BRL',2),
  ('BSD',2),
  ('BTN',2),
  ('BWP',2),
  ('BYN',2),
  ('BZD',2),
  ('CAD',2),
  ('CDF',2),
  ('CHF',2),
  ('CLF',4),
  ('CLP',0),
  ('CNY',2),
  ('COP',2),
  ('CRC',2),
  ('CUP',2),
  ('CVE',2),
  ('CZK',2),
  ('DJF',0),
  ('DKK',2),
  ('DOP',2),
  ('DZD',2),
  ('EGP',2),
  ('ERN',2),
  ('ETB',2),
  ('EUR',2),
  ('FJD',2),
  ('FKP',2),
  ('GBP',2),
  ('GEL',2),
  ('GHS',2),
  ('GIP',2),
  ('GMD',2),
  ('GNF',0),
  ('GTQ',2),
  ('GYD',2),
  ('HKD',2),
  ('HNL',2),
  ('HTG',2),
  ('HUF',2),
  ('IDR',2),
  ('ILS',2),
  ('INR',2),
  ('IQD',3),
  ('IRR',2),
  ('ISK',0),
  ('JMD',2),
  ('JOD',3),
  ('JPY',0),
  ('KES',2),
  ('KGS',2),
  ('KHR',2),
  ('KMF',0),
  ('KPW',2),
  ('KRW',0),
  ('KWD',3),
  ('KYD',2),
  ('KZT',2),
  ('LAK',2),
  ('LBP',2),
  ('LKR',2),
  ('LRD',2),
  ('LSL',2),
  ('LYD',3),
  ('MAD',2),
  ('MDL',2),
  ('MGA',2),
  ('MKD',2),
  ('MMK',2),
  ('MNT',2),
  ('MOP',2),
  ('MRU',2),
  ('MUR',2),
  ('MVR',2),
  ('MWK',2),
  ('MXN',2),
  ('MYR',2),
  ('MZN',2),
  ('NAD',2),
  ('NGN',2),
  ('NIO',2),
  ('NOK',2),
  ('NPR',2),
  ('NZD',2),
  ('OMR',3),
  ('PAB',2),
  ('PEN',2),
  ('PGK',2),
  ('PHP',2),
  ('PKR',2),
  ('PLN',2),
  ('PYG',0),
  ('QAR',2),
  ('RON',2),
  ('RSD',2),
  ('RUB',2),
  ('RWF',0),
  ('SAR',2),
  ('SBD',2),
  ('SCR',2),
  ('SDG',2),
  ('SEK',2),
  ('SGD',2),
  ('SHP',2),
  ('SLE',2),
  ('SOS',2),
  ('SRD',2),
  ('SSP',2),
  ('STN',2),
  ('SVC',2),
  ('SYP',2),
  ('SZL',2),
  ('THB',2),
  ('TJS',2),
  ('TMT',2),
  ('TND',3),
  ('TOP',2),
  ('TRY',2),
  ('TTD',2),
  ('TWD',2),
  ('TZS',2),
  ('UAH',2),
  ('UGX',0),
  ('USD',2),
  ('UYU',2),
  ('UYW',4),
  ('UZS',2),
  ('VES',2),
  ('VND',0),
  ('VUV',0),
  ('WST',2),
  ('XAF',0),
  ('XCD',2),
  ('XOF',0),
  ('XPF',0),
  ('YER',2),
  ('ZAR',2),
  ('ZMW',2),
  ('ZWG',2);
UPDATE currencies SET name = v.name, symbol = v.symbol FROM (VALUES
  ('BAM','Bosnia and Herzegovina convertible mark','KM'),('EUR','Euro','€'),('USD','US dollar','$'),
  ('GBP','Pound sterling','£'),('CHF','Swiss franc','CHF'),('RSD','Serbian dinar','RSD'),
  ('HUF','Hungarian forint','Ft'),('JPY','Japanese yen','¥'),('KWD','Kuwaiti dinar','KD')) AS v(code,name,symbol)
WHERE currencies.code = v.code;

INSERT INTO exchange_rates (provider_id, base_currency, quote_currency, rate, rate_date, source)
SELECT id, 'EUR', 'BAM', 1.95583, DATE '1999-01-01', 'fixed' FROM exchange_rate_providers WHERE code = 'fixed';

-- +goose Down
-- The initial schema is not reversible in production; drop the database instead.
SELECT 1;
