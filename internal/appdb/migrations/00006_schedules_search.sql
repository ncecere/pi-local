-- +goose Up

-- Scheduled messages to agents: a person's (made in the app) or an agent's own (its schedule tools). Each fire sends
-- the message to the agent (in a thread of its own, or the thread it was made in) with the fire's ID as the request ID.
CREATE TABLE schedules (
    id               TEXT PRIMARY KEY, -- sc_…
    agent_id         TEXT    NOT NULL,
    name             TEXT    NOT NULL,
    once             INTEGER NOT NULL DEFAULT 0,
    at               INTEGER, -- once: when (Unix ms)
    cron             TEXT,    -- recurring
    timezone         TEXT    NOT NULL DEFAULT 'UTC',
    message          TEXT    NOT NULL,
    thread_mode      TEXT    NOT NULL DEFAULT 'new', -- new: a thread per run; this: thread_id
    thread_id        TEXT,
    origin_thread_id TEXT,
    made_by          TEXT    NOT NULL DEFAULT 'user', -- user or agent
    missed_policy    TEXT    NOT NULL DEFAULT 'run_once', -- after the app was closed: skip, or run_once
    paused           INTEGER NOT NULL DEFAULT 0,
    paused_reason    TEXT,
    next_fire_at     INTEGER, -- NULL: no more fires (a reminder that fired)
    last_fire_at     INTEGER,
    failures         INTEGER NOT NULL DEFAULT 0,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
) STRICT;
CREATE INDEX schedules_due ON schedules (next_fire_at) WHERE paused = 0 AND next_fire_at IS NOT NULL;

CREATE TABLE schedule_runs (
    id          TEXT PRIMARY KEY, -- the fire's ID, also the message's request ID
    schedule_id TEXT    NOT NULL,
    agent_id    TEXT    NOT NULL,
    thread_id   TEXT    NOT NULL,
    fired_at    INTEGER NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'running', -- running, done, failed
    error       TEXT,
    finished_at INTEGER
) STRICT;
CREATE INDEX schedule_runs_by_schedule ON schedule_runs (schedule_id, fired_at DESC);
CREATE INDEX schedule_runs_running ON schedule_runs (agent_id, thread_id) WHERE status = 'running';

-- Search inside messages: each conversation's text (what people and agents said; not thinking or tool output),
-- kept current as replies finish and conversations are opened.
CREATE VIRTUAL TABLE message_index USING fts5(
    agent_id UNINDEXED,
    thread_id UNINDEXED,
    title,
    body,
    tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TABLE message_index_meta (
    agent_id   TEXT    NOT NULL,
    thread_id  TEXT    NOT NULL,
    indexed_at INTEGER NOT NULL,
    PRIMARY KEY (agent_id, thread_id)
) STRICT;

-- +goose Down
DROP TABLE message_index_meta;
DROP TABLE message_index;
DROP TABLE schedule_runs;
DROP TABLE schedules;
