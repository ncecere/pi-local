// Package agents keeps the app's agents: one folder each under <data>/agents/<id>, holding agent.yaml (the config),
// state.sqlite (the agent's pi-durable storage, which only its runtime opens), workspace/, tmp/ and logs/.
package agents

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base32"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// ErrNotFound: no agent has that ID.
var ErrNotFound = errors.New("agent not found")

// Agent is one agent as the app knows it.
type Agent struct {
	ID               string
	Dir              string
	Config           Config
	Revision         int
	CreatedAt        time.Time
	UpdatedAt        time.Time
	LastUsedAt       *time.Time
	PiDurableVersion string
}

// StoragePath is the agent's pi-durable storage file.
func (a *Agent) StoragePath() string { return filepath.Join(a.Dir, "state.sqlite") }

// WorkspaceDir is the folder the agent's tools work in.
func (a *Agent) WorkspaceDir() string {
	if a.Config.Workspace.Folder != "" {
		return a.Config.Workspace.Folder
	}
	return a.OwnWorkspaceDir()
}

// OwnWorkspaceDir is the workspace/ folder inside the agent's folder (its workspace when it has no project folder).
func (a *Agent) OwnWorkspaceDir() string { return filepath.Join(a.Dir, "workspace") }

// AttachmentsDir is where files a person attaches are saved, and how the agent's tools name it: inside the
// workspace, except for a project folder, which they'd clutter (then the agent's temporary folder, which its tools
// can also open).
func (a *Agent) AttachmentsDir() (dir string, relative bool) {
	if a.Config.Workspace.Folder != "" {
		return filepath.Join(a.TempDir(), "attachments"), false
	}
	return filepath.Join(a.OwnWorkspaceDir(), "attachments"), true
}

// TempDir is the agent's private temporary directory.
func (a *Agent) TempDir() string { return filepath.Join(a.Dir, "tmp") }

// LogDir holds the runtime's logs.
func (a *Agent) LogDir() string { return filepath.Join(a.Dir, "logs") }

// Change is what happened to an agent, for listeners (the supervisor restarts a changed agent; the UI hears of it).
type Change struct {
	AgentID string
	Deleted bool
	Agent   *Agent // a copy; nil when deleted
}

// Store is the registry of agents: the rows in app.db and each folder's agent.yaml, kept in memory.
type Store struct {
	db   *sql.DB
	root string // <data>/agents

	writeMu   sync.Mutex // serializes Create, Update and Delete
	mu        sync.RWMutex
	agents    map[string]*Agent
	listeners []func(Change)

	// MCPExists says whether the app's catalog has an MCP server (set by the app).
	MCPExists func(slug string) bool

	// ModelAvailable says whether agents may be given a model now (set by the app from the model catalog). Only a
	// model being chosen is checked: an agent keeps a model that went away until it is given another.
	ModelAvailable func(ModelRef) bool
}

// checkCanCall: every agent named exists, none twice, and not the agent itself.
func (s *Store) checkCanCall(self string, ids []string) ([]string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	seen := map[string]bool{}
	out := []string{}
	for _, id := range ids {
		if id == self {
			return nil, invalid("invalid_can_call", "An agent can't ask itself.")
		}
		if _, ok := s.agents[id]; !ok {
			return nil, invalid("invalid_can_call", "There is no agent %q.", id)
		}
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	if len(out) > 50 {
		return nil, invalid("invalid_can_call", "An agent may name at most 50 others to ask.")
	}
	return out, nil
}

func (s *Store) checkMCP(list []MCPChoice) error {
	if s.MCPExists == nil {
		return nil
	}
	for _, m := range list {
		if !s.MCPExists(m.Server) {
			return invalid("invalid_mcp", "There is no MCP server %q (Settings → MCP).", m.Server)
		}
	}
	return nil
}

// UsingMCP lists the agents using an MCP server.
func (s *Store) UsingMCP(slug string) []*Agent {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []*Agent
	for _, a := range s.agents {
		for _, m := range a.Config.MCP {
			if m.Server == slug {
				out = append(out, copyOf(a))
				break
			}
		}
	}
	return out
}

func (s *Store) checkModel(m ModelRef) error {
	if m == DemoModel {
		return nil
	}
	if s.ModelAvailable == nil || !s.ModelAvailable(m) {
		return invalid("invalid_model", "Choose one of the models offered (%s isn't available).", m)
	}
	return nil
}

// UsingModel lists the agents on a model.
func (s *Store) UsingModel(m ModelRef) []*Agent {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []*Agent
	for _, a := range s.agents {
		if a.Config.Model == m {
			out = append(out, copyOf(a))
		}
	}
	return out
}

var idPattern = regexp.MustCompile(`^ag_[a-z2-7]{16}$`)

// ValidID reports whether id has the form of an agent ID.
func ValidID(id string) bool { return idPattern.MatchString(id) }

func newID() string {
	b := make([]byte, 10)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return "ag_" + strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b))
}

// Open loads every agent. An agent whose folder or agent.yaml is missing or unreadable is logged and skipped (its row
// stays, so it comes back when the folder does).
func Open(ctx context.Context, db *sql.DB, root string) (*Store, error) {
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, err
	}
	s := &Store{db: db, root: root, agents: map[string]*Agent{}}
	rows, err := db.QueryContext(ctx, `SELECT id, dir, revision, created_at, updated_at, last_used_at, COALESCE(pi_durable_version, '') FROM agents`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var a Agent
		var created, updated int64
		var lastUsed sql.NullInt64
		if err := rows.Scan(&a.ID, &a.Dir, &a.Revision, &created, &updated, &lastUsed, &a.PiDurableVersion); err != nil {
			return nil, err
		}
		a.CreatedAt, a.UpdatedAt = time.UnixMilli(created), time.UnixMilli(updated)
		if lastUsed.Valid {
			t := time.UnixMilli(lastUsed.Int64)
			a.LastUsedAt = &t
		}
		cfg, err := readConfig(a.Dir)
		if err != nil {
			slog.Warn("agent folder unreadable; skipping", "agent", a.ID, "dir", a.Dir, "err", err)
			continue
		}
		a.Config = cfg
		s.agents[a.ID] = &a
	}
	return s, rows.Err()
}

// OnChange registers a listener, called after every change (outside the store's lock).
func (s *Store) OnChange(fn func(Change)) {
	s.mu.Lock()
	s.listeners = append(s.listeners, fn)
	s.mu.Unlock()
}

func (s *Store) notify(c Change) {
	s.mu.RLock()
	listeners := append([]func(Change){}, s.listeners...)
	s.mu.RUnlock()
	for _, fn := range listeners {
		fn(c)
	}
}

func copyOf(a *Agent) *Agent {
	c := *a
	c.Config.CanCall = append([]string(nil), a.Config.CanCall...)
	c.Config.Workspace.Tools = append([]string(nil), a.Config.Workspace.Tools...)
	c.Config.Approvals.Tools = append([]string(nil), a.Config.Approvals.Tools...)
	c.Config.MCP = nil
	for _, m := range a.Config.MCP {
		choice := MCPChoice{Server: m.Server}
		if m.Tools != nil { // nil: all tools; an empty list stays empty
			choice.Tools = append([]string{}, m.Tools...)
		}
		c.Config.MCP = append(c.Config.MCP, choice)
	}
	if a.LastUsedAt != nil {
		t := *a.LastUsedAt
		c.LastUsedAt = &t
	}
	return &c
}

// List returns every agent, newest first.
func (s *Store) List() []*Agent {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]*Agent, 0, len(s.agents))
	for _, a := range s.agents {
		out = append(out, copyOf(a))
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].CreatedAt.After(out[j].CreatedAt)
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// Get returns a copy of one agent.
func (s *Store) Get(id string) (*Agent, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	a, ok := s.agents[id]
	if !ok {
		return nil, ErrNotFound
	}
	return copyOf(a), nil
}

// Create makes a new agent: its folder, agent.yaml and row.
func (s *Store) Create(ctx context.Context, cfg Config) (*Agent, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	cfg.Normalize()
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	if err := s.checkModel(cfg.Model); err != nil {
		return nil, err
	}
	id := newID()
	canCall, err := s.checkCanCall(id, cfg.CanCall)
	if err != nil {
		return nil, err
	}
	cfg.CanCall = canCall
	if err := s.checkMCP(cfg.MCP); err != nil {
		return nil, err
	}
	dir := filepath.Join(s.root, id)
	for _, sub := range []string{"workspace", "tmp", "logs"} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0o700); err != nil {
			return nil, err
		}
	}
	if err := writeConfig(dir, cfg); err != nil {
		os.RemoveAll(dir)
		return nil, err
	}
	now := time.Now()
	if _, err := s.db.ExecContext(ctx, `INSERT INTO agents (id, dir, revision, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`,
		id, dir, now.UnixMilli(), now.UnixMilli()); err != nil {
		os.RemoveAll(dir)
		return nil, err
	}
	a := &Agent{ID: id, Dir: dir, Config: cfg, Revision: 1, CreatedAt: time.UnixMilli(now.UnixMilli()), UpdatedAt: time.UnixMilli(now.UnixMilli())}
	s.mu.Lock()
	s.agents[id] = a
	s.mu.Unlock()
	out := copyOf(a)
	s.notify(Change{AgentID: id, Agent: copyOf(a)})
	return out, nil
}

// Update changes an agent's config through fn and bumps its revision (a running agent restarts with it).
func (s *Store) Update(ctx context.Context, id string, fn func(*Config)) (*Agent, error) {
	// Changes are serialized; the checks run without the read lock (checking a model asks the catalog, which may ask
	// which agents use a model).
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	current, err := s.Get(id)
	if err != nil {
		return nil, err
	}
	cfg := current.Config
	if cfg.KindSettings != nil {
		m := make(map[string]any, len(cfg.KindSettings))
		for k, v := range cfg.KindSettings {
			m[k] = v
		}
		cfg.KindSettings = m
	}
	fn(&cfg)
	cfg.Normalize()
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	if cfg.Model != current.Config.Model {
		if err := s.checkModel(cfg.Model); err != nil {
			return nil, err
		}
	}
	if cfg.CanCall, err = s.checkCanCall(id, cfg.CanCall); err != nil {
		return nil, err
	}
	if err := s.checkMCP(cfg.MCP); err != nil {
		return nil, err
	}
	if len(cfg.CanCall) == 0 {
		cfg.CanCall = nil
	}
	now := time.Now()
	if err := writeConfig(current.Dir, cfg); err != nil {
		return nil, err
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE agents SET revision = revision + 1, updated_at = ? WHERE id = ?`, now.UnixMilli(), id); err != nil {
		return nil, err
	}
	s.mu.Lock()
	a, ok := s.agents[id]
	if !ok {
		s.mu.Unlock()
		return nil, ErrNotFound
	}
	a.Config = cfg
	a.Revision++
	a.UpdatedAt = time.UnixMilli(now.UnixMilli())
	out := copyOf(a)
	s.mu.Unlock()
	s.notify(Change{AgentID: id, Agent: copyOf(out)})
	return out, nil
}

// Touch records that an agent was used now (at most once a minute, to keep writes down).
func (s *Store) Touch(ctx context.Context, id string) {
	now := time.Now()
	s.mu.Lock()
	a, ok := s.agents[id]
	if !ok || (a.LastUsedAt != nil && now.Sub(*a.LastUsedAt) < time.Minute) {
		s.mu.Unlock()
		return
	}
	t := time.UnixMilli(now.UnixMilli())
	a.LastUsedAt = &t
	s.mu.Unlock()
	if _, err := s.db.ExecContext(ctx, `UPDATE agents SET last_used_at = ? WHERE id = ?`, now.UnixMilli(), id); err != nil {
		slog.Warn("recording agent use", "agent", id, "err", err)
	}
}

// RecordStorageVersion keeps the newest pi-durable version that has run on the agent's storage.
func (s *Store) RecordStorageVersion(ctx context.Context, id, version string) error {
	s.mu.Lock()
	a, ok := s.agents[id]
	if !ok {
		s.mu.Unlock()
		return ErrNotFound
	}
	if CompareVersions(version, a.PiDurableVersion) <= 0 {
		s.mu.Unlock()
		return nil
	}
	a.PiDurableVersion = version
	s.mu.Unlock()
	_, err := s.db.ExecContext(ctx, `UPDATE agents SET pi_durable_version = ? WHERE id = ?`, version, id)
	return err
}

// Delete removes an agent: its row (and its threads' records) and its folder, moved to <data>/trash so a mistake can
// be undone by hand. The caller stops its runtime first.
func (s *Store) Delete(ctx context.Context, id string) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	s.mu.Lock()
	a, ok := s.agents[id]
	if !ok {
		s.mu.Unlock()
		return ErrNotFound
	}
	delete(s.agents, id)
	s.mu.Unlock()
	if _, err := s.db.ExecContext(ctx, `DELETE FROM agents WHERE id = ?`, id); err != nil {
		return err
	}
	trash := filepath.Join(filepath.Dir(s.root), "trash")
	if err := os.MkdirAll(trash, 0o700); err == nil {
		dest := filepath.Join(trash, fmt.Sprintf("%s-%s", id, time.Now().Format("20060102-150405")))
		if err := os.Rename(a.Dir, dest); err != nil {
			slog.Warn("moving a deleted agent's folder to the trash", "agent", id, "err", err)
		}
	}
	s.notify(Change{AgentID: id, Deleted: true})
	// Nobody may ask it any more.
	for _, other := range s.List() {
		if !containsID(other.Config.CanCall, id) {
			continue
		}
		s.writeMu.Unlock()
		_, err := s.Update(ctx, other.ID, func(c *Config) { c.CanCall = removeID(c.CanCall, id) })
		s.writeMu.Lock()
		if err != nil {
			slog.Warn("removing a deleted agent from canCall", "agent", other.ID, "err", err)
		}
	}
	return nil
}

func containsID(ids []string, id string) bool {
	for _, x := range ids {
		if x == id {
			return true
		}
	}
	return false
}

func removeID(ids []string, id string) []string {
	out := ids[:0:0]
	for _, x := range ids {
		if x != id {
			out = append(out, x)
		}
	}
	return out
}

// CompareVersions compares two semantic versions (major.minor.patch, an optional pre-release counts as older).
// An empty version is older than any other.
func CompareVersions(a, b string) int {
	if a == b {
		return 0
	}
	if a == "" {
		return -1
	}
	if b == "" {
		return 1
	}
	pa, pb := parseVersion(a), parseVersion(b)
	for i := 0; i < 3; i++ {
		if pa.n[i] != pb.n[i] {
			if pa.n[i] < pb.n[i] {
				return -1
			}
			return 1
		}
	}
	switch {
	case pa.pre == pb.pre:
		return 0
	case pa.pre == "":
		return 1
	case pb.pre == "":
		return -1
	case pa.pre < pb.pre:
		return -1
	default:
		return 1
	}
}

type version struct {
	n   [3]int
	pre string
}

func parseVersion(s string) version {
	var v version
	core, pre, _ := strings.Cut(s, "-")
	v.pre = pre
	for i, part := range strings.SplitN(core, ".", 3) {
		fmt.Sscanf(part, "%d", &v.n[i])
	}
	return v
}

// Exists reports whether there is an agent with that ID.
func (s *Store) Exists(id string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, ok := s.agents[id]
	return ok
}

// CanCall is an agent's own list of agents it may ask.
func (s *Store) CanCall(id string) []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if a, ok := s.agents[id]; ok {
		return append([]string(nil), a.Config.CanCall...)
	}
	return nil
}

// ConfigText is an agent's agent.yaml as it is on disk.
func (s *Store) ConfigText(id string) ([]byte, error) {
	a, err := s.Get(id)
	if err != nil {
		return nil, err
	}
	return os.ReadFile(filepath.Join(a.Dir, configFile))
}

// Import makes a new agent from an exported folder's files: agent.yaml's config and, when given, its storage
// (state.sqlite, and state.sqlite-wal if there was one). The model need not be available: the agent then fails to
// start, saying so, until it is given another. canCall is cleared: agent IDs mean nothing on another computer.
func (s *Store) Import(ctx context.Context, cfg Config, storage map[string][]byte) (*Agent, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	cfg.Normalize()
	cfg.CanCall = nil
	// MCP servers this computer doesn't have are left out (add them in Settings → MCP, then choose them again).
	var kept []MCPChoice
	for _, m := range cfg.MCP {
		if s.MCPExists == nil || s.MCPExists(m.Server) {
			kept = append(kept, m)
		}
	}
	cfg.MCP = kept
	// A project folder this computer doesn't have: the agent works in its own workspace until it is given one.
	if cfg.Workspace.Folder != "" {
		if info, err := os.Stat(cfg.Workspace.Folder); err != nil || !info.IsDir() {
			cfg.Workspace.Folder = ""
		}
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	id := newID()
	dir := filepath.Join(s.root, id)
	for _, sub := range []string{"workspace", "tmp", "logs"} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0o700); err != nil {
			return nil, err
		}
	}
	for name, data := range storage {
		if name != "state.sqlite" && name != "state.sqlite-wal" {
			continue
		}
		if err := os.WriteFile(filepath.Join(dir, name), data, 0o600); err != nil {
			os.RemoveAll(dir)
			return nil, err
		}
	}
	if err := writeConfig(dir, cfg); err != nil {
		os.RemoveAll(dir)
		return nil, err
	}
	now := time.Now()
	if _, err := s.db.ExecContext(ctx, `INSERT INTO agents (id, dir, revision, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`,
		id, dir, now.UnixMilli(), now.UnixMilli()); err != nil {
		os.RemoveAll(dir)
		return nil, err
	}
	a := &Agent{ID: id, Dir: dir, Config: cfg, Revision: 1, CreatedAt: time.UnixMilli(now.UnixMilli()), UpdatedAt: time.UnixMilli(now.UnixMilli())}
	s.mu.Lock()
	s.agents[id] = a
	s.mu.Unlock()
	s.notify(Change{AgentID: id, Agent: copyOf(a)})
	return copyOf(a), nil
}

// NameOf is an agent's name ("an agent" when there is none by that ID).
func (s *Store) NameOf(id string) string {
	if a, err := s.Get(id); err == nil {
		return a.Config.Name
	}
	return "an agent"
}
