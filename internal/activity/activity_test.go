package activity

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/ncecere/pi-local/internal/appdb"
)

func newStore(t *testing.T) *Store {
	t.Helper()
	db, err := appdb.Open(context.Background(), filepath.Join(t.TempDir(), "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	s := New(db)
	s.AgentName = func(id string) string { return "Agent " + id }
	t.Cleanup(func() { s.Close(); db.Close() })
	return s
}

func list(t *testing.T, s *Store, q Query) []*Entry {
	t.Helper()
	items, _, err := s.List(context.Background(), q)
	if err != nil {
		t.Fatal(err)
	}
	return items
}

func TestRecordedEntriesAreBoundedAndNamed(t *testing.T) {
	s := newStore(t)
	s.Record(Entry{Kind: KindMessage, AgentID: "ag_1", Title: "  Message\nsent  " + strings.Repeat("x", 500), Detail: json.RawMessage(`{"a":1}`)})
	s.Record(Entry{Kind: KindMessage, AgentID: "ag_1", Title: "Bad detail", Detail: json.RawMessage(`{not json`)})
	s.Record(Entry{Kind: "", Title: "No kind"})
	s.Record(Entry{Kind: KindError, Title: ""})
	items := list(t, s, Query{})
	if len(items) != 2 {
		t.Fatalf("entries: %d", len(items))
	}
	for _, e := range items {
		if e.AgentName != "Agent ag_1" || utf8.RuneCountInString(e.Title) > maxTitle || strings.Contains(e.Title, "\n") || e.At == 0 {
			t.Fatalf("an entry: %+v", e)
		}
	}
	if string(items[1].Detail) != `{"a":1}` || string(items[0].Detail) != `{}` {
		t.Fatalf("details: %s %s", items[1].Detail, items[0].Detail)
	}
	raw, _ := json.Marshal(Entry{Kind: KindSignIn, Title: "Signed in"})
	if !strings.Contains(string(raw), `"agentId":null`) || !strings.Contains(string(raw), `"threadId":null`) || !strings.Contains(string(raw), `"detail":{}`) {
		t.Fatalf("an entry with no agent: %s", raw)
	}
}

func TestToolCallsFromARuntimeAreValidatedRedactedAndKeptOnce(t *testing.T) {
	s := newStore(t)
	ms := int64(42)
	items := []ToolItem{
		{EntryID: "7", CallID: "c1", ThreadID: "t1", Tool: "bash", Outcome: "ok", DurationMs: &ms, EndedAt: time.Now().UnixMilli(),
			Arguments: json.RawMessage(`{"command":"curl -H 'Authorization: Bearer abcdefgh12345678' https://x.example","apiKey":"k","notes":["export TOKEN=hunter2hunter2"]}`),
			Approval:  &ToolApproval{Status: "approved", By: "Bo", Source: "builtin"}},
		{EntryID: "7", CallID: "c1", ThreadID: "t1", Tool: "bash", Outcome: "ok"}, // reported again
		{EntryID: "8", CallID: "c2", Tool: "write", Outcome: "denied", Error: "Tool call blocked: denied by Bo: password=hunter2 please no"},
		{EntryID: "9", Tool: "read", Outcome: "nonsense"},                // not an outcome
		{EntryID: "10", Tool: "", Outcome: "ok"},                         // no tool
		{Tool: "read", Outcome: "ok"},                                    // nothing to name it by
		{EntryID: "11", CallID: "c3", Tool: "read", Outcome: "declined"}, // fine
	}
	if n := s.RecordTools("ag_1", items); n != 4 {
		t.Fatalf("took %d", n)
	}
	got := list(t, s, Query{})
	if len(got) != 3 {
		t.Fatalf("kept %d: the repeat should be dropped", len(got))
	}
	var bash *Entry
	for _, e := range got {
		if e.Title == "bash" {
			bash = e
		}
	}
	if bash == nil || bash.Kind != KindTool || bash.Actor != "Agent ag_1" || bash.AgentID != "ag_1" || bash.ThreadID != "t1" || bash.DurationMs == nil || *bash.DurationMs != 42 {
		t.Fatalf("the call: %+v", bash)
	}
	for _, leak := range []string{"abcdefgh12345678", "hunter2", `"k"`} {
		if strings.Contains(string(bash.Detail), leak) {
			t.Fatalf("%q kept in %s", leak, bash.Detail)
		}
	}
	for _, e := range got {
		if strings.Contains(string(e.Detail), "hunter2") {
			t.Fatalf("a secret in %s", e.Detail)
		}
	}
	var detail struct {
		Approval struct{ Status, By, Source string }
	}
	json.Unmarshal(bash.Detail, &detail)
	if detail.Approval.Status != "approved" || detail.Approval.By != "Bo" || detail.Approval.Source != "builtin" {
		t.Fatalf("the approval: %s", bash.Detail)
	}
	// A batch is bounded.
	many := make([]ToolItem, MaxToolBatch+50)
	for i := range many {
		many[i] = ToolItem{EntryID: "m" + string(rune('A'+i%26)) + strings.Repeat("z", i/26), Tool: "get_time", Outcome: "ok"}
	}
	if n := s.RecordTools("ag_1", many); n != MaxToolBatch {
		t.Fatalf("a big batch took %d", n)
	}
}

func TestApprovalToolDedupeSurvivesReopeningAndEitherReportOrder(t *testing.T) {
	for _, tc := range []struct {
		status      string
		resultFirst bool
	}{{"cancelled", false}, {"cancelled", true}, {"timed_out", false}, {"timed_out", true}} {
		t.Run(tc.status+"/result-first="+strconv.FormatBool(tc.resultFirst), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "app.db")
			open := func() *Store {
				db, err := appdb.Open(t.Context(), path)
				if err != nil {
					t.Fatal(err)
				}
				s := New(db)
				t.Cleanup(func() { s.Close(); db.Close() })
				return s
			}
			at := time.Now().UnixMilli()
			fallback := ToolItem{CallID: "repeated", ThreadID: "t", Tool: "bash", Outcome: "declined", EndedAt: at,
				Arguments: json.RawMessage(`{"command":"echo password=hunter2"}`), Approval: &ToolApproval{ID: "ap_one", Status: tc.status}}
			result := fallback
			result.EntryID, result.EndedAt = "42", at+1
			first, later := fallback, result
			if tc.resultFirst {
				first, later = later, first
			}
			s := open()
			s.RecordTools("ag_1", []ToolItem{first})
			s.Close()
			if err := s.db.Close(); err != nil {
				t.Fatal(err)
			}
			s = open() // no in-memory seen set can hide a duplicate
			s.RecordTools("ag_1", []ToolItem{later, later})
			got := list(t, s, Query{Agent: "ag_1"})
			if len(got) != 1 || got[0].Outcome != "declined" || got[0].DurationMs != nil || strings.Contains(string(got[0].Detail), "hunter2") {
				t.Fatalf("the declined call: %+v", got)
			}
			// A new task may reuse the provider call ID; its approval and result entry are distinct.
			later.EntryID = "43"
			later.Approval = &ToolApproval{ID: "ap_two", Status: "cancelled"}
			s.RecordTools("ag_1", []ToolItem{later})
			s.RecordTools("ag_2", []ToolItem{first})
			if got := list(t, s, Query{}); len(got) != 3 {
				t.Fatalf("distinct calls/agents were merged: %+v", got)
			}
		})
	}
}

func TestFiltersCursorsAndRetention(t *testing.T) {
	s := newStore(t)
	now := time.Now()
	for i := 0; i < 10; i++ {
		kind, agent := KindMessage, "ag_1"
		if i%2 == 1 {
			kind, agent = KindTool, "ag_2"
		}
		// Five entries share one instant: the cursor must tell them apart.
		at := now.Add(-time.Duration(i/5) * time.Hour).UnixMilli()
		s.Record(Entry{At: at, Kind: kind, AgentID: agent, ThreadID: "t" + string(rune('0'+i%3)), Title: "Entry " + string(rune('A'+i)), Outcome: "ok"})
	}
	s.Record(Entry{At: now.Add(-100 * 24 * time.Hour).UnixMilli(), Kind: KindMessage, Title: "Ancient"})

	if got := list(t, s, Query{Agent: "ag_2"}); len(got) != 5 {
		t.Fatalf("agent filter: %d", len(got))
	}
	if got := list(t, s, Query{Kinds: []string{KindMessage, KindTool}, Thread: "t0"}); len(got) != 4 {
		t.Fatalf("thread and kinds: %d", len(got))
	}
	if got := list(t, s, Query{Text: "entry a"}); len(got) != 1 || got[0].Title != "Entry A" {
		t.Fatalf("text: %+v", got)
	}
	if got := list(t, s, Query{Text: "100%"}); len(got) != 0 {
		t.Fatalf("a percent sign is not a wildcard: %+v", got)
	}

	var seen []int64
	q := Query{Limit: 3}
	for pages := 0; pages < 10; pages++ {
		items, next, err := s.List(context.Background(), q)
		if err != nil {
			t.Fatal(err)
		}
		for _, e := range items {
			seen = append(seen, e.ID)
		}
		if next == "" {
			break
		}
		q.Before = next
	}
	if len(seen) != 11 {
		t.Fatalf("paged through %d of 11", len(seen))
	}
	dup := map[int64]bool{}
	for _, id := range seen {
		if dup[id] {
			t.Fatalf("entry %d twice", id)
		}
		dup[id] = true
	}
	if got := list(t, s, Query{Before: "1"}); len(got) != 0 {
		t.Fatalf("a bare time: %d", len(got))
	}
	if _, _, ok := ParseCursor("x.y"); ok {
		t.Fatal("a bad cursor parsed")
	}

	if n, err := s.Prune(context.Background()); err != nil || n != 1 {
		t.Fatalf("prune: %d %v", n, err)
	}
	if got := list(t, s, Query{Limit: 500}); len(got) != 10 {
		t.Fatalf("after pruning: %d", len(got))
	}
}

func TestCSVExportIsOneRowPerEntryAndNeverAFormula(t *testing.T) {
	s := newStore(t)
	at := time.Date(2026, 10, 21, 9, 30, 0, 0, time.UTC).UnixMilli()
	s.Record(Entry{At: at, Kind: KindTool, AgentID: "ag_1", ThreadID: "t1", Title: "=HYPERLINK(\"http://evil.example\")", Actor: "+1", Outcome: "ok",
		Detail: Detail(map[string]any{"note": "a, \"quoted\"\nline"})})
	for i := 0; i < 1200; i++ { // more than a page
		s.Record(Entry{At: at - int64(i) - 1, Kind: KindMessage, Title: "Message sent"})
	}
	var buf bytes.Buffer
	if err := s.WriteCSV(context.Background(), &buf, Query{Limit: 1}); err != nil {
		t.Fatal(err)
	}
	rows, err := csv.NewReader(&buf).ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1202 || strings.Join(rows[0], ",") != strings.Join(CSVHeader, ",") {
		t.Fatalf("rows: %d %v", len(rows), rows[0])
	}
	first := rows[1]
	if first[0] != "2026-10-21T09:30:00.000Z" || !strings.HasPrefix(first[6], "'=HYPERLINK") || first[5] != "'+1" || first[2] != "Agent ag_1" {
		t.Fatalf("the first row: %q", first)
	}
	var detail map[string]string
	if json.Unmarshal([]byte(first[9]), &detail); detail["note"] != "a, \"quoted\"\nline" {
		t.Fatalf("detail: %q", first[9])
	}
}

func TestAPreviewIsShortOneLineAndHasNoCredentials(t *testing.T) {
	if got := Preview("  hello \n\n  there  "); got != "hello there" {
		t.Fatalf("%q", got)
	}
	long := Preview(strings.Repeat("word ", 100))
	if utf8.RuneCountInString(long) != PreviewChars || !strings.HasSuffix(long, "…") {
		t.Fatalf("%d %q", utf8.RuneCountInString(long), long)
	}
	if got := Preview("use Authorization: Bearer abcdefgh12345678 please"); strings.Contains(got, "abcdefgh") {
		t.Fatalf("a credential in a preview: %q", got)
	}
}

func TestClosingWritesWhatIsQueued(t *testing.T) {
	db, err := appdb.Open(context.Background(), filepath.Join(t.TempDir(), "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	s := New(db)
	for i := 0; i < 500; i++ {
		s.Record(Entry{Kind: KindMessage, Title: "Message sent"})
	}
	s.Close()
	s.Record(Entry{Kind: KindMessage, Title: "After closing"}) // dropped, not a panic
	s.Flush()
	var n int
	db.QueryRow(`SELECT COUNT(*) FROM activity`).Scan(&n)
	if n != 500 {
		t.Fatalf("written: %d", n)
	}
}
