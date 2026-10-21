package process

import (
	"errors"
	"os/exec"

	"golang.org/x/sys/unix"
)

func (*group) exited(cmd *exec.Cmd) error {
	var info unix.Siginfo
	for {
		err := unix.Waitid(unix.P_PID, cmd.Process.Pid, &info, unix.WEXITED|unix.WNOWAIT, nil)
		if errors.Is(err, unix.ECHILD) {
			return errIdentityLost
		}
		if !errors.Is(err, unix.EINTR) {
			return err
		}
	}
}
