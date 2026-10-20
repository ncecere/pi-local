// Package teams keeps teams of agents and decides who may ask whom: an agent's own canCall, a team's lead asking its
// members, and with membersTalk members asking each other and the lead.
package teams

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base32"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

// Team is a group of agents people talk to through its lead.
type Team struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	LeadID      string    `json:"leadId"`
	MemberIDs   []string  `json:"memberIds"`
	MembersTalk bool      `json:"membersTalk"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// Input is a team to make, or changes to one.
type Input struct {
	Name        *string   `json:"name"`
	Description *string   `json:"description"`
	LeadID      *string   `json:"leadId"`
	MemberIDs   *[]string `json:"memberIds"`
	MembersTalk *bool     `json:"membersTalk"`
}

// Error is a validation failure for people.
type Error struct{ Code, Message string }

func (e *Error) Error() string { return e.Message }

func bad(code, format string, args ...any) error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// ErrNotFound: no such team.
var ErrNotFound = errors.New("team not found")

// Agents is what teams need to know of agents.
type Agents interface {
	Exists(id string) bool
	CanCall(id string) []string
}

// Store is the teams table.
type Store struct {
	db       *sql.DB
	agents   Agents
	OnChange func(teamID string, team *Team) // team nil: deleted
}

// New makes the store.
func New(db *sql.DB, agents Agents) *Store {
	return &Store{db: db, agents: agents, OnChange: func(string, *Team) {}}
}

func newID() string {
	b := make([]byte, 10)
	rand.Read(b)
	return "tm_" + strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b))
}

func scan(row interface{ Scan(...any) error }) (*Team, error) {
	var t Team
	var members string
	var talk int
	var created, updated int64
	if err := row.Scan(&t.ID, &t.Name, &t.Description, &t.LeadID, &members, &talk, &created, &updated); err != nil {
		return nil, err
	}
	json.Unmarshal([]byte(members), &t.MemberIDs)
	if t.MemberIDs == nil {
		t.MemberIDs = []string{}
	}
	t.MembersTalk = talk != 0
	t.CreatedAt, t.UpdatedAt = time.UnixMilli(created), time.UnixMilli(updated)
	return &t, nil
}

const cols = `id, name, description, lead_id, member_ids, members_talk, created_at, updated_at`

// List returns every team, by name.
func (s *Store) List(ctx context.Context) ([]*Team, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+cols+` FROM teams ORDER BY name COLLATE NOCASE, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*Team{}
	for rows.Next() {
		t, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// Get returns one team.
func (s *Store) Get(ctx context.Context, id string) (*Team, error) {
	t, err := scan(s.db.QueryRowContext(ctx, `SELECT `+cols+` FROM teams WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return t, err
}

func (s *Store) validate(t *Team) error {
	t.Name = strings.TrimSpace(t.Name)
	t.Description = strings.TrimSpace(t.Description)
	if t.Name == "" || utf8.RuneCountInString(t.Name) > 60 || strings.ContainsAny(t.Name, "\r\n") {
		return bad("invalid_name", "A team's name is 1 to 60 characters, on one line.")
	}
	if utf8.RuneCountInString(t.Description) > 500 {
		return bad("invalid_description", "A description is at most 500 characters.")
	}
	if !s.agents.Exists(t.LeadID) {
		return bad("invalid_lead", "Choose one of your agents to lead the team.")
	}
	seen := map[string]bool{}
	var members []string
	for _, id := range t.MemberIDs {
		if id == t.LeadID || seen[id] {
			continue
		}
		if !s.agents.Exists(id) {
			return bad("invalid_members", "There is no agent %q.", id)
		}
		seen[id] = true
		members = append(members, id)
	}
	if len(members) == 0 || len(members) > 20 {
		return bad("invalid_members", "A team has 1 to 20 members besides its lead.")
	}
	t.MemberIDs = members
	return nil
}

func (s *Store) write(ctx context.Context, t *Team, insert bool) error {
	members, _ := json.Marshal(t.MemberIDs)
	talk := 0
	if t.MembersTalk {
		talk = 1
	}
	if insert {
		_, err := s.db.ExecContext(ctx, `INSERT INTO teams (`+cols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			t.ID, t.Name, t.Description, t.LeadID, string(members), talk, t.CreatedAt.UnixMilli(), t.UpdatedAt.UnixMilli())
		return err
	}
	_, err := s.db.ExecContext(ctx, `UPDATE teams SET name = ?, description = ?, lead_id = ?, member_ids = ?, members_talk = ?, updated_at = ? WHERE id = ?`,
		t.Name, t.Description, t.LeadID, string(members), talk, t.UpdatedAt.UnixMilli(), t.ID)
	return err
}

func (in Input) apply(t *Team) {
	if in.Name != nil {
		t.Name = *in.Name
	}
	if in.Description != nil {
		t.Description = *in.Description
	}
	if in.LeadID != nil {
		t.LeadID = *in.LeadID
	}
	if in.MemberIDs != nil {
		t.MemberIDs = *in.MemberIDs
	}
	if in.MembersTalk != nil {
		t.MembersTalk = *in.MembersTalk
	}
}

// Create makes a team.
func (s *Store) Create(ctx context.Context, in Input) (*Team, error) {
	now := time.UnixMilli(time.Now().UnixMilli())
	t := &Team{ID: newID(), CreatedAt: now, UpdatedAt: now}
	in.apply(t)
	if err := s.validate(t); err != nil {
		return nil, err
	}
	if err := s.write(ctx, t, true); err != nil {
		return nil, err
	}
	s.OnChange(t.ID, t)
	return t, nil
}

// Update changes a team.
func (s *Store) Update(ctx context.Context, id string, in Input) (*Team, error) {
	t, err := s.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	in.apply(t)
	t.UpdatedAt = time.UnixMilli(time.Now().UnixMilli())
	if err := s.validate(t); err != nil {
		return nil, err
	}
	if err := s.write(ctx, t, false); err != nil {
		return nil, err
	}
	s.OnChange(t.ID, t)
	return t, nil
}

// Delete removes a team (its agents stay).
func (s *Store) Delete(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM teams WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	s.OnChange(id, nil)
	return nil
}

// RemoveAgent takes a deleted agent out of every team: a team it led is deleted, and so is a team left without
// members.
func (s *Store) RemoveAgent(ctx context.Context, agentID string) error {
	list, err := s.List(ctx)
	if err != nil {
		return err
	}
	for _, t := range list {
		if t.LeadID == agentID {
			if err := s.Delete(ctx, t.ID); err != nil && !errors.Is(err, ErrNotFound) {
				return err
			}
			continue
		}
		var kept []string
		for _, m := range t.MemberIDs {
			if m != agentID {
				kept = append(kept, m)
			}
		}
		if len(kept) == len(t.MemberIDs) {
			continue
		}
		if len(kept) == 0 {
			s.Delete(ctx, t.ID)
			continue
		}
		t.MemberIDs = kept
		t.UpdatedAt = time.UnixMilli(time.Now().UnixMilli())
		if err := s.write(ctx, t, false); err != nil {
			return err
		}
		s.OnChange(t.ID, t)
	}
	return nil
}

// Callee is someone an agent may ask, and why.
type Callee struct {
	ID  string `json:"id"`
	Via string `json:"via"` // "direct" (canCall) or "team"
}

// Callable lists whom an agent may ask: its canCall, the members of teams it leads, and with membersTalk the
// other members (and lead) of teams it belongs to. Never itself.
func (s *Store) Callable(ctx context.Context, agentID string) ([]Callee, error) {
	via := map[string]string{}
	for _, id := range s.agents.CanCall(agentID) {
		via[id] = "direct"
	}
	list, err := s.List(ctx)
	if err != nil {
		return nil, err
	}
	add := func(id string) {
		if id != agentID && via[id] == "" {
			via[id] = "team"
		}
	}
	for _, t := range list {
		member := false
		for _, m := range t.MemberIDs {
			member = member || m == agentID
		}
		if t.LeadID == agentID {
			for _, m := range t.MemberIDs {
				add(m)
			}
		}
		if member && t.MembersTalk {
			add(t.LeadID)
			for _, m := range t.MemberIDs {
				add(m)
			}
		}
	}
	out := []Callee{}
	for id, v := range via {
		if s.agents.Exists(id) {
			out = append(out, Callee{ID: id, Via: v})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

// MayCall reports whether one agent may ask another.
func (s *Store) MayCall(ctx context.Context, caller, target string) bool {
	list, err := s.Callable(ctx, caller)
	if err != nil {
		return false
	}
	for _, c := range list {
		if c.ID == target {
			return true
		}
	}
	return false
}
