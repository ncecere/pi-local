package linuxsandbox

// Native x86-64 Linux only. Numbers are from Linux arch/x86/entry/syscalls/
// syscall_64.tbl. This is an allowlist, not libseccomp's evolving default policy.
// Unknown/new syscalls return EPERM. ABI mismatches (including x32) are killed.
// No mount, namespace, ptrace, process_vm, io_uring, keyring, kernel IPC, socket,
// bpf, perf_event_open, userfaultfd, handle-based open, or module syscalls occur.
// clone3 intentionally returns EPERM, NOT ENOSYS: no native fallback is certified.
var localSyscalls = []uint32{
	0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, // IO, mappings, signals
	17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, // positional/vector IO, pipe, memory
	32, 33, 34, 35, 36, 37, 38, 39, 40, // dup, sleep, timers, pid, sendfile
	57, 58, 59, 60, 61, 62, 63, // fork/vfork/exec/exit/wait/kill/uname
	72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95,
	// fcntl/flock/sync/truncate, directory and file operations (no special nodes)
	96, 97, 98, 99, 100, 102, 104, 107, 108, 109, 110, 111, 112, 115, 118, 120, 121, 124,
	// time, resource query, identity query, session/process groups, sched_yield query
	127, 128, 129, 130, 131, 132, // pending/wait/queue/suspend/sigaltstack/utime
	137, 138, 140, 141, 142, 143, 144, 145, 146, 147, 148, // statfs, priority/scheduler, mlock
	149, 150, 151, 152, // priority query, memory locking
	160,      // setrlimit (namespace-local process only)
	186, 187, // gettid/readahead
	202, 203, 204, // futex, affinity
	217, 218, 219, // getdents64, set_tid_address, restart_syscall
	221, 222, 223, 224, 225, 226, 227, 228, 229, 230, 231, 232, 233, 234,
	// fadvise64, timers, clocks, epoll, tgkill; semtimedop=220 is absent
	235,      // utimes
	247,      // waitid
	257, 258, // openat, mkdirat
	260, 261, 262, 263, 264, 265, 266, 267, 268, 269, 270, 271,
	// fchownat through ppoll (mknodat=259 deliberately absent)
	273, 274, 275, 276, 277, 278, 280, 281, // robust lists, splice, tee, sync, utimens, epoll
	283, 284, 285, 286, 287, // timerfd, eventfd, fallocate
	289, 290, 291, 292, 293, 294, 295, 296, 297,
	// signalfd4, eventfd2, epoll_create1, dup3, pipe2, inotify_init1, preadv/pwritev
	302,      // prlimit64
	306,      // syncfs
	309,      // getcpu
	316, 318, // renameat2, getrandom
	324,           // membarrier
	326, 327, 328, // copy_file_range, preadv2, pwritev2
	332, 334, // statx, rseq
	436, 437, 439, 441, // close_range, openat2, faccessat2, epoll_pwait2
}

const (
	bpfLD   = 0x20
	bpfJEQ  = 0x15
	bpfJSET = 0x45
	bpfAND  = 0x54
	bpfRET  = 0x06
	allow   = 0x7fff0000
	deny    = 0x00050001 // SECCOMP_RET_ERRNO | EPERM
	killABI = 0x80000000 // SECCOMP_RET_KILL_PROCESS
)

type instruction struct {
	Code   uint16
	JT, JF uint8
	K      uint32
}

func stmt(code uint16, k uint32) instruction             { return instruction{Code: code, K: k} }
func jump(code uint16, k uint32, t, f uint8) instruction { return instruction{code, t, f, k} }

func Filter() []instruction {
	out := []instruction{stmt(bpfLD, 4), jump(bpfJEQ, 0xc000003e, 1, 0), stmt(bpfRET, killABI), stmt(bpfLD, 0), jump(bpfJSET, 0x40000000, 0, 1), stmt(bpfRET, killABI)}
	special := func(n uint32, block []instruction) {
		out = append(out, jump(bpfJEQ, n, 0, uint8(len(block))))
		out = append(out, block...)
	}
	// clone: no namespace creation, tracing bypass, or high flags. Fork and
	// thread creation stay in the PID namespace, whose init owns their lifetime.
	special(56, []instruction{stmt(bpfLD, 20), jump(bpfJEQ, 0, 1, 0), stmt(bpfRET, deny), stmt(bpfLD, 16), jump(bpfJSET, 0x7e822080, 0, 1), stmt(bpfRET, deny), stmt(bpfRET, allow)})
	// A socketpair is local to this process tree, never a host/abstract endpoint.
	special(53, []instruction{stmt(bpfLD, 16), jump(bpfJEQ, 1, 1, 0), stmt(bpfRET, deny), stmt(bpfLD, 24), stmt(bpfAND, ^(uint32(0x80000 | 0x800))), jump(bpfJEQ, 1, 1, 0), stmt(bpfRET, deny), stmt(bpfLD, 32), jump(bpfJEQ, 0, 1, 0), stmt(bpfRET, deny), stmt(bpfRET, allow)})
	// Only terminal queries and FIONREAD; no TIOCSTI/TIOCLINUX or device controls.
	special(16, []instruction{stmt(bpfLD, 28), jump(bpfJEQ, 0, 1, 0), stmt(bpfRET, deny), stmt(bpfLD, 24), jump(bpfJEQ, 0x5401, 3, 0), jump(bpfJEQ, 0x5413, 2, 0), jump(bpfJEQ, 0x541b, 1, 0), stmt(bpfRET, deny), stmt(bpfRET, allow)})
	// Native TLS setup/query only (ARCH_SET_FS and ARCH_GET_FS).
	special(158, []instruction{stmt(bpfLD, 16), jump(bpfJEQ, 0x1002, 2, 0), jump(bpfJEQ, 0x1003, 1, 0), stmt(bpfRET, deny), stmt(bpfRET, allow)})
	// Thread names and read-only confinement queries; no privilege/ptracer changes.
	special(157, []instruction{stmt(bpfLD, 16), jump(bpfJEQ, 15, 4, 0), jump(bpfJEQ, 16, 3, 0), jump(bpfJEQ, 21, 2, 0), jump(bpfJEQ, 39, 1, 0), stmt(bpfRET, deny), stmt(bpfRET, allow)})
	for _, n := range localSyscalls {
		out = append(out, jump(bpfJEQ, n, 0, 1), stmt(bpfRET, allow))
	}
	return append(out, stmt(bpfRET, deny))
}
