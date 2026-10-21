-- +goose Up
-- ECB reference rates via the Frankfurter API (no key). Enabled by FX_PROVIDERS=ecb (default).
INSERT INTO exchange_rate_providers (code, name, kind, config, priority)
VALUES ('ecb', 'European Central Bank reference rates (Frankfurter API)', 'http',
        '{"url":"https://api.frankfurter.dev/v1","base":"EUR"}', 50)
ON CONFLICT (code) DO NOTHING;

-- +goose Down
DELETE FROM exchange_rate_providers WHERE code = 'ecb'
  AND NOT EXISTS (SELECT 1 FROM exchange_rates er WHERE er.provider_id = exchange_rate_providers.id);
