// Package process owns a command's containment, single reap, and cleanup.
// Callers must not call cmd.Start, cmd.Wait, or signal cmd.Process themselves.
package process

import (
	"context"
	"errors"
	"os/exec"
	"sync"
	"time"
)

var ErrUnsupported = errors.New("process-tree containment is unsupported on this platform")

// An external reaper violates this package's ownership contract. If the OS
// reports that loss, numeric process/group identities must no longer be used.
var errIdentityLost = errors.New("process: child identity no longer owned")

// Tree owns one launch. Close is mandatory even after Wait, and idempotent.
// A future Windows implementation must retain a non-inherited, kill-on-close
// Job handle until Close, disallow breakaway, and assign before any user code
// runs (never launch first and assign later). Until then Start fails closed.
type Tree interface {
	Wait() error
	Done() <-chan struct{}
	Term() error
	GracefulStop(time.Duration) error
	KillTree() error
	Close() error
}

type Starter func(context.Context, *exec.Cmd) (Tree, error)

type containment interface {
	prepare(*exec.Cmd) error
	// exited observes exit WITHOUT reaping. The leader's PID must stay pinned
	// until signal is retired under tree.mu; cmd.Wait is only called afterward.
	// Other errors force-stop the still-unreaped child; errIdentityLost instead
	// retires all numeric signalling without attempting cleanup.
	exited(*exec.Cmd) error
	signal(*exec.Cmd, bool) error
	close() error
}

type tree struct {
	mu        sync.Mutex
	cmd       *exec.Cmd
	owner     containment
	retired   bool
	done      chan struct{}
	err       error // published by done
	closeOnce sync.Once
	closeErr  error
}

// Start establishes containment before launching. ctx is checked before launch;
// it does not own the running command. Use Watch for a lifetime deadline, or a
// caller's readiness select for a startup-only deadline. Do not use CommandContext:
// its default Cancel kills only the leader, outside this ownership contract.
func Start(ctx context.Context, cmd *exec.Cmd) (Tree, error) {
	return start(ctx, cmd, platformContainment())
}

func start(ctx context.Context, cmd *exec.Cmd, owner containment) (Tree, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if cmd.Cancel != nil {
		return nil, errors.New("process: use exec.Command, not CommandContext")
	}
	if err := owner.prepare(cmd); err != nil {
		owner.close()
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		owner.close()
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		owner.close()
		return nil, err
	}
	t := &tree{cmd: cmd, owner: owner, done: make(chan struct{})}
	go t.reap()
	return t, nil
}

func (t *tree) reap() {
	err := t.owner.exited(t.cmd)
	t.mu.Lock()
	if !errors.Is(err, errIdentityLost) {
		// Start succeeded and the sole Wait has not run: the unreaped leader
		// pins the group identity, even if exit observation failed. Clean up
		// before releasing it; an observer failure force-stops our own child.
		_ = t.owner.signal(t.cmd, true)
	}
	// On ownership loss fail safe: never signal a possibly reused group.
	t.retired = true
	t.mu.Unlock()
	t.err = t.cmd.Wait() // exactly one reap, after retiring every signalling path
	close(t.done)
}

func (t *tree) Done() <-chan struct{} { return t.done }
func (t *tree) Wait() error           { <-t.done; return t.err }

func (t *tree) signal(kill bool) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.retired {
		return nil
	}
	return t.owner.signal(t.cmd, kill)
}

func (t *tree) Term() error     { return t.signal(false) }
func (t *tree) KillTree() error { return t.signal(true) }

// GracefulStop sends TERM to the owned tree, then escalates after grace. It
// waits for the sole reap; callers must bound exec I/O with Cmd.WaitDelay.
func (t *tree) GracefulStop(grace time.Duration) error {
	err := t.Term()
	timer := time.NewTimer(max(grace, 0))
	defer timer.Stop()
	select {
	case <-t.done:
	case <-timer.C:
		err = errors.Join(err, t.KillTree())
		<-t.done
	}
	return err
}

func (t *tree) Close() error {
	t.closeOnce.Do(func() {
		t.closeErr = t.KillTree()
		<-t.done
		t.closeErr = errors.Join(t.closeErr, t.owner.close())
	})
	return t.closeErr
}

// Watch applies lifetime cancellation (MCP commands use stdin for JSON or null,
// not the runtime EOF watchdog). It exits on cancellation or the single reap.
func Watch(ctx context.Context, t Tree, grace time.Duration) {
	go func() {
		select {
		case <-ctx.Done():
			_ = t.GracefulStop(grace)
		case <-t.Done():
		}
	}()
}
