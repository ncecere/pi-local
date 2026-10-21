//go:build linux && amd64

package linuxsandbox

import (
	"context"
	"os"
	"os/exec"
	"runtime"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

// All potentially mutating negative probes are invalid even without seccomp:
// socketpair gets an invalid output pointer, clone has SIGHAND without VM
// (rejected before task/namespace creation), and ioctl gets an invalid FD.
func threadFilterProbes() int {
	calls := []struct{ nr, a, b, c uintptr }{
		{unix.SYS_SOCKET, unix.AF_INET, unix.SOCK_STREAM, 0},
		{unix.SYS_SOCKETPAIR, unix.AF_INET, unix.SOCK_STREAM, 0},
		{unix.SYS_SOCKETPAIR, unix.AF_UNIX, unix.SOCK_DGRAM, 0},
		{unix.SYS_SOCKETPAIR, unix.AF_UNIX, unix.SOCK_SEQPACKET, 0},
		{unix.SYS_SOCKETPAIR, unix.AF_UNIX, unix.SOCK_STREAM, 1},
		{unix.SYS_SOCKETPAIR, unix.AF_UNIX, unix.SOCK_STREAM | 0x40000000, 0},
		{unix.SYS_IOCTL, ^uintptr(0), unix.TIOCSTI, 0},
		{unix.SYS_IOCTL, ^uintptr(0), uintptr(1)<<32 | unix.TCGETS, 0},
	}
	for _, flag := range []uintptr{
		unix.CLONE_NEWTIME, unix.CLONE_NEWNS, unix.CLONE_NEWCGROUP,
		unix.CLONE_NEWUTS, unix.CLONE_NEWIPC, unix.CLONE_NEWUSER,
		unix.CLONE_NEWPID, unix.CLONE_NEWNET, unix.CLONE_PTRACE,
		unix.CLONE_UNTRACED, uintptr(1) << 32, uintptr(1) << 63,
	} {
		calls = append(calls, struct{ nr, a, b, c uintptr }{unix.SYS_CLONE, flag | unix.CLONE_SIGHAND, 0, 0})
	}
	for i, call := range calls {
		_, _, errno := unix.RawSyscall6(call.nr, call.a, call.b, call.c, 1, 0, 0)
		if errno != unix.EPERM {
			return i + 1 // Fixed probe index only; never syscall output or metadata.
		}
	}
	// Both permitted flag combinations must reach the kernel on EVERY thread.
	for i, flags := range []uintptr{0, unix.SOCK_CLOEXEC | unix.SOCK_NONBLOCK} {
		pair := [2]int32{-1, -1}
		_, _, errno := unix.RawSyscall6(unix.SYS_SOCKETPAIR, unix.AF_UNIX, unix.SOCK_STREAM|flags, 0, uintptr(unsafe.Pointer(&pair)), 0, 0)
		if errno != 0 {
			return 100 + i
		}
		for _, fd := range pair {
			_, _, _ = unix.RawSyscall(unix.SYS_CLOSE, uintptr(fd), 0, 0)
		}
	}
	// An allowed ioctl on an invalid descriptor must NOT be turned into EPERM.
	_, _, errno := unix.RawSyscall(unix.SYS_IOCTL, ^uintptr(0), unix.TCGETS, 0)
	if errno != unix.EBADF {
		return 102
	}
	return 0
}

func TestNativeFilterSynchronizesExistingThreads(t *testing.T) {
	if os.Getenv("PI_LOCAL_SANDBOX_TSYNC_FIXTURE") != "1" {
		if os.Getenv("PI_LOCAL_SANDBOX_NATIVE_TESTS") != "1" {
			t.Skip("native TSYNC not exercised on this worker")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestNativeFilterSynchronizesExistingThreads$")
		cmd.Env = []string{"PI_LOCAL_SANDBOX_TSYNC_FIXTURE=1"}
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("existing-thread TSYNC gate failed: %v\n%s", err, out)
		}
		return
	}
	// The parent test runner never installs a filter. Locked workers remain on
	// distinct pre-existing kernel threads across the installation barrier.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	const workers = 4
	type result struct{ tid, probe int }
	ready := make(chan int, workers)
	installed := make(chan struct{})
	results := make(chan result, workers)
	for i := 0; i < workers; i++ {
		go func() {
			runtime.LockOSThread()
			defer runtime.UnlockOSThread()
			tid, _, _ := unix.RawSyscall(unix.SYS_GETTID, 0, 0, 0)
			ready <- int(tid)
			<-installed
			after, _, _ := unix.RawSyscall(unix.SYS_GETTID, 0, 0, 0)
			probe := threadFilterProbes()
			if after != tid {
				probe = 103
			}
			results <- result{int(tid), probe}
		}()
	}
	installer, _, _ := unix.RawSyscall(unix.SYS_GETTID, 0, 0, 0)
	seen := map[int]bool{int(installer): true}
	for i := 0; i < workers; i++ {
		tid := <-ready
		if tid <= 0 || seen[tid] {
			t.Fatal("workers did not occupy distinct pre-existing OS threads")
		}
		seen[tid] = true
	}
	if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
		t.Fatal(err)
	}
	if err := applyFilter(); err != nil {
		t.Fatal(err)
	}
	close(installed)
	if probe := threadFilterProbes(); probe != 0 {
		t.Fatalf("installer failed fixed syscall probe %d", probe)
	}
	completed := make(map[int]bool)
	for i := 0; i < workers; i++ {
		r := <-results
		if !seen[r.tid] || completed[r.tid] || r.probe != 0 {
			t.Fatalf("existing worker failed fixed syscall probe %d", r.probe)
		}
		completed[r.tid] = true
	}
}
