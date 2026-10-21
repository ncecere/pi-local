package knowledge

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"time"
)

// File statuses.
const (
	StatusIndexed  = "indexed"
	StatusPartial  = "partial"   // indexed, but only the first part (a huge file)
	StatusEmpty    = "empty"     // read, and there is no text in it
	StatusError    = "error"     // could not be read (a damaged or protected file, a scanned PDF)
	StatusTooLarge = "too_large" // over the size limit: not read
)

// Store is the index in app.db. app.db has one connection: a method never starts another query while its rows are
// open, so each one reads its rows into memory before it does anything else.
type Store struct {
	db *sql.DB
}

// NewStore makes the store.
func NewStore(db *sql.DB) *Store { return &Store{db: db} }

type fileRow struct {
	ID     int64
	Rel    string
	Size   int64
	MTime  int64
	Status string
	Error  string
}

// files are every file the index has for a folder.
func (s *Store) files(ctx context.Context, folder string) ([]fileRow, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, rel, size, mtime, status, error FROM knowledge_files WHERE folder = ?`, folder)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []fileRow
	for rows.Next() {
		var f fileRow
		if err := rows.Scan(&f.ID, &f.Rel, &f.Size, &f.MTime, &f.Status, &f.Error); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// put replaces a file's passages and its row (the stat the file had when it was read).
func (s *Store) put(ctx context.Context, folder, rel string, size, mtime int64, status, problem string, passages []Passage) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var id int64
	err = tx.QueryRowContext(ctx, `SELECT id FROM knowledge_files WHERE folder = ? AND rel = ?`, folder, rel).Scan(&id)
	switch {
	case err == sql.ErrNoRows:
		id = 0
	case err != nil:
		return err
	}
	now := time.Now().UnixMilli()
	if id == 0 {
		res, err := tx.ExecContext(ctx, `INSERT INTO knowledge_files (folder, rel, size, mtime, status, error, passages, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			folder, rel, size, mtime, status, problem, len(passages), now)
		if err != nil {
			return err
		}
		if id, err = res.LastInsertId(); err != nil {
			return err
		}
	} else {
		if _, err := tx.ExecContext(ctx, `DELETE FROM knowledge_passages WHERE file_id = ?`, id); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE knowledge_files SET size = ?, mtime = ?, status = ?, error = ?, passages = ?, indexed_at = ? WHERE id = ?`,
			size, mtime, status, problem, len(passages), now, id); err != nil {
			return err
		}
	}
	if len(passages) > 0 {
		stmt, err := tx.PrepareContext(ctx, `INSERT INTO knowledge_passages (file_id, ord, locator, title, body) VALUES (?, ?, ?, ?, ?)`)
		if err != nil {
			return err
		}
		defer stmt.Close()
		for i, p := range passages {
			if _, err := stmt.ExecContext(ctx, id, i, p.Locator, rel, p.Text); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}

// remove deletes a file and its passages.
func (s *Store) remove(ctx context.Context, id int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `DELETE FROM knowledge_passages WHERE file_id = ?`, id); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM knowledge_files WHERE id = ?`, id); err != nil {
		return err
	}
	return tx.Commit()
}

// forget deletes everything about a folder.
func (s *Store) forget(ctx context.Context, folder string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `DELETE FROM knowledge_passages WHERE file_id IN (SELECT id FROM knowledge_files WHERE folder = ?)`, folder); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM knowledge_files WHERE folder = ?`, folder); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM knowledge_folders WHERE path = ?`, folder); err != nil {
		return err
	}
	return tx.Commit()
}

// folderPaths are the folders the index has anything for.
func (s *Store) folderPaths(ctx context.Context) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT path FROM knowledge_folders UNION SELECT DISTINCT folder FROM knowledge_files`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// folderRow is what a scan recorded about a folder.
type folderRow struct {
	ScannedAt *int64
	Truncated bool
	Error     string
}

func (s *Store) folder(ctx context.Context, path string) (folderRow, error) {
	var f folderRow
	var at sql.NullInt64
	var truncated int
	err := s.db.QueryRowContext(ctx, `SELECT scanned_at, truncated, error FROM knowledge_folders WHERE path = ?`, path).Scan(&at, &truncated, &f.Error)
	if err == sql.ErrNoRows {
		return folderRow{}, nil
	}
	if err != nil {
		return folderRow{}, err
	}
	if at.Valid {
		f.ScannedAt = &at.Int64
	}
	f.Truncated = truncated != 0
	return f, nil
}

func (s *Store) setFolder(ctx context.Context, path string, scannedAt *int64, truncated bool, problem string) error {
	t := 0
	if truncated {
		t = 1
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO knowledge_folders (path, scanned_at, truncated, error) VALUES (?, ?, ?, ?)
		ON CONFLICT (path) DO UPDATE SET scanned_at = COALESCE(excluded.scanned_at, knowledge_folders.scanned_at), truncated = excluded.truncated, error = excluded.error`,
		path, scannedAt, t, problem)
	return err
}

// Counts is what the index holds for a folder.
type Counts struct {
	Files    int // read, with text (indexed and partial)
	Passages int
	Problems int // could not be read
	TooLarge int
	Partial  int
}

func (s *Store) counts(ctx context.Context, folder string) (Counts, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT status, COUNT(*), COALESCE(SUM(passages), 0) FROM knowledge_files WHERE folder = ? GROUP BY status`, folder)
	if err != nil {
		return Counts{}, err
	}
	defer rows.Close()
	var c Counts
	for rows.Next() {
		var status string
		var n, passages int
		if err := rows.Scan(&status, &n, &passages); err != nil {
			return Counts{}, err
		}
		switch status {
		case StatusIndexed:
			c.Files += n
		case StatusPartial:
			c.Files += n
			c.Partial += n
		case StatusError:
			c.Problems += n
		case StatusTooLarge:
			c.TooLarge += n
		}
		c.Passages += passages
	}
	return c, rows.Err()
}

// Problem is a file that could not be indexed, or only in part.
type Problem struct {
	Folder  string `json:"folder"`
	Path    string `json:"path"`
	Rel     string `json:"rel"`
	Status  string `json:"status"`
	Message string `json:"message"`
}

func (s *Store) problems(ctx context.Context, folder string, limit int) ([]Problem, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT rel, status, error FROM knowledge_files WHERE folder = ? AND status IN ('error', 'too_large', 'partial') ORDER BY rel LIMIT ?`, folder, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Problem{}
	for rows.Next() {
		p := Problem{Folder: folder}
		if err := rows.Scan(&p.Rel, &p.Status, &p.Message); err != nil {
			return nil, err
		}
		p.Path = filepath.Join(folder, filepath.FromSlash(p.Rel))
		out = append(out, p)
	}
	return out, rows.Err()
}

// hasFile says whether a file (by its path in a folder) is in the index with its text.
func (s *Store) hasFile(ctx context.Context, folder, rel string) (bool, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM knowledge_files WHERE folder = ? AND rel = ? AND status IN ('indexed', 'partial', 'empty')`, folder, rel).Scan(&n)
	return n > 0, err
}

// Hit is one passage a search found.
type Hit struct {
	Folder  string  `json:"folder"`
	Rel     string  `json:"rel"`
	Path    string  `json:"path"` // absolute
	File    string  `json:"file"` // the file's name
	Locator string  `json:"locator,omitempty"`
	Text    string  `json:"text"`
	Ord     int     `json:"ord"`
	Score   float64 `json:"score"` // bm25: lower is better; not shown
}

// stopwords are left out of a question before it is searched (the index ranks by how many of the rest a passage has).
var stopwords = func() map[string]bool {
	m := map[string]bool{}
	for _, w := range strings.Fields(`a an and are as at be been but by can could did do does for from had has have how i if in into is it its
		me my of on or our shall she should so than that the their them then there these they this those to was we were what when where
		which who whom why will with would you your about any all also not no yes tell give show find please`) {
		m[w] = true
	}
	return m
}()

// matchQuery makes an FTS5 query from words: each quoted (no FTS5 syntax gets through) as a prefix, any of them
// matching (the ranking puts passages with more of them first). Questions are cleaned of filler words, unless that
// leaves nothing.
func matchQuery(terms []string) string {
	var keep []string
	for _, t := range terms {
		if !stopwords[t] {
			keep = append(keep, t)
		}
	}
	if len(keep) == 0 {
		keep = terms
	}
	parts := make([]string, len(keep))
	for i, t := range keep {
		parts[i] = `"` + strings.ReplaceAll(t, `"`, `""`) + `"*`
	}
	return strings.Join(parts, " OR ")
}

// search finds the best passages for terms in the folders, best first.
func (s *Store) search(ctx context.Context, folders []string, terms []string, limit int) ([]Hit, error) {
	if len(folders) == 0 || len(terms) == 0 {
		return []Hit{}, nil
	}
	marks := strings.TrimSuffix(strings.Repeat("?,", len(folders)), ",")
	args := []any{matchQuery(terms)}
	for _, f := range folders {
		args = append(args, f)
	}
	args = append(args, limit)
	// The file's name counts four times a word in the text.
	rows, err := s.db.QueryContext(ctx, `SELECT f.folder, f.rel, p.locator, p.ord, p.body, bm25(knowledge_fts, 4.0, 1.0) AS score
		FROM knowledge_fts JOIN knowledge_passages p ON p.id = knowledge_fts.rowid JOIN knowledge_files f ON f.id = p.file_id
		WHERE knowledge_fts MATCH ? AND f.folder IN (`+marks+`)
		ORDER BY score LIMIT ?`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Hit{}
	for rows.Next() {
		var h Hit
		if err := rows.Scan(&h.Folder, &h.Rel, &h.Locator, &h.Ord, &h.Text, &h.Score); err != nil {
			return nil, err
		}
		h.Path = filepath.Join(h.Folder, filepath.FromSlash(h.Rel))
		h.File = filepath.Base(h.Path)
		out = append(out, h)
	}
	return out, rows.Err()
}
