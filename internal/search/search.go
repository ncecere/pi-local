// Package search keeps a searchable copy of what was said in every conversation (SQLite FTS5 in app.db): the text
// of people's and agents' messages, never thinking or tool output. It is kept current as replies end and
// conversations are opened; the agents' own storage stays the record.
package search

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"time"
	"unicode"
)

const maxBodyChars = 200_000

// Store is the index.
type Store struct {
	db *sql.DB
}

// New makes the store.
func New(db *sql.DB) *Store { return &Store{db: db} }

// Text is what a view's messages say, for the index: user and assistant text, one paragraph each.
func Text(view json.RawMessage) string {
	var v struct {
		Messages []struct {
			Role string `json:"role"`
			Text string `json:"text"`
		} `json:"messages"`
	}
	if json.Unmarshal(view, &v) != nil {
		return ""
	}
	var b strings.Builder
	for _, m := range v.Messages {
		if (m.Role != "user" && m.Role != "assistant") || strings.TrimSpace(m.Text) == "" {
			continue
		}
		if b.Len() > 0 {
			b.WriteString("\n\n")
		}
		b.WriteString(m.Text)
		if b.Len() > maxBodyChars {
			break
		}
	}
	out := b.String()
	if r := []rune(out); len(r) > maxBodyChars {
		out = string(r[:maxBodyChars])
	}
	return out
}

// Put replaces a conversation's indexed text.
func (s *Store) Put(ctx context.Context, agentID, threadID, title, body string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `DELETE FROM message_index WHERE agent_id = ? AND thread_id = ?`, agentID, threadID); err != nil {
		return err
	}
	if strings.TrimSpace(body) != "" {
		if _, err := tx.ExecContext(ctx, `INSERT INTO message_index (agent_id, thread_id, title, body) VALUES (?, ?, ?, ?)`, agentID, threadID, title, body); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO message_index_meta (agent_id, thread_id, indexed_at) VALUES (?, ?, ?)
		ON CONFLICT (agent_id, thread_id) DO UPDATE SET indexed_at = excluded.indexed_at`, agentID, threadID, time.Now().UnixMilli()); err != nil {
		return err
	}
	return tx.Commit()
}

// Forget removes a conversation (agentID with threadID "": every conversation of the agent).
func (s *Store) Forget(ctx context.Context, agentID, threadID string) {
	if threadID == "" {
		s.db.ExecContext(ctx, `DELETE FROM message_index WHERE agent_id = ?`, agentID)
		s.db.ExecContext(ctx, `DELETE FROM message_index_meta WHERE agent_id = ?`, agentID)
		return
	}
	s.db.ExecContext(ctx, `DELETE FROM message_index WHERE agent_id = ? AND thread_id = ?`, agentID, threadID)
	s.db.ExecContext(ctx, `DELETE FROM message_index_meta WHERE agent_id = ? AND thread_id = ?`, agentID, threadID)
}

// Terms are the words of a query, at least two characters each.
func Terms(q string) []string {
	var out []string
	for _, w := range strings.FieldsFunc(q, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) }) {
		if len([]rune(w)) >= 2 {
			out = append(out, strings.ToLower(w))
		}
		if len(out) == 10 {
			break
		}
	}
	return out
}

// Hit is one conversation matching a search.
type Hit struct {
	AgentID   string `json:"agentId"`
	ThreadID  string `json:"threadId"`
	Snippet   string `json:"snippet"` // matches between \u0001 and \u0002
	IndexedAt string `json:"indexedAt"`
}

// Search finds conversations with every word of q (each word matching the start of a word), best first.
func (s *Store) Search(ctx context.Context, q string, limit int) ([]Hit, error) {
	return s.SearchAgent(ctx, "", q, limit)
}

// SearchAgent is Search within one agent's conversations (agentID "": everyone's). An agent's own search tool uses
// it with its own ID, so it never reads another agent's conversations.
func (s *Store) SearchAgent(ctx context.Context, agentID, q string, limit int) ([]Hit, error) {
	terms := Terms(q)
	if len(terms) == 0 {
		return []Hit{}, nil
	}
	// Each term quoted (no FTS5 syntax gets through) as a prefix query.
	parts := make([]string, len(terms))
	for i, t := range terms {
		parts[i] = `"` + strings.ReplaceAll(t, `"`, `""`) + `"*`
	}
	rows, err := s.db.QueryContext(ctx, `SELECT i.agent_id, i.thread_id, snippet(message_index, 3, char(1), char(2), '…', 16), COALESCE(m.indexed_at, 0)
		FROM message_index i LEFT JOIN message_index_meta m ON m.agent_id = i.agent_id AND m.thread_id = i.thread_id
		WHERE message_index MATCH ? AND (? = '' OR i.agent_id = ?) ORDER BY rank LIMIT ?`, strings.Join(parts, " "), agentID, agentID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Hit{}
	for rows.Next() {
		var h Hit
		var at int64
		if err := rows.Scan(&h.AgentID, &h.ThreadID, &h.Snippet, &at); err != nil {
			return nil, err
		}
		h.IndexedAt = time.UnixMilli(at).UTC().Format(time.RFC3339)
		out = append(out, h)
	}
	return out, rows.Err()
}
