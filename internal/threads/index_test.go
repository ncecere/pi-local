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
	*now = now.Add(10 * time.Minute)
	x.Sending(ctx, "ag_a", "young", "on its way", nil)
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
