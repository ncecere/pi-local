//go:build !windows

package process

import (
	"context"
	"os/exec"
)

func platformStart(ctx context.Context, cmd *exec.Cmd) (Tree, error) {
	return start(ctx, cmd, platformContainment())
}
