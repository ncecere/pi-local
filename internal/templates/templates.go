// Package templates keeps agent templates: ready-made starting points for a new agent (its kind, instructions,
// tools, approvals, and an optional first schedule). Built-in ones ship with the app; people import, export and make
// their own, which are plain YAML files in the data folder's templates/ folder, so they can be shared.
package templates

import (
	"bytes"
	"embed"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"gopkg.in/yaml.v3"

	"github.com/ncecere/pi-local/internal/agents"
)

//go:embed builtin/*.yaml
var builtinFS embed.FS

// Template is a starting point for an agent.
type Template struct {
	ID           string                 `yaml:"id" json:"id"`
	Name         string                 `yaml:"name" json:"name"`
	Description  string                 `yaml:"description" json:"description"`
	Category     string                 `yaml:"category,omitempty" json:"category"`
	Icon         string                 `yaml:"icon,omitempty" json:"icon"`
	Kind         string                 `yaml:"kind" json:"kind"`
	Instructions string                 `yaml:"instructions,omitempty" json:"instructions"`
	Workspace    *agents.Workspace      `yaml:"workspace,omitempty" json:"workspace,omitempty"`
	Approvals    *agents.Approvals      `yaml:"approvals,omitempty" json:"approvals,omitempty"`
	Web          *agents.WebTools       `yaml:"web,omitempty" json:"web,omitempty"`
	Schedules    *agents.AgentSchedules `yaml:"schedules,omitempty" json:"schedules,omitempty"`
	// Schedule is a first schedule made with the agent (editable after).
	Schedule *Schedule `yaml:"schedule,omitempty" json:"schedule,omitempty"`
	// MCP names the MCP servers it works with (their IDs in Settings → MCP), used when this computer has them.
	MCP []string `yaml:"mcp,omitempty" json:"mcp,omitempty"`
	// Needs says what makes it work well ("web-search"), so the gallery can say what to set up.
	Needs []string `yaml:"needs,omitempty" json:"needs,omitempty"`
	// Builtin: shipped with the app (not editable or deletable).
	Builtin bool `yaml:"-" json:"builtin"`
}

// Schedule is a template's first schedule.
type Schedule struct {
	Name       string `yaml:"name" json:"name"`
	Cron       string `yaml:"cron" json:"cron"`
	Message    string `yaml:"message" json:"message"`
	ThreadMode string `yaml:"threadMode,omitempty" json:"threadMode,omitempty"` // new (default) or this
}

// Error is a refusal for people.
type Error struct {
	Status  int
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Message }

func bad(code, format string, args ...any) error {
	return &Error{Status: http.StatusBadRequest, Code: code, Message: fmt.Sprintf(format, args...)}
}

// ErrNotFound: no such template.
var ErrNotFound = &Error{Status: http.StatusNotFound, Code: "not_found", Message: "Template not found"}

var idPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,47}$`)

// Categories, in the gallery's order.
var Categories = []string{"everyday", "work", "life", "meta", "yours"}

// Store is the built-in templates plus the person's.
type Store struct {
	dir     string
	mu      sync.Mutex
	builtin []Template
}

// New loads the built-ins; dir holds the person's templates.
func New(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	s := &Store{dir: dir}
	entries, err := builtinFS.ReadDir("builtin")
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		raw, _ := builtinFS.ReadFile("builtin/" + e.Name())
		t, err := Parse(raw)
		if err != nil {
			return nil, fmt.Errorf("built-in template %s: %w", e.Name(), err)
		}
		t.Builtin = true
		s.builtin = append(s.builtin, *t)
	}
	order := map[string]int{"assistant": 0, "researcher": 1, "writer": 2, "daily-briefing": 3, "translator": 4, "planner": 5, "coding": 6}
	sort.SliceStable(s.builtin, func(i, j int) bool { return order[s.builtin[i].ID] < order[s.builtin[j].ID] })
	return s, nil
}

// Parse reads and checks a template file.
func Parse(raw []byte) (*Template, error) {
	if len(raw) > 128<<10 {
		return nil, bad("invalid_template", "A template file is at most 128 KiB.")
	}
	var t Template
	dec := yaml.NewDecoder(bytes.NewReader(raw))
	dec.KnownFields(true)
	if err := dec.Decode(&t); err != nil {
		return nil, bad("invalid_template", "%s", importProblem(err))
	}
	return &t, t.check()
}

func (t *Template) check() error {
	t.Name = strings.TrimSpace(t.Name)
	t.Description = strings.TrimSpace(t.Description)
	if !idPattern.MatchString(t.ID) {
		return bad("invalid_template", "A template's id is 1 to 48 lowercase letters, digits or dashes.")
	}
	if t.Name == "" || utf8.RuneCountInString(t.Name) > agents.MaxNameChars {
		return bad("invalid_template", "A template needs a name of 1 to %d characters.", agents.MaxNameChars)
	}
	if utf8.RuneCountInString(t.Description) > agents.MaxDescriptionChars {
		return bad("invalid_template", "A template's description is at most %d characters.", agents.MaxDescriptionChars)
	}
	if t.Kind == "" {
		t.Kind = "assistant"
	}
	// Everything an agent would be checked for: make one from it and validate.
	cfg := agents.Config{Name: t.Name}
	t.Apply(&cfg)
	cfg.Normalize()
	if err := cfg.Validate(); err != nil {
		return bad("invalid_template", "%s", err.Error())
	}
	if t.Schedule != nil {
		if strings.TrimSpace(t.Schedule.Cron) == "" || strings.TrimSpace(t.Schedule.Message) == "" {
			return bad("invalid_template", "A template's schedule needs a cron and a message.")
		}
		if m := t.Schedule.ThreadMode; m != "" && m != "new" && m != "this" {
			return bad("invalid_template", "A schedule's threadMode is new or this.")
		}
	}
	return nil
}

// Apply sets an agent's configuration from the template (the request's own fields come after, and win).
func (t *Template) Apply(c *agents.Config) {
	c.Kind = t.Kind
	if t.Description != "" && c.Description == "" {
		c.Description = t.Description
	}
	c.Instructions = t.Instructions
	if t.Workspace != nil {
		c.Workspace.Tools = append([]string(nil), t.Workspace.Tools...)
	}
	if t.Approvals != nil {
		c.Approvals = agents.Approvals{Tools: append([]string(nil), t.Approvals.Tools...), TimeoutSeconds: t.Approvals.TimeoutSeconds}
	}
	if t.Web != nil {
		c.Web = *t.Web
	}
	if t.Schedules != nil {
		c.Schedules = *t.Schedules
	}
	c.MCP = nil
	for _, slug := range t.MCP {
		c.MCP = append(c.MCP, agents.MCPChoice{Server: slug})
	}
}

// FromAgent makes a template from an agent's configuration (no model, no agents it may ask, no project folder: those
// belong to this computer).
func FromAgent(id string, c agents.Config) *Template {
	t := &Template{ID: id, Name: c.Name, Description: c.Description, Kind: c.Kind, Instructions: c.Instructions, Category: "yours"}
	if len(c.Workspace.Tools) > 0 {
		t.Workspace = &agents.Workspace{Tools: append([]string(nil), c.Workspace.Tools...)}
	}
	if len(c.Approvals.Tools) > 0 {
		a := c.Approvals
		t.Approvals = &a
	}
	// Always recorded: a template without web would give new agents the default (both on).
	w := c.Web
	t.Web = &w
	if c.Schedules.AgentMade {
		s := c.Schedules
		t.Schedules = &s
	}
	for _, m := range c.MCP {
		t.MCP = append(t.MCP, m.Server)
	}
	return t
}

// Marshal writes a template file.
func Marshal(t *Template) []byte {
	var buf bytes.Buffer
	buf.WriteString("# A Pi Local agent template. Import it with Import template… in the New agent dialog.\n")
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	enc.Encode(t)
	return buf.Bytes()
}

// List is every template: the built-ins, then the person's by name.
func (s *Store) List() []Template {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := append([]Template{}, s.builtin...)
	entries, _ := os.ReadDir(s.dir)
	var yours []Template
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".yaml" {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(s.dir, e.Name()))
		if err != nil {
			continue
		}
		t, err := Parse(raw)
		if err != nil || strings.TrimSuffix(e.Name(), ".yaml") != t.ID {
			continue
		}
		t.Category = "yours"
		yours = append(yours, *t)
	}
	sort.Slice(yours, func(i, j int) bool { return strings.ToLower(yours[i].Name) < strings.ToLower(yours[j].Name) })
	return append(out, yours...)
}

// Get finds a template by ID.
func (s *Store) Get(id string) (*Template, error) {
	for _, t := range s.List() {
		if t.ID == id {
			return &t, nil
		}
	}
	return nil, ErrNotFound
}

// Save keeps a template of the person's: a new ID when it would replace a built-in or another one ("name-2").
func (s *Store) Save(t *Template) (*Template, error) {
	t.Builtin = false
	t.Category = "yours"
	if err := t.check(); err != nil {
		return nil, err
	}
	taken := map[string]bool{}
	for _, existing := range s.List() {
		taken[existing.ID] = true
	}
	base := t.ID
	for n := 2; taken[t.ID]; n++ {
		t.ID = fmt.Sprintf("%s-%d", strings.TrimRight(base[:min(len(base), 44)], "-"), n)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	path := filepath.Join(s.dir, t.ID+".yaml")
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, Marshal(t), 0o600); err != nil {
		return nil, err
	}
	if err := os.Rename(tmp, path); err != nil {
		return nil, err
	}
	return t, nil
}

// Import keeps a template file someone shared.
func (s *Store) Import(raw []byte) (*Template, error) {
	t, err := Parse(raw)
	if err != nil {
		return nil, err
	}
	return s.Save(t)
}

// Delete removes one of the person's templates.
func (s *Store) Delete(id string) error {
	t, err := s.Get(id)
	if err != nil {
		return err
	}
	if t.Builtin {
		return &Error{Status: http.StatusConflict, Code: "builtin", Message: "Built-in templates can't be deleted."}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.Remove(filepath.Join(s.dir, id+".yaml")); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// Slug makes a template ID from a name.
func Slug(name string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(name) {
		switch {
		case r >= 'a' && r <= 'z' || r >= '0' && r <= '9':
			b.WriteRune(r)
			dash = false
		case !dash && b.Len() > 0:
			b.WriteByte('-')
			dash = true
		}
	}
	id := strings.Trim(b.String(), "-")
	if len(id) > 40 {
		id = strings.Trim(id[:40], "-")
	}
	if id == "" {
		id = "template"
	}
	return id
}

// LocalTimezone is this computer's IANA time zone (for a template's first schedule), or UTC when it can't be told.
func LocalTimezone() string {
	if tz := os.Getenv("TZ"); tz != "" {
		if _, err := time.LoadLocation(tz); err == nil {
			return tz
		}
	}
	if target, err := os.Readlink("/etc/localtime"); err == nil {
		if i := strings.Index(target, "zoneinfo/"); i >= 0 {
			name := target[i+len("zoneinfo/"):]
			if _, err := time.LoadLocation(name); err == nil {
				return name
			}
		}
	}
	return "UTC"
}

var yamlLine = regexp.MustCompile(`line (\d+)`)
var unknownField = regexp.MustCompile(`field (\S+) not found`)

// importProblem says why a file isn't a template, for people (not the YAML parser's words).
func importProblem(err error) string {
	msg := err.Error()
	if m := unknownField.FindStringSubmatch(msg); m != nil {
		return fmt.Sprintf("This isn't a Pi Local template: it has a setting Pi Local doesn't know (%s).", m[1])
	}
	if m := yamlLine.FindStringSubmatch(msg); m != nil {
		return fmt.Sprintf("This isn't a Pi Local template: it can't be read (a problem near line %s).", m[1])
	}
	return "This isn't a Pi Local template: it can't be read."
}
