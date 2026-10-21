package memory

import (
	"context"
	"slices"
	"strings"
	"unicode/utf8"
)

// Suggestions from conversations (M2): one system-wide switch, off by default. When it is on, the app asks an agent's
// model for what a conversation showed about the person, as suggestions (trust inferred, status suggested) they
// accept or dismiss in Settings → You.

// MaxCandidates is the most facts one extraction may suggest.
const MaxCandidates = 3

const suggestionsKey = "memory_suggestions"

// SuggestionsOn reports whether the person turned suggestions from conversations on.
func (s *Store) SuggestionsOn() bool {
	var v string
	s.db.QueryRow(`SELECT value FROM settings WHERE key = ?`, suggestionsKey).Scan(&v)
	return v == "on"
}

// SetSuggestions turns suggestions from conversations on or off.
func (s *Store) SetSuggestions(on bool) error {
	v := "off"
	if on {
		v = "on"
	}
	if _, err := s.db.Exec(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, suggestionsKey, v); err != nil {
		return err
	}
	s.OnChange("")
	return nil
}

// Candidate is a fact an agent's model found in a conversation.
type Candidate struct {
	Text     string `json:"text"`
	Category string `json:"category"`
}

// CleanCandidates keeps what can be a suggestion: one sentence of a fact, a known category (preferences when the
// model named none or an unknown one), no duplicates, at most MaxCandidates.
func CleanCandidates(in []Candidate) []Candidate {
	out := []Candidate{}
	seen := map[string]bool{}
	for _, c := range in {
		text, err := cleanText(c.Text)
		if err != nil || utf8.RuneCountInString(text) > 300 {
			continue
		}
		category := strings.ToLower(strings.TrimSpace(c.Category))
		if !slices.Contains(Categories, category) {
			category = "preferences"
		}
		key := category + "\x00" + strings.ToLower(text)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, Candidate{Text: text, Category: category})
		if len(out) == MaxCandidates {
			break
		}
	}
	return out
}

// Extraction is how far a conversation was checked.
type Extraction struct {
	Cursor  string // stable durable message ID (e<entry>[:<index>])
	ReplyAt int64  // the thread's last reply then (Unix ms)
}

// Extracted says how far a conversation was checked (zero when never).
func (s *Store) Extracted(ctx context.Context, agentID, threadID string) Extraction {
	var e Extraction
	s.db.QueryRowContext(ctx, `SELECT cursor, reply_at FROM memory_extractions WHERE agent_id = ? AND thread_id = ?`, agentID, threadID).Scan(&e.Cursor, &e.ReplyAt)
	return e
}

// SetExtracted records a successful extraction, including an empty result. Callers hold the thread claim.
func (s *Store) SetExtracted(ctx context.Context, agentID, threadID string, e Extraction) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO memory_extractions (agent_id, thread_id, cursor, reply_at, extracted_at) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (agent_id, thread_id) DO UPDATE SET cursor = excluded.cursor, reply_at = excluded.reply_at, extracted_at = excluded.extracted_at`,
		agentID, threadID, e.Cursor, e.ReplyAt, s.now().UnixMilli())
	return err
}

// ForgetThread drops what is kept about a conversation (threadID "": every conversation of the agent).
func (s *Store) ForgetThread(ctx context.Context, agentID, threadID string) {
	if threadID == "" {
		s.db.ExecContext(ctx, `DELETE FROM memory_extractions WHERE agent_id = ?`, agentID)
		return
	}
	s.db.ExecContext(ctx, `DELETE FROM memory_extractions WHERE agent_id = ? AND thread_id = ?`, agentID, threadID)
}
