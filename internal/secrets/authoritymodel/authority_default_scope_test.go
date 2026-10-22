package authoritymodel_test

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"
)

// FAKE authenticated observations supplied by the harness, not OS authentication.
// A trusted constructor/namespace is assumed to inject the ONE same backend for
// the same SID/fixed application across entry points. No catalog is implemented.
const scopeApp = "fixed-model-application"

type scopeSubject struct {
	SID, App      string
	Authenticated bool
}

var scopeUser = scopeSubject{"fake-authenticated-SID", scopeApp, true}

const (
	scopeFirst = "first-initialization-chooses"
	scopeKnown = "enforced-known-directory"
)

type scopeRequest struct {
	Ref, Alias string
	// Untrusted labels must never select a backend/reference.
	CallerPath, Data, AgentID, BinaryLabel, FSUUID string
}
type defaultScopeCandidate struct {
	backend          *authorityModel
	bound            scopeSubject
	policy, knownDir string
}

func validScopeSubject(s scopeSubject) bool {
	return s.Authenticated && s.SID != "" && s.App == scopeApp
}
func newDefaultScopeCandidate(m *authorityModel, bound, observed scopeSubject, policy, knownDir string) (*defaultScopeCandidate, error) {
	if m == nil || !validScopeSubject(bound) || !validScopeSubject(observed) || bound != observed ||
		(policy != scopeFirst && policy != scopeKnown) || (policy == scopeKnown && knownDir == "") {
		return nil, modelRefused
	}
	return &defaultScopeCandidate{m, bound, policy, knownDir}, nil
}
func (c *defaultScopeCandidate) open(ctx context.Context, observed scopeSubject, req scopeRequest, fault modelFault) (*modelGrant, error) {
	// Admission precedes even cancellation and any call into the model actor.
	if req.Ref != "default" || !validScopeSubject(observed) || observed != c.bound {
		return nil, modelRefused
	}
	var admission func(string) bool
	if c.policy == scopeKnown {
		admission = func(dir string) bool { return dir == c.knownDir }
	}
	return c.backend.openWithAdmission(ctx, "default", req.Alias, fault, admission)
}
func scopeCandidate(t *testing.T, m *authorityModel, policy string) *defaultScopeCandidate {
	t.Helper()
	c, err := newDefaultScopeCandidate(m, scopeUser, scopeUser, policy, "directory-A")
	if err != nil {
		t.Fatal(err)
	}
	return c
}
func scopeOpen(t *testing.T, c *defaultScopeCandidate, alias string) *modelGrant {
	t.Helper()
	g, err := c.open(modelBackground, scopeUser, scopeRequest{Ref: "default", Alias: alias}, modelFault{})
	if err != nil || g == nil {
		t.Fatalf("candidate open: %v", err)
	}
	t.Cleanup(g.close)
	return g
}
func scopeUnchanged(t *testing.T, before, after modelWorld) {
	t.Helper()
	if !reflect.DeepEqual(before, after) {
		t.Fatal("rejected admission touched backend")
	}
}

func TestDefaultScopeRejectsCustomAndUnknownBeforeBackendEvenCancelled(t *testing.T) {
	for _, policy := range []string{scopeFirst, scopeKnown} {
		for _, ref := range []string{modelProfile, "", "unknown", "DEFAULT", "default\x00", "profile:bad"} {
			for _, cancelled := range []bool{false, true} {
				t.Run(fmt.Sprintf("%s/%q/cancel=%v", policy, ref, cancelled), func(t *testing.T) {
					m := newAuthorityModel(t, modelFreshWorld())
					c := scopeCandidate(t, m, policy)
					before := m.snapshot()
					ctx, cancel := context.WithCancel(modelBackground)
					defer cancel()
					if cancelled {
						cancel()
					}
					g, err := c.open(ctx, scopeUser, scopeRequest{Ref: ref, Alias: "observed-main"}, modelFault{})
					modelDenied(t, g, err, modelRefused)
					scopeUnchanged(t, before, m.snapshot())
				})
			}
		}
	}
}

func TestDefaultScopeUnknownOrMismatchedIdentityHasZeroBackendActivity(t *testing.T) {
	for _, observed := range []scopeSubject{{}, {"", scopeApp, true}, {scopeUser.SID, "", true}, {scopeUser.SID, "other-app", true}, {"other-SID", scopeApp, true}, {scopeUser.SID, scopeApp, false}} {
		t.Run(fmt.Sprintf("%+v", observed), func(t *testing.T) {
			m := newAuthorityModel(t, modelFreshWorld())
			before := m.snapshot()
			if c, err := newDefaultScopeCandidate(m, scopeUser, observed, scopeFirst, ""); c != nil || !errors.Is(err, modelRefused) {
				t.Fatal("constructor admitted unknown/mismatched subject")
			}
			// Unknown bound observations also cannot establish a candidate.
			if !validScopeSubject(observed) {
				if c, err := newDefaultScopeCandidate(m, observed, observed, scopeFirst, ""); c != nil || !errors.Is(err, modelRefused) {
					t.Fatal("constructor trusted unknown binding")
				}
			}
			c := scopeCandidate(t, m, scopeFirst)
			ctx, cancel := context.WithCancel(modelBackground)
			cancel()
			for _, ctx := range []context.Context{modelBackground, ctx} {
				g, err := c.open(ctx, observed, scopeRequest{Ref: "default", Alias: "observed-main"}, modelFault{})
				modelDenied(t, g, err, modelRefused)
			}
			scopeUnchanged(t, before, m.snapshot())
		})
	}
}

func TestDefaultScopeLabelsCannotChooseBackendOrReference(t *testing.T) {
	m := newAuthorityModel(t, modelFreshWorld())
	desktop, headless := scopeCandidate(t, m, scopeFirst), scopeCandidate(t, m, scopeFirst)
	first := scopeOpen(t, desktop, "observed-main")
	before := m.snapshot()
	req := scopeRequest{"default", "observed-other", "/different/executable", "different-data", "different-agent", "headless-compatible-version", "different-filesystem-UUID"}
	g, err := headless.open(modelBackground, scopeUser, req, modelFault{})
	modelDenied(t, g, err, modelBusy)
	if desktop.backend != headless.backend || headless.backend != m {
		t.Fatal("labels selected a different backend")
	}
	modelSameMaterial(t, before, m.snapshot())
	first.close()
	req.Alias = "observed-alias"
	g, err = headless.open(modelBackground, scopeUser, req, modelFault{})
	if err != nil || g == nil {
		t.Fatalf("equivalent headless binding: %v", err)
	}
	g.close()
	if m.snapshot().Generated != 1 || len(m.snapshot().VisibleAuthority) != 1 {
		t.Fatal("labels forked default authority")
	}
	modelBalanced(t, m.snapshot())
	modelCheckTrace(t, m.snapshot())
}

func TestDefaultScopeKnownDirectoryAcceptsAliasAndRefusesOtherBeforeDirectoryLease(t *testing.T) {
	m := newAuthorityModel(t, modelFreshWorld())
	c := scopeCandidate(t, m, scopeKnown)
	before := m.snapshot()
	g, err := c.open(modelBackground, scopeUser, scopeRequest{Ref: "default", Alias: "observed-other"}, modelFault{})
	modelDenied(t, g, err, modelRefused)
	after := m.snapshot()
	modelSameMaterial(t, before, after)
	if after.Generated != 0 || after.DirAcquires != 0 || after.RefAcquires != 1 ||
		len(after.Events) != 2 || after.Events[0].Name != "acquire:reference" || after.Events[1].Name != "release:reference" {
		t.Fatal("known-directory rejection observed artifacts or bypassed reference-first admission")
	}
	g = scopeOpen(t, c, "observed-alias")
	g.close()
	if m.snapshot().VisibleAuthority["default"].Binding.Dir != "directory-A" {
		t.Fatal("alias not admitted by injected identity")
	}
	modelBalanced(t, m.snapshot())
	modelCheckTrace(t, m.snapshot())
}

func TestDefaultScopeFirstInitializationChoosesBButCannotLaterMoveToA(t *testing.T) {
	m := newAuthorityModel(t, modelFreshWorld())
	c := scopeCandidate(t, m, scopeFirst)
	g := scopeOpen(t, c, "observed-other")
	g.close()
	before := m.snapshot()
	g, err := c.open(modelBackground, scopeUser, scopeRequest{Ref: "default", Alias: "observed-main"}, modelFault{})
	modelDenied(t, g, err, modelRefused)
	modelSameMaterial(t, before, m.snapshot())
	if before.VisibleAuthority["default"].Binding.Dir != "directory-B" || len(m.snapshot().VisibleDB) != 1 {
		t.Fatal("first location did not bind one default store")
	}
	modelBalanced(t, m.snapshot())
	modelCheckTrace(t, m.snapshot())
}

func TestDefaultScopePendingAmbiguityReservesAnyRetainedBindingNotAcknowledgement(t *testing.T) {
	faults := []modelFault{{Point: "pending.write", When: "before"}, {Point: "pending.write", When: "after"}, {Point: "pending.flush", When: "before"}, {Point: "pending.flush", When: "after"}, {Point: "pending.readback", When: "before"}, {Point: "pending.readback", When: "after"}, {Point: "pending.readback", When: "mismatch"}}
	for _, policy := range []string{scopeFirst, scopeKnown} {
		for _, fault := range faults {
			for _, crash := range []bool{false, true} {
				t.Run(fmt.Sprintf("%s/%s/%s/crash=%v", policy, fault.Point, fault.When, crash), func(t *testing.T) {
					m := newAuthorityModel(t, modelFreshWorld())
					c := scopeCandidate(t, m, policy)
					g, err := c.open(modelBackground, scopeUser, scopeRequest{Ref: "default", Alias: "observed-main"}, fault)
					modelDenied(t, g, err, modelUnknown)
					original := m.snapshot()
					a := original.VisibleAuthority["default"]
					visible := !(fault.Point == "pending.write" && fault.When == "before")
					durable := fault.Point == "pending.readback" || fault.Point == "pending.flush" && fault.When == "after"
					if a.Present != visible || original.DurableAuthority["default"].Present != durable || original.Writes != boolCount(visible) || original.Generated != 1 || original.Grants != 0 || len(original.VisibleDB)+len(original.DurableDB) != 0 {
						t.Fatal("incorrect PENDING ambiguity fixture")
					}
					for _, e := range original.Events {
						if e.Name == "ack:pending" {
							t.Fatal("failed acknowledgement counted as ack")
						}
					}
					modelBalanced(t, original)
					modelCheckTrace(t, original)
					if crash {
						m.crash()
					}
					before := m.snapshot()
					retained := before.VisibleAuthority["default"].Present
					g, err = c.open(modelBackground, scopeUser, scopeRequest{Ref: "default", Alias: "observed-other"}, modelFault{})
					if retained || policy == scopeKnown {
						modelDenied(t, g, err, modelRefused)
						modelSameMaterial(t, before, m.snapshot())
						if m.snapshot().Grants != 0 {
							t.Fatal("failed second open granted another root")
						}
						// Same-location resume must reuse the exact retained UUID/key, not merely
						// constants that could hide a second generation. Check generation/writes.
						g = scopeOpen(t, c, "observed-alias")
						g.close()
						after := m.snapshot()
						wantGenerated, wantWrites := before.Generated, before.Writes+1
						if !retained {
							wantGenerated++
							wantWrites++
						}
						if after.Generated != wantGenerated || after.Writes != wantWrites || after.VisibleAuthority["default"].Binding != (modelBinding{"default", "directory-A", modelUUID, modelKey}) || len(after.VisibleAuthority) != 1 || len(after.VisibleDB) != 1 {
							t.Fatal("PENDING resume replaced material or forked store")
						}
						if retained && after.VisibleAuthority["default"].Binding != a.Binding {
							t.Fatal("retained UUID/key changed")
						}
					} else {
						// LIMITATION: before-write (or crash losing the unflushed authority) has
						// no authority AND no artifacts. This is indistinguishable from first use.
						if len(before.VisibleAuthority)+len(before.DurableAuthority)+len(before.VisibleDB)+len(before.DurableDB) != 0 {
							t.Fatal("limitation fixture retained material")
						}
						if err != nil || g == nil {
							t.Fatalf("expected all-lost limitation: %v", err)
						}
						g.close()
						after := m.snapshot()
						if after.Generated != before.Generated+1 || after.Writes != before.Writes+2 || after.VisibleAuthority["default"].Binding.Dir != "directory-B" {
							t.Fatal("all-lost limitation not demonstrated")
						}
						t.Log("LIMITATION, not freshness defense: no retained authority/artifacts permits another first location")
					}
					modelBalanced(t, m.snapshot())
					modelCheckTrace(t, m.snapshot())
				})
			}
		}
	}
}
func boolCount(b bool) int {
	if b {
		return 1
	}
	return 0
}

func TestDefaultScopeRetainedPendingRejectsCustomWitnessWithoutBackendCall(t *testing.T) {
	m := newAuthorityModel(t, modelFreshWorld())
	c := scopeCandidate(t, m, scopeFirst)
	g, err := c.open(modelBackground, scopeUser, scopeRequest{Ref: "default", Alias: "observed-main"}, modelFault{Point: "pending.readback", When: "after"})
	modelDenied(t, g, err, modelUnknown)
	before := m.snapshot()
	g, err = c.open(modelBackground, scopeUser, scopeRequest{Ref: modelProfile, Alias: "observed-alias"}, modelFault{})
	modelDenied(t, g, err, modelRefused)
	scopeUnchanged(t, before, m.snapshot())
	// The original permissive model's unsafe witness remains in authority_grants_test.go.
	// This candidate changes admission only, not root freshness or custom issuance.
}

func TestDefaultScopeActiveEveryOpenAcknowledgesWithoutRewriting(t *testing.T) {
	for _, policy := range []string{scopeFirst, scopeKnown} {
		for _, fault := range []modelFault{{Point: "active.flush", When: "before"}, {Point: "active.flush", When: "after"}, {Point: "active.readback", When: "before"}, {Point: "active.readback", When: "after"}, {Point: "active.readback", When: "mismatch"}} {
			t.Run(policy+"/"+fault.Point+"/"+fault.When, func(t *testing.T) {
				m := newAuthorityModel(t, modelFreshWorld())
				c := scopeCandidate(t, m, policy)
				g := scopeOpen(t, c, "observed-main")
				g.close()
				before := m.snapshot()
				g, err := c.open(modelBackground, scopeUser, scopeRequest{Ref: "default", Alias: "observed-alias"}, fault)
				modelDenied(t, g, err, modelUnknown)
				modelSameMaterial(t, before, m.snapshot())
				if m.snapshot().Grants != 1 {
					t.Fatal("prior ack substituted for new ack")
				}
				g = scopeOpen(t, c, "observed-alias")
				g.close()
				after := m.snapshot()
				modelSameMaterial(t, before, after)
				if after.Grants != 2 {
					t.Fatal("fresh ACTIVE ack did not grant")
				}
				modelBalanced(t, after)
				modelCheckTrace(t, after)
			})
		}
	}
}

func TestDefaultScopeGlobalReferenceExcludesOtherLocationBeforeArtifactObservation(t *testing.T) {
	for _, policy := range []string{scopeFirst, scopeKnown} {
		t.Run(policy, func(t *testing.T) {
			m := newAuthorityModel(t, modelFreshWorld())
			c := scopeCandidate(t, m, policy)
			g := scopeOpen(t, c, "observed-main")
			before := m.snapshot()
			for _, alias := range []string{"observed-other", "observed-alias"} {
				other, err := c.open(modelBackground, scopeUser, scopeRequest{Ref: "default", Alias: alias}, modelFault{})
				modelDenied(t, other, err, modelBusy)
			}
			after := m.snapshot()
			modelSameMaterial(t, before, after)
			if !reflect.DeepEqual(before.Events, after.Events) || before.DirAcquires != after.DirAcquires || after.References["default"] != after.Directories["directory-A"] || len(after.Directories) != 1 {
				t.Fatal("global lease failed before artifact scan or directory lease did not last through grant")
			}
			// Exercise independent directory exclusion via the ORIGINAL permissive model,
			// not candidate custom admission. No second reference acquisition under a held directory.
			other, err := m.open(modelBackground, modelProfile, "observed-alias", modelFault{})
			modelDenied(t, other, err, modelBusy)
			modelSameMaterial(t, before, m.snapshot())
			g.close()
			modelBalanced(t, m.snapshot())
			modelCheckTrace(t, m.snapshot())
		})
	}
}

func TestDefaultScopeCancellationKeepsOwnerLeasesUntilSynchronousCompletion(t *testing.T) {
	for _, policy := range []string{scopeFirst, scopeKnown} {
		for _, point := range []string{"observe", "pending.write", "pending.flush", "pending.readback", "db.create", "db.commit", "db.reconcile", "active.write", "active.flush", "active.readback"} {
			t.Run(policy+"/"+point, func(t *testing.T) {
				m := newAuthorityModel(t, modelFreshWorld())
				c := scopeCandidate(t, m, policy)
				ctx, cancel := context.WithCancel(modelBackground)
				defer cancel()
				entered, proceed := make(chan struct{}), make(chan struct{})
				type outcome struct {
					g   *modelGrant
					err error
				}
				done := make(chan outcome, 1)
				go func() {
					g, err := c.open(ctx, scopeUser, scopeRequest{Ref: "default", Alias: "observed-main"}, modelFault{Point: point, Entered: entered, Continue: proceed})
					done <- outcome{g, err}
				}()
				<-entered
				released, joined := false, false
				defer func() {
					if !released {
						close(proceed)
					}
					if !joined {
						out := <-done
						out.g.close()
					}
				}()
				cancel()
				before := m.snapshot()
				if before.References["default"] == 0 || before.References["default"] != before.Directories["directory-A"] || before.RefReleases+before.DirReleases != 0 || before.Grants != 0 {
					t.Fatal("cancel released owner before synchronous completion")
				}
				select {
				case out := <-done:
					joined = true
					out.g.close()
					t.Fatal("cancellation detached synchronous operation")
				default:
				}
				other, err := c.open(modelBackground, scopeUser, scopeRequest{Ref: "default", Alias: "observed-other"}, modelFault{})
				modelDenied(t, other, err, modelBusy)
				if !reflect.DeepEqual(before.Events, m.snapshot().Events) {
					t.Fatal("different-location contender observed artifacts under another owner")
				}
				close(proceed)
				released = true
				out := <-done
				joined = true
				modelDenied(t, out.g, out.err, context.Canceled)
				if !errors.Is(out.err, modelUnknown) {
					t.Fatal("cancellation lost ambiguity")
				}
				modelBalanced(t, m.snapshot())
				modelCheckTrace(t, m.snapshot())
			})
		}
	}
}

func TestDefaultScopeCancelledDefaultHasZeroBackendActivity(t *testing.T) {
	m := newAuthorityModel(t, modelFreshWorld())
	c := scopeCandidate(t, m, scopeKnown)
	before := m.snapshot()
	ctx, cancel := context.WithCancel(modelBackground)
	cancel()
	g, err := c.open(ctx, scopeUser, scopeRequest{Ref: "default", Alias: "observed-main"}, modelFault{})
	modelDenied(t, g, err, context.Canceled)
	scopeUnchanged(t, before, m.snapshot())
}

func TestAuthorityModelNilAdmissionHookPreservesOriginalBehavior(t *testing.T) {
	for _, ref := range []string{"default", modelProfile, "invalid"} {
		for _, alias := range []string{"observed-main", "observed-alias", "observed-other", "unknown"} {
			for _, fault := range []modelFault{{}, {Point: "pending.write", When: "after"}, {Point: "pending.readback", When: "mismatch"}} {
				t.Run(fmt.Sprintf("%s/%s/%v", ref, alias, fault), func(t *testing.T) {
					a, b := newAuthorityModel(t, modelFreshWorld()), newAuthorityModel(t, modelFreshWorld())
					ga, ea := a.open(modelBackground, ref, alias, fault)
					gb, eb := b.openWithAdmission(modelBackground, ref, alias, fault, nil)
					ga.close()
					gb.close()
					if (ga == nil) != (gb == nil) || !errors.Is(ea, eb) || !reflect.DeepEqual(a.snapshot(), b.snapshot()) {
						t.Fatal("nil hook changed original behavior")
					}
				})
			}
		}
	}
}

func TestDefaultScopePreflightNeverCallsActorEvenForReadOnlyObservation(t *testing.T) {
	// Sending any model call, including a read-only snapshot, panics. Unlike event
	// counts alone this also detects a backend read hidden before rejection.
	calls := make(chan func(*modelWorld))
	close(calls)
	m := &authorityModel{calls: calls}
	for _, policy := range []string{scopeFirst, scopeKnown} {
		c := scopeCandidate(t, m, policy)
		ctx, cancel := context.WithCancel(modelBackground)
		cancel()
		for _, ctx := range []context.Context{modelBackground, ctx} {
			for _, ref := range []string{modelProfile, "unknown", "", "default\x00"} {
				g, err := c.open(ctx, scopeUser, scopeRequest{Ref: ref, Alias: "observed-main"}, modelFault{})
				modelDenied(t, g, err, modelRefused)
			}
			for _, subject := range []scopeSubject{{}, {"other-SID", scopeApp, true}, {scopeUser.SID, "other-app", true}, {scopeUser.SID, scopeApp, false}} {
				if candidate, err := newDefaultScopeCandidate(m, scopeUser, subject, policy, "directory-A"); candidate != nil || !errors.Is(err, modelRefused) {
					t.Fatal("bad constructor observation admitted")
				}
				g, err := c.open(ctx, subject, scopeRequest{Ref: "default", Alias: "observed-main"}, modelFault{})
				modelDenied(t, g, err, modelRefused)
			}
		}
		g, err := c.open(ctx, scopeUser, scopeRequest{Ref: "default", Alias: "observed-main"}, modelFault{})
		modelDenied(t, g, err, context.Canceled)
	}
}

func TestDefaultScopeDoesNotReplaceInvalidRetainedAuthority(t *testing.T) {
	for _, policy := range []string{scopeFirst, scopeKnown} {
		for _, kind := range []string{"invalid", "partial", "wrong-location"} {
			t.Run(policy+"/"+kind, func(t *testing.T) {
				w := modelSeed("PENDING")
				w.VisibleDB, w.DurableDB = map[string]modelDB{}, map[string]modelDB{}
				a := w.VisibleAuthority["default"]
				switch kind {
				case "invalid":
					a.Valid = false
				case "partial":
					a = modelRecord{Version: 2}
				case "wrong-location":
					a.Binding.Dir = "directory-B"
				}
				w.VisibleAuthority["default"], w.DurableAuthority["default"] = a, a
				m := newAuthorityModel(t, w)
				c := scopeCandidate(t, m, policy)
				g, err := c.open(modelBackground, scopeUser, scopeRequest{Ref: "default", Alias: "observed-main"}, modelFault{})
				modelDenied(t, g, err, modelRefused)
				modelSameMaterial(t, w, m.snapshot())
				modelBalanced(t, m.snapshot())
				modelCheckTrace(t, m.snapshot())
			})
		}
	}
}

func TestDefaultScopeGrantCloseJoinsCancelledSynchronousSecretOperation(t *testing.T) {
	for _, policy := range []string{scopeFirst, scopeKnown} {
		t.Run(policy, func(t *testing.T) {
			m := newAuthorityModel(t, modelFreshWorld())
			c := scopeCandidate(t, m, policy)
			g := scopeOpen(t, c, "observed-main")
			before := m.snapshot()
			ctx, cancel := context.WithCancel(modelBackground)
			defer cancel()
			entered, proceed := make(chan struct{}), make(chan struct{})
			done := make(chan error, 1)
			go func() {
				_, err := g.secret(ctx, "set", "model-only-value", modelFault{Point: "secret.set", Entered: entered, Continue: proceed})
				done <- err
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
					<-done
					<-closed
				}
			}()
			cancel()
			held := m.snapshot()
			if held.RefReleases+held.DirReleases != 0 {
				t.Fatal("Close released before synchronous completion")
			}
			select {
			case <-closed:
				t.Fatal("Close detached synchronous grant operation")
			default:
			}
			other, err := c.open(modelBackground, scopeUser, scopeRequest{Ref: "default", Alias: "observed-other"}, modelFault{})
			modelDenied(t, other, err, modelBusy)
			close(proceed)
			released = true
			err = <-done
			<-closed
			joined = true
			if !errors.Is(err, context.Canceled) || !errors.Is(err, modelUnknown) {
				t.Fatalf("lost ambiguity: %v", err)
			}
			modelBalanced(t, m.snapshot())
			modelCheckTrace(t, m.snapshot())
			g = scopeOpen(t, c, "observed-alias")
			value, err := g.secret(modelBackground, "get", "", modelFault{})
			if err != nil || value != "model-only-value" {
				t.Fatal("cancelled synchronous write was rolled back")
			}
			g.close()
			after := m.snapshot()
			if before.VisibleAuthority["default"] != after.VisibleAuthority["default"] || after.Generated != before.Generated || after.Writes != before.Writes {
				t.Fatal("grant operation replaced authority")
			}
			modelBalanced(t, after)
			modelCheckTrace(t, after)
		})
	}
}
