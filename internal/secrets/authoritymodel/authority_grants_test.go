package authoritymodel_test

import (
	"context"
	"errors"
	"maps"
	"testing"
)

func TestAuthorityModelUnacknowledgedPendingCannotInitializeDatabase(t *testing.T) {
	for _, point := range []string{"pending.flush", "pending.readback"} {
		t.Run(point, func(t *testing.T) {
			w := modelSeed("PENDING")
			w.VisibleDB, w.DurableDB = map[string]modelDB{}, map[string]modelDB{}
			w.DurableAuthority = map[string]modelRecord{} // A prior write was merely visible.
			m := newAuthorityModel(t, w)
			g, err := m.open(modelBackground, "default", "observed-main", modelFault{Point: point, When: "before"})
			modelDenied(t, g, err, modelUnknown)
			got := m.snapshot()
			if len(got.VisibleDB)+len(got.DurableDB) != 0 || got.Generated != 0 || got.Writes != 0 {
				t.Fatal("initialized DB or replaced root before existing PENDING acknowledgement")
			}
			g = modelOpen(t, m)
			g.close()
			if m.snapshot().Generated != 0 || m.snapshot().Writes != 1 {
				t.Fatal("PENDING resume rewrote root")
			}
			modelBalanced(t, m.snapshot())
			modelCheckTrace(t, m.snapshot())
		})
	}
}

func TestAuthorityModelActiveValidatesDatabaseAndAllowsExistingSecretRows(t *testing.T) {
	for _, bad := range []string{"schema", "auth", "binding", "wal-loss"} {
		t.Run(bad, func(t *testing.T) {
			w := modelSeed("ACTIVE")
			db := w.VisibleDB["directory-A"]
			switch bad {
			case "schema":
				db.Image.Schema = false
			case "auth":
				db.Image.Auth = false
			case "binding":
				db.Image.Binding.UUID = "another-root"
			case "wal-loss":
				db.RequiredWAL = true
			}
			w.VisibleDB["directory-A"], w.DurableDB["directory-A"] = db, db
			m := newAuthorityModel(t, w)
			g, err := m.open(modelBackground, "default", "observed-main", modelFault{})
			modelDenied(t, g, err, modelRefused)
			modelSameMaterial(t, w, m.snapshot())
			modelBalanced(t, m.snapshot())
		})
	}
	w := modelSeed("ACTIVE")
	db := w.VisibleDB["directory-A"]
	db.WAL, db.RequiredWAL, db.WALValid = true, true, true
	db.WALImage = db.Image
	db.WALImage.Rows, db.WALImage.Value = 1, "existing-opaque-value"
	w.VisibleDB["directory-A"], w.DurableDB["directory-A"] = db, db
	m := newAuthorityModel(t, w)
	g := modelOpen(t, m)
	got, err := g.secret(modelBackground, "get", "", modelFault{})
	if err != nil || got != "existing-opaque-value" || m.snapshot().Writes != 0 {
		t.Fatal("ACTIVE lost reconciled rows or rewrote authority")
	}
	g.close()
	m.crash()
	reopened := modelOpen(t, m)
	reopened.close()
	modelSameMaterial(t, w, m.snapshot())
	modelBalanced(t, m.snapshot())
	modelCheckTrace(t, m.snapshot())
}

func TestAuthorityModelDistinctReferencesAndDirectoriesHaveIndependentLeases(t *testing.T) {
	m := newAuthorityModel(t, modelFreshWorld())
	first := modelOpen(t, m)
	second, err := m.open(modelBackground, modelProfile, "observed-other", modelFault{})
	if err != nil || second == nil {
		t.Fatalf("unrelated reference/directory blocked: %v", err)
	}
	defer second.close()
	w := m.snapshot()
	if len(w.References) != 2 || len(w.Directories) != 2 || len(w.VisibleAuthority) != 2 || len(w.VisibleDB) != 2 {
		t.Fatal("namespace or directory exclusion collapsed")
	}
	first.close()
	second.close()
	modelBalanced(t, m.snapshot())
	modelCheckTrace(t, m.snapshot())
}

func TestAuthorityModelCancelledPreflightDoesNotAcquireOrPublish(t *testing.T) {
	m := newAuthorityModel(t, modelFreshWorld())
	ctx, cancel := context.WithCancel(modelBackground)
	cancel()
	g, err := m.open(ctx, "default", "observed-main", modelFault{})
	modelDenied(t, g, err, context.Canceled)
	w := m.snapshot()
	if len(w.Events) != 0 || w.Generated != 0 || w.Writes != 0 {
		t.Fatal("cancelled preflight touched authority")
	}
	modelBalanced(t, w)
}

func TestAuthorityModelSecretCommitAmbiguityChangesOnlyDatabase(t *testing.T) {
	for _, op := range []string{"set", "delete"} {
		for _, when := range []string{"before", "after"} {
			t.Run(op+"/"+when, func(t *testing.T) {
				m := newAuthorityModel(t, modelFreshWorld())
				g := modelOpen(t, m)
				if _, err := g.secret(modelBackground, "set", "old", modelFault{}); err != nil {
					t.Fatal(err)
				}
				before := m.snapshot()
				value, err := g.secret(modelBackground, op, "new", modelFault{Point: "secret." + op, When: when})
				if value != "" || !errors.Is(err, modelUnknown) {
					t.Fatal("ambiguous CRUD returned success or value")
				}
				g.close()
				m.crash()
				g = modelOpen(t, m)
				want := "old"
				if when == "after" {
					if op == "set" {
						want = "new"
					} else {
						want = ""
					}
				}
				got, err := g.secret(modelBackground, "get", "", modelFault{})
				if err != nil || got != want {
					t.Fatalf("reconcile got %q %v, want %q", got, err, want)
				}
				after := m.snapshot()
				if !maps.Equal(before.VisibleAuthority, after.VisibleAuthority) || !maps.Equal(before.DurableAuthority, after.DurableAuthority) || before.Writes != after.Writes || before.Generated != after.Generated {
					t.Fatal("CRUD changed root authority")
				}
				g.close()
				modelBalanced(t, m.snapshot())
				modelCheckTrace(t, m.snapshot())
			})
		}
	}
}

func TestAuthorityModelCloseJoinsCancelledSynchronousSecretOperation(t *testing.T) {
	m := newAuthorityModel(t, modelFreshWorld())
	g := modelOpen(t, m)
	ctx, cancel := context.WithCancel(modelBackground)
	defer cancel()
	entered, proceed := make(chan struct{}), make(chan struct{})
	written := make(chan error, 1)
	go func() {
		_, err := g.secret(ctx, "set", "complete-but-cancelled", modelFault{Point: "secret.set", Entered: entered, Continue: proceed})
		written <- err
	}()
	<-entered
	closed := make(chan struct{})
	go func() { g.close(); close(closed) }()
	released, joined := false, false
	defer func() {
		if !released {
			close(proceed)
		}
		if !joined {
			<-written
			<-closed
		}
	}()
	cancel()
	w := m.snapshot()
	if w.RefReleases != 0 || w.DirReleases != 0 {
		t.Fatal("Close released in-flight secret operation")
	}
	select {
	case <-closed:
		t.Fatal("Close returned before synchronous operation")
	default:
	}
	other, err := m.open(modelBackground, modelProfile, "observed-alias", modelFault{})
	modelDenied(t, other, err, modelBusy)
	close(proceed)
	released = true
	err = <-written
	<-closed
	joined = true
	if !errors.Is(err, modelUnknown) || !errors.Is(err, context.Canceled) {
		t.Fatalf("write outcome %v", err)
	}
	modelBalanced(t, m.snapshot())
	modelCheckTrace(t, m.snapshot())
	g = modelOpen(t, m)
	got, err := g.secret(modelBackground, "get", "", modelFault{})
	if err != nil || got != "complete-but-cancelled" {
		t.Fatal("cancellation rolled back an ambiguous committed secret")
	}
	g.close()
	modelBalanced(t, m.snapshot())
}

// UNRESOLVED COUNTEREXAMPLE, NOT safe-protocol acceptance. Concurrent directory
// exclusion is not persistent ownership. This test passes ONLY by witnessing the
// unsafe second-reference grant; fixing that behavior requires separate design
// review, not silently strengthening this model or inventing a reference catalog.
func TestAuthorityModelUnresolvedCounterexampleSequentialReferencesGrantSameDirectory(t *testing.T) {
	m := newAuthorityModel(t, modelFreshWorld())
	first, err := m.open(modelBackground, "default", "observed-main", modelFault{Point: "pending.readback", When: "after"})
	modelDenied(t, first, err, modelUnknown)
	pending := m.snapshot()
	modelBalanced(t, pending)
	a := pending.VisibleAuthority["default"]
	if a.Phase != "PENDING" || a != pending.DurableAuthority["default"] || len(pending.VisibleDB)+len(pending.DurableDB) != 0 || pending.Grants != 0 {
		t.Fatal("counterexample did not retain PENDING A with no DB or grant")
	}

	second, err := m.open(modelBackground, modelProfile, "observed-alias", modelFault{})
	if err != nil || second == nil {
		t.Fatalf("unresolved counterexample not witnessed: expected unsafe B grant, got %v", err)
	}
	defer second.close()
	unsafe := m.snapshot()
	b := unsafe.VisibleAuthority[modelProfile]
	if unsafe.Grants != 1 || unsafe.Generated != 2 || unsafe.Writes != 3 || b.Phase != "ACTIVE" || b != unsafe.DurableAuthority[modelProfile] ||
		b.Binding.Dir != a.Binding.Dir || unsafe.VisibleDB[a.Binding.Dir].Image.Binding != b.Binding ||
		unsafe.VisibleAuthority["default"] != a || unsafe.DurableAuthority["default"] != a {
		t.Fatal("counterexample trace lost its competing bindings or retained material")
	}
	t.Log("UNRESOLVED COUNTEREXAMPLE: retained PENDING A/noDB released both leases; B on an alias of the same directory received an ACTIVE grant")
	second.close()
	first, err = m.open(modelBackground, "default", "observed-main", modelFault{})
	modelDenied(t, first, err, modelRefused) // A is now stranded by B's DB binding.
	modelSameMaterial(t, unsafe, m.snapshot())
	modelBalanced(t, m.snapshot())
	modelCheckTrace(t, m.snapshot()) // Lease ordering alone does not reject this trace.
}

func TestAuthorityModelCrashRestoresDurableDatabaseNotVisibleDatabase(t *testing.T) {
	// This is an externally supplied loss snapshot, NOT an alleged successful
	// SQLite commit. Normal successful modeled commits assume durability.
	w := modelSeed("ACTIVE")
	durable := w.DurableDB["directory-A"]
	durable.Image.Rows, durable.Image.Value = 1, "durable-value"
	visible := durable
	visible.Image.Value = "visible-only-value"
	w.VisibleDB["directory-A"], w.DurableDB["directory-A"] = visible, durable
	m := newAuthorityModel(t, w)
	m.crash()
	if !maps.Equal(m.snapshot().VisibleDB, w.DurableDB) {
		t.Fatal("crash retained visible-only DB state")
	}
	g := modelOpen(t, m)
	got, err := g.secret(modelBackground, "get", "", modelFault{})
	if err != nil || got != "durable-value" {
		t.Fatal("reopen did not observe durable DB snapshot")
	}
	g.close()
	modelBalanced(t, m.snapshot())
	modelCheckTrace(t, m.snapshot())
}
