package agents

import (
	"context"
	"errors"
	"fmt"
	"os"
	"runtime"
)

// SaveOutcomeError means the caller must not claim the transaction was rolled back.
// A committed update may still need its agent.yaml materialized; Open retries that work.
// A commit error, unlike a validation/transaction callback error, has an uncertain outcome.
type SaveOutcomeError struct {
	Committed bool
	Err       error
}

func (e *SaveOutcomeError) Error() string {
	if e.Committed {
		return "The change was saved, but agent.yaml materialization is pending; reopen the app to retry: " + e.Err.Error()
	}
	return "The save outcome could not be confirmed; reopen the app before retrying: " + e.Err.Error()
}
func (e *SaveOutcomeError) Unwrap() error { return e.Err }

// RecoverPending finishes committed config writes. It also lets an idempotent builder
// retry repair a previous materialization failure without applying the proposal again.
func (s *Store) RecoverPending(ctx context.Context) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.recoverPending(ctx)
}

func (s *Store) recoverPending(ctx context.Context) error {
	rows, err := s.db.QueryContext(ctx, `SELECT a.id, a.dir, a.revision, m.revision, m.config
		FROM agent_config_materializations m JOIN agents a ON a.id = m.agent_id`)
	if err != nil {
		return err
	}
	type pending struct {
		id, dir string
		rev     int
		raw     []byte
	}
	var list []pending
	for rows.Next() {
		var p pending
		var committedRevision int
		if err := rows.Scan(&p.id, &p.dir, &committedRevision, &p.rev, &p.raw); err != nil {
			rows.Close()
			return err
		}
		if p.rev != committedRevision {
			rows.Close()
			return fmt.Errorf("agent %s: materialization revision %d differs from committed revision %d", p.id, p.rev, committedRevision)
		}
		list = append(list, p)
	}
	err = rows.Err()
	err = errors.Join(err, rows.Close())
	if err != nil {
		return err
	}
	// No rows or transaction may remain open: app.db has a single connection.
	for _, p := range list {
		if err := s.materialize(ctx, p.id, s.resolveDir(p.dir), p.rev, p.raw); err != nil {
			return &SaveOutcomeError{Committed: true, Err: fmt.Errorf("agent %s: %w", p.id, err)}
		}
	}
	return nil
}

func (s *Store) boundary(stage string) error {
	if s.updateBoundary != nil {
		return s.updateBoundary(stage)
	}
	return nil
}

func (s *Store) materialize(ctx context.Context, id, dir string, revision int, raw []byte) error {
	if err := s.boundary("postcommit"); err != nil {
		return err
	}
	if err := writeConfigBytes(dir, raw); err != nil {
		return err
	}
	if err := s.boundary("materialized"); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `DELETE FROM agent_config_materializations WHERE agent_id = ? AND revision = ?`, id, revision)
	return err
}

func syncConfigDir(dir string) error {
	// Go does not support directory Sync on Windows. File Sync and atomic replacement
	// still protect process-crash recovery there; power-loss directory durability is
	// not guaranteed. On platforms supporting directory fsync, failures are surfaced.
	if runtime.GOOS == "windows" {
		return nil
	}
	f, err := os.Open(dir)
	if err != nil {
		return err
	}
	return errors.Join(f.Sync(), f.Close())
}
