-- +goose Up
CREATE INDEX transactions_related ON transactions (related_transaction_id) WHERE related_transaction_id IS NOT NULL;
CREATE INDEX transactions_corrects ON transactions (corrects_transaction_id) WHERE corrects_transaction_id IS NOT NULL;
CREATE INDEX postings_account_tx ON postings (account_id, transaction_id) WHERE deleted_at IS NULL;

-- +goose Down
DROP INDEX transactions_related;
DROP INDEX transactions_corrects;
DROP INDEX postings_account_tx;
