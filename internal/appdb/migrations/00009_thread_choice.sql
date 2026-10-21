-- +goose Up

-- The model and thinking level the person chose for a conversation (Settings → Models → Per conversation): empty for
-- the agent's own model and the model's default thinking.
ALTER TABLE threads ADD COLUMN model_id TEXT;
ALTER TABLE threads ADD COLUMN thinking TEXT;

-- +goose Down
ALTER TABLE threads DROP COLUMN thinking;
ALTER TABLE threads DROP COLUMN model_id;
