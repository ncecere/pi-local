package authoritymodel_test

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"reflect"
	"strings"
	"testing"
)

var modelBackground = context.Background()

func modelSeed(phase string) modelWorld {
	w := modelFreshWorld()
	a := modelRecord{true, true, 2, phase, modelBinding{"default", "directory-A", modelUUID, modelKey}}
	w.VisibleAuthority["default"], w.DurableAuthority["default"] = a, a
	db := modelDB{Exists: true, Image: modelImage{Schema: true, Auth: true, Binding: a.Binding}}
	w.VisibleDB["directory-A"], w.DurableDB["directory-A"] = db, db
	return w
}
func modelOpen(t *testing.T, m *authorityModel) *modelGrant {
	t.Helper()
	g, err := m.open(modelBackground, "default", "observed-main", modelFault{})
	if err != nil || g == nil {
		t.Fatalf("open: grant=%v err=%v", g, err)
	}
	t.Cleanup(g.close)
	return g
}
func modelDenied(t *testing.T, g *modelGrant, err, kind error) {
	t.Helper()
	if g != nil || !errors.Is(err, kind) {
		g.close()
		t.Fatalf("grant=%v err=%v, want no grant and %v", g, err, kind)
	}
	if _, err := g.secret(modelBackground, "set", "must-not-escape", modelFault{}); !errors.Is(err, modelClosed) {
		t.Fatal("secret API usable without grant")
	}
}
func modelBalanced(t *testing.T, w modelWorld) {
	t.Helper()
	if len(w.References)+len(w.Directories) != 0 || w.RefAcquires != w.RefReleases || w.DirAcquires != w.DirReleases {
		t.Fatalf("unbalanced leases: refs %d/%d dirs %d/%d", w.RefAcquires, w.RefReleases, w.DirAcquires, w.DirReleases)
	}
}
func modelSameMaterial(t *testing.T, a, b modelWorld) {
	t.Helper()
	if !maps.Equal(a.VisibleAuthority, b.VisibleAuthority) || !maps.Equal(a.DurableAuthority, b.DurableAuthority) ||
		!maps.Equal(a.VisibleDB, b.VisibleDB) || !maps.Equal(a.DurableDB, b.DurableDB) ||
		!maps.Equal(a.Legacy, b.Legacy) || !maps.Equal(a.Format1, b.Format1) || a.Writes != b.Writes || a.Generated != b.Generated {
		t.Fatal("refusal changed/replaced/deleted material")
	}
}

// Trace oracle: completion alone is not successful flush, validated readback,
// or authenticated schema/binding/row verification. These remain model events,
// not an independent cryptographic or native-storage proof.
func modelCheckTrace(t *testing.T, w modelWorld) {
	t.Helper()
	if err := modelTraceError(w); err != nil {
		t.Fatal(err)
	}
}

func modelTraceError(w modelWorld) error {
	type held struct {
		ref, dir, pending, active, verified bool
		flush, read                         string
	}
	owners := map[int]held{}
	for _, e := range w.Events {
		h := owners[e.Owner]
		switch e.Name {
		case "acquire:reference":
			if h.ref || h.dir {
				return errors.New("reference acquired out of order")
			}
			h.ref = true
		case "acquire:directory":
			if !h.ref || h.dir {
				return errors.New("directory acquired before reference")
			}
			h.dir = true
		case "release:directory":
			if !h.dir || !h.ref {
				return errors.New("invalid directory release")
			}
			h.dir = false
		case "release:reference":
			if !h.ref || h.dir {
				return errors.New("reference released before directory")
			}
			h.ref = false
		case "ok:pending.flush", "ok:active.flush":
			h.flush = strings.TrimSuffix(strings.TrimPrefix(e.Name, "ok:"), ".flush")
		case "validated:pending.readback", "validated:active.readback":
			h.read = strings.TrimSuffix(strings.TrimPrefix(e.Name, "validated:"), ".readback")
		case "ack:pending", "ack:active":
			phase := strings.TrimPrefix(e.Name, "ack:")
			if !h.ref || !h.dir || h.flush != phase || h.read != phase {
				return errors.New("ack without successful leased flush/validated readback")
			}
			if phase == "pending" {
				h.pending = true
			} else {
				h.active = true
			}
		case "verified:db":
			if !h.ref || !h.dir {
				return errors.New("DB verification without leases")
			}
			h.verified = true
		case "grant":
			if !h.ref || !h.dir || !h.active || !h.verified {
				return errors.New("pre-ack grant")
			}
		}
		if strings.HasPrefix(e.Name, "start:") {
			if !h.ref || !h.dir {
				return fmt.Errorf("unleased %s", e.Name)
			}
			if e.Name == "start:db.create" && !h.pending {
				return errors.New("DB before acknowledged PENDING")
			}
			if e.Name == "start:active.write" && !h.verified {
				return errors.New("ACTIVE before DB verification")
			}
		}
		owners[e.Owner] = h
	}
	return nil
}

func TestAuthorityModelOracleRejectsCompletionWithoutSuccessfulValidation(t *testing.T) {
	m := newAuthorityModel(t, modelFreshWorld())
	g := modelOpen(t, m)
	g.close()
	good := m.snapshot()
	if err := modelTraceError(good); err != nil {
		t.Fatal(err)
	}
	for _, marker := range []string{"ok:pending.flush", "validated:pending.readback", "verified:db", "ok:active.flush", "validated:active.readback"} {
		t.Run(marker, func(t *testing.T) {
			bad := good.clone()
			found := false
			for i := range bad.Events {
				if bad.Events[i].Name == marker {
					completion := strings.TrimPrefix(strings.TrimPrefix(marker, "ok:"), "validated:")
					if marker == "verified:db" {
						completion = "db.reconcile"
					}
					bad.Events[i].Name = "done:" + completion
					found = true
				}
			}
			if !found || modelTraceError(bad) == nil {
				t.Fatal("completion-only mutation escaped the validation oracle")
			}
		})
	}
}

func TestAuthorityModelFreshBootstrapAndCRUDNeverRewriteActive(t *testing.T) {
	m := newAuthorityModel(t, modelFreshWorld())
	g := modelOpen(t, m)
	initial := m.snapshot()
	if initial.Writes != 2 || initial.Generated != 1 || initial.Grants != 1 || initial.VisibleAuthority["default"] != initial.DurableAuthority["default"] {
		t.Fatal("bootstrap did not acknowledge exactly one root and two phases")
	}
	for _, op := range []string{"set", "get", "delete"} {
		value, err := g.secret(modelBackground, op, "opaque-test-value", modelFault{})
		if err != nil || op == "get" && value != "opaque-test-value" {
			t.Fatalf("%s: %q %v", op, value, err)
		}
		if op == "set" && m.snapshot().VisibleDB["directory-A"].Image.Rows != 1 {
			t.Fatal("secret not committed to DB")
		}
	}
	g.close()
	g.close()
	if _, err := g.secret(modelBackground, "get", "", modelFault{}); !errors.Is(err, modelClosed) {
		t.Fatal("closed grant usable")
	}
	m.crash()
	reopened := modelOpen(t, m)
	after := m.snapshot()
	if after.Writes != initial.Writes || after.Generated != initial.Generated || !maps.Equal(after.VisibleAuthority, initial.VisibleAuthority) {
		t.Fatal("ACTIVE reopen or CRUD rewrote authority")
	}
	reopened.close()
	modelBalanced(t, m.snapshot())
	modelCheckTrace(t, m.snapshot())
}

func TestAuthorityModelBoundaryFailuresNeverGrantAndReopenOnlyReconciles(t *testing.T) {
	points := []string{"observe", "pending.write", "pending.flush", "pending.readback", "db.create", "db.commit", "db.reconcile", "active.write", "active.flush", "active.readback"}
	for _, point := range points {
		for _, when := range []string{"before", "after", "mismatch"} {
			if when == "mismatch" && !strings.HasSuffix(point, ".readback") {
				continue
			}
			for _, crash := range []bool{false, true} {
				t.Run(fmt.Sprintf("%s/%s/crash=%v", point, when, crash), func(t *testing.T) {
					m := newAuthorityModel(t, modelFreshWorld())
					g, err := m.open(modelBackground, "default", "observed-main", modelFault{Point: point, When: when})
					modelDenied(t, g, err, modelUnknown)
					before := m.snapshot()
					if before.Grants != 0 {
						t.Fatal("grant before acknowledgement")
					}
					modelBalanced(t, before)
					modelCheckTrace(t, before)
					if crash {
						m.crash()
					}
					observed := m.snapshot()
					g, err = m.open(modelBackground, "default", "observed-main", modelFault{})
					partial := point == "db.create" && when == "after" || point == "db.commit" && when == "before"
					if partial {
						modelDenied(t, g, err, modelRefused)
						modelSameMaterial(t, observed, m.snapshot())
					} else {
						if err != nil || g == nil {
							t.Fatalf("reconciliation failed: %v", err)
						}
						g.close()
					}
					after := m.snapshot()
					if observed.VisibleAuthority["default"].Present && after.Generated != before.Generated {
						t.Fatal("existing root replaced")
					}
					if a := after.VisibleAuthority["default"]; a.Present && (a.Binding.UUID != modelUUID || a.Binding.Key != modelKey) {
						t.Fatal("root changed")
					}
					modelBalanced(t, after)
					modelCheckTrace(t, after)
				})
			}
		}
	}
}

func TestAuthorityModelVisibleActiveNeedsFreshAcknowledgementWithoutWrite(t *testing.T) {
	for _, fault := range []modelFault{{Point: "active.flush", When: "before"}, {Point: "active.flush", When: "after"}, {Point: "active.readback", When: "before"}, {Point: "active.readback", When: "after"}, {Point: "active.readback", When: "mismatch"}} {
		t.Run(fault.Point+"/"+fault.When, func(t *testing.T) {
			m := newAuthorityModel(t, modelFreshWorld())
			g, err := m.open(modelBackground, "default", "observed-main", modelFault{Point: "active.write", When: "after"})
			modelDenied(t, g, err, modelUnknown)
			visible := m.snapshot()
			if visible.VisibleAuthority["default"].Phase != "ACTIVE" || visible.DurableAuthority["default"].Phase != "PENDING" {
				t.Fatal("fixture failed to expose unacknowledged promotion")
			}
			g, err = m.open(modelBackground, "default", "observed-alias", fault)
			modelDenied(t, g, err, modelUnknown)
			if m.snapshot().Grants != 0 || m.snapshot().Writes != visible.Writes {
				t.Fatal("visible ACTIVE trusted or rewritten")
			}
			g = modelOpen(t, m)
			ack := m.snapshot()
			if ack.Writes != visible.Writes || ack.Generated != 1 || ack.VisibleAuthority["default"] != ack.DurableAuthority["default"] {
				t.Fatal("reopen did not acknowledge immutable ACTIVE")
			}
			g.close()
			modelBalanced(t, m.snapshot())
			modelCheckTrace(t, m.snapshot())
		})
	}
}

func TestAuthorityModelActiveReopenRequiresAcknowledgementEvenAfterPriorGrant(t *testing.T) {
	m := newAuthorityModel(t, modelSeed("ACTIVE"))
	g := modelOpen(t, m)
	g.close()
	before := m.snapshot()
	g, err := m.open(modelBackground, "default", "observed-main", modelFault{Point: "active.flush", When: "before"})
	modelDenied(t, g, err, modelUnknown)
	modelSameMaterial(t, before, m.snapshot())
	if m.snapshot().Grants != 1 {
		t.Fatal("prior acknowledgement substituted for current acknowledgement")
	}
	modelBalanced(t, m.snapshot())
}

func TestAuthorityModelPendingCleanAbsenceResumesIdenticalRoot(t *testing.T) {
	w := modelSeed("PENDING")
	w.VisibleDB, w.DurableDB = map[string]modelDB{}, map[string]modelDB{}
	m := newAuthorityModel(t, w)
	g := modelOpen(t, m)
	g.close()
	after := m.snapshot()
	if after.Generated != 0 || after.Writes != 1 || after.VisibleAuthority["default"].Binding != w.VisibleAuthority["default"].Binding {
		t.Fatal("PENDING replaced instead of resumed")
	}
	modelCheckTrace(t, after)
	modelBalanced(t, after)
}

func TestAuthorityModelPendingRequiresSchemaBindingAuthenticationAndZeroReconciledRows(t *testing.T) {
	cases := map[string]func(*modelDB){
		"partial":             func(d *modelDB) { d.Image = modelImage{} },
		"keycheck-not-schema": func(d *modelDB) { d.Image.Schema = false },
		"unauthenticated":     func(d *modelDB) { d.Image.Auth = false },
		"wrong-key":           func(d *modelDB) { d.Image.Binding.Key = "wrong" },
		"wrong-uuid":          func(d *modelDB) { d.Image.Binding.UUID = "wrong" },
		"wrong-reference":     func(d *modelDB) { d.Image.Binding.Ref = modelProfile },
		"wrong-location":      func(d *modelDB) { d.Image.Binding.Dir = "directory-B" },
		"secret-rows":         func(d *modelDB) { d.Image.Rows, d.Image.Value = 1, "retained-ciphertext" },
		"wal-secret-rows": func(d *modelDB) {
			d.WAL, d.WALValid, d.RequiredWAL = true, true, true
			d.WALImage = d.Image
			d.WALImage.Rows = 1
		},
		"lost-required-wal": func(d *modelDB) { d.RequiredWAL = true },
		"corrupt-wal":       func(d *modelDB) { d.WAL = true },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			w := modelSeed("PENDING")
			db := w.VisibleDB["directory-A"]
			change(&db)
			w.VisibleDB["directory-A"], w.DurableDB["directory-A"] = db, db
			m := newAuthorityModel(t, w)
			g, err := m.open(modelBackground, "default", "observed-main", modelFault{})
			modelDenied(t, g, err, modelRefused)
			modelSameMaterial(t, w, m.snapshot())
			modelBalanced(t, m.snapshot())
		})
	}
	t.Run("committed-empty-WAL-can-promote", func(t *testing.T) {
		w := modelSeed("PENDING")
		db := w.VisibleDB["directory-A"]
		db.WAL, db.WALValid, db.RequiredWAL, db.WALImage = true, true, true, db.Image
		db.Image = modelImage{} // Only reconciliation reveals the committed schema.
		w.VisibleDB["directory-A"], w.DurableDB["directory-A"] = db, db
		m := newAuthorityModel(t, w)
		g := modelOpen(t, m)
		g.close()
		if m.snapshot().Generated != 0 || m.snapshot().Writes != 1 {
			t.Fatal("WAL resume replaced root")
		}
	})
}

func TestAuthorityModelArtifactsAndInvalidAuthorityFailClosedAndPreserve(t *testing.T) {
	cases := map[string]func(*modelWorld){
		"absent-key-existing-ciphertext": func(w *modelWorld) {
			delete(w.VisibleAuthority, "default")
			delete(w.DurableAuthority, "default")
			d := w.VisibleDB["directory-A"]
			d.Image.Rows, d.Image.Value = 1, "ciphertext"
			w.VisibleDB["directory-A"], w.DurableDB["directory-A"] = d, d
		},
		"active-missing-db":     func(w *modelWorld) { delete(w.VisibleDB, "directory-A"); delete(w.DurableDB, "directory-A") },
		"active-recreated-root": func(w *modelWorld) { w.Recreated["directory-A"] = true },
		"legacy-credentials":    func(w *modelWorld) { *w = modelFreshWorld(); w.Legacy["directory-A"] = true },
		"format1-artifacts":     func(w *modelWorld) { *w = modelFreshWorld(); w.Format1["directory-A"] = true },
	}
	for _, field := range []string{"malformed", "version1", "unknown-version", "unknown-phase", "wrong-ref", "wrong-dir", "missing-uuid", "missing-key", "torn-promotion"} {
		cases[field] = func(w *modelWorld) {
			a := w.VisibleAuthority["default"]
			switch field {
			case "malformed":
				a.Valid = false
			case "version1":
				a.Version = 1
			case "unknown-version":
				a.Version = 99
			case "unknown-phase":
				a.Phase = "FUTURE"
			case "wrong-ref":
				a.Binding.Ref = modelProfile
			case "wrong-dir":
				a.Binding.Dir = "directory-B"
			case "missing-uuid":
				a.Binding.UUID = ""
			case "missing-key":
				a.Binding.Key = ""
			case "torn-promotion":
				a.Valid, a.Phase = false, "ACT"
			}
			w.VisibleAuthority["default"], w.DurableAuthority["default"] = a, a
		}
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			w := modelSeed("ACTIVE")
			change(&w)
			m := newAuthorityModel(t, w)
			g, err := m.open(modelBackground, "default", "observed-main", modelFault{})
			modelDenied(t, g, err, modelRefused)
			modelSameMaterial(t, w, m.snapshot())
			modelBalanced(t, m.snapshot())
		})
	}
	for _, phase := range []string{"absent", "PENDING"} {
		for _, sidecar := range []string{"wal", "shm", "journal"} {
			t.Run(phase+"/orphan-"+sidecar, func(t *testing.T) {
				w := modelFreshWorld()
				if phase == "PENDING" {
					w = modelSeed(phase)
				}
				db := modelDB{}
				switch sidecar {
				case "wal":
					db.WAL = true
				case "shm":
					db.SHM = true
				case "journal":
					db.Journal = true
				}
				w.VisibleDB["directory-A"], w.DurableDB["directory-A"] = db, db
				m := newAuthorityModel(t, w)
				g, err := m.open(modelBackground, "default", "observed-main", modelFault{})
				modelDenied(t, g, err, modelRefused)
				modelSameMaterial(t, w, m.snapshot())
				modelBalanced(t, m.snapshot())
			})
		}
	}
}

func TestAuthorityModelReferenceGrammarAndUnobservedAliasesAreRefused(t *testing.T) {
	for _, ref := range []string{"default", modelProfile, "profile:00000000-0000-0000-0000-000000000000"} {
		if !modelValidRef(ref) {
			t.Fatalf("canonical reference rejected: %q", ref)
		}
	}
	for _, ref := range []string{"", "DEFAULT", " default", "default\x00", "default/child", "directory-A", "profile:" + modelUUID + "\n", strings.ToUpper(modelProfile), "profile:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee", "profile:aaaaaaaa_bbbb-cccc-dddd-eeeeeeeeeeee", "profile:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeé"} {
		t.Run(ref, func(t *testing.T) {
			m := newAuthorityModel(t, modelFreshWorld())
			g, err := m.open(modelBackground, ref, "observed-main", modelFault{})
			modelDenied(t, g, err, modelRefused)
			if len(m.snapshot().Events) != 0 {
				t.Fatal("invalid reference acquired lease or accessed authority")
			}
		})
	}
	m := newAuthorityModel(t, modelFreshWorld())
	g, err := m.open(modelBackground, "default", "unobserved-spelling", modelFault{})
	modelDenied(t, g, err, modelRefused)
	modelBalanced(t, m.snapshot())
	if m.snapshot().Generated != 0 {
		t.Fatal("invented canonical path from unobserved alias")
	}
}

func TestAuthorityModelCancellationRetainsBothLeasesUntilSynchronousCompletion(t *testing.T) {
	for _, point := range []string{"observe", "pending.write", "pending.flush", "pending.readback", "db.create", "db.commit", "db.reconcile", "active.write", "active.flush", "active.readback"} {
		t.Run(point, func(t *testing.T) {
			m := newAuthorityModel(t, modelFreshWorld())
			ctx, cancel := context.WithCancel(modelBackground)
			defer cancel()
			entered, proceed := make(chan struct{}), make(chan struct{})
			type result struct {
				g   *modelGrant
				err error
			}
			done := make(chan result, 1)
			go func() {
				g, err := m.open(ctx, "default", "observed-main", modelFault{Point: point, Entered: entered, Continue: proceed})
				done <- result{g, err}
			}()
			<-entered
			// Join before the model's actor cleanup, including on assertion failure.
			released, joined := false, false
			defer func() {
				if !released {
					close(proceed)
				}
				if !joined {
					out := <-done
					if out.g != nil {
						out.g.close()
					}
				}
			}()
			cancel()
			held := m.snapshot()
			if held.References["default"] == 0 || held.Directories["directory-A"] == 0 || held.RefReleases != 0 || held.DirReleases != 0 || held.Grants != 0 {
				t.Fatal("cancellation released an in-flight operation")
			}
			select {
			case out := <-done:
				joined = true
				out.g.close()
				t.Fatal("cancel detached synchronous call")
			default:
			}
			// Same reference collides even at another directory. Different refs
			// sharing an observed directory collide at independent exclusion.
			for _, contender := range [][2]string{{"default", "observed-other"}, {modelProfile, "observed-alias"}} {
				g, err := m.open(modelBackground, contender[0], contender[1], modelFault{})
				modelDenied(t, g, err, modelBusy)
			}
			held = m.snapshot()
			if held.RefAcquires != 2 || held.RefReleases != 1 || held.DirAcquires != 1 || held.DirReleases != 0 {
				t.Fatal("collision leaked or stole lease")
			}
			modelCheckTrace(t, held)
			close(proceed)
			released = true
			out := <-done
			joined = true
			modelDenied(t, out.g, out.err, context.Canceled)
			if !errors.Is(out.err, modelUnknown) {
				t.Fatal("cancelled completed boundary lost ambiguity")
			}
			modelBalanced(t, m.snapshot())
			modelCheckTrace(t, m.snapshot())
		})
	}
}

func TestAuthorityModelLifetimeGrantExcludesAliasesAndDifferentReferences(t *testing.T) {
	m := newAuthorityModel(t, modelFreshWorld())
	g := modelOpen(t, m)
	for _, contender := range [][2]string{{"default", "observed-alias"}, {"default", "observed-other"}, {modelProfile, "observed-alias"}} {
		other, err := m.open(modelBackground, contender[0], contender[1], modelFault{})
		modelDenied(t, other, err, modelBusy)
	}
	g.close()
	other, err := m.open(modelBackground, modelProfile, "observed-alias", modelFault{})
	// Directory exclusion survives as authenticated DB binding once released;
	// no competing authority can be initialized over the existing DB.
	modelDenied(t, other, err, modelRefused)
	if m.snapshot().Generated != 1 || m.snapshot().Writes != 2 {
		t.Fatal("different reference replaced existing material")
	}
	modelBalanced(t, m.snapshot())
	modelCheckTrace(t, m.snapshot())
}

func TestAuthorityModelIndistinguishabilityIsNotAntiRollback(t *testing.T) {
	t.Run("missing-everything-versus-first-use", func(t *testing.T) {
		// A historical grant is deliberately erased by an EXTERNAL rollback
		// fixture, not by protocol logic. No trusted historical marker survives.
		history := newAuthorityModel(t, modelFreshWorld())
		g := modelOpen(t, history)
		if _, err := g.secret(modelBackground, "set", "lost-ciphertext", modelFault{}); err != nil {
			t.Fatal(err)
		}
		g.close()
		lostObservation := modelFreshWorld()
		firstObservation := modelFreshWorld()
		if !reflect.DeepEqual(lostObservation, firstObservation) {
			t.Fatal("fixtures are distinguishable")
		}
		for _, observation := range []modelWorld{lostObservation, firstObservation} {
			m := newAuthorityModel(t, observation)
			grant := modelOpen(t, m)
			grant.close()
			if m.snapshot().Generated != 1 {
				t.Fatal("equal fresh observations behaved differently")
			}
		}
	})
	t.Run("stale-PENDING-empty-DB-versus-unactivated-PENDING", func(t *testing.T) {
		unactivated := modelSeed("PENDING")
		history := newAuthorityModel(t, unactivated)
		g := modelOpen(t, history)
		if _, err := g.secret(modelBackground, "set", "deleted-later", modelFault{}); err != nil {
			t.Fatal(err)
		}
		if _, err := g.secret(modelBackground, "delete", "", modelFault{}); err != nil {
			t.Fatal(err)
		}
		g.close()
		// Replay old authority while retaining a genuinely empty authenticated
		// DB. These observations cannot reveal prior activation or use.
		replayed := unactivated.clone()
		replayed.VisibleDB, replayed.DurableDB = history.snapshot().VisibleDB, history.snapshot().DurableDB
		if !reflect.DeepEqual(replayed, unactivated) {
			t.Fatal("fixtures are distinguishable")
		}
		for _, observation := range []modelWorld{replayed, unactivated} {
			m := newAuthorityModel(t, observation)
			grant := modelOpen(t, m)
			grant.close()
			if m.snapshot().Generated != 0 || m.snapshot().Writes != 1 {
				t.Fatal("stale empty PENDING cannot be distinguished")
			}
		}
	})
}
