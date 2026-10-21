-- +goose Up
-- The new config and revision commit together. agent.yaml is only a materialized
-- copy until its file and directory have been synced and this row is removed.
CREATE TABLE agent_config_materializations (
    agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    config BLOB NOT NULL
) STRICT;

-- +goose Down
DROP TABLE agent_config_materializations;
