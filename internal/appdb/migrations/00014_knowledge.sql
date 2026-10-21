-- +goose Up

-- Knowledge folders (internal/knowledge): the documents in the folders agents were given, split into passages and
-- searchable (FTS5). The index is per folder, shared by the agents that use it, and can always be rebuilt from the
-- files (the app reads the folders again on start and watches them).
CREATE TABLE knowledge_folders (
    path       TEXT PRIMARY KEY,           -- absolute
    scanned_at INTEGER,                    -- Unix ms: when the last full scan finished (NULL: not yet)
    truncated  INTEGER NOT NULL DEFAULT 0, -- more files than the cap: only the first ones are indexed
    error      TEXT    NOT NULL DEFAULT '' -- the folder itself: missing, not a folder
) STRICT;

CREATE TABLE knowledge_files (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    folder     TEXT    NOT NULL,           -- knowledge_folders.path
    rel        TEXT    NOT NULL,           -- path inside the folder, with /
    size       INTEGER NOT NULL,
    mtime      INTEGER NOT NULL,           -- Unix ns, as seen when it was read
    status     TEXT    NOT NULL,           -- indexed, partial, empty, error, too_large
    error      TEXT    NOT NULL DEFAULT '',-- why (error, too_large, partial)
    passages   INTEGER NOT NULL DEFAULT 0,
    indexed_at INTEGER NOT NULL,
    UNIQUE (folder, rel)
) STRICT;

CREATE TABLE knowledge_passages (
    id      INTEGER PRIMARY KEY,
    file_id INTEGER NOT NULL,
    ord     INTEGER NOT NULL,              -- position in the file
    locator TEXT    NOT NULL DEFAULT '',   -- page 4, sheet Budget, slide 2, section "…"
    title   TEXT    NOT NULL,              -- the file's path inside its folder (searched too)
    body    TEXT    NOT NULL
) STRICT;
CREATE INDEX knowledge_passages_by_file ON knowledge_passages (file_id, ord);

-- The text index reads its content from knowledge_passages, so the text is stored once.
CREATE VIRTUAL TABLE knowledge_fts USING fts5(
    title,
    body,
    content = 'knowledge_passages',
    content_rowid = 'id',
    tokenize = 'porter unicode61 remove_diacritics 2'
);

-- +goose StatementBegin
CREATE TRIGGER knowledge_passages_ai AFTER INSERT ON knowledge_passages BEGIN
    INSERT INTO knowledge_fts (rowid, title, body) VALUES (new.id, new.title, new.body);
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER knowledge_passages_ad AFTER DELETE ON knowledge_passages BEGIN
    INSERT INTO knowledge_fts (knowledge_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
END;
-- +goose StatementEnd

-- +goose Down
DROP TRIGGER knowledge_passages_ad;
DROP TRIGGER knowledge_passages_ai;
DROP TABLE knowledge_fts;
DROP TABLE knowledge_passages;
DROP TABLE knowledge_files;
DROP TABLE knowledge_folders;
