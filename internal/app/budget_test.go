package app

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ncecere/pi-local/internal/budget"
	"github.com/ncecere/pi-local/internal/usage"
)

// budgetEvents collects the `budget` events the hub sends (level 0: a budget was changed).
type budgetEvents struct {
	mu   sync.Mutex
	list []budget.Event
}

func watchBudgets(t *testing.T, h *harness) *budgetEvents {
	t.Helper()
	ch, cancel := h.app.Hub.Subscribe()
	t.Cleanup(cancel)
	got := &budgetEvents{}
	go func() {
		for ev := range ch {
			if ev.Name != "budget" {
				continue
			}
			var e budget.Event
			if json.Unmarshal(ev.Data, &e) == nil {
				got.mu.Lock()
				got.list = append(got.list, e)
				got.mu.Unlock()
			}
		}
	}()
	return got
}

// levels are the 80 and 100 events so far, in order (changes, level 0, left out).
func (b *budgetEvents) levels() []int {
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []int
	for _, e := range b.list {
		if e.Level > 0 {
			out = append(out, e.Level)
		}
	}
	return out
}

func (b *budgetEvents) last() budget.Event {
	b.mu.Lock()
	defer b.mu.Unlock()
	for i := len(b.list) - 1; i >= 0; i-- {
		if b.list[i].Level > 0 {
			return b.list[i]
		}
	}
	return budget.Event{}
}

type budgetJSON struct {
	App    *budget.Status  `json:"app"`
	Agents []budget.Status `json:"agents"`
}

func (h *harness) budgets() budgetJSON {
	h.t.Helper()
	return decodeInto[budgetJSON](h.t, h.mustDo("GET", "/api/budgets", nil, 200))
}

func (h *harness) agentBudget(agent string) *budget.Status {
	h.t.Helper()
	for _, s := range h.budgets().Agents {
		if s.AgentID == agent {
			return &s
		}
	}
	return nil
}

// spend adds usage that costs `usd` at the scripted model's prices ($1 per million tokens each way: a million tokens
// of input is a dollar).
func (h *harness) spend(agent string, usd float64) {
	h.t.Helper()
	tokens := int64(usd * 1e6 / 2) // half in, half out, each at $1 per million
	err := h.app.RecordUsage(context.Background(), agent, "script/s1", usage.Counts{Requests: 1, Input: tokens, Output: tokens})
	if err != nil {
		h.t.Fatal(err)
	}
}

func (h *harness) priceScripted(in, out float64) {
	h.t.Helper()
	h.mustDo("PUT", "/api/providers/script/models/s1", map[string]any{"name": "Scripted", "inputPrice": in, "outputPrice": out}, 200)
}

func overBudget(t *testing.T, h *harness, agent, thread string) (int, string, string) {
	t.Helper()
	code, data := h.do("POST", "/api/agents/"+agent+"/threads/"+thread+"/messages", map[string]string{"text": "more please", "requestId": "rx-" + thread})
	var e struct {
		Error struct{ Code, Message string }
	}
	json.Unmarshal(data, &e)
	return code, e.Error.Code, e.Error.Message
}

// Real usage, reported by a real runtime: 1,200 tokens in and 300 out cost $0.90 at $500 and $1,000 per million.
func TestAnAgentBudgetWarnsAtEightyPercentAndStopsAtAHundred(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	scripted(t, h)
	h.priceScripted(500, 1000)
	events := watchBudgets(t, h)
	agent := h.agentOn("Spendy", "script/s1", map[string]any{"budget": map[string]any{"monthlyUsd": 1}})
	month := time.Now().Month().String()

	// A budget is on the agent, with stop as the default.
	if got := string(h.mustDo("GET", "/api/agents", nil, 200)); !strings.Contains(got, `"budget":{"monthlyUsd":1,"onExceed":"stop"}`) {
		t.Fatalf("agent budget: %s", got)
	}

	h.sendAndWait(agent, "t1", "hello", "r1")
	eventually(t, 20*time.Second, "the 80% event", func() bool { return len(events.levels()) == 1 })
	if e := events.last(); e.Level != 80 || e.Status.AgentID != agent || !strings.Contains(e.Message, "used 90% of its $1 budget for "+month) {
		t.Fatalf("80%% event: %+v", e)
	}
	st := h.agentBudget(agent)
	if st == nil || st.State != "near" || st.Blocked || st.Percent < 89 || st.Percent > 91 {
		t.Fatalf("after one request: %+v", st)
	}
	// Still allowed at 90%.
	h.sendAndWait(agent, "t2", "again", "r2")
	eventually(t, 20*time.Second, "the 100% event", func() bool { return len(events.levels()) == 2 })
	if e := events.last(); e.Level != 100 || !strings.Contains(e.Message, "Spendy reached its $1 budget for "+month+". It is stopped until you raise it.") {
		t.Fatalf("100%% event: %+v", e)
	}
	if st := h.agentBudget(agent); st == nil || st.State != "over" || !st.Blocked {
		t.Fatalf("after two requests: %+v", st)
	}

	// Refused: 402, saying whose budget and what to do, and no conversation is made.
	code, errCode, message := overBudget(t, h, agent, "t3")
	if code != 402 || errCode != "over_budget" || message != "Spendy reached its $1 budget for "+month+". Raise it in its settings." {
		t.Fatalf("a message over budget: %d %s %q", code, errCode, message)
	}
	for _, th := range h.threads(agent) {
		if th.ThreadID == "t3" {
			t.Fatal("a refused first message left a conversation")
		}
	}

	// Each level was announced once: nothing more came.
	if got := events.levels(); len(got) != 2 {
		t.Fatalf("events: %v", got)
	}

	// A schedule's "Run now" is refused the same way, and starts nothing.
	s := decodeInto[scheduleJSON](t, h.mustDo("POST", "/api/agents/"+agent+"/schedules", map[string]any{"cron": "@daily", "message": "Digest"}, 201))
	code, data := h.do("POST", "/api/schedules/"+s.ID+"/run", nil)
	if code != 402 || !strings.Contains(string(data), `"over_budget"`) || !strings.Contains(string(data), "Raise it in its settings.") {
		t.Fatalf("run now over budget: %d %s", code, data)
	}

	// Raising it lets the agent work again; the 80% announcement for the new limit is a new one.
	h.mustDo("PATCH", "/api/agents/"+agent, map[string]any{"budget": map[string]any{"monthlyUsd": 100, "onExceed": "stop"}}, 200)
	h.sendAndWait(agent, "t3", "now?", "r3")
	if st := h.agentBudget(agent); st == nil || st.State != "ok" || st.Blocked || st.MonthlyUSD != 100 {
		t.Fatalf("after raising the budget: %+v", st)
	}

	// Removing it takes the budget away.
	h.mustDo("PATCH", "/api/agents/"+agent, map[string]any{"budget": nil}, 200)
	if h.agentBudget(agent) != nil {
		t.Fatal("the budget should be gone")
	}
	if got := string(h.mustDo("GET", "/api/agents", nil, 200)); !strings.Contains(got, `"budget":null`) {
		t.Fatalf("agent without a budget: %s", got)
	}
}

func TestWarnOnlyKeepsAnAgentWorking(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	scripted(t, h)
	h.priceScripted(1, 1)
	events := watchBudgets(t, h)
	agent := h.agentOn("Easygoing", "script/s1", map[string]any{"budget": map[string]any{"monthlyUsd": 10, "onExceed": "warn"}})

	h.spend(agent, 8)
	h.spend(agent, 3)
	eventually(t, 10*time.Second, "both events", func() bool { return len(events.levels()) == 2 })
	if e := events.last(); !strings.Contains(e.Message, "It keeps running.") {
		t.Fatalf("a warn-only message: %q", e.Message)
	}
	st := h.agentBudget(agent)
	if st == nil || st.State != "over" || st.Blocked || st.OnExceed != "warn" || st.SpentUSD < 10.99 || st.SpentUSD > 11.01 {
		t.Fatalf("status: %+v", st)
	}
	// Not refused.
	if v := h.sendAndWait(agent, "t1", "still here", "r1"); lastReply(v) == "" {
		t.Fatal("no reply")
	}
}

func TestTheAppWideBudgetStopsEveryAgent(t *testing.T) {
	h := start(t, t.TempDir(), Config{DemoTokensPerSecond: "100000"})
	scripted(t, h)
	h.priceScripted(1, 1)
	events := watchBudgets(t, h)
	lead := h.agentOn("Lead", "script/s1", nil)
	member := h.agentOn("Helper", "script/s1", map[string]any{"description": "Knows things"})
	h.mustDo("POST", "/api/teams", map[string]any{"name": "Crew", "leadId": lead, "memberIds": []string{member}}, 201)

	// Nothing set.
	if got := string(h.mustDo("GET", "/api/settings/budget", nil, 200)); !strings.Contains(got, `"budget":null`) {
		t.Fatalf("no app budget: %s", got)
	}
	for _, bad := range []map[string]any{{"monthlyUsd": 0}, {"monthlyUsd": -3}, {"monthlyUsd": 5, "onExceed": "explode"}, {"monthlyUsd": 2e9}} {
		if code, data := h.do("PUT", "/api/settings/budget", map[string]any{"budget": bad}); code != 400 || !strings.Contains(string(data), "invalid_budget") {
			t.Fatalf("a bad budget %v: %d %s", bad, code, data)
		}
	}
	h.mustDo("PUT", "/api/settings/budget", map[string]any{"budget": map[string]any{"monthlyUsd": 20, "onExceed": "stop"}}, 200)
	if got := h.budgets(); got.App == nil || got.App.MonthlyUSD != 20 || got.App.State != "ok" || len(got.Agents) != 0 {
		t.Fatalf("budgets: %+v", got)
	}

	// Two agents add up: $9 and $8 is 85%.
	h.spend(lead, 9)
	h.spend(member, 8)
	eventually(t, 10*time.Second, "the 80% event", func() bool { return len(events.levels()) == 1 })
	if e := events.last(); e.Status.Scope != "app" || !strings.Contains(e.Message, "Pi Local used 85% of its $20 budget") {
		t.Fatalf("app event: %+v", e)
	}
	// Under the limit, agents work.
	h.sendAndWait(lead, "t1", "hello", "r1")

	h.spend(member, 5) // $22
	eventually(t, 10*time.Second, "the 100% event", func() bool { return len(events.levels()) == 2 })
	if e := events.last(); !strings.Contains(e.Message, "Pi Local reached its $20 budget for "+time.Now().Month().String()+". Agents are stopped until you raise it.") {
		t.Fatalf("app event: %+v", e)
	}

	// Every agent refuses messages, with the app's wording.
	code, errCode, message := overBudget(t, h, member, "t9")
	if code != 402 || errCode != "over_budget" || message != "Pi Local reached its $20 budget for "+time.Now().Month().String()+". Raise it in Settings → Usage." {
		t.Fatalf("a message over the app budget: %d %s %q", code, errCode, message)
	}
	// Warn only: no refusals.
	h.mustDo("PUT", "/api/settings/budget", map[string]any{"budget": map[string]any{"monthlyUsd": 20, "onExceed": "warn"}}, 200)
	h.sendAndWait(member, "t9", "fine now", "r9")

	// Removed.
	h.mustDo("PUT", "/api/settings/budget", map[string]any{"budget": nil}, 200)
	if got := h.budgets(); got.App != nil {
		t.Fatalf("budgets after removing: %+v", got)
	}
	// An unrecognized body is refused rather than read as "remove".
	h.mustDo("PUT", "/api/settings/budget", map[string]any{}, 400)
}

// An ask goes to the agent asked: over its budget, it is refused, and the asking agent's model is told why.
func TestAnAskToAnAgentOverItsBudgetIsRefused(t *testing.T) {
	h := start(t, t.TempDir(), Config{DemoTokensPerSecond: "100000"})
	scripted(t, h)
	h.priceScripted(1, 1)
	lead := h.agentOn("Lead", "script/s1", nil)
	member := h.agentOn("Helper", "script/s1", map[string]any{"budget": map[string]any{"monthlyUsd": 5}})
	h.mustDo("POST", "/api/teams", map[string]any{"name": "Crew", "leadId": lead, "memberIds": []string{member}}, 201)

	h.spend(member, 2)
	v := h.sendAndWait(lead, "t1", "ASK:Helper:What do you know?", "r1")
	if !strings.HasPrefix(lastReply(v), "Got: ") || strings.Contains(lastReply(v), "budget") {
		t.Fatalf("an ask under the budget: %q", lastReply(v))
	}
	h.spend(member, 4)
	v = h.sendAndWait(lead, "t1", "ASK:Helper:And now?", "r2")
	if got := lastReply(v); !strings.Contains(got, "Helper reached its $5 budget") || !strings.Contains(got, "Raise it in its settings.") {
		t.Fatalf("an ask over the budget: %q", got)
	}
	// The lead itself is not over anything and keeps working.
	h.sendAndWait(lead, "t1", "thanks", "r3")
}

// Unpriced models can't be counted in dollars: they are counted apart, and never push a budget over.
func TestUnpricedUsageIsCountedApartFromABudget(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	scripted(t, h) // s1 has no prices
	agent := h.agentOn("Frugal", "script/s1", map[string]any{"budget": map[string]any{"monthlyUsd": 1}})
	h.spend(agent, 500)
	st := h.agentBudget(agent)
	if st == nil || st.SpentUSD != 0 || st.UnpricedRequests != 1 || st.State != "ok" || st.Blocked {
		t.Fatalf("unpriced usage: %+v", st)
	}
	h.sendAndWait(agent, "t1", "go on", "r1")
}

// The scheduled fire of an agent over budget: a failed run saying why, and the schedule isn't paused for it.
func TestAScheduledRunIsRefusedOverBudget(t *testing.T) {
	dir := t.TempDir()
	first := start(t, dir, Config{DemoTokensPerSecond: "100000"})
	scripted(t, first)
	first.priceScripted(1, 1)
	agent := first.agentOn("Nightly", "script/s1", map[string]any{"budget": map[string]any{"monthlyUsd": 5}})
	s := decodeInto[scheduleJSON](t, first.mustDo("POST", "/api/agents/"+agent+"/schedules", map[string]any{"cron": "@daily", "message": "Digest"}, 201))
	first.app.DB.Exec(`UPDATE schedules SET next_fire_at = ? WHERE id = ?`, time.Now().Add(-time.Hour).UnixMilli(), s.ID)
	first.spend(agent, 6)
	first.close()

	second := start(t, dir, Config{DemoTokensPerSecond: "100000"})
	eventually(t, 30*time.Second, "the fire to be refused", func() bool {
		got := second.schedule(s.ID)
		return got.LastRun != nil && got.LastRun.Status == "failed"
	})
	got := second.schedule(s.ID)
	if got.LastRun.Error == nil || !strings.Contains(*got.LastRun.Error, "Nightly reached its $5 budget") || got.Paused {
		t.Fatalf("refused run: %+v (%v)", got, got.LastRun.Error)
	}
	if got.NextFireAt == nil || time.UnixMilli(*got.NextFireAt).Before(time.Now()) {
		t.Fatalf("it should still move on to its next fire: %+v", got)
	}
	// Nothing was sent: the conversation of the run was never made.
	if n := len(second.threads(agent)); n != 0 {
		t.Fatalf("a refused run made %d conversations", n)
	}
}

// Usage drill-down: filters, a month, the options for the filters, the budget shown.
func TestUsageDrillDownByAgentModelAndMonth(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	scripted(t, h)
	h.priceScripted(1, 1)
	h.mustDo("PUT", "/api/providers/script/models/s2", map[string]any{"name": "Scripted Two", "inputPrice": 2, "outputPrice": 4}, 200)
	ada := h.agentOn("Ada", "script/s1", map[string]any{"budget": map[string]any{"monthlyUsd": 100, "onExceed": "warn"}})
	bo := h.agentOn("Bo", "script/s1", nil)
	ctx := context.Background()
	rec := func(agent, model string, in, out int64) {
		if err := h.app.RecordUsage(ctx, agent, model, usage.Counts{Requests: 1, Input: in, Output: out}); err != nil {
			t.Fatal(err)
		}
	}
	rec(ada, "script/s1", 1_000_000, 1_000_000) // $2
	rec(ada, "script/s2", 1_000_000, 1_000_000) // $6
	rec(bo, "script/s1", 500_000, 0)            // $0.50
	h.mustDo("PUT", "/api/settings/budget", map[string]any{"budget": map[string]any{"monthlyUsd": 50, "onExceed": "warn"}}, 200)

	type report struct {
		Month string `json:"month"`
		From  string `json:"from"`
		To    string `json:"to"`
		Days  int    `json:"days"`
		Total struct {
			Requests int     `json:"requests"`
			CostUSD  float64 `json:"costUsd"`
		} `json:"total"`
		Agents []struct {
			AgentID string  `json:"agentId"`
			Name    string  `json:"name"`
			CostUSD float64 `json:"costUsd"`
		} `json:"agents"`
		Models []struct {
			ModelID string `json:"modelId"`
		} `json:"models"`
		ByDay   []struct{ Day string } `json:"byDay"`
		Options struct {
			Agents []struct{ AgentID, Name string } `json:"agents"`
			Models []struct{ ModelID, Name string } `json:"models"`
		} `json:"options"`
		Budget *struct {
			App   *budget.Status `json:"app"`
			Agent *budget.Status `json:"agent"`
		} `json:"budget"`
	}
	get := func(query string) report {
		return decodeInto[report](t, h.mustDo("GET", "/api/me/usage?"+query, nil, 200))
	}

	all := get("days=7")
	if all.Total.Requests != 3 || fmt.Sprintf("%.2f", all.Total.CostUSD) != "8.50" || len(all.Agents) != 2 || len(all.Models) != 2 {
		t.Fatalf("all: %+v", all)
	}
	if all.Budget == nil || all.Budget.App == nil || all.Budget.Agent != nil || all.Budget.App.MonthlyUSD != 50 || fmt.Sprintf("%.2f", all.Budget.App.SpentUSD) != "8.50" {
		t.Fatalf("budget in the report: %+v", all.Budget)
	}

	// One agent: its models, its budget too; the filters still offer everyone.
	byAda := get("days=7&agent=" + ada)
	if byAda.Total.Requests != 2 || fmt.Sprintf("%.2f", byAda.Total.CostUSD) != "8.00" || len(byAda.Agents) != 1 || len(byAda.Models) != 2 {
		t.Fatalf("by agent: %+v", byAda)
	}
	if byAda.Budget == nil || byAda.Budget.Agent == nil || byAda.Budget.Agent.MonthlyUSD != 100 || len(byAda.Options.Agents) != 2 || len(byAda.Options.Models) != 2 {
		t.Fatalf("by agent budget/options: %+v", byAda)
	}
	// One model: who used it.
	byModel := get("days=7&model=" + "script%2Fs1")
	if byModel.Total.Requests != 2 || fmt.Sprintf("%.2f", byModel.Total.CostUSD) != "2.50" || len(byModel.Agents) != 2 || len(byModel.Models) != 1 {
		t.Fatalf("by model: %+v", byModel)
	}
	// Both.
	both := get("days=7&agent=" + bo + "&model=script%2Fs2")
	if both.Total.Requests != 0 || len(both.Agents) != 0 {
		t.Fatalf("agent and model that never met: %+v", both)
	}

	// The month view: the whole calendar month, today in it.
	now := time.Now()
	month := get("month=" + now.Format("2006-01"))
	last := time.Date(now.Year(), now.Month()+1, 0, 0, 0, 0, 0, now.Location())
	if month.Month != now.Format("2006-01") || month.Days != last.Day() || len(month.ByDay) != last.Day() || month.From != now.Format("2006-01")+"-01" || month.To != last.Format("2006-01-02") || month.Total.Requests != 3 {
		t.Fatalf("month: %+v", month)
	}
	// A month without usage is empty, its days all there.
	empty := get("month=2020-02")
	if empty.Total.Requests != 0 || empty.Days != 29 || len(empty.ByDay) != 29 || empty.Budget == nil || empty.Budget.App.SpentUSD != 0 {
		t.Fatalf("an old month: %+v", empty)
	}
	for _, bad := range []string{"month=2026-13", "month=October", "month=2026-1"} {
		if code, data := h.do("GET", "/api/me/usage?"+bad, nil); code != 400 || !strings.Contains(string(data), "invalid_month") {
			t.Fatalf("%s: %d %s", bad, code, data)
		}
	}
}

// Cached tokens are costed at the cache prices a model has, and at its input price when it has none.
func TestCacheTokensAreCostedAtTheirOwnPrices(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	scripted(t, h)
	h.mustDo("PUT", "/api/providers/script/models/s1", map[string]any{"name": "Scripted", "inputPrice": 2, "outputPrice": 10}, 200)
	agent := h.createAgent("Cacher")
	record := func() {
		if err := h.app.RecordUsage(context.Background(), agent, "script/s1", usage.Counts{Requests: 1, Input: 1_000_000, Output: 1_000_000, CacheRead: 1_000_000, CacheWrite: 1_000_000}); err != nil {
			t.Fatal(err)
		}
	}
	cost := func() string {
		r := decodeInto[struct {
			Total struct {
				CostUSD float64 `json:"costUsd"`
			} `json:"total"`
		}](t, h.mustDo("GET", "/api/me/usage?days=7", nil, 200))
		return fmt.Sprintf("%.2f", r.Total.CostUSD)
	}
	record()
	if got := cost(); got != "16.00" { // 2 + 10 + 2 + 2: cache at the input price
		t.Fatalf("without cache prices: %s", got)
	}
	h.mustDo("PUT", "/api/providers/script/models/s1", map[string]any{"cacheReadPrice": 0.2, "cacheWritePrice": 2.5}, 200)
	if got := cost(); got != "14.70" { // 2 + 10 + 0.2 + 2.5
		t.Fatalf("with cache prices: %s", got)
	}
}
