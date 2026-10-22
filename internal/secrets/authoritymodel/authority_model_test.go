// This package is an unwired TEST-ONLY transition model, not a storage adapter.
// Its public constants are identities, not cryptographic keys. Successful fake
// flush/commit and observed directory equivalence are assumptions, not OS proofs.
// An unresolved sequential cross-reference counterexample is deliberately retained;
// see TestAuthorityModelUnresolvedCounterexampleSequentialReferencesGrantSameDirectory
// and docs/qa/v0.5-secret-authority-model.md. This is NOT protocol acceptance.
package authoritymodel_test

import (
	"context"
	"errors"
	"maps"
	"slices"
	"strings"
	"testing"
)

const (
	modelProfile = "profile:01234567-89ab-4cde-8fab-0123456789ab"
	modelUUID    = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
	modelKey     = "PUBLIC-FAKE-ROOT-IDENTITY"
)

var (
	modelUnknown = errors.New("model: outcome unknown")
	modelRefused = errors.New("model: invalid or recovery required")
	modelBusy    = errors.New("model: lease collision")
	modelClosed  = errors.New("model: no acknowledged grant")
)

type modelBinding struct{ Ref, Dir, UUID, Key string }
type modelRecord struct {
	Present, Valid bool
	Version        int
	Phase          string
	Binding        modelBinding
}
type modelImage struct {
	Schema, Auth bool
	Binding      modelBinding
	Rows         int
	Value        string // One opaque modeled secret slot; no encryption claim.
}
type modelDB struct {
	Exists                                   bool
	Image                                    modelImage
	WAL, RequiredWAL, WALValid, SHM, Journal bool
	WALImage                                 modelImage
}

func (d modelDB) artifacts() bool { return d != (modelDB{}) }

// Reconciliation is an observation of a committed image, not SQLite execution.
// Missing required WAL, unauthenticated WAL and orphan sidecars are not repaired.
func (d modelDB) reconcile() (modelImage, error) {
	if !d.Exists || d.RequiredWAL && !d.WAL {
		return modelImage{}, modelRefused
	}
	if d.WAL {
		if !d.WALValid {
			return modelImage{}, modelRefused
		}
		return d.WALImage, nil
	}
	return d.Image, nil
}

type modelEvent struct {
	Name, Ref, Dir string
	Owner          int
}
type modelWorld struct {
	VisibleAuthority, DurableAuthority map[string]modelRecord
	VisibleDB, DurableDB               map[string]modelDB
	Aliases                            map[string]string // Injected directory IDs, NOT a path normalizer.
	Legacy, Format1, Recreated         map[string]bool
	References, Directories            map[string]int
	Events                             []modelEvent
	Next, Generated, Writes, Grants    int
	RefAcquires, RefReleases           int
	DirAcquires, DirReleases           int
}

func modelFreshWorld() modelWorld {
	return modelWorld{
		VisibleAuthority: map[string]modelRecord{}, DurableAuthority: map[string]modelRecord{},
		VisibleDB: map[string]modelDB{}, DurableDB: map[string]modelDB{},
		Aliases: map[string]string{"observed-main": "directory-A", "observed-alias": "directory-A", "observed-other": "directory-B"},
		Legacy:  map[string]bool{}, Format1: map[string]bool{}, Recreated: map[string]bool{},
		References: map[string]int{}, Directories: map[string]int{},
	}
}

func (w modelWorld) clone() modelWorld {
	w.VisibleAuthority, w.DurableAuthority = maps.Clone(w.VisibleAuthority), maps.Clone(w.DurableAuthority)
	w.VisibleDB, w.DurableDB = maps.Clone(w.VisibleDB), maps.Clone(w.DurableDB)
	w.Aliases = maps.Clone(w.Aliases)
	w.Legacy, w.Format1, w.Recreated = maps.Clone(w.Legacy), maps.Clone(w.Format1), maps.Clone(w.Recreated)
	w.References, w.Directories = maps.Clone(w.References), maps.Clone(w.Directories)
	w.Events = slices.Clone(w.Events)
	return w
}

// One channel-owned actor supplies race-safe observations. No mutex, filesystem,
// registry, DPAPI, production Store/Vault or OS lease is involved.
type authorityModel struct{ calls chan func(*modelWorld) }

func newAuthorityModel(t *testing.T, seed modelWorld) *authorityModel {
	t.Helper()
	m := &authorityModel{calls: make(chan func(*modelWorld))}
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		w := seed.clone()
		for call := range m.calls {
			call(&w)
		}
	}()
	t.Cleanup(func() { close(m.calls); <-stopped })
	return m
}

func (m *authorityModel) do(fn func(*modelWorld)) {
	done := make(chan struct{})
	m.calls <- func(w *modelWorld) { fn(w); close(done) }
	<-done
}
func (m *authorityModel) snapshot() (w modelWorld) {
	m.do(func(s *modelWorld) { w = s.clone() })
	return
}
func (m *authorityModel) crash() {
	m.do(func(w *modelWorld) {
		if len(w.References)+len(w.Directories) != 0 {
			panic("crash snapshots require joined operations and released grants")
		}
		w.VisibleAuthority = maps.Clone(w.DurableAuthority)
		w.VisibleDB = maps.Clone(w.DurableDB)
	})
}

// Grammar only: issuance/explicit creation of custom profile IDs is NOT modeled.
func modelValidRef(ref string) bool {
	if ref == "default" {
		return true
	}
	if !strings.HasPrefix(ref, "profile:") {
		return false
	}
	u := strings.TrimPrefix(ref, "profile:")
	if len(u) != 36 {
		return false
	}
	for i := range len(u) {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if u[i] != '-' {
				return false
			}
		} else if !(u[i] >= '0' && u[i] <= '9' || u[i] >= 'a' && u[i] <= 'f') {
			return false
		}
	}
	return true
}
func modelValidRecord(a modelRecord, ref, dir string) bool {
	b := a.Binding
	return a.Present && a.Valid && a.Version == 2 && (a.Phase == "PENDING" || a.Phase == "ACTIVE") &&
		b.Ref == ref && b.Dir == dir && b.UUID != "" && b.Key != ""
}

// Fault points surround synchronous boundary completion. An after-write failure
// can leave a visible, unflushed value. A successful flush copies it to durable
// state. This intentionally does NOT assume atomic old-or-new replacement.
type modelFault struct {
	Point, When string // before, after, mismatch
	Entered     chan<- struct{}
	Continue    <-chan struct{}
}
type modelRun struct {
	m        *authorityModel
	ctx      context.Context
	ref, dir string
	owner    int
	fault    modelFault
}

func (r modelRun) event(w *modelWorld, name string) {
	w.Events = append(w.Events, modelEvent{name, r.ref, r.dir, r.owner})
}
func (r modelRun) step(name string, action func(*modelWorld)) error {
	if err := r.ctx.Err(); err != nil {
		return err
	}
	hit := r.fault.Point == name
	r.m.do(func(w *modelWorld) {
		if w.References[r.ref] != r.owner || w.Directories[r.dir] != r.owner {
			panic("authority/database access without both leases")
		}
		r.event(w, "start:"+name)
		if !hit || r.fault.When != "before" {
			action(w)
		}
	})
	// Blocking is OUTSIDE the actor: snapshots and competing opens can proceed.
	// Cancellation is checked only after this synchronous fake call completes.
	if hit && r.fault.Entered != nil {
		close(r.fault.Entered)
		<-r.fault.Continue
	}
	r.m.do(func(w *modelWorld) { r.event(w, "done:"+name) })
	if hit && (r.fault.When == "before" || r.fault.When == "after") {
		return modelUnknown
	}
	if err := r.ctx.Err(); err != nil {
		return errors.Join(modelUnknown, err)
	}
	r.m.do(func(w *modelWorld) { r.event(w, "ok:"+name) })
	return nil
}
func (r modelRun) release() {
	r.m.do(func(w *modelWorld) {
		if w.Directories[r.dir] == r.owner {
			delete(w.Directories, r.dir)
			w.DirReleases++
			r.event(w, "release:directory")
		}
		if w.References[r.ref] == r.owner {
			delete(w.References, r.ref)
			w.RefReleases++
			r.event(w, "release:reference")
		}
	})
}
func (r modelRun) acknowledge(a modelRecord) error {
	phase := strings.ToLower(a.Phase)
	if err := r.step(phase+".flush", func(w *modelWorld) {
		w.DurableAuthority[r.ref] = w.VisibleAuthority[r.ref]
	}); err != nil {
		return err
	}
	var read modelRecord
	if err := r.step(phase+".readback", func(w *modelWorld) {
		read = w.VisibleAuthority[r.ref]
		if r.fault.Point == phase+".readback" && r.fault.When == "mismatch" {
			read.Binding.Key = "different-but-well-formed-root"
		}
	}); err != nil {
		return err
	}
	if read != a || !modelValidRecord(read, r.ref, r.dir) {
		return modelUnknown
	}
	r.m.do(func(w *modelWorld) {
		r.event(w, "validated:"+phase+".readback")
		r.event(w, "ack:"+phase)
	})
	return nil
}
func (r modelRun) publish(a modelRecord) error {
	if err := r.step(strings.ToLower(a.Phase)+".write", func(w *modelWorld) {
		if w.VisibleAuthority[r.ref].Phase == "ACTIVE" {
			panic("immutable ACTIVE rewritten")
		}
		w.VisibleAuthority[r.ref] = a
		w.Writes++
	}); err != nil {
		return err
	}
	return r.acknowledge(a)
}

func (m *authorityModel) open(ctx context.Context, ref, alias string, fault modelFault) (_ *modelGrant, result error) {
	if !modelValidRef(ref) {
		return nil, modelRefused
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	r := modelRun{m: m, ctx: ctx, ref: ref, fault: fault}
	m.do(func(w *modelWorld) {
		w.Next++
		r.owner = w.Next
		if w.References[ref] != 0 {
			result = modelBusy
			return
		}
		w.References[ref] = r.owner
		w.RefAcquires++
		r.event(w, "acquire:reference")
		// Alias resolution is only an injected observation after reference lease.
		r.dir = w.Aliases[alias]
		if r.dir == "" {
			result = modelRefused
			return
		}
		if w.Directories[r.dir] != 0 {
			result = modelBusy
			return
		}
		w.Directories[r.dir] = r.owner
		w.DirAcquires++
		r.event(w, "acquire:directory")
	})
	defer func() {
		if result != nil {
			r.release()
		}
	}()
	if result != nil {
		return nil, result
	}
	var a modelRecord
	var db modelDB
	var forbidden, recreated bool
	if err := r.step("observe", func(w *modelWorld) {
		a, db = w.VisibleAuthority[ref], w.VisibleDB[r.dir]
		forbidden = w.Legacy[r.dir] || w.Format1[r.dir]
		recreated = w.Recreated[r.dir]
	}); err != nil {
		return nil, err
	}
	if forbidden {
		return nil, modelRefused
	}
	if !a.Present {
		if a != (modelRecord{}) || db.artifacts() {
			return nil, modelRefused
		}
		a = modelRecord{true, true, 2, "PENDING", modelBinding{ref, r.dir, modelUUID, modelKey}}
		m.do(func(w *modelWorld) { w.Generated++ })
		if err := r.publish(a); err != nil {
			return nil, err
		}
	} else {
		if !modelValidRecord(a, ref, r.dir) {
			return nil, modelRefused
		}
		if a.Phase == "PENDING" {
			// Existing visible PENDING is not evidence of prior acknowledgement.
			if err := r.acknowledge(a); err != nil {
				return nil, err
			}
		}
	}
	if a.Phase == "ACTIVE" && (!db.Exists || recreated) {
		return nil, modelRefused
	}
	if a.Phase == "PENDING" && !db.Exists {
		if db.artifacts() {
			return nil, modelRefused
		}
		if err := r.step("db.create", func(w *modelWorld) {
			db = modelDB{Exists: true} // Partial file retained on ambiguous commit.
			w.VisibleDB[r.dir], w.DurableDB[r.dir] = db, db
		}); err != nil {
			return nil, err
		}
		if err := r.step("db.commit", func(w *modelWorld) {
			// Expected schema, binding and zero rows appear in ONE committed image.
			db.Image = modelImage{Schema: true, Auth: true, Binding: a.Binding}
			w.VisibleDB[r.dir], w.DurableDB[r.dir] = db, db
		}); err != nil {
			return nil, err
		}
	}
	var image modelImage
	var reconcileErr error
	if err := r.step("db.reconcile", func(*modelWorld) { image, reconcileErr = db.reconcile() }); err != nil {
		return nil, err
	}
	if reconcileErr != nil || !image.Schema || !image.Auth || image.Binding != a.Binding || image.Rows < 0 {
		return nil, modelRefused
	}
	if a.Phase == "PENDING" && image.Rows != 0 {
		return nil, modelRefused
	}
	m.do(func(w *modelWorld) { r.event(w, "verified:db") })
	if a.Phase == "PENDING" {
		a.Phase = "ACTIVE"
		if err := r.publish(a); err != nil {
			return nil, err
		}
	} else if err := r.acknowledge(a); err != nil {
		return nil, err
	}
	g := &modelGrant{run: r, gate: make(chan struct{}, 1)}
	g.gate <- struct{}{}
	m.do(func(w *modelWorld) { w.Grants++; r.event(w, "grant") })
	return g, nil
}

// A lifetime grant, deliberately NOT secrets.Store. A single opaque slot is
// enough to challenge CRUD ordering. Close joins synchronous grant operations.
type modelGrant struct {
	run    modelRun
	gate   chan struct{}
	closed bool // Owned by gate, never accessed outside it.
}

func (g *modelGrant) close() {
	if g == nil {
		return
	}
	<-g.gate
	defer func() { g.gate <- struct{}{} }()
	if !g.closed {
		g.closed = true
		g.run.release()
	}
}
func (g *modelGrant) secret(ctx context.Context, op, value string, fault modelFault) (string, error) {
	if g == nil {
		return "", modelClosed
	}
	<-g.gate
	defer func() { g.gate <- struct{}{} }()
	if g.closed {
		return "", modelClosed
	}
	r := g.run
	r.ctx, r.fault = ctx, fault
	var output string
	err := r.step("secret."+op, func(w *modelWorld) {
		db := w.VisibleDB[r.dir]
		image, err := db.reconcile()
		if err != nil {
			panic("invalid fixture during granted CRUD")
		}
		switch op {
		case "set":
			image.Rows, image.Value = 1, value
		case "delete":
			image.Rows, image.Value = 0, ""
		case "get":
			output = image.Value
			return
		default:
			panic("unknown model operation")
		}
		db = modelDB{Exists: true, Image: image}
		w.VisibleDB[r.dir], w.DurableDB[r.dir] = db, db
	})
	if err != nil {
		return "", err
	}
	return output, nil
}
