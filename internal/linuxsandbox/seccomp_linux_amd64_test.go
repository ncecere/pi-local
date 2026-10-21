//go:build linux && amd64

package linuxsandbox

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"runtime"
	"sync"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

type synchronizedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (b *synchronizedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.Write(p)
}
func (b *synchronizedBuffer) String() string { b.mu.Lock(); defer b.mu.Unlock(); return b.b.String() }

func TestNativeFilterSubprocess(t *testing.T) {
	mode := os.Getenv("PI_LOCAL_SANDBOX_FILTER_FIXTURE")
	if mode != "" {
		runtime.LockOSThread()
		if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
			t.Fatal(err)
		}
		if err := applyFilter(); err != nil {
			t.Fatal(err)
		}
		if mode == "x32" {
			_, _, _ = unix.RawSyscall(0x40000000, 0, 0, 0)
			os.Exit(91)
		}
		for _, call := range []struct{ nr, a, b, c uintptr }{{unix.SYS_SOCKET, unix.AF_UNIX, unix.SOCK_STREAM, 0}, {unix.SYS_SOCKET, unix.AF_INET, unix.SOCK_STREAM, 0}, {unix.SYS_UNSHARE, unix.CLONE_NEWUSER, 0, 0}, {unix.SYS_PTRACE, unix.PTRACE_TRACEME, 0, 0}, {unix.SYS_PROCESS_VM_READV, uintptr(os.Getpid()), 0, 0}, {unix.SYS_IO_URING_SETUP, 0, 0, 0}, {unix.SYS_KEYCTL, 0, 0, 0}, {unix.SYS_CLONE3, 0, 0, 0}, {unix.SYS_IOCTL, ^uintptr(0), 0x5412, 0}} {
			_, _, errno := unix.RawSyscall(call.nr, call.a, call.b, call.c)
			if errno != unix.EPERM {
				t.Fatalf("syscall %d returned %v, want explicit EPERM", call.nr, errno)
			}
		}
		pair, err := unix.Socketpair(unix.AF_UNIX, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
		if err != nil {
			t.Fatal(err)
		}
		unix.Close(pair[0])
		unix.Close(pair[1])
		return
	}
	if os.Getenv("PI_LOCAL_SANDBOX_NATIVE_TESTS") != "1" {
		t.Skip("native seccomp not exercised on this worker")
	}
	for _, mode := range []string{"deny", "x32"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestNativeFilterSubprocess$")
			cmd.Env = []string{"PI_LOCAL_SANDBOX_FILTER_FIXTURE=" + mode}
			out, err := cmd.CombinedOutput()
			if mode == "deny" {
				if err != nil {
					t.Fatalf("native syscall gate failed: %v\n%s", err, out)
				}
				return
			}
			exit, ok := err.(*exec.ExitError)
			if !ok {
				t.Fatalf("x32 was not killed: %v %s", err, out)
			}
			status, ok := exit.Sys().(syscall.WaitStatus)
			if !ok || !status.Signaled() || status.Signal() != syscall.SIGSYS {
				t.Fatalf("wrong ABI result: %v %s", status, out)
			}
		})
	}
}
