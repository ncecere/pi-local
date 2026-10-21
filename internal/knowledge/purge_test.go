package knowledge

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Seed a real file and an indexed passage with the same metadata: rescanning does not replace its row unless a
// stale purge incorrectly deletes it first. This catches remove/re-add races that a mere final text check misses.
func seedPurgeTest(t *testing.T) (*Service, *sql.DB, string, int64) {
	t.Helper()
	db := openDB(t)
	s := New(NewStore(db), &fakeExtractor{}, time.Hour, nil)
	t.Cleanup(s.Close)
	dir := t.TempDir()
	path := filepath.Join(dir, "policy.txt")
	write(t, path, "refund policy")
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.store.put(context.Background(), dir, "policy.txt", info.Size(), info.ModTime().UnixNano(), StatusIndexed, "", []Passage{{Text: "refund policy"}}); err != nil {
		t.Fatal(err)
	}
	var id int64
	if err := db.QueryRow(`SELECT id FROM knowledge_files`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	s.SetFolders([]string{dir})
	return s, db, dir, id
}

func fillScanQueue(t *testing.T, s *Service, dir string) {
	t.Helper()
	for len(s.queue) < cap(s.queue) {
		s.enqueue(request{path: dir, full: true})
	}
	if len(s.queue) != 512 {
		t.Fatal("the regression test requires a full 512-slot queue")
	}
}

func TestRemovingTheLastReferenceCannotLoseAPurgeWhenTheScanQueueIsFull(t *testing.T) {
	s, db, dir, _ := seedPurgeTest(t)
	fillScanQueue(t, s, dir)
	s.SetFolders(nil)
	s.mu.Lock()
	_, pending := s.purges[dir]
	s.mu.Unlock()
	if !pending {
		t.Fatal("removal was not kept outside the saturated scan queue")
	}
	s.Start()
	within(t, 10*time.Second, "the purge and queued scans to drain", func() bool {
		var files, passages int
		if err := db.QueryRow(`SELECT (SELECT COUNT(*) FROM knowledge_files), (SELECT COUNT(*) FROM knowledge_passages)`).Scan(&files, &passages); err != nil {
			t.Fatal(err)
		}
		s.mu.Lock()
		pending := len(s.purges)
		s.mu.Unlock()
		return files == 0 && passages == 0 && len(s.queue) == 0 && pending == 0
	})
	if hits, err := s.store.search(context.Background(), []string{dir}, []string{"refund"}, 5); err != nil || len(hits) != 0 {
		t.Fatalf("FTS passages survived the purge: %+v %v", hits, err)
	}
}

func TestReaddingAFolderCancelsItsPendingPurgeBeforeQueuedWorkDrains(t *testing.T) {
	s, db, dir, originalID := seedPurgeTest(t)
	fillScanQueue(t, s, dir)
	s.SetFolders(nil)
	s.SetFolders([]string{dir})
	s.mu.Lock()
	_, pending := s.purges[dir]
	s.mu.Unlock()
	if pending {
		t.Fatal("re-adding the folder left a stale purge")
	}
	s.Start()
	within(t, 10*time.Second, "queued scans to drain", func() bool {
		return len(s.queue) == 0 && s.Status(context.Background(), dir).State == "ready"
	})
	var id, files, passages int64
	if err := db.QueryRow(`SELECT id, (SELECT COUNT(*) FROM knowledge_files), (SELECT COUNT(*) FROM knowledge_passages) FROM knowledge_files`).Scan(&id, &files, &passages); err != nil {
		t.Fatal(err)
	}
	if id != originalID || files != 1 || passages != 1 {
		t.Fatalf("a re-added folder was deleted/rebuilt: id %d (was %d), files %d, passages %d", id, originalID, files, passages)
	}
}

func TestFailedPurgesRemainPendingAndAreRetriedWithoutAnotherConfigChange(t *testing.T) {
	s, db, dir, _ := seedPurgeTest(t)
	if _, err := db.Exec(`CREATE TRIGGER fail_knowledge_purge BEFORE DELETE ON knowledge_files BEGIN SELECT RAISE(ABORT, 'try again'); END`); err != nil {
		t.Fatal(err)
	}
	s.SetFolders(nil)
	<-s.wake // consume the initial notification; the retry ticker must pick up the failed deletion
	s.drainPurges()
	s.mu.Lock()
	_, pending := s.purges[dir]
	s.mu.Unlock()
	var files, passages int
	db.QueryRow(`SELECT (SELECT COUNT(*) FROM knowledge_files), (SELECT COUNT(*) FROM knowledge_passages)`).Scan(&files, &passages)
	if !pending || files != 1 || passages != 1 {
		t.Fatal("a failed purge was lost or partially committed")
	}
	if _, err := db.Exec(`DROP TRIGGER fail_knowledge_purge`); err != nil {
		t.Fatal(err)
	}
	s.Start()
	within(t, 10*time.Second, "automatic purge retry", func() bool {
		var count int
		if err := db.QueryRow(`SELECT COUNT(*) FROM knowledge_files`).Scan(&count); err != nil {
			t.Fatal(err)
		}
		return count == 0
	})
}
