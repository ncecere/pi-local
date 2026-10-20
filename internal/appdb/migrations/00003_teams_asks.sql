-- +goose Up

-- Teams of agents: people chat with the lead; the lead may ask the members (and, with members_talk, members each other).
CREATE TABLE teams (
    id           TEXT PRIMARY KEY, -- tm_…
    name         TEXT    NOT NULL,
    description  TEXT    NOT NULL DEFAULT '',
    lead_id      TEXT    NOT NULL, -- an agent; RemoveAgent deletes the team with its lead (and says so)
    member_ids   TEXT    NOT NULL DEFAULT '[]', -- JSON array of agent IDs
    members_talk INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
) STRICT;

-- One agent asking another (ask_agent). Keyed by the caller's conversation and tool call, so a runtime that replays
-- the call finds the same ask. chain: the agents that led here (the caller's own chain plus the caller), for cycles
-- and the depth limit.
CREATE TABLE asks (
    id            TEXT PRIMARY KEY, -- ask_…
    caller_id     TEXT    NOT NULL,
    caller_thread TEXT    NOT NULL DEFAULT '',
    call_key      TEXT    NOT NULL,
    target_id     TEXT    NOT NULL,
    target_thread TEXT    NOT NULL,
    message       TEXT    NOT NULL,
    chain         TEXT    NOT NULL DEFAULT '[]',
    baseline      INTEGER NOT NULL DEFAULT -1, -- user messages in the target thread before this ask (-1: not counted yet)
    status        TEXT    NOT NULL DEFAULT 'pending', -- pending, done, failed
    result        TEXT,
    error         TEXT,
    created_at    INTEGER NOT NULL,
    finished_at   INTEGER,
    UNIQUE (caller_id, call_key)
) STRICT;
CREATE INDEX asks_pending ON asks (status) WHERE status = 'pending';
CREATE INDEX asks_by_target ON asks (target_id, target_thread);
CREATE INDEX asks_by_caller ON asks (caller_id, caller_thread, created_at);

-- Threads an agent was asked in name who asked.
ALTER TABLE threads ADD COLUMN called_by_agent TEXT;
ALTER TABLE threads ADD COLUMN called_by_thread TEXT;

-- +goose Down
ALTER TABLE threads DROP COLUMN called_by_thread;
ALTER TABLE threads DROP COLUMN called_by_agent;
DROP TABLE asks;
DROP TABLE teams;
