// Package memory is what agents know about the person, and what each agent knows about itself and its job.
//
//   - About you: a basics card the person writes (name, role, time zone …) and facts agents learned or the person
//     added, by category, in app.db. Every agent sees the basics and preferences; other categories only when its
//     agent.yaml shares them. Facts from outside text (a web page, mail, a tool result) are kept but never shown in
//     the always-on profile; facts an agent concluded, or saved when the person wasn't there, wait as suggestions.
//   - Agent notes: what an agent learned about its own job, in memory.json in its folder (they travel with it).
//
// Both reach an agent every turn as a short section (Context), and through its recall tool.
package memory

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// Categories of facts about the person. "preferences" counts as basics: every agent sees it.
var Categories = []string{"preferences", "people", "projects", "work", "health", "family", "finances", "home", "interests"}

// Shareable are the categories an agent sees only when its agent.yaml shares them.
var Shareable = []string{"people", "projects", "work", "health", "family", "finances", "home", "interests"}

// Basics is the person's About me card.
type Basics struct {
	Name         string `json:"name"`
	Role         string `json:"role"`
	Organization string `json:"organization"`
	Timezone     string `json:"timezone"`
	Language     string `json:"language"`
	AddressAs    string `json:"addressAs"`   // how agents should address them
	AnswerStyle  string `json:"answerStyle"` // e.g. "short and direct"
	SignOff      string `json:"signOff"`     // how to sign messages written for them
}

// Fact is something about the person.
type Fact struct {
	ID           string  `json:"id"`
	Category     string  `json:"category"`
	Text         string  `json:"text"`
	Trust        string  `json:"trust"`  // said | inferred | external
	Status       string  `json:"status"` // active | suggested
	Pinned       bool    `json:"pinned"`
	SourceAgent  *string `json:"sourceAgent"`
	SourceThread *string `json:"sourceThread"`
	CreatedAt    int64   `json:"createdAt"`
	UpdatedAt    int64   `json:"updatedAt"`
	// History: what it said before each change of its text or category, newest first ("Changed from … on Oct 21").
	History []Revision `json:"history"`
}

// Revision is what a fact was before it changed.
type Revision struct {
	Text     string `json:"text"`
	Category string `json:"category"`
	At       int64  `json:"at"` // when it changed (Unix ms)
}

// maxHistory is how many past versions a fact keeps.
const maxHistory = 20

// Note is something an agent learned about its own job.
type Note struct {
	ID        string  `json:"id"`
	Text      string  `json:"text"`
	Thread    *string `json:"thread,omitempty"`
	CreatedAt int64   `json:"createdAt"`
	UpdatedAt int64   `json:"updatedAt"`
}

// Error is a refusal for people (or an agent's model).
type Error struct {
	Status  int
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Message }

// HTTPStatus is the error as an HTTP answer.
func (e *Error) HTTPStatus() (int, string, string) { return e.Status, e.Code, e.Message }

func bad(code, format string, args ...any) error {
	return &Error{Status: http.StatusBadRequest, Code: code, Message: fmt.Sprintf(format, args...)}
}

// ErrNotFound: no such memory.
var ErrNotFound = &Error{Status: http.StatusNotFound, Code: "not_found", Message: "That memory isn't there any more."}

const (
	maxText       = 1000
	maxFacts      = 5000
	maxNotes      = 500
	profileBudget = 4000 // characters (~1,000 tokens) of "about you" every turn
	notesBudget   = 3000 // characters of an agent's own notes every turn
)

// Store keeps both kinds.
type Store struct {
	db      *sql.DB
	factMu  sync.Mutex // serialize duplicate checks and inserts across idle, compaction and remember
	notesMu sync.Mutex
	now     func() time.Time
	// OnChange is told when the person's memory or an agent's notes change (agentID "" for the person's).
	OnChange func(agentID string)
}

// New makes the store.
func New(db *sql.DB) *Store {
	return &Store{db: db, now: time.Now, OnChange: func(string) {}}
}

func newID(prefix string) string {
	b := make([]byte, 10)
	rand.Read(b)
	const alphabet = "abcdefghijklmnopqrstuvwxyz234567"
	out := make([]byte, len(b))
	for i, c := range b {
		out[i] = alphabet[int(c)%len(alphabet)]
	}
	return prefix + string(out)
}

func cleanText(s string) (string, error) {
	s = strings.Join(strings.Fields(strings.ToValidUTF8(s, "")), " ")
	if s == "" || utf8.RuneCountInString(s) > maxText {
		return "", bad("invalid_text", "A memory is 1 to %d characters.", maxText)
	}
	return s, nil
}

// --- the person's basics ------------------------------------------------------------------------------------------

// GetBasics reads the About me card; fields not set yet come from defaults (the computer's name, time zone, language).
func (s *Store) GetBasics(defaults Basics) Basics {
	var raw string
	s.db.QueryRow(`SELECT value FROM settings WHERE key = 'about_me'`).Scan(&raw)
	var b Basics
	if raw == "" || json.Unmarshal([]byte(raw), &b) != nil {
		return defaults
	}
	return b
}

// HasBasics reports whether the person has saved the card.
func (s *Store) HasBasics() bool {
	var raw string
	s.db.QueryRow(`SELECT value FROM settings WHERE key = 'about_me'`).Scan(&raw)
	return raw != ""
}

// SetBasics saves the About me card.
func (s *Store) SetBasics(b Basics) (Basics, error) {
	for _, f := range []*string{&b.Name, &b.Role, &b.Organization, &b.Timezone, &b.Language, &b.AddressAs, &b.AnswerStyle, &b.SignOff} {
		*f = strings.TrimSpace(*f)
		if utf8.RuneCountInString(*f) > 200 || strings.ContainsAny(*f, "\r\n") {
			return Basics{}, bad("invalid_basics", "Each field is one line of at most 200 characters.")
		}
	}
	raw, _ := json.Marshal(b)
	if _, err := s.db.Exec(`INSERT INTO settings (key, value) VALUES ('about_me', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, string(raw)); err != nil {
		return Basics{}, err
	}
	s.OnChange("")
	return b, nil
}

// --- facts about the person -----------------------------------------------------------------------------------------

const factCols = `id, category, text, trust, status, pinned, source_agent, source_thread, created_at, updated_at`

func scanFact(row interface{ Scan(...any) error }) (*Fact, error) {
	var f Fact
	var pinned int
	var agent, thread sql.NullString
	if err := row.Scan(&f.ID, &f.Category, &f.Text, &f.Trust, &f.Status, &pinned, &agent, &thread, &f.CreatedAt, &f.UpdatedAt); err != nil {
		return nil, err
	}
	f.Pinned = pinned != 0
	f.History = []Revision{}
	if agent.Valid {
		f.SourceAgent = &agent.String
	}
	if thread.Valid {
		f.SourceThread = &thread.String
	}
	return &f, nil
}

// Facts lists facts (all statuses when status is ""), newest first. Rows are read and closed before anything else
// queries (app.db has one connection).
func (s *Store) Facts(ctx context.Context, status string) ([]*Fact, error) {
	q := `SELECT ` + factCols + ` FROM user_memories`
	var args []any
	if status != "" {
		q += ` WHERE status = ?`
		args = append(args, status)
	}
	rows, err := s.db.QueryContext(ctx, q+` ORDER BY pinned DESC, updated_at DESC`, args...)
	if err != nil {
		return nil, err
	}
	var out []*Fact
	for rows.Next() {
		f, err := scanFact(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, f)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, s.attachHistory(ctx, out)
}

// attachHistory fills the facts' history (one query, after the facts' rows are closed).
func (s *Store) attachHistory(ctx context.Context, facts []*Fact) error {
	if len(facts) == 0 {
		return nil
	}
	byID := make(map[string]*Fact, len(facts))
	for _, f := range facts {
		byID[f.ID] = f
	}
	rows, err := s.db.QueryContext(ctx, `SELECT memory_id, text, category, changed_at FROM user_memory_history ORDER BY changed_at DESC, id DESC`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var r Revision
		if err := rows.Scan(&id, &r.Text, &r.Category, &r.At); err != nil {
			return err
		}
		if f, ok := byID[id]; ok {
			f.History = append(f.History, r)
		}
	}
	return rows.Err()
}

// Fact reads one.
func (s *Store) Fact(ctx context.Context, id string) (*Fact, error) {
	f, err := scanFact(s.db.QueryRowContext(ctx, `SELECT `+factCols+` FROM user_memories WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT text, category, changed_at FROM user_memory_history WHERE memory_id = ? ORDER BY changed_at DESC, id DESC`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var r Revision
		if err := rows.Scan(&r.Text, &r.Category, &r.At); err != nil {
			return nil, err
		}
		f.History = append(f.History, r)
	}
	return f, rows.Err()
}

// FactInput is a fact to save.
type FactInput struct {
	Category string
	Text     string
	// Trust: said (the person's words, they were there), inferred, external (outside text).
	Trust string
	// Active: save it as known (the person added it, or said it); otherwise it waits as a suggestion.
	Active       bool
	Pinned       bool
	SourceAgent  string
	SourceThread string
}

// AddFact saves a fact. The same text in the same category isn't saved twice (the existing one is returned, made
// active if this one would be).
func (s *Store) AddFact(ctx context.Context, in FactInput) (*Fact, error) {
	s.factMu.Lock()
	defer s.factMu.Unlock()
	text, err := cleanText(in.Text)
	if err != nil {
		return nil, err
	}
	if !slices.Contains(Categories, in.Category) {
		return nil, bad("invalid_category", "A category is one of: %s.", strings.Join(Categories, ", "))
	}
	if in.Trust != "said" && in.Trust != "inferred" && in.Trust != "external" {
		return nil, bad("invalid_trust", "Trust is said, inferred or external.")
	}
	var existing string
	s.db.QueryRowContext(ctx, `SELECT id FROM user_memories WHERE category = ? AND lower(text) = lower(?)`, in.Category, text).Scan(&existing)
	if existing != "" {
		if in.Active {
			s.db.ExecContext(ctx, `UPDATE user_memories SET status = 'active', updated_at = ? WHERE id = ?`, s.now().UnixMilli(), existing)
			s.OnChange("")
		}
		return s.Fact(ctx, existing)
	}
	var count int
	s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM user_memories`).Scan(&count)
	if count >= maxFacts {
		return nil, &Error{Status: http.StatusConflict, Code: "full", Message: "Memory is full: delete some things in Settings → You."}
	}
	status := "suggested"
	if in.Active {
		status = "active"
	}
	now := s.now().UnixMilli()
	id := newID("um_")
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `INSERT INTO user_memories (`+factCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, in.Category, text, in.Trust, status, boolInt(in.Pinned), nullable(in.SourceAgent), nullable(in.SourceThread), now, now); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO user_memory_index (id, text) VALUES (?, ?)`, id, text); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	s.OnChange("")
	return s.Fact(ctx, id)
}

// FactChange edits a fact (the person, in Settings → You).
type FactChange struct {
	Category *string `json:"category"`
	Text     *string `json:"text"`
	Pinned   *bool   `json:"pinned"`
	// Accept makes a suggestion known (trust becomes inferred if it was outside text the person vouched for).
	Accept *bool `json:"accept"`
}

// UpdateFact changes a fact.
func (s *Store) UpdateFact(ctx context.Context, id string, ch FactChange) (*Fact, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	// Read on the transaction's connection: concurrent edits must snapshot the preceding edit,
	// not a version read before waiting for app.db's single connection.
	f, err := scanFact(tx.QueryRowContext(ctx, `SELECT `+factCols+` FROM user_memories WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	before := Revision{Text: f.Text, Category: f.Category}
	if ch.Category != nil {
		if !slices.Contains(Categories, *ch.Category) {
			return nil, bad("invalid_category", "A category is one of: %s.", strings.Join(Categories, ", "))
		}
		f.Category = *ch.Category
	}
	if ch.Text != nil {
		if f.Text, err = cleanText(*ch.Text); err != nil {
			return nil, err
		}
		// The person wrote it: their own words now.
		f.Trust = "said"
	}
	if ch.Pinned != nil {
		f.Pinned = *ch.Pinned
	}
	if ch.Accept != nil && *ch.Accept {
		f.Status = "active"
		if f.Trust == "external" {
			f.Trust = "inferred"
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE user_memories SET category = ?, text = ?, trust = ?, status = ?, pinned = ?, updated_at = ? WHERE id = ?`,
		f.Category, f.Text, f.Trust, f.Status, boolInt(f.Pinned), s.now().UnixMilli(), id); err != nil {
		return nil, err
	}
	if ch.Text != nil {
		if _, err := tx.ExecContext(ctx, `DELETE FROM user_memory_index WHERE id = ?`, id); err != nil {
			return nil, err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO user_memory_index (id, text) VALUES (?, ?)`, id, f.Text); err != nil {
			return nil, err
		}
	}
	// What it said before, when its words or category changed (not for a pin or an accept).
	if f.Text != before.Text || f.Category != before.Category {
		if _, err := tx.ExecContext(ctx, `INSERT INTO user_memory_history (memory_id, text, category, changed_at) VALUES (?, ?, ?, ?)`,
			id, before.Text, before.Category, s.now().UnixMilli()); err != nil {
			return nil, err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM user_memory_history WHERE memory_id = ? AND id NOT IN
			(SELECT id FROM user_memory_history WHERE memory_id = ? ORDER BY changed_at DESC, id DESC LIMIT ?)`, id, id, maxHistory); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	s.OnChange("")
	return s.Fact(ctx, id)
}

// DeleteFact forgets a fact (deleted means deleted).
func (s *Store) DeleteFact(ctx context.Context, id string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `DELETE FROM user_memories WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM user_memory_index WHERE id = ?`, id); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM user_memory_history WHERE memory_id = ?`, id); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.OnChange("")
	return nil
}

// EraseFacts forgets everything about the person (the basics card too).
func (s *Store) EraseFacts(ctx context.Context) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, q := range []string{`DELETE FROM user_memories`, `DELETE FROM user_memory_index`, `DELETE FROM user_memory_history`, `DELETE FROM settings WHERE key = 'about_me'`} {
		if _, err := tx.ExecContext(ctx, q); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.OnChange("")
	return nil
}

// visible reports whether an agent that shares these categories may see a fact.
func visible(f *Fact, share []string) bool {
	return f.Status == "active" && (f.Category == "preferences" || slices.Contains(share, f.Category))
}

// SearchFacts finds active facts an agent may see, matching a query (all when empty), best first.
func (s *Store) SearchFacts(ctx context.Context, query string, share []string, limit int) ([]*Fact, error) {
	limit = min(max(limit, 1), 50)
	var ids []string
	if q := ftsQuery(query); q != "" {
		rows, err := s.db.QueryContext(ctx, `SELECT id FROM user_memory_index WHERE user_memory_index MATCH ? ORDER BY rank LIMIT 200`, q)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id string
			rows.Scan(&id)
			ids = append(ids, id)
		}
		rows.Close()
	}
	all, err := s.Facts(ctx, "active")
	if err != nil {
		return nil, err
	}
	byID := map[string]*Fact{}
	for _, f := range all {
		byID[f.ID] = f
	}
	var out []*Fact
	if strings.TrimSpace(query) == "" {
		for _, f := range all {
			if visible(f, share) {
				out = append(out, f)
			}
		}
	} else {
		for _, id := range ids {
			if f, ok := byID[id]; ok && visible(f, share) {
				out = append(out, f)
			}
		}
	}
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// ftsQuery quotes each word as a prefix term (no FTS syntax gets through), OR-ed so any word can match.
func ftsQuery(q string) string {
	var parts []string
	for _, w := range strings.FieldsFunc(strings.ToLower(q), func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r > 127)
	}) {
		if len(w) >= 2 {
			parts = append(parts, `"`+w+`"*`)
		}
		if len(parts) == 12 {
			break
		}
	}
	return strings.Join(parts, " OR ")
}

// --- an agent's own notes -------------------------------------------------------------------------------------------

func notesPath(agentDir string) string { return filepath.Join(agentDir, "memory.json") }

// Notes reads an agent's notes, newest first.
func (s *Store) Notes(agentDir string) ([]Note, error) {
	s.notesMu.Lock()
	defer s.notesMu.Unlock()
	return readNotes(agentDir)
}

func readNotes(agentDir string) ([]Note, error) {
	raw, err := os.ReadFile(notesPath(agentDir))
	if errors.Is(err, os.ErrNotExist) {
		return []Note{}, nil
	}
	if err != nil {
		return nil, err
	}
	var file struct {
		Notes []Note `json:"notes"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		return nil, fmt.Errorf("memory.json is not readable: %w", err)
	}
	sort.SliceStable(file.Notes, func(i, j int) bool { return file.Notes[i].UpdatedAt > file.Notes[j].UpdatedAt })
	if file.Notes == nil {
		file.Notes = []Note{}
	}
	return file.Notes, nil
}

func writeNotes(agentDir string, notes []Note) error {
	raw, _ := json.MarshalIndent(map[string]any{
		"about": "What this agent learned about its own job (Pi Local). Edit in the app, or here while the app is closed.",
		"notes": notes,
	}, "", "  ")
	tmp := notesPath(agentDir) + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, notesPath(agentDir))
}

// AddNote saves a note for an agent (the same text isn't saved twice).
func (s *Store) AddNote(agentID, agentDir, text, thread string) (*Note, error) {
	text, err := cleanText(text)
	if err != nil {
		return nil, err
	}
	s.notesMu.Lock()
	defer s.notesMu.Unlock()
	notes, err := readNotes(agentDir)
	if err != nil {
		return nil, err
	}
	for _, n := range notes {
		if strings.EqualFold(n.Text, text) {
			return &n, nil
		}
	}
	if len(notes) >= maxNotes {
		return nil, &Error{Status: http.StatusConflict, Code: "full", Message: "This agent's memory is full: delete some notes on its Memory tab."}
	}
	now := s.now().UnixMilli()
	n := Note{ID: newID("an_"), Text: text, CreatedAt: now, UpdatedAt: now}
	if thread != "" {
		n.Thread = &thread
	}
	if err := writeNotes(agentDir, append([]Note{n}, notes...)); err != nil {
		return nil, err
	}
	s.OnChange(agentID)
	return &n, nil
}

// UpdateNote changes a note's text.
func (s *Store) UpdateNote(agentID, agentDir, id, text string) (*Note, error) {
	text, err := cleanText(text)
	if err != nil {
		return nil, err
	}
	s.notesMu.Lock()
	defer s.notesMu.Unlock()
	notes, err := readNotes(agentDir)
	if err != nil {
		return nil, err
	}
	for i := range notes {
		if notes[i].ID == id {
			notes[i].Text, notes[i].UpdatedAt = text, s.now().UnixMilli()
			if err := writeNotes(agentDir, notes); err != nil {
				return nil, err
			}
			s.OnChange(agentID)
			return &notes[i], nil
		}
	}
	return nil, ErrNotFound
}

// DeleteNote forgets one note; id "" forgets them all (reset).
func (s *Store) DeleteNote(agentID, agentDir, id string) error {
	s.notesMu.Lock()
	defer s.notesMu.Unlock()
	notes, err := readNotes(agentDir)
	if err != nil {
		return err
	}
	kept := notes[:0]
	found := false
	for _, n := range notes {
		if id == "" || n.ID == id {
			found = true
			continue
		}
		kept = append(kept, n)
	}
	if !found && id != "" {
		return ErrNotFound
	}
	if err := writeNotes(agentDir, kept); err != nil {
		return err
	}
	s.OnChange(agentID)
	return nil
}

// SearchNotes finds an agent's notes containing the query's words (all when empty).
func (s *Store) SearchNotes(agentDir, query string, limit int) ([]Note, error) {
	notes, err := s.Notes(agentDir)
	if err != nil {
		return nil, err
	}
	words := strings.Fields(strings.ToLower(query))
	type scored struct {
		n     Note
		score int
	}
	var hits []scored
	for _, n := range notes {
		text := strings.ToLower(n.Text)
		score := 0
		for _, w := range words {
			if strings.Contains(text, w) {
				score++
			}
		}
		if len(words) == 0 || score > 0 {
			hits = append(hits, scored{n, score})
		}
	}
	sort.SliceStable(hits, func(i, j int) bool { return hits[i].score > hits[j].score })
	out := []Note{}
	for _, h := range hits {
		if len(out) == limit {
			break
		}
		out = append(out, h.n)
	}
	return out, nil
}

// --- the section an agent sees every turn --------------------------------------------------------------------------

// Context is what an agent sees about the person and itself every turn: the basics and the facts it may see (pinned
// first, then newest), and its own notes, each within a budget; the rest is reachable with recall.
func (s *Store) Context(ctx context.Context, basics Basics, share []string, agentDir string) (aboutYou, ownNotes string) {
	var b strings.Builder
	line := func(label, v string) {
		if v != "" {
			fmt.Fprintf(&b, "%s: %s\n", label, v)
		}
	}
	line("Name", basics.Name)
	line("Call them", basics.AddressAs)
	line("Role", basics.Role)
	line("Organization", basics.Organization)
	line("Time zone", basics.Timezone)
	line("Language", basics.Language)
	line("How they like answers", basics.AnswerStyle)
	line("Sign messages you write for them as", basics.SignOff)
	facts, _ := s.Facts(ctx, "active")
	byCat := map[string][]string{}
	more := 0
	used := b.Len()
	for _, f := range facts {
		// Outside text never reaches the always-on profile.
		if !visible(f, share) || f.Trust == "external" {
			continue
		}
		entry := "- " + f.Text
		if used+len(entry)+1 > profileBudget-60 {
			more++
			continue
		}
		used += len(entry) + 1
		byCat[f.Category] = append(byCat[f.Category], entry)
	}
	for _, c := range Categories {
		if items := byCat[c]; len(items) > 0 {
			fmt.Fprintf(&b, "%s%s:\n%s\n", strings.ToUpper(c[:1]), c[1:], strings.Join(items, "\n"))
		}
	}
	if more > 0 {
		fmt.Fprintf(&b, "(%d more: use recall.)\n", more)
	}
	aboutYou = strings.TrimSpace(b.String())

	notes, _ := s.Notes(agentDir)
	var n strings.Builder
	extra := 0
	for _, note := range notes {
		entry := "- " + note.Text + "\n"
		if n.Len()+len(entry) > notesBudget {
			extra++
			continue
		}
		n.WriteString(entry)
	}
	if extra > 0 {
		fmt.Fprintf(&n, "(%d more: use recall.)\n", extra)
	}
	return aboutYou, strings.TrimSpace(n.String())
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}
