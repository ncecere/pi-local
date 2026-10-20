-- +goose Up

-- MCP servers agents may use. Env and header values and OAuth state are in the OS keychain (internal/secrets); this
-- row keeps their names, and the tools the last test found.
CREATE TABLE mcp_servers (
    slug                TEXT PRIMARY KEY, -- the tool prefix: mcp__<slug>__<tool>
    name                TEXT    NOT NULL,
    description         TEXT    NOT NULL DEFAULT '',
    transport           TEXT    NOT NULL, -- stdio or http
    command             TEXT,
    args                TEXT    NOT NULL DEFAULT '[]',
    cwd                 TEXT,
    env_names           TEXT    NOT NULL DEFAULT '[]',
    url                 TEXT,
    header_names        TEXT    NOT NULL DEFAULT '[]',
    oauth               INTEGER NOT NULL DEFAULT 0,
    oauth_redirect_url  TEXT, -- the loopback redirect the client was registered with
    enabled             INTEGER NOT NULL DEFAULT 1,
    tools               TEXT    NOT NULL DEFAULT '[]',
    tested_at           INTEGER,
    last_error          TEXT,
    imported_from       TEXT,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
) STRICT;

-- +goose Down
DROP TABLE mcp_servers;
