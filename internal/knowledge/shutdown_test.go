package knowledge

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestCloseCancelsAnInProgressHugeSplitWithoutIndexingPartialWork(t *testing.T) {
	db := openDB(t)
	s := New(NewStore(db), &fakeExtractor{}, time.Hour, nil)
	lifetime := s.ctx
	entered := make(chan struct{})
	s.ctx = &splitProbeContext{Context: lifetime, onCheck: func(n int) {
		if n == 20 {
			close(entered)
			// Pause at a deterministic checkpoint inside splitting until Close cancels the service.
			<-lifetime.Done()
		}
	}}
	markdown := strings.Repeat("x", 32<<20)
	folder := t.TempDir()
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		s.indexDocument(folder, found{rel: "huge.docx", kind: "docx"}, Result{Markdown: markdown})
	}()
	select {
	case <-entered:
	case <-time.After(10 * time.Second): // deadlock guard, not a split-speed assertion
		s.Close()
		t.Fatal("splitting never reached a cancellation checkpoint")
	}
	closed := make(chan struct{})
	go func() { s.Close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(10 * time.Second):
		t.Fatal("Close did not cancel the in-progress split")
	}
	var files int
	if err := db.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM knowledge_files`).Scan(&files); err != nil {
		t.Fatal(err)
	}
	if files != 0 {
		t.Fatal("cancelled split was stored as a partial document")
	}
}
