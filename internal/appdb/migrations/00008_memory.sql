-- +goose Up

-- What agents know about the person (Settings → You). The basics card is a setting (about_me); these are the facts
-- agents learned or the person added, by category. Each agent sees the basics and preferences, plus the categories
-- its agent.yaml shares (memory.share).
CREATE TABLE user_memories (
    id           TEXT    PRIMARY KEY,           -- um_…
    category     TEXT    NOT NULL,              -- preferences | people | projects | work | health | family | finances | home | interests
    text         TEXT    NOT NULL,
    trust        TEXT    NOT NULL,              -- said (the person's own words) | inferred | external (outside text)
    status       TEXT    NOT NULL,              -- active | suggested
    pinned       INTEGER NOT NULL DEFAULT 0,
    source_agent TEXT,                          -- the agent that saved it (NULL: the person)
    source_thread TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
) STRICT;
CREATE INDEX user_memories_by_status ON user_memories (status, category);

CREATE VIRTUAL TABLE user_memory_index USING fts5(
    id UNINDEXED,
    text,
    tokenize = 'unicode61 remove_diacritics 2'
);

-- +goose Down
DROP TABLE user_memory_index;
DROP TABLE user_memories;
