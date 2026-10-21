//go:build darwin || linux

package process

import (
	"errors"
	"os/exec"
	"syscall"
)

type group struct{}

func platformContainment() containment { return &group{} }

func (*group) prepare(cmd *exec.Cmd) error {
	if cmd.SysProcAttr != nil {
		return errors.New("process: containment owns SysProcAttr")
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	return nil
}

func (*group) signal(cmd *exec.Cmd, kill bool) error {
	sig := syscall.SIGTERM
	if kill {
		sig = syscall.SIGKILL
	}
	err := syscall.Kill(-cmd.Process.Pid, sig)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return err
}

// Unix groups have no kill-on-close handle. Signals are retired before reap;
// Close MUST NOT signal a stored numeric PGID afterward. Children that escape
// the group, an unexpected death of this app, or loss of child ownership to an
// external reaper can still orphan descendants. The runtime's stdin EOF watchdog
// remains necessary. A child must never be waited by another caller.
func (*group) close() error { return nil }
