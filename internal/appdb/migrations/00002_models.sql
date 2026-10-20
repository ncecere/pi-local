-- +goose Up

-- Model providers. The API key and header values are in the OS keychain (internal/secrets), never here; this row
-- says whether a key is stored and which headers there are.
CREATE TABLE providers (
    id           TEXT PRIMARY KEY, -- a slug agent.yaml names: [a-z0-9-]{1,32}
    name         TEXT    NOT NULL,
    kind         TEXT    NOT NULL,
    base_url     TEXT    NOT NULL,
    has_key      INTEGER NOT NULL DEFAULT 0,
    header_names TEXT    NOT NULL DEFAULT '[]', -- JSON array
    enabled      INTEGER NOT NULL DEFAULT 1,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
) STRICT;

-- The models agents may use, with what the runtime needs to know about each and optional prices.
CREATE TABLE models (
    provider_id    TEXT    NOT NULL REFERENCES providers (id) ON DELETE CASCADE,
    model_id       TEXT    NOT NULL,
    name           TEXT    NOT NULL,
    context_window INTEGER NOT NULL DEFAULT 128000,
    max_tokens     INTEGER NOT NULL DEFAULT 16000,
    reasoning      INTEGER NOT NULL DEFAULT 0,
    images         INTEGER NOT NULL DEFAULT 0,
    input_price    REAL, -- USD per million tokens; NULL: unpriced
    output_price   REAL,
    enabled        INTEGER NOT NULL DEFAULT 1,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    PRIMARY KEY (provider_id, model_id)
) STRICT;

-- Model usage per agent, model and local day, as the runtimes report it. Kept when an agent or model is deleted
-- (with its last name), so past spending stays visible.
CREATE TABLE usage (
    day          TEXT    NOT NULL, -- YYYY-MM-DD, local time
    agent_id     TEXT    NOT NULL,
    agent_name   TEXT    NOT NULL,
    model        TEXT    NOT NULL, -- "<provider>/<modelId>"
    model_name   TEXT    NOT NULL,
    requests     INTEGER NOT NULL DEFAULT 0,
    input        INTEGER NOT NULL DEFAULT 0,
    output       INTEGER NOT NULL DEFAULT 0,
    cache_read   INTEGER NOT NULL DEFAULT 0,
    cache_write  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, agent_id, model)
) STRICT;

-- App-wide settings (the default model, ...).
CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
) STRICT;

-- +goose Down
DROP TABLE settings;
DROP TABLE usage;
DROP TABLE models;
DROP TABLE providers;
