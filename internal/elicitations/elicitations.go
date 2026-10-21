// Package elicitations keeps MCP servers' questions to the person (MCP elicitation, form mode) while a tool call waits
// for the answer. A runtime relays a server's `elicitation/create` here and waits; the UI shows it and answers.
//
// They live in memory only: a question belongs to one live connection between a runtime and an MCP server, so once
// either is gone there is nobody left to answer. Each expires after a while (the call then gets "cancel"). An answer's
// content is handed to the waiting runtime and then dropped.
package elicitations

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/mail"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// DefaultTTL is how long a question waits for the person.
const DefaultTTL = 15 * time.Minute

const (
	maxMessage    = 20_000
	maxProperties = 20
	maxPending    = 20 // per agent
	maxStringLen  = 10_000
)

// Elicitation is one question, as the UI sees it.
type Elicitation struct {
	ID         string          `json:"id"`
	AgentID    string          `json:"agentId"`
	AgentName  string          `json:"agentName"`
	ThreadID   *string         `json:"threadId"`
	Server     string          `json:"server"`
	ServerName string          `json:"serverName"`
	Tool       *string         `json:"tool"`
	Message    string          `json:"message"`
	Schema     json.RawMessage `json:"requestedSchema"`
	// State: pending, accepted, declined, cancelled or expired.
	State     string `json:"state"`
	CreatedAt int64  `json:"createdAt"`
	ExpiresAt int64  `json:"expiresAt"`
}

// Request is what a runtime relays.
type Request struct {
	Server     string          `json:"server"`
	ServerName string          `json:"serverName"`
	Tool       string          `json:"tool"`
	ThreadID   string          `json:"threadId"`
	Message    string          `json:"message"`
	Schema     json.RawMessage `json:"requestedSchema"`
}

// Answer is the person's answer, for the runtime: MCP's ElicitResult.
type Answer struct {
	Action  string         `json:"action"`
	Content map[string]any `json:"content,omitempty"`
}

// Error is a failure for people.
type Error struct {
	Status  int
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Message }

func bad(code, format string, args ...any) error {
	return &Error{Status: http.StatusBadRequest, Code: code, Message: fmt.Sprintf(format, args...)}
}

// ErrNotFound: no such question (or not this agent's).
var ErrNotFound = &Error{Status: http.StatusNotFound, Code: "not_found", Message: "That question isn't there any more."}

type property struct {
	Type      string   `json:"type"`
	Title     string   `json:"title,omitempty"`
	Enum      []string `json:"enum,omitempty"`
	Minimum   *float64 `json:"minimum,omitempty"`
	Maximum   *float64 `json:"maximum,omitempty"`
	MinLength *int     `json:"minLength,omitempty"`
	MaxLength *int     `json:"maxLength,omitempty"`
	Format    string   `json:"format,omitempty"`
}

type schema struct {
	Type       string              `json:"type"`
	Properties map[string]property `json:"properties"`
	Required   []string            `json:"required,omitempty"`
}

type item struct {
	e      Elicitation
	schema schema
	answer *Answer
	done   chan struct{} // closed once it isn't pending
	timer  *time.Timer
}

// Store keeps the questions.
type Store struct {
	mu    sync.Mutex
	items map[string]*item
	ttl   time.Duration
	// OnChange is told about every question created or settled (a copy).
	OnChange func(Elicitation)
	// AgentName names an agent for the UI.
	AgentName func(agentID string) string
}

// New makes a store whose questions wait ttl (DefaultTTL when 0).
func New(ttl time.Duration) *Store {
	if ttl <= 0 {
		ttl = DefaultTTL
	}
	return &Store{items: map[string]*item{}, ttl: ttl, OnChange: func(Elicitation) {}, AgentName: func(id string) string { return id }}
}

func newID() string {
	b := make([]byte, 10)
	rand.Read(b)
	const alphabet = "abcdefghijklmnopqrstuvwxyz234567"
	out := make([]byte, len(b))
	for i, c := range b {
		out[i] = alphabet[int(c)%len(alphabet)]
	}
	return "el_" + string(out)
}

// parseSchema accepts MCP's form-mode schema: an object of primitive properties.
func parseSchema(raw json.RawMessage) (schema, error) {
	var s schema
	if len(raw) == 0 {
		return schema{Type: "object", Properties: map[string]property{}}, nil
	}
	if err := json.Unmarshal(raw, &s); err != nil || (s.Type != "" && s.Type != "object") {
		return s, bad("invalid_schema", "The server's form isn't an object of fields.")
	}
	if len(s.Properties) > maxProperties {
		return s, bad("invalid_schema", "The server's form has more than %d fields.", maxProperties)
	}
	for name, p := range s.Properties {
		switch p.Type {
		case "string", "number", "integer", "boolean":
		default:
			return s, bad("invalid_schema", "The server's form field %q has an unsupported type %q.", name, p.Type)
		}
	}
	for _, name := range s.Required {
		if _, ok := s.Properties[name]; !ok {
			return s, bad("invalid_schema", "The server's form requires %q, which it doesn't define.", name)
		}
	}
	return s, nil
}

// Create records a runtime's question and expires it after the store's ttl.
func (s *Store) Create(agentID string, req Request) (Elicitation, error) {
	if strings.TrimSpace(req.Server) == "" {
		return Elicitation{}, bad("invalid_request", "Name the MCP server that asks.")
	}
	msg := strings.ToValidUTF8(req.Message, "\uFFFD")
	if utf8.RuneCountInString(msg) > maxMessage {
		msg = string([]rune(msg)[:maxMessage]) + "…"
	}
	sc, err := parseSchema(req.Schema)
	if err != nil {
		return Elicitation{}, err
	}
	rawSchema, _ := json.Marshal(sc)
	now := time.Now()
	if req.Server == "agent" && req.ServerName == "" {
		req.ServerName = s.AgentName(agentID) // the agent's own question (ask_person)
	}
	e := Elicitation{
		ID: newID(), AgentID: agentID, AgentName: s.AgentName(agentID), Server: req.Server, ServerName: req.ServerName,
		Message: msg, Schema: rawSchema, State: "pending", CreatedAt: now.UnixMilli(), ExpiresAt: now.Add(s.ttl).UnixMilli(),
	}
	if e.ServerName == "" {
		e.ServerName = req.Server
	}
	if req.ThreadID != "" {
		t := req.ThreadID
		e.ThreadID = &t
	}
	if req.Tool != "" {
		t := req.Tool
		e.Tool = &t
	}
	s.mu.Lock()
	pending := 0
	for _, it := range s.items {
		if it.e.AgentID == agentID && it.e.State == "pending" {
			pending++
		}
	}
	if pending >= maxPending {
		s.mu.Unlock()
		return Elicitation{}, &Error{Status: http.StatusTooManyRequests, Code: "too_many", Message: "Too many questions are waiting for the person."}
	}
	it := &item{e: e, schema: sc, done: make(chan struct{})}
	s.items[e.ID] = it
	it.timer = time.AfterFunc(s.ttl, func() { s.settle(e.ID, "expired", &Answer{Action: "cancel"}) })
	s.mu.Unlock()
	s.OnChange(e)
	return e, nil
}

// settle ends a pending question; false when it wasn't pending.
func (s *Store) settle(id, state string, answer *Answer) bool {
	s.mu.Lock()
	it, ok := s.items[id]
	if !ok || it.e.State != "pending" {
		s.mu.Unlock()
		return false
	}
	it.e.State, it.answer = state, answer
	it.timer.Stop()
	close(it.done)
	e := it.e
	s.mu.Unlock()
	s.OnChange(e)
	// Kept a little while for a runtime that polls late, then forgotten (with the answer's content).
	time.AfterFunc(2*time.Minute, func() {
		s.mu.Lock()
		delete(s.items, id)
		s.mu.Unlock()
	})
	return true
}

// Answer is the person's answer from the UI.
func (s *Store) Answer(id, action string, content map[string]any) (Elicitation, error) {
	s.mu.Lock()
	it, ok := s.items[id]
	var sc schema
	var state string
	if ok {
		sc, state = it.schema, it.e.State
	}
	s.mu.Unlock()
	if !ok {
		return Elicitation{}, ErrNotFound
	}
	if state != "pending" {
		return Elicitation{}, &Error{Status: http.StatusConflict, Code: "not_pending", Message: "That question was already answered or has expired."}
	}
	var answer *Answer
	switch action {
	case "accept":
		clean, err := checkContent(sc, content)
		if err != nil {
			return Elicitation{}, err
		}
		answer = &Answer{Action: "accept", Content: clean}
		state = "accepted"
	case "decline":
		answer, state = &Answer{Action: "decline"}, "declined"
	case "cancel":
		answer, state = &Answer{Action: "cancel"}, "cancelled"
	default:
		return Elicitation{}, bad("invalid_action", "Answer accept, decline or cancel.")
	}
	if !s.settle(id, state, answer) {
		return Elicitation{}, &Error{Status: http.StatusConflict, Code: "not_pending", Message: "That question was already answered or has expired."}
	}
	e, _ := s.get(id)
	return e, nil
}

// checkContent checks an accepted form against the schema and returns it with only the schema's fields.
func checkContent(sc schema, content map[string]any) (map[string]any, error) {
	out := map[string]any{}
	for name := range content {
		if _, ok := sc.Properties[name]; !ok {
			return nil, bad("invalid_content", "The form has no field %q.", name)
		}
	}
	names := make([]string, 0, len(sc.Properties))
	for name := range sc.Properties {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		p := sc.Properties[name]
		label := p.Title
		if label == "" {
			label = name
		}
		v, present := content[name]
		if !present || v == nil {
			for _, r := range sc.Required {
				if r == name {
					return nil, bad("invalid_content", "%s is required.", label)
				}
			}
			continue
		}
		switch p.Type {
		case "boolean":
			b, ok := v.(bool)
			if !ok {
				return nil, bad("invalid_content", "%s must be yes or no.", label)
			}
			out[name] = b
		case "number", "integer":
			f, ok := v.(float64)
			if !ok || math.IsNaN(f) || math.IsInf(f, 0) {
				return nil, bad("invalid_content", "%s must be a number.", label)
			}
			if p.Type == "integer" && f != math.Trunc(f) {
				return nil, bad("invalid_content", "%s must be a whole number.", label)
			}
			if (p.Minimum != nil && f < *p.Minimum) || (p.Maximum != nil && f > *p.Maximum) {
				return nil, bad("invalid_content", "%s is out of range.", label)
			}
			out[name] = f
		case "string":
			str, ok := v.(string)
			if !ok {
				return nil, bad("invalid_content", "%s must be text.", label)
			}
			n := utf8.RuneCountInString(str)
			if n > maxStringLen || (p.MaxLength != nil && n > *p.MaxLength) || (p.MinLength != nil && n < *p.MinLength) {
				return nil, bad("invalid_content", "%s has the wrong length.", label)
			}
			if len(p.Enum) > 0 {
				found := false
				for _, opt := range p.Enum {
					found = found || opt == str
				}
				if !found {
					return nil, bad("invalid_content", "%s must be one of the choices.", label)
				}
			}
			if err := checkFormat(p.Format, str); err != nil {
				return nil, bad("invalid_content", "%s %s.", label, err.Error())
			}
			out[name] = str
		}
	}
	return out, nil
}

func checkFormat(format, v string) error {
	if v == "" {
		return nil
	}
	switch format {
	case "email":
		if _, err := mail.ParseAddress(v); err != nil {
			return errors.New("must be an email address")
		}
	case "uri":
		if u, err := url.Parse(v); err != nil || u.Scheme == "" {
			return errors.New("must be a full address")
		}
	case "date":
		if _, err := time.Parse(time.DateOnly, v); err != nil {
			return errors.New("must be a date (YYYY-MM-DD)")
		}
	case "date-time":
		if _, err := time.Parse(time.RFC3339, v); err != nil {
			return errors.New("must be a date and time")
		}
	}
	return nil
}

func (s *Store) get(id string) (Elicitation, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	it, ok := s.items[id]
	if !ok {
		return Elicitation{}, false
	}
	return it.e, true
}

// Wait waits up to max for an agent's question to be answered: its answer, or done false when still pending.
func (s *Store) Wait(ctx context.Context, agentID, id string, max time.Duration) (Answer, bool, error) {
	s.mu.Lock()
	it, ok := s.items[id]
	s.mu.Unlock()
	if !ok || it.e.AgentID != agentID {
		return Answer{}, false, ErrNotFound
	}
	t := time.NewTimer(max)
	defer t.Stop()
	select {
	case <-it.done:
		s.mu.Lock()
		a := *it.answer
		s.mu.Unlock()
		return a, true, nil
	case <-t.C:
		return Answer{}, false, nil
	case <-ctx.Done():
		return Answer{}, false, ctx.Err()
	}
}

// Withdraw ends an agent's question that the server or the call gave up on.
func (s *Store) Withdraw(agentID, id string) error {
	s.mu.Lock()
	it, ok := s.items[id]
	s.mu.Unlock()
	if !ok || it.e.AgentID != agentID {
		return ErrNotFound
	}
	s.settle(id, "cancelled", &Answer{Action: "cancel"})
	return nil
}

// ForgetAgent withdraws an agent's questions (its runtime stopped, or it was deleted).
func (s *Store) ForgetAgent(agentID string) {
	s.mu.Lock()
	var ids []string
	for id, it := range s.items {
		if it.e.AgentID == agentID && it.e.State == "pending" {
			ids = append(ids, id)
		}
	}
	s.mu.Unlock()
	for _, id := range ids {
		s.settle(id, "cancelled", &Answer{Action: "cancel"})
	}
}

// Pending lists the questions waiting for the person, oldest first.
func (s *Store) Pending() []Elicitation {
	s.mu.Lock()
	out := []Elicitation{}
	for _, it := range s.items {
		if it.e.State == "pending" {
			out = append(out, it.e)
		}
	}
	s.mu.Unlock()
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt < out[j].CreatedAt })
	return out
}
