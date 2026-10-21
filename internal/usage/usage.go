// Package usage records the model usage runtimes report, per local day, agent and model, and reports it with an
// estimated cost from the models' prices.
package usage

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"strings"
	"time"
)

// Counts are one report's numbers (runtime/src/lib/usage.ts).
type Counts struct {
	Requests   int64 `json:"requests"`
	Input      int64 `json:"input"`
	Output     int64 `json:"output"`
	CacheRead  int64 `json:"cacheRead"`
	CacheWrite int64 `json:"cacheWrite"`
}

// Valid: whole numbers from 0, within reason (a runtime is trusted only so far).
func (c Counts) Valid() bool {
	const max = 1 << 40
	for _, n := range []int64{c.Requests, c.Input, c.Output, c.CacheRead, c.CacheWrite} {
		if n < 0 || n > max {
			return false
		}
	}
	return c.Requests > 0
}

// Store is the usage table.
type Store struct {
	db  *sql.DB
	now func() time.Time
}

// New makes the store.
func New(db *sql.DB) *Store { return &Store{db: db, now: time.Now} }

// SetClock replaces the clock (tests).
func (s *Store) SetClock(now func() time.Time) { s.now = now }

// Record adds a report to today's row for the agent and model.
func (s *Store) Record(ctx context.Context, agentID, agentName, model, modelName string, c Counts) error {
	day := s.now().Format(time.DateOnly)
	_, err := s.db.ExecContext(ctx, `INSERT INTO usage (day, agent_id, agent_name, model, model_name, requests, input, output, cache_read, cache_write)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (day, agent_id, model) DO UPDATE SET agent_name = excluded.agent_name, model_name = excluded.model_name,
			requests = requests + excluded.requests, input = input + excluded.input, output = output + excluded.output,
			cache_read = cache_read + excluded.cache_read, cache_write = cache_write + excluded.cache_write`,
		day, agentID, agentName, model, modelName, c.Requests, c.Input, c.Output, c.CacheRead, c.CacheWrite)
	return err
}

// Totals are summed usage with its estimated cost (docs/api.md, UsageTotals).
type Totals struct {
	Requests         int64   `json:"requests"`
	InputTokens      int64   `json:"inputTokens"`
	OutputTokens     int64   `json:"outputTokens"`
	CacheReadTokens  int64   `json:"cacheReadTokens"`
	CacheWriteTokens int64   `json:"cacheWriteTokens"`
	CostUSD          float64 `json:"costUsd"`
	UnpricedRequests int64   `json:"unpricedRequests"`
}

func (t *Totals) add(o Totals) {
	t.Requests += o.Requests
	t.InputTokens += o.InputTokens
	t.OutputTokens += o.OutputTokens
	t.CacheReadTokens += o.CacheReadTokens
	t.CacheWriteTokens += o.CacheWriteTokens
	t.CostUSD += o.CostUSD
	t.UnpricedRequests += o.UnpricedRequests
}

// AgentTotals is one agent's line.
type AgentTotals struct {
	Totals
	AgentID string `json:"agentId"`
	Name    string `json:"name"`
}

// ModelTotals is one model's line.
type ModelTotals struct {
	Totals
	ModelID string `json:"modelId"`
	Name    string `json:"name"`
}

// DayTotals is one day's line.
type DayTotals struct {
	Totals
	Day string `json:"day"`
}

// Report is usage over a range of days (docs/api.md, UsageReport).
type Report struct {
	From string `json:"from"`
	To   string `json:"to"`
	Days int    `json:"days"`
	// Month is "YYYY-MM" for a month report.
	Month  string        `json:"month,omitempty"`
	Total  Totals        `json:"total"`
	Agents []AgentTotals `json:"agents"`
	Models []ModelTotals `json:"models"`
	ByDay  []DayTotals   `json:"byDay"`
	// Options are the agents and models with usage in the period, for the filters.
	Options Options `json:"options"`
	// Budget: this month's budgets (docs/api.md, UsageBudget), set by the API; null when none applies.
	Budget any `json:"budget"`
}

// Price is a model's price in USD per million tokens. CacheRead and CacheWrite are nil when it has none: cached tokens
// are then counted at the input price, an estimate that errs on the high side.
type Price struct {
	Input, Output         float64
	CacheRead, CacheWrite *float64
}

// Cost is what a report's tokens cost at this price.
func (p Price) Cost(c Counts) float64 {
	read, write := p.Input, p.Input
	if p.CacheRead != nil {
		read = *p.CacheRead
	}
	if p.CacheWrite != nil {
		write = *p.CacheWrite
	}
	return (float64(c.Input)*p.Input + float64(c.Output)*p.Output + float64(c.CacheRead)*read + float64(c.CacheWrite)*write) / 1e6
}

// Prices gives a model's prices, or ok=false when it has none (its usage is counted, but as unpriced).
type Prices func(model string) (Price, bool)

// Names gives current names for agents and models still around (deleted ones keep the name recorded last).
type Names struct {
	Agent func(id string) (string, bool)
	Model func(id string) (string, bool)
}

// Query says which usage a report is about: the last Days days (today included), or a calendar Month ("2026-10", the
// whole month), optionally only one agent's or one model's.
type Query struct {
	Days  int
	Month string
	Agent string
	Model string
}

// AgentOption and ModelOption are what the filters offer: everything with usage in the period, whatever is filtered.
type AgentOption struct {
	AgentID string `json:"agentId"`
	Name    string `json:"name"`
}

// ModelOption is a model with usage in the period.
type ModelOption struct {
	ModelID string `json:"modelId"`
	Name    string `json:"name"`
}

// Options are the filters' choices.
type Options struct {
	Agents []AgentOption `json:"agents"`
	Models []ModelOption `json:"models"`
}

type row struct {
	day, agentID, agentName, model, modelName string
	c                                         Counts
}

// load reads the rows from..to (YYYY-MM-DD). Every row is read before the caller looks up prices and names: those
// are queries too, and app.db has one connection, which an open result holds until it is closed.
func (s *Store) load(ctx context.Context, from, to string) ([]row, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT day, agent_id, agent_name, model, model_name, requests, input, output, cache_read, cache_write
		FROM usage WHERE day >= ? AND day <= ?`, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var all []row
	for rows.Next() {
		var x row
		if err := rows.Scan(&x.day, &x.agentID, &x.agentName, &x.model, &x.modelName, &x.c.Requests, &x.c.Input, &x.c.Output, &x.c.CacheRead, &x.c.CacheWrite); err != nil {
			return nil, err
		}
		all = append(all, x)
	}
	return all, rows.Err()
}

// totalsOf is a row's numbers with their cost (unpriced requests counted apart).
func totalsOf(c Counts, price Price, priced bool) Totals {
	t := Totals{Requests: c.Requests, InputTokens: c.Input, OutputTokens: c.Output, CacheReadTokens: c.CacheRead, CacheWriteTokens: c.CacheWrite}
	if priced {
		t.CostUSD = price.Cost(c)
	} else {
		t.UnpricedRequests = c.Requests
	}
	return t
}

// priceLookup remembers each model's price for the length of one report (a lookup is a query).
func priceLookup(prices Prices) Prices {
	type found struct {
		p  Price
		ok bool
	}
	seen := map[string]found{}
	return func(model string) (Price, bool) {
		if f, ok := seen[model]; ok {
			return f.p, f.ok
		}
		p, ok := prices(model)
		seen[model] = found{p, ok}
		return p, ok
	}
}

// MonthRange is a calendar month's first and last day, for a month "YYYY-MM" ("" is the current one), and its key.
func (s *Store) MonthRange(month string) (key, from, to string, ok bool) {
	var first time.Time
	if month == "" {
		now := s.now()
		first = time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, now.Location())
	} else {
		t, err := time.ParseInLocation("2006-01", month, s.now().Location())
		if err != nil {
			return "", "", "", false
		}
		first = t
	}
	last := first.AddDate(0, 1, -1)
	return first.Format("2006-01"), first.Format(time.DateOnly), last.Format(time.DateOnly), true
}

// Spend is what a month's usage cost: the cost of the priced requests, and how many requests had no price.
type Spend struct {
	CostUSD          float64 `json:"costUsd"`
	Requests         int64   `json:"requests"`
	UnpricedRequests int64   `json:"unpricedRequests"`
}

// Spend sums a calendar month ("YYYY-MM", "" for the current one) for one agent, or for all of them ("").
func (s *Store) Spend(ctx context.Context, month, agentID string, prices Prices) (Spend, error) {
	_, from, to, ok := s.MonthRange(month)
	if !ok {
		return Spend{}, fmt.Errorf("invalid month %q", month)
	}
	all, err := s.load(ctx, from, to)
	if err != nil {
		return Spend{}, err
	}
	prices = priceLookup(prices)
	var out Spend
	for _, x := range all {
		if agentID != "" && x.agentID != agentID {
			continue
		}
		price, priced := prices(x.model)
		t := totalsOf(x.c, price, priced)
		out.CostUSD += t.CostUSD
		out.Requests += t.Requests
		out.UnpricedRequests += t.UnpricedRequests
	}
	return out, nil
}

// Report sums the usage the query asks for.
func (s *Store) Report(ctx context.Context, q Query, prices Prices, names Names) (*Report, error) {
	today := s.now()
	var from, to string
	var days int
	if q.Month != "" {
		key, f, t, ok := s.MonthRange(q.Month)
		if !ok {
			return nil, fmt.Errorf("invalid month %q", q.Month)
		}
		from, to = f, t
		first, _ := time.ParseInLocation(time.DateOnly, from, today.Location())
		last, _ := time.ParseInLocation(time.DateOnly, to, today.Location())
		days = int(last.Sub(first).Hours()/24+0.5) + 1
		q.Month = key
	} else {
		days = q.Days
		from = today.AddDate(0, 0, -(days - 1)).Format(time.DateOnly)
		to = today.Format(time.DateOnly)
	}
	all, err := s.load(ctx, from, to)
	if err != nil {
		return nil, err
	}
	prices = priceLookup(prices)
	agentName := func(id, recorded string) string {
		if names.Agent != nil {
			if n, ok := names.Agent(id); ok {
				return n
			}
		}
		return recorded
	}
	modelName := func(id, recorded string) string {
		if names.Model != nil {
			if n, ok := names.Model(id); ok {
				return n
			}
		}
		return recorded
	}
	r := &Report{From: from, To: to, Days: days, Month: q.Month}
	agents := map[string]*AgentTotals{}
	models := map[string]*ModelTotals{}
	byDay := map[string]*DayTotals{}
	options := Options{Agents: []AgentOption{}, Models: []ModelOption{}}
	seenAgent, seenModel := map[string]bool{}, map[string]bool{}
	for _, x := range all {
		// The filters offer everything used in the period, not only what is left after filtering.
		if !seenAgent[x.agentID] {
			seenAgent[x.agentID] = true
			options.Agents = append(options.Agents, AgentOption{AgentID: x.agentID, Name: agentName(x.agentID, x.agentName)})
		}
		if !seenModel[x.model] {
			seenModel[x.model] = true
			options.Models = append(options.Models, ModelOption{ModelID: x.model, Name: modelName(x.model, x.modelName)})
		}
		if (q.Agent != "" && x.agentID != q.Agent) || (q.Model != "" && x.model != q.Model) {
			continue
		}
		price, priced := prices(x.model)
		t := totalsOf(x.c, price, priced)
		r.Total.add(t)
		if agents[x.agentID] == nil {
			agents[x.agentID] = &AgentTotals{AgentID: x.agentID, Name: agentName(x.agentID, x.agentName)}
		}
		agents[x.agentID].add(t)
		if models[x.model] == nil {
			models[x.model] = &ModelTotals{ModelID: x.model, Name: modelName(x.model, x.modelName)}
		}
		models[x.model].add(t)
		if byDay[x.day] == nil {
			byDay[x.day] = &DayTotals{Day: x.day}
		}
		byDay[x.day].add(t)
	}
	sort.Slice(options.Agents, func(i, j int) bool {
		return strings.ToLower(options.Agents[i].Name) < strings.ToLower(options.Agents[j].Name)
	})
	sort.Slice(options.Models, func(i, j int) bool {
		return strings.ToLower(options.Models[i].Name) < strings.ToLower(options.Models[j].Name)
	})
	r.Options = options
	r.Agents = []AgentTotals{}
	for _, a := range agents {
		r.Agents = append(r.Agents, *a)
	}
	sort.Slice(r.Agents, func(i, j int) bool {
		if r.Agents[i].Requests != r.Agents[j].Requests {
			return r.Agents[i].Requests > r.Agents[j].Requests
		}
		return r.Agents[i].AgentID < r.Agents[j].AgentID
	})
	r.Models = []ModelTotals{}
	for _, m := range models {
		r.Models = append(r.Models, *m)
	}
	sort.Slice(r.Models, func(i, j int) bool {
		if r.Models[i].Requests != r.Models[j].Requests {
			return r.Models[i].Requests > r.Models[j].Requests
		}
		return r.Models[i].ModelID < r.Models[j].ModelID
	})
	// Every day of the range, zeros included, oldest first.
	start, _ := time.ParseInLocation(time.DateOnly, from, today.Location())
	r.ByDay = []DayTotals{}
	for d := 0; d < days; d++ {
		day := start.AddDate(0, 0, d).Format(time.DateOnly)
		if t := byDay[day]; t != nil {
			r.ByDay = append(r.ByDay, *t)
		} else {
			r.ByDay = append(r.ByDay, DayTotals{Day: day})
		}
	}
	return r, nil
}
