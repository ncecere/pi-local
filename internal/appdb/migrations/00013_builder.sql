-- +goose Up
CREATE TABLE agent_creators (
    agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
    creator_id TEXT NOT NULL,
    request_key TEXT NOT NULL,
    UNIQUE (creator_id, request_key)
) STRICT;
-- Proposals are immutable snapshots, including defaults, approved before mutation.
-- No foreign key: replay after deletion must not create the agent again.
CREATE TABLE builder_requests (
    caller TEXT NOT NULL,
    request_key TEXT NOT NULL,
    input TEXT NOT NULL,
    proposal TEXT NOT NULL,
    target TEXT NOT NULL,
    approval_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    PRIMARY KEY (caller, request_key)
) STRICT;

-- +goose Down
DROP TABLE builder_requests;
DROP TABLE agent_creators;
