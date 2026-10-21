-- +goose Up

-- What a fact said before the person (or an accepted edit) changed its text or category: "Changed from … on Oct 21"
-- under the fact in Settings → You. One row per change, kept as long as the fact is.
CREATE TABLE user_memory_history (
    id         INTEGER PRIMARY KEY,
    memory_id  TEXT    NOT NULL,           -- um_…
    category   TEXT    NOT NULL,           -- what it was
    text       TEXT    NOT NULL,           -- what it said
    changed_at INTEGER NOT NULL
) STRICT;
CREATE INDEX user_memory_history_by_fact ON user_memory_history (memory_id, changed_at);

-- Which conversations were checked for suggestions, and how far (the number of messages read), so a conversation is
-- read once per reply and only its new part.
CREATE TABLE memory_extractions (
    agent_id     TEXT    NOT NULL,
    thread_id    TEXT    NOT NULL,
    messages     INTEGER NOT NULL,
    reply_at     INTEGER NOT NULL,         -- the thread's last reply when it was checked (Unix ms)
    extracted_at INTEGER NOT NULL,
    PRIMARY KEY (agent_id, thread_id)
) STRICT;

-- +goose Down
DROP TABLE memory_extractions;
DROP TABLE user_memory_history;
