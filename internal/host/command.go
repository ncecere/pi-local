package host

import (
	"context"
	"fmt"
	"os/exec"
	"time"
)

// commandRunner owns only the short-lived opener helper, not the application
// launched by it. Run waits synchronously, surfacing helper failure rather than
// claiming success on Start. CommandContext kills a stalled helper; Run reaps it.
// WaitDelay also bounds any inherited I/O cleanup. No pipes or shell are used.
type commandRunner struct {
	// command is an isolated helper factory in tests; nil uses exec.CommandContext.
	command func(context.Context, string, ...string) *exec.Cmd
}

func (r commandRunner) Run(ctx context.Context, name string, args ...string) error {
	command := r.command
	if command == nil {
		command = exec.CommandContext
	}
	cmd := command(ctx, name, args...)
	cmd.WaitDelay = time.Second
	err := cmd.Run()
	if ctx.Err() != nil {
		return fmt.Errorf("waiting for opener helper: %w", ctx.Err())
	}
	return err
}
