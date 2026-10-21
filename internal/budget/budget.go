// Package budget keeps monthly spending limits: one for each agent (agent.yaml `budget`) and one for the whole app
// (Settings → Usage). Spending is this calendar month's usage at the models' prices; requests to models without
// prices can't be counted in dollars and are reported apart. At 80% and at 100% of a budget an event goes out (once
// each month), and at 100% an agent whose budget says "stop" is refused new work.
package budget

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/ncecere/pi-local/internal/agents"
	"github.com/ncecere/pi-local/internal/usage"
)

// Levels at which a budget says something.
const (
	// WarnPercent: "used 80% of its budget".
	WarnPercent = 80
	// StopPercent: "reached its budget".
	StopPercent = 100
)

// States of a budget this month.
const (
	StateOK   = "ok"
	StateNear = "near" // at 80% or more
	StateOver = "over" // at 100% or more
)

const appSetting = "budget.app"

// Setting is the app-wide budget.
type Setting = agents.Budget

// Status is one budget and how much of it is used this month (docs/api.md, BudgetStatus).
type Status struct {
	Scope      string  `json:"scope"` // "app" or "agent"
	AgentID    string  `json:"agentId,omitempty"`
	Name       string  `json:"name"` // the agent's name, or "Pi Local"
	Month      string  `json:"month"`
	MonthName  string  `json:"monthName"` // "October"
	MonthlyUSD float64 `json:"monthlyUsd"`
	OnExceed   string  `json:"onExceed"`
	SpentUSD   float64 `json:"spentUsd"`
	// UnpricedRequests this month: not in SpentUSD, so the real spending may be more.
	UnpricedRequests int64   `json:"unpricedRequests"`
	Percent          float64 `json:"percent"`
	State            string  `json:"state"`
	// Blocked: the budget says stop and is used up, so new work is refused.
	Blocked bool `json:"blocked"`
}

// Overview is the app's budget and every agent's.
type Overview struct {
	App    *Status  `json:"app"`
	Agents []Status `json:"agents"`
}

// Event is what the hub carries as the `budget` event (docs/api.md): a budget reached 80% or 100% of its limit.
type Event struct {
	Level   int    `json:"level"` // 80 or 100
	Message string `json:"message"`
	Status  Status `json:"status"`
}

// OverBudgetError is a refusal: new work is not accepted while a budget that says stop is used up. Its message is for
// people (and, for an ask, for the asking agent's model).
type OverBudgetError struct {
	Message string
	Status  Status
}

func (e *OverBudgetError) Error() string { return e.Message }

// HTTPStatus and Code are the API's answer: 402 over_budget.
func (e *OverBudgetError) HTTPStatus() int { return http.StatusPaymentRequired }

// Code is the API error code.
func (e *OverBudgetError) Code() string { return "over_budget" }

// Service computes budgets and enforces them.
type Service struct {
	db    *sql.DB
	usage *usage.Store
	// Prices gives a model's prices (nil: nothing is priced).
	Prices usage.Prices
	// Agent finds an agent's name and budget (b is nil without one); All lists the agents that have a budget.
	Agent func(id string) (name string, b *agents.Budget, ok bool)
	All   func() []AgentBudget
	// Publish sends the `budget` event.
	Publish func(Event)

	now func() time.Time
	mu  sync.Mutex // one evaluation at a time, so an alert is sent once
}

// AgentBudget is an agent with a budget.
type AgentBudget struct {
	ID     string
	Name   string
	Budget agents.Budget
}

// New makes the service.
func New(db *sql.DB, store *usage.Store) *Service {
	return &Service{db: db, usage: store, now: time.Now, Publish: func(Event) {}}
}

// SetClock replaces the clock (tests).
func (s *Service) SetClock(now func() time.Time) { s.now = now }

// App is the app-wide budget, or nil when there is none.
func (s *Service) App(ctx context.Context) *Setting {
	var raw string
	if err := s.db.QueryRowContext(ctx, `SELECT value FROM settings WHERE key = ?`, appSetting).Scan(&raw); err != nil {
		return nil
	}
	var b Setting
	if json.Unmarshal([]byte(raw), &b) != nil || b.CheckBudget() != nil {
		return nil
	}
	return &b
}

// SetApp sets the app-wide budget, or removes it (nil).
func (s *Service) SetApp(ctx context.Context, b *Setting) error {
	if b == nil {
		_, err := s.db.ExecContext(ctx, `DELETE FROM settings WHERE key = ?`, appSetting)
		return err
	}
	if err := b.CheckBudget(); err != nil {
		return err
	}
	raw, _ := json.Marshal(b)
	_, err := s.db.ExecContext(ctx, `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, appSetting, string(raw))
	return err
}

func (s *Service) prices() usage.Prices {
	if s.Prices != nil {
		return s.Prices
	}
	return func(string) (usage.Price, bool) { return usage.Price{}, false }
}

// money writes dollars the way people say them: $20, $20.50.
func money(v float64) string {
	cents := int64(math.Round(v * 100))
	if cents%100 == 0 {
		return "$" + commas(cents/100)
	}
	return fmt.Sprintf("$%s.%02d", commas(cents/100), cents%100)
}

func commas(n int64) string {
	s := fmt.Sprint(n)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}

func (s *Service) status(ctx context.Context, month, scope, agentID, name string, b agents.Budget) (Status, error) {
	month, _, _, ok := s.usage.MonthRange(month)
	if !ok {
		return Status{}, fmt.Errorf("invalid month")
	}
	t, _ := time.ParseInLocation("2006-01", month, s.now().Location())
	spend, err := s.usage.Spend(ctx, month, agentID, s.prices())
	if err != nil {
		return Status{}, err
	}
	st := Status{Scope: scope, AgentID: agentID, Name: name, Month: month, MonthName: t.Month().String(),
		MonthlyUSD: b.MonthlyUSD, OnExceed: b.OnExceed, SpentUSD: spend.CostUSD, UnpricedRequests: spend.UnpricedRequests, State: StateOK}
	st.Percent = spend.CostUSD / b.MonthlyUSD * 100
	switch {
	case st.Percent >= StopPercent:
		st.State = StateOver
		st.Blocked = b.OnExceed == agents.BudgetStop
	case st.Percent >= WarnPercent:
		st.State = StateNear
	}
	return st, nil
}

// AppStatus is the app-wide budget's status for a month ("YYYY-MM", "" for this one); nil when there is no budget.
func (s *Service) AppStatus(ctx context.Context, month string) (*Status, error) {
	b := s.App(ctx)
	if b == nil {
		return nil, nil
	}
	st, err := s.status(ctx, month, "app", "", "Pi Local", *b)
	return &st, err
}

// AgentStatus is an agent's budget status for a month; nil when it has no budget.
func (s *Service) AgentStatus(ctx context.Context, month, agentID string) (*Status, error) {
	name, b, ok := s.Agent(agentID)
	if !ok || b == nil {
		return nil, nil
	}
	st, err := s.status(ctx, month, "agent", agentID, name, *b)
	return &st, err
}

// Overview is the app's budget and every agent's that has one, this month.
func (s *Service) Overview(ctx context.Context) (*Overview, error) {
	app, err := s.AppStatus(ctx, "")
	if err != nil {
		return nil, err
	}
	o := &Overview{App: app, Agents: []Status{}}
	for _, a := range s.All() {
		st, err := s.status(ctx, "", "agent", a.ID, a.Name, a.Budget)
		if err != nil {
			return nil, err
		}
		o.Agents = append(o.Agents, st)
	}
	return o, nil
}

func (st Status) refusal() *OverBudgetError {
	what := "Raise it in its settings."
	if st.Scope == "app" {
		what = "Raise it in Settings → Usage."
	}
	return &OverBudgetError{Status: st,
		Message: fmt.Sprintf("%s reached its %s budget for %s. %s", st.Name, money(st.MonthlyUSD), st.MonthName, what)}
}

// Check refuses new work for an agent whose budget (or the app's) says stop and is used up: an *OverBudgetError. Any
// other trouble reading usage lets the work through (a budget is a guard, not a reason to stop working).
func (s *Service) Check(ctx context.Context, agentID string) error {
	if st, err := s.AgentStatus(ctx, "", agentID); err == nil && st != nil && st.Blocked {
		return st.refusal()
	}
	if st, err := s.AppStatus(ctx, ""); err == nil && st != nil && st.Blocked {
		return st.refusal()
	}
	return nil
}

func (st Status) alertText(level int) string {
	if level >= StopPercent {
		msg := fmt.Sprintf("%s reached its %s budget for %s.", st.Name, money(st.MonthlyUSD), st.MonthName)
		if st.OnExceed == agents.BudgetStop {
			if st.Scope == "app" {
				return msg + " Agents are stopped until you raise it."
			}
			return msg + " It is stopped until you raise it."
		}
		return msg + " It keeps running."
	}
	return fmt.Sprintf("%s used %d%% of its %s budget for %s.", st.Name, WarnPercent, money(st.MonthlyUSD), st.MonthName)
}

// Evaluate looks at an agent's budget and the app's after it used its model, and sends a `budget` event the first
// time each reaches 80% and 100% in a month (again if the limit is changed and reached again).
func (s *Service) Evaluate(ctx context.Context, agentID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var list []*Status
	if st, err := s.AgentStatus(ctx, "", agentID); err == nil && st != nil {
		list = append(list, st)
	}
	if st, err := s.AppStatus(ctx, ""); err == nil && st != nil {
		list = append(list, st)
	}
	for _, st := range list {
		level := 0
		switch st.State {
		case StateOver:
			level = StopPercent
		case StateNear:
			level = WarnPercent
		}
		if level == 0 {
			continue
		}
		scope := "app"
		if st.Scope == "agent" {
			scope = st.AgentID
		}
		key := "budget.alert." + scope + "." + st.Month
		stamp := func(l int) string { return fmt.Sprintf("%d@%v", l, st.MonthlyUSD) }
		var last string
		s.db.QueryRowContext(ctx, `SELECT value FROM settings WHERE key = ?`, key).Scan(&last)
		// Done already at this level (or a higher one) for this limit.
		if prev, limit, ok := strings.Cut(last, "@"); ok && limit == fmt.Sprint(st.MonthlyUSD) {
			var n int
			fmt.Sscan(prev, &n)
			if n >= level {
				continue
			}
		}
		if _, err := s.db.ExecContext(ctx, `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, key, stamp(level)); err != nil {
			continue
		}
		s.Publish(Event{Level: level, Message: st.alertText(level), Status: *st})
	}
}
