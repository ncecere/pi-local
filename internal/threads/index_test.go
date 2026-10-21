package threads

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/ncecere/pi-local/internal/appdb"
)

func newIndex(t *testing.T) (*Index, *[]Change, *time.Time) {
	t.Helper()
	db, err := appdb.Open(context.Background(), filepath.Join(t.TempDir(), "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if _, err := db.Exec(`INSERT INTO agents (id, dir, created_at, updated_at) VALUES ('ag_a', '/x', 0, 0)`); err != nil {
		t.Fatal(err)
	}
	var changes []Change
	now := time.UnixMilli(1_800_000_000_000)
	x := NewIndex(db, func(c Change) { changes = append(changes, c) })
	x.now = func() time.Time { return now }
	return x, &changes, &now
}

func ms(t time.Time) int64 { return t.UnixMilli() }

func TestALateReportNeverBringsBackADeletedThread(t *testing.T) {
	ctx := context.Background()
	x, _, now := newIndex(t)
	if _, err := x.Sending(ctx, "ag_a", "t1", "hello", nil); err != nil {
		t.Fatal(err)
	}
	x.Sent("ag_a", "t1")
	if err := x.Delete(ctx, "ag_a", "t1"); err != nil {
		t.Fatal(err)
	}
	reply := ms(*now) + 10
	if err := x.Report(ctx, "ag_a", Status{ThreadID: "t1", Title: "hello", Busy: false, LastReplyAt: &reply, At: ms(*now) + 20}); err != nil {
		t.Fatal(err)
	}
	if _, err := x.Get(ctx, "ag_a", "t1"); err != ErrNotFound {
		t.Fatalf("a report after the delete brought the thread back: %v", err)
	}
}

func TestTheNewestReportWins(t *testing.T) {
	ctx := context.Background()
	x, _, now := newIndex(t)
	x.Sending(ctx, "ag_a", "t1", "hello", nil)
	x.Sent("ag_a", "t1")
	done := ms(*now) + 500
	x.Report(ctx, "ag_a", Status{ThreadID: "t1", Title: "hello", Busy: false, LastReplyAt: &done, At: ms(*now) + 500})
	// An older report arriving late (busy, from before the reply ended) changes nothing.
	x.Report(ctx, "ag_a", Status{ThreadID: "t1", Title: "hello", Busy: true, At: ms(*now) + 100})
	got, _ := x.Get(ctx, "ag_a", "t1")
	if got.Busy || got.LastReplyAt == nil || *got.LastReplyAt != done {
		t.Fatalf("an older report overwrote a newer one: %+v", got)
	}
}

func TestSyncAdoptsAndRemovesButSparesYoungRecords(t *testing.T) {
	ctx := context.Background()
	x, changes, now := newIndex(t)
	// An old record the runtime no longer has, and a young one whose first message may not have arrived yet.
	x.Sending(ctx, "ag_a", "old", "old thread", nil)
	x.Sent("ag_a", "old")
	*now = now.Add(10 * time.Minute)
	x.Sending(ctx, "ag_a", "young", "on its way", nil)
	x.Sent("ag_a", "young")
	*changes = nil
	at := ms(*now) + 1
	err := x.Sync(ctx, "ag_a", []Status{{ThreadID: "fromRuntime", Title: "Made by a tool\nsecond line", CreatedAt: ms(*now) - 5000, Busy: true, At: at}}, at)
	if err != nil {
		t.Fatal(err)
	}
	list, _ := x.List(ctx, "ag_a")
	ids := map[string]*Thread{}
	for _, th := range list {
		ids[th.ThreadID] = th
	}
	if _, ok := ids["old"]; ok {
		t.Fatal("a record the runtime no longer has was kept")
	}
	if _, ok := ids["young"]; !ok {
		t.Fatal("a young record was removed by the sync")
	}
	if th := ids["fromRuntime"]; th == nil || th.Title != "Made by a tool" || !th.Busy {
		t.Fatalf("the runtime's thread wasn't adopted: %+v", th)
	}
	var deleted, adopted bool
	for _, c := range *changes {
		deleted = deleted || (c.ThreadID == "old" && c.Deleted)
		adopted = adopted || (c.ThreadID == "fromRuntime" && c.Thread != nil)
	}
	if !deleted || !adopted {
		t.Fatalf("changes not announced: %+v", *changes)
	}
}

func TestRenameOutlivesTheRuntimesTitle(t *testing.T) {
	ctx := context.Background()
	x, _, now := newIndex(t)
	x.Sending(ctx, "ag_a", "t1", "first message", nil)
	x.Sent("ag_a", "t1")
	if _, err := x.Rename(ctx, "ag_a", "t1", "My name"); err != nil {
		t.Fatal(err)
	}
	x.Report(ctx, "ag_a", Status{ThreadID: "t1", Title: "first message", At: ms(*now) + 1})
	got, _ := x.Get(ctx, "ag_a", "t1")
	if got.Title != "My name" {
		t.Fatalf("a report replaced the person's title: %q", got.Title)
	}
	if _, err := x.Rename(ctx, "ag_a", "nope", "x"); err != ErrNotFound {
		t.Fatalf("renaming an unknown thread: %v", err)
	}
}

func TestTitleFrom(t *testing.T) {
	long := ""
	for range 70 {
		long += "é"
	}
	cases := map[string]string{"  hello\nworld": "hello", long: long[:60*2]}
	for in, want := range cases {
		if got := TitleFrom(in); got != want {
			t.Errorf("TitleFrom(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestWakingDoesNotMakeOldConversationsLookNew(t *testing.T) {
	ctx := context.Background()
	x, _, now := newIndex(t)
	x.Sending(ctx, "ag_a", "old", "research cats", nil)
	x.Sent("ag_a", "old")
	replied := ms(*now) + 1_000
	x.Report(ctx, "ag_a", Status{ThreadID: "old", Title: "research cats", LastReplyAt: &replied, At: replied})
	before, _ := x.Get(ctx, "ag_a", "old")

	// 15 minutes later the agent wakes (a schedule): its start-up sync lists every thread, at that moment.
	later := ms(*now) + 15*60_000
	created := ms(*now)
	x.Sync(ctx, "ag_a", []Status{
		{ThreadID: "old", Title: "research cats", CreatedAt: created, LastReplyAt: &replied, At: later},
		{ThreadID: "busy", Title: "scheduled", CreatedAt: later - 10, Busy: true, At: later},
	}, later)
	after, _ := x.Get(ctx, "ag_a", "old")
	if after.UpdatedAt != before.UpdatedAt {
		t.Fatalf("waking moved the old conversation's activity from %v to %v", before.UpdatedAt, after.UpdatedAt)
	}
	// A conversation busy at the sync is active now.
	if busy, _ := x.Get(ctx, "ag_a", "busy"); busy.UpdatedAt != later {
		t.Fatalf("a busy conversation's activity: %v", busy.UpdatedAt)
	}
}

func TestASyncCantClearBusyWhileAMessageIsOnItsWay(t *testing.T) {
	ctx := context.Background()
	x, _, now := newIndex(t)
	x.Sending(ctx, "ag_a", "t1", "first", nil)
	x.Sent("ag_a", "t1")
	replied := ms(*now) + 100
	x.Report(ctx, "ag_a", Status{ThreadID: "t1", Title: "first", LastReplyAt: &replied, At: replied})

	// A second message: the runtime restarts for it and syncs before the message reaches it (idle, newer).
	x.Sending(ctx, "ag_a", "t1", "second", nil)
	x.Sync(ctx, "ag_a", []Status{{ThreadID: "t1", Title: "first", CreatedAt: ms(*now), LastReplyAt: &replied, At: ms(*now) + 5_000}}, ms(*now)+5_000)
	if got, _ := x.Get(ctx, "ag_a", "t1"); !got.Busy {
		t.Fatal("a sync from before the message arrived cleared busy")
	}
	// Once it has arrived, the runtime's word counts again.
	x.Sent("ag_a", "t1")
	done := ms(*now) + 9_000
	x.Report(ctx, "ag_a", Status{ThreadID: "t1", Title: "first", LastReplyAt: &done, At: done})
	if got, _ := x.Get(ctx, "ag_a", "t1"); got.Busy {
		t.Fatal("the reply's end should clear busy")
	}
}
