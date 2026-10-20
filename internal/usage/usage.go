// Package usage records the model usage runtimes report, per local day, agent and model, and reports it with an
// estimated cost from the models' prices.
package usage

import (
	"context"
	"database/sql"
	"sort"
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
	From   string        `json:"from"`
	To     string        `json:"to"`
	Days   int           `json:"days"`
	Total  Totals        `json:"total"`
	Agents []AgentTotals `json:"agents"`
	Models []ModelTotals `json:"models"`
	ByDay  []DayTotals   `json:"byDay"`
}

// Prices gives a model's prices in USD per million tokens (input, output), or ok=false when it has none.
type Prices func(model string) (input, output float64, ok bool)

// Names gives current names for agents and models still around (deleted ones keep the name recorded last).
type Names struct {
	Agent func(id string) (string, bool)
	Model func(id string) (string, bool)
}

// Report sums the last `days` days (today included).
func (s *Store) Report(ctx context.Context, days int, prices Prices, names Names) (*Report, error) {
	today := s.now()
	from := today.AddDate(0, 0, -(days - 1)).Format(time.DateOnly)
	to := today.Format(time.DateOnly)
	rows, err := s.db.QueryContext(ctx, `SELECT day, agent_id, agent_name, model, model_name, requests, input, output, cache_read, cache_write
		FROM usage WHERE day >= ? AND day <= ?`, from, to)
	if err != nil {
		return nil, err
	}
	// Read every row before looking up prices and names: those are queries too, and app.db has one connection, which
	// these rows hold until they are closed.
	type row struct {
		day, agentID, agentName, model, modelName string
		c                                         Counts
	}
	var all []row
	for rows.Next() {
		var x row
		if err := rows.Scan(&x.day, &x.agentID, &x.agentName, &x.model, &x.modelName, &x.c.Requests, &x.c.Input, &x.c.Output, &x.c.CacheRead, &x.c.CacheWrite); err != nil {
			rows.Close()
			return nil, err
		}
		all = append(all, x)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	r := &Report{From: from, To: to, Days: days}
	agents := map[string]*AgentTotals{}
	models := map[string]*ModelTotals{}
	byDay := map[string]*DayTotals{}
	for _, x := range all {
		day, agentID, agentName, model, modelName, c := x.day, x.agentID, x.agentName, x.model, x.modelName, x.c
		t := Totals{Requests: c.Requests, InputTokens: c.Input, OutputTokens: c.Output, CacheReadTokens: c.CacheRead, CacheWriteTokens: c.CacheWrite}
		if in, out, ok := prices(model); ok {
			// Cached input reads are billed as input here: an estimate that errs on the high side.
			t.CostUSD = (float64(c.Input+c.CacheRead+c.CacheWrite)*in + float64(c.Output)*out) / 1e6
		} else {
			t.UnpricedRequests = c.Requests
		}
		r.Total.add(t)
		if names.Agent != nil {
			if n, ok := names.Agent(agentID); ok {
				agentName = n
			}
		}
		if names.Model != nil {
			if n, ok := names.Model(model); ok {
				modelName = n
			}
		}
		if agents[agentID] == nil {
			agents[agentID] = &AgentTotals{AgentID: agentID, Name: agentName}
		}
		agents[agentID].add(t)
		if models[model] == nil {
			models[model] = &ModelTotals{ModelID: model, Name: modelName}
		}
		models[model].add(t)
		if byDay[day] == nil {
			byDay[day] = &DayTotals{Day: day}
		}
		byDay[day].add(t)
	}
	r.Agents = []AgentTotals{}
	for _, a := range agents {
		r.Agents = append(r.Agents, *a)
	}
	sort.Slice(r.Agents, func(i, j int) bool { return r.Agents[i].Requests > r.Agents[j].Requests })
	r.Models = []ModelTotals{}
	for _, m := range models {
		r.Models = append(r.Models, *m)
	}
	sort.Slice(r.Models, func(i, j int) bool { return r.Models[i].Requests > r.Models[j].Requests })
	// Every day of the range, zeros included, oldest first.
	for d := 0; d < days; d++ {
		day := today.AddDate(0, 0, -(days - 1 - d)).Format(time.DateOnly)
		if t := byDay[day]; t != nil {
			r.ByDay = append(r.ByDay, *t)
		} else {
			r.ByDay = append(r.ByDay, DayTotals{Day: day})
		}
	}
	return r, nil
}
