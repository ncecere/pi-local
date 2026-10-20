-- +goose Up

-- Tool calls waiting for a person's approval (docs/api.md, "Workspace tools, approvals and attachments"). The runtime
-- reports each request and keeps the wait in its own storage; the app keeps the request, decides when it expires,
-- and delivers decisions (waking the agent) until they land.
CREATE TABLE approvals (
    agent_id          TEXT    NOT NULL,
    id                TEXT    NOT NULL, -- ap_…, unique within its agent
    thread_id         TEXT,
    tool              TEXT    NOT NULL,
    call_id           TEXT    NOT NULL DEFAULT '',
    arguments         TEXT    NOT NULL DEFAULT 'null', -- a redacted, bounded JSON view
    summary           TEXT,
    status            TEXT    NOT NULL DEFAULT 'pending', -- pending, approved, denied, timed_out, cancelled
    requested_at      INTEGER NOT NULL,
    expires_at        INTEGER NOT NULL,
    decided_at        INTEGER,
    decided_by        TEXT,
    reason            TEXT,
    delivered         INTEGER NOT NULL DEFAULT 1, -- 0: a decision the runtime hasn't been told yet
    delivery_attempts INTEGER NOT NULL DEFAULT 0,
    next_delivery_at  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (agent_id, id)
) STRICT;
CREATE INDEX approvals_pending ON approvals (status, expires_at) WHERE status = 'pending';
CREATE INDEX approvals_undelivered ON approvals (next_delivery_at) WHERE delivered = 0;

-- +goose Down
DROP TABLE approvals;
