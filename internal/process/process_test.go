package process

import (
	"context"
	"errors"
	"os/exec"
	"path/filepath"
	"testing"
)

type failingOwner struct {
	prepares, closes int
	prepareErr       error
	prepared         func()
}

func (o *failingOwner) prepare(*exec.Cmd) error {
	o.prepares++
	if o.prepared != nil {
		o.prepared()
	}
	return o.prepareErr
}
func (*failingOwner) exited(*exec.Cmd) error       { panic("unexpected child") }
func (*failingOwner) signal(*exec.Cmd, bool) error { panic("unexpected signal") }
func (o *failingOwner) close() error               { o.closes++; return nil }

func TestStartFailures(t *testing.T) {
	for _, mode := range []string{"prepare", "cancel-before", "cancel-after-prepare", "exec"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			o := &failingOwner{}
			switch mode {
			case "prepare":
				o.prepareErr = ErrUnsupported
			case "cancel-before":
				cancel()
			case "cancel-after-prepare":
				o.prepared = cancel
			}
			cmd := exec.Command(filepath.Join(t.TempDir(), "missing-command"))
			if _, err := start(ctx, cmd, o); err == nil {
				t.Fatal("wanted refusal")
			}
			if cmd.Process != nil {
				t.Fatal("child launched on failure")
			}
			want := 1
			if mode == "cancel-before" {
				want = 0
			}
			if o.prepares != want || o.closes != want {
				t.Fatalf("prepare/close = %d/%d", o.prepares, o.closes)
			}
		})
	}
}

func TestRejectCommandContext(t *testing.T) {
	cmd := exec.CommandContext(context.Background(), "unused")
	if _, err := Start(context.Background(), cmd); err == nil || errors.Is(err, ErrUnsupported) {
		t.Fatalf("got %v", err)
	}
	if cmd.Process != nil {
		t.Fatal("launched")
	}
}
