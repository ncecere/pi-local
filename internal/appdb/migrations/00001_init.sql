-- +goose Up

-- Every agent the app manages. Its configuration is in its folder (agent.yaml); this row is what the app adds:
-- where the folder is, when it was used, and the newest pi-durable version that wrote its storage.
CREATE TABLE agents (
    id                 TEXT PRIMARY KEY,
    dir                TEXT    NOT NULL UNIQUE,
    revision           INTEGER NOT NULL DEFAULT 1,
    created_at         INTEGER NOT NULL, -- Unix ms
    updated_at         INTEGER NOT NULL,
    last_used_at       INTEGER,
    pi_durable_version TEXT
) STRICT;

-- The app's record of each agent's threads, so listing never starts a runtime. Kept current by the runtime's reports
-- (threads/sync at start, threads/report at each reply's end): the newest report by its own clock (status_at) wins.
CREATE TABLE threads (
    agent_id       TEXT    NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    thread_id      TEXT    NOT NULL,
    title          TEXT    NOT NULL,
    title_override TEXT,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    busy           INTEGER NOT NULL DEFAULT 0,
    last_reply_at  INTEGER,
    last_error     TEXT,
    status_at      INTEGER NOT NULL, -- the clock of the newest report applied
    recorded_at    INTEGER NOT NULL, -- when the app first wrote the record (a sync ignores records younger than 5 min)
    PRIMARY KEY (agent_id, thread_id)
) STRICT;
CREATE INDEX threads_by_activity ON threads (agent_id, updated_at DESC);

-- The person's preferences (appearance, inbox state), as the chat UI saves them: one JSON object per key.
CREATE TABLE prefs (
    key        TEXT PRIMARY KEY,
    value      TEXT    NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;

-- +goose Down
DROP TABLE prefs;
DROP TABLE threads;
DROP TABLE agents;
