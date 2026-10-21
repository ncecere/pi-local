package budget

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ncecere/pi-local/internal/agents"
	"github.com/ncecere/pi-local/internal/appdb"
	"github.com/ncecere/pi-local/internal/usage"
)

type fixture struct {
	t      *testing.T
	db     *sql.DB
	usage  *usage.Store
	svc    *Service
	now    time.Time
	events []Event
	agent  *agents.Budget
}

func setup(t *testing.T) *fixture {
	t.Helper()
	db, err := appdb.Open(context.Background(), filepath.Join(t.TempDir(), "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	f := &fixture{t: t, db: db, now: time.Date(2026, 10, 21, 12, 0, 0, 0, time.Local)}
	f.usage = usage.New(db)
	f.svc = New(db, f.usage)
	clock := func() time.Time { return f.now }
	f.svc.SetClock(clock)
	f.usage.SetClock(clock)
	// $1 per million tokens, in and out, so a million tokens of each is $2.
	f.svc.Prices = func(model string) (usage.Price, bool) {
		if model == "m/priced" {
			return usage.Price{Input: 1, Output: 1}, true
		}
		return usage.Price{}, false
	}
	f.svc.Agent = func(id string) (string, *agents.Budget, bool) { return "Hardac", f.agent, id == "ag_1" }
	f.svc.All = func() []AgentBudget {
		if f.agent == nil {
			return nil
		}
		return []AgentBudget{{ID: "ag_1", Name: "Hardac", Budget: *f.agent}}
	}
	f.svc.Publish = func(e Event) { f.events = append(f.events, e) }
	return f
}

// spend records usage costing usd (at $1 per million tokens each way) and evaluates, as the app does.
func (f *fixture) spend(usd float64) {
	f.t.Helper()
	n := int64(usd * 1e6 / 2)
	if err := f.usage.Record(context.Background(), "ag_1", "Hardac", "m/priced", "Priced", usage.Counts{Requests: 1, Input: n, Output: n}); err != nil {
		f.t.Fatal(err)
	}
	f.svc.Evaluate(context.Background(), "ag_1")
}

func (f *fixture) levels() []int {
	var out []int
	for _, e := range f.events {
		out = append(out, e.Level)
	}
	return out
}

func TestMoneyIsWrittenTheWayPeopleSayIt(t *testing.T) {
	for in, want := range map[float64]string{20: "$20", 20.5: "$20.50", 0.01: "$0.01", 1234: "$1,234", 1234567.89: "$1,234,567.89", 19.999: "$20"} {
		if got := money(in); got != want {
			t.Errorf("money(%v) = %q, want %q", in, got, want)
		}
	}
}

func TestAnAgentIsStoppedAtItsBudgetAndNotBefore(t *testing.T) {
	f := setup(t)
	f.agent = &agents.Budget{MonthlyUSD: 20, OnExceed: agents.BudgetStop}
	ctx := context.Background()
	f.spend(19.99)
	if err := f.svc.Check(ctx, "ag_1"); err != nil {
		t.Fatalf("just under: %v", err)
	}
	f.spend(0.01) // exactly $20: reached
	err := f.svc.Check(ctx, "ag_1")
	var over *OverBudgetError
	if !errors.As(err, &over) || over.Message != "Hardac reached its $20 budget for October. Raise it in its settings." {
		t.Fatalf("at the budget: %v", err)
	}
	if over.HTTPStatus() != 402 || over.Code() != "over_budget" || !over.Status.Blocked {
		t.Fatalf("over budget error: %+v", over)
	}
	// Another agent is fine.
	if err := f.svc.Check(ctx, "ag_2"); err != nil {
		t.Fatal(err)
	}
	// A new month starts afresh.
	f.now = time.Date(2026, 11, 1, 0, 5, 0, 0, time.Local)
	if err := f.svc.Check(ctx, "ag_1"); err != nil {
		t.Fatalf("next month: %v", err)
	}
	st, _ := f.svc.AgentStatus(ctx, "", "ag_1")
	if st.Month != "2026-11" || st.MonthName != "November" || st.SpentUSD != 0 {
		t.Fatalf("next month's status: %+v", st)
	}
	// October's, asked for by name, is still there.
	st, _ = f.svc.AgentStatus(ctx, "2026-10", "ag_1")
	if st.SpentUSD < 19.99 || st.State != StateOver {
		t.Fatalf("October's status: %+v", st)
	}
}

func TestWarnOnlyNeverRefuses(t *testing.T) {
	f := setup(t)
	f.agent = &agents.Budget{MonthlyUSD: 1, OnExceed: agents.BudgetWarn}
	f.spend(5)
	if err := f.svc.Check(context.Background(), "ag_1"); err != nil {
		t.Fatal(err)
	}
	if st, _ := f.svc.AgentStatus(context.Background(), "", "ag_1"); st.State != StateOver || st.Blocked {
		t.Fatalf("%+v", st)
	}
}

func TestEachLevelIsAnnouncedOncePerMonthAndLimit(t *testing.T) {
	f := setup(t)
	f.agent = &agents.Budget{MonthlyUSD: 10, OnExceed: agents.BudgetStop}
	f.spend(5)
	if len(f.events) != 0 {
		t.Fatalf("at 50%%: %v", f.levels())
	}
	f.spend(3.5) // 85%
	f.spend(0.5) // 90%: nothing new
	f.spend(1.5) // 105%
	f.spend(4)   // more: nothing new
	if got := f.levels(); len(got) != 2 || got[0] != 80 || got[1] != 100 {
		t.Fatalf("levels: %v", got)
	}
	if m := f.events[0].Message; m != "Hardac used 85% of its $10 budget for October." { // what it used, past 80%
		t.Fatalf("80%% message: %q", m)
	}
	if m := f.events[1].Message; m != "Hardac reached its $10 budget for October. It is stopped until you raise it." {
		t.Fatalf("100%% message: %q", m)
	}

	// A single jump past both says the stronger thing once.
	f2 := setup(t)
	f2.agent = &agents.Budget{MonthlyUSD: 1, OnExceed: agents.BudgetWarn}
	f2.spend(3)
	if got := f2.levels(); len(got) != 1 || got[0] != 100 || !strings.Contains(f2.events[0].Message, "It keeps running.") {
		t.Fatalf("one jump: %v %+v", got, f2.events)
	}

	// A new limit is a new budget: its 80% is announced again.
	f.agent = &agents.Budget{MonthlyUSD: 100, OnExceed: agents.BudgetStop}
	f.spend(1)
	f.spend(70) // $13.50+4+... well past 80 of 100
	last := f.events[len(f.events)-1]
	if last.Level != 80 || !strings.Contains(last.Message, "$100 budget") {
		t.Fatalf("after raising the limit: %v %+v", f.levels(), last)
	}

	// A new month is announced again too.
	f.now = time.Date(2026, 11, 3, 9, 0, 0, 0, time.Local)
	before := len(f.events)
	f.spend(85)
	if len(f.events) != before+1 || f.events[before].Status.Month != "2026-11" {
		t.Fatalf("next month: %v", f.levels())
	}
}

func TestUnpricedRequestsAreCountedApart(t *testing.T) {
	f := setup(t)
	f.agent = &agents.Budget{MonthlyUSD: 1, OnExceed: agents.BudgetStop}
	ctx := context.Background()
	if err := f.usage.Record(ctx, "ag_1", "Hardac", "m/free", "Free", usage.Counts{Requests: 3, Input: 9e9, Output: 9e9}); err != nil {
		t.Fatal(err)
	}
	f.spend(0.5)
	st, _ := f.svc.AgentStatus(ctx, "", "ag_1")
	if st.UnpricedRequests != 3 || st.SpentUSD < 0.49 || st.SpentUSD > 0.51 || st.State != StateOK {
		t.Fatalf("%+v", st)
	}
}

func TestTheAppBudgetAddsUpEveryAgentAndRefusesAll(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	if err := f.svc.SetApp(ctx, &Setting{MonthlyUSD: 10, OnExceed: agents.BudgetStop}); err != nil {
		t.Fatal(err)
	}
	f.spend(12)
	err := f.svc.Check(ctx, "ag_1")
	var over *OverBudgetError
	if !errors.As(err, &over) || over.Message != "Pi Local reached its $10 budget for October. Raise it in Settings → Usage." {
		t.Fatalf("app budget refusal: %v", err)
	}
	// An agent that doesn't exist is refused too: the budget is the app's.
	if err := f.svc.Check(ctx, "ag_9"); err == nil {
		t.Fatal("the app budget should stop every agent")
	}
	if err := f.svc.SetApp(ctx, nil); err != nil {
		t.Fatal(err)
	}
	if f.svc.App(ctx) != nil || f.svc.Check(ctx, "ag_1") != nil {
		t.Fatal("removing the app budget should lift it")
	}
	for _, bad := range []*Setting{{MonthlyUSD: 0}, {MonthlyUSD: -1}, {MonthlyUSD: 5, OnExceed: "boom"}, {MonthlyUSD: 1e9}} {
		if err := f.svc.SetApp(ctx, bad); err == nil {
			t.Errorf("%+v should be refused", bad)
		}
	}
}

func TestOverviewListsTheAppAndEachAgentBudget(t *testing.T) {
	f := setup(t)
	f.agent = &agents.Budget{MonthlyUSD: 4, OnExceed: agents.BudgetWarn}
	ctx := context.Background()
	f.svc.SetApp(ctx, &Setting{MonthlyUSD: 40, OnExceed: agents.BudgetStop})
	f.spend(2)
	o, err := f.svc.Overview(ctx)
	if err != nil || o.App == nil || len(o.Agents) != 1 || o.Agents[0].Percent < 49 || o.Agents[0].Percent > 51 || o.App.Percent < 4.9 || o.App.Percent > 5.1 {
		t.Fatalf("%+v %v", o, err)
	}
}
