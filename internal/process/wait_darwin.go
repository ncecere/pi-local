package process

import (
	"errors"
	"os/exec"
	"syscall"

	"golang.org/x/sys/unix"
)

// kqueue observes NOTE_EXIT without consuming the child's wait status. A very
// early exit can make registration fail; the child's PID is still pinned because
// the sole cmd.Wait has not run, so reap can clean its group before waiting.
// No other code may wait on this child.
func (*group) exited(cmd *exec.Cmd) error {
	// kqueue has no atomic CLOEXEC constructor on Darwin. Do not let another
	// concurrent exec inherit the observer during the CloseOnExec window.
	syscall.ForkLock.RLock()
	fd, err := unix.Kqueue()
	if err == nil {
		unix.CloseOnExec(fd)
	}
	syscall.ForkLock.RUnlock()
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	events := make([]unix.Kevent_t, 1)
	change := unix.Kevent_t{
		Ident: uint64(cmd.Process.Pid), Filter: unix.EVFILT_PROC,
		Flags: unix.EV_ADD | unix.EV_ONESHOT, Fflags: unix.NOTE_EXIT,
	}
	if _, err := unix.Kevent(fd, []unix.Kevent_t{change}, nil, nil); err != nil {
		return err
	}
	for {
		n, err := unix.Kevent(fd, nil, events, nil)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			return err
		}
		if n > 0 {
			if events[0].Flags&unix.EV_ERROR != 0 {
				return unix.Errno(events[0].Data)
			}
			return nil
		}
	}
}
