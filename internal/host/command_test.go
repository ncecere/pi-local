package host

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"testing"
	"time"
)

// This disposable Go subprocess is the only real command executed by these
// tests. It never launches desktop utilities or accesses personal state.
func TestOpenerHelper(t *testing.T) {
	args := os.Args
	if len(args) < 3 || args[len(args)-2] != "host-test-helper" {
		return
	}
	switch args[len(args)-1] {
	case "success":
		os.Exit(0)
	case "failure":
		os.Exit(17)
	case "stall":
		time.Sleep(time.Hour)
		os.Exit(0)
	default:
		os.Exit(18)
	}
}

func TestCommandRunnerWaitsReapsAndBoundsCleanup(t *testing.T) {
	for _, mode := range []string{"success", "failure", "stall", "cancelled"} {
		t.Run(mode, func(t *testing.T) {
			var cmd *exec.Cmd
			r := commandRunner{command: func(ctx context.Context, _ string, _ ...string) *exec.Cmd {
				cmd = exec.CommandContext(ctx, os.Args[0], "-test.run=^TestOpenerHelper$", "--", "host-test-helper", mode)
				cmd.Dir = t.TempDir()
				return cmd
			}}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if mode == "stall" {
				var stop context.CancelFunc
				ctx, stop = context.WithTimeout(ctx, 200*time.Millisecond)
				defer stop()
			}
			if mode == "cancelled" {
				cancel()
			}
			start := time.Now()
			err := r.Run(ctx, "never-a-desktop-utility", "ignored")
			if time.Since(start) > 6*time.Second {
				t.Fatal("unbounded helper cleanup")
			}
			if cmd == nil || cmd.WaitDelay <= 0 {
				t.Fatal("missing owned/bounded command")
			}
			switch mode {
			case "success":
				if err != nil || cmd.ProcessState == nil || !cmd.ProcessState.Success() {
					t.Fatalf("helper not successfully reaped: %v", err)
				}
			case "failure":
				var exit *exec.ExitError
				if !errors.As(err, &exit) || cmd.ProcessState == nil || cmd.ProcessState.ExitCode() != 17 {
					t.Fatalf("exit failure hidden or not reaped: %v", err)
				}
			case "stall":
				if !errors.Is(err, context.DeadlineExceeded) || cmd.ProcessState == nil || cmd.ProcessState.Success() {
					t.Fatalf("stalled helper not killed/reaped: %v", err)
				}
			case "cancelled":
				if !errors.Is(err, context.Canceled) || cmd.Process != nil {
					t.Fatalf("cancelled command started: %v", err)
				}
			}
		})
	}
}

func TestCommandRunnerStartFailure(t *testing.T) {
	r := commandRunner{command: func(ctx context.Context, _ string, _ ...string) *exec.Cmd {
		return exec.CommandContext(ctx, "", "not-a-desktop-utility")
	}}
	if err := r.Run(context.Background(), "ignored"); err == nil {
		t.Fatal("start failure reported success")
	}
}
