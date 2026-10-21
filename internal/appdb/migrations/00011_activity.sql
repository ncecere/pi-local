-- +goose Up

-- The audit log (docs/api.md, "Activity"): what agents did and what was done to them. Tool calls come from the runtimes
-- (the gateway's POST /activity, batched); the app writes the rest: messages sent, schedule runs, asks, approvals decided,
-- MCP sign-ins, budget refusals and errors. Kept 90 days, pruned daily. No conversation text beyond a short preview.
CREATE TABLE activity (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    at          INTEGER NOT NULL,               -- Unix ms: when it happened (a tool call: when it ended)
    kind        TEXT    NOT NULL,               -- tool, message, schedule, ask, approval, sign_in, budget, error
    agent_id    TEXT    NOT NULL DEFAULT '',    -- '' for what belongs to no agent (an MCP sign-in)
    agent_name  TEXT    NOT NULL DEFAULT '',    -- as it was named then (the entry outlives a deleted agent)
    thread_id   TEXT    NOT NULL DEFAULT '',
    actor       TEXT    NOT NULL DEFAULT '',    -- who: the agent, the person, a schedule, another agent, Pi Local
    title       TEXT    NOT NULL,               -- one line: the tool's name, "Message sent", …
    outcome     TEXT    NOT NULL DEFAULT '',    -- ok, error, denied, declined, refused, …
    duration_ms INTEGER,
    detail      TEXT    NOT NULL DEFAULT '{}',  -- JSON, bounded and redacted
    dedupe      TEXT                            -- one entry per key: a runtime may report a call twice
) STRICT;
CREATE INDEX activity_at ON activity (at DESC, id DESC);
CREATE INDEX activity_agent ON activity (agent_id, at DESC, id DESC);
CREATE INDEX activity_thread ON activity (agent_id, thread_id, at DESC) WHERE thread_id <> '';
CREATE UNIQUE INDEX activity_dedupe ON activity (dedupe) WHERE dedupe IS NOT NULL;

-- +goose Down
DROP TABLE activity;
