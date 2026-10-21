package mcp

import (
	"context"
	"os/exec"
	"time"

	"github.com/ncecere/pi-local/internal/process"
)

// No stdin watchdog here: probes consume JSON and login commands have null stdin.
// Containment (or an explicit unsupported error) must precede every launch.
func startCommand(launch, lifetime context.Context, cmd *exec.Cmd) (process.Tree, error) {
	tree, err := process.Start(launch, cmd)
	if err != nil {
		return nil, err
	}
	process.Watch(lifetime, tree, 500*time.Millisecond)
	return tree, nil
}
