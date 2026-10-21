-- +goose Up

-- Prices for cached tokens (USD per million; NULL: counted at the input price), and where a model's prices came from:
-- 'list' (the app's price list) or 'you' (typed in Settings → Models); NULL: unpriced. Prices set before this
-- column existed were typed by the person.
ALTER TABLE models ADD COLUMN cache_read_price REAL;
ALTER TABLE models ADD COLUMN cache_write_price REAL;
ALTER TABLE models ADD COLUMN price_source TEXT;
UPDATE models SET price_source = 'you' WHERE input_price IS NOT NULL OR output_price IS NOT NULL;

-- +goose Down
ALTER TABLE models DROP COLUMN price_source;
ALTER TABLE models DROP COLUMN cache_write_price;
ALTER TABLE models DROP COLUMN cache_read_price;
