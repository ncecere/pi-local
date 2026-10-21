/* TEST ONLY: disposable standalone-control input preparation, NOT a sandbox,
 * target guard, or confinement proof. No libc/runtime. Never used by PID-1
 * probes. Mark all inherited nonstdio FDs CLOEXEC in THIS process only, then
 * exec the unchanged detector with zero FDs or exactly one explicit FD3.
 * Exit 70 = argument contract; 71 = close_range unavailable/refused;
 * 72 = explicit FD setup failed; 73 = exec failed. No fallback or skip. */
typedef unsigned long u64;
struct stat64 {
    u64 dev, ino, nlink;
    unsigned mode, uid, gid, pad;
    u64 rdev;
    long size, blksize, blocks;
    u64 atime, atime_ns, mtime, mtime_ns, ctime, ctime_ns, unused[3];
};
_Static_assert(sizeof(struct stat64) == 144, "native stat ABI");

__asm__(".text\n.global _start\n.type _start,@function\n_start:\n"
        "mov %rsp,%rdi\nand $-16,%rsp\ncall prepare\nud2\n"
        ".size _start,.-_start\n");

static long raw(long n, long a, long b, long c) {
    long r;
    __asm__ volatile("syscall" : "=a"(r) : "a"(n), "D"(a), "S"(b), "d"(c)
                     : "rcx", "r11", "memory");
    return r;
}
__attribute__((noreturn)) static void finish(int code) {
    raw(60, code, 0, 0);
    __builtin_unreachable();
}
static int bounded(const char *s) {
    for (unsigned i = 0; i < 4096; ++i) if (!s[i]) return i != 0;
    return 0;
}
static int equal(const char *a, const char *b) {
    unsigned i = 0;
    while (a[i] && a[i] == b[i]) ++i;
    return a[i] == b[i];
}
__attribute__((noreturn, used)) void prepare(u64 *stack) {
    /* At most one detector argument, selected from own-FD controls only.
     * No arbitrary detector argv/PID-1 identities or environment forwarding. */
    if (stack[0] != 3 && stack[0] != 4) finish(70);
    char **argv = (char **)(stack + 1);
    for (u64 i = 0; i < stack[0]; ++i) if (!bounded(argv[i])) finish(70);
    if (argv[2][0] != '/') finish(70);
    int keep = equal(argv[1], "keep-fd3");
    int fresh = equal(argv[1], "new-pipe-fd3");
    if (!keep && !fresh && !equal(argv[1], "none")) finish(70);
    if (stack[0] == 4) {
        if (keep || fresh ||
            (!equal(argv[3], "--high-fd-control") &&
             !equal(argv[3], "--self-stdio-control") &&
             !equal(argv[3], "--self-missing-stdio-control") &&
             !equal(argv[3], "--self-pipe-control") &&
             !equal(argv[3], "--self-eventfd-control"))) finish(70);
    }
    if (keep) {
        /* Go supplies ONLY the intentional /dev/null negative at FD3.
         * Reject a missing/wrong-role input rather than preserving ambient FD3. */
        struct stat64 st;
        if (raw(72, 3, 1, 0) != 0 || raw(5, 3, (long)&st, 0) ||
            (st.mode & 0170000) != 0020000 || st.rdev != 259) finish(72);
    }
    if (raw(436, 3, 0xffffffffUL, 4 /* CLOSE_RANGE_CLOEXEC */)) finish(71);
    if (keep && raw(72, 3, 2 /* F_SETFD */, 0)) finish(72);
    if (fresh) {
        /* New authority AFTER preparation must still fail the raw scanner.
         * Both pipe ends start CLOEXEC; only synthetic FD3 is made inheritable. */
        int ends[2];
        if (raw(293, (long)ends, 0x80000 /* O_CLOEXEC */, 0)) finish(72);
        if (ends[0] == 3) {
            if (raw(72, 3, 2, 0)) finish(72);
        } else if (raw(33, ends[0], 3, 0) != 3) finish(72);
    }
    char *args[] = {argv[2], stack[0] == 4 ? argv[3] : (char *)0, 0};
    char *env[] = {0};
    raw(59, (long)argv[2], (long)args, (long)env);
    finish(73);
}
