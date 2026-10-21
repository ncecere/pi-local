/* Test-only Linux x86-64 payload. No headers, libc, loader, constructors, or Go
 * runtime. _start's FIRST syscall is getrlimit; no descriptor is opened before
 * a bounded initial inherited-FD scan. Raw getdents64 of /proc/self/fd
 * then covers descriptors above a subsequently lowered RLIMIT_NOFILE.
 * Only a constant success marker is output; every failure is silent.
 * See exec_authority_linux_amd64_test.go for the fixed exit-status contract.
 */
typedef unsigned long u64;
struct limit { u64 soft, hard; } limits;
struct stat64 {
    u64 dev, ino, nlink;
    unsigned mode, uid, gid, pad;
    u64 rdev;
    long size, blksize, blocks;
    u64 atime, atime_ns, mtime, mtime_ns, ctime, ctime_ns, unused[3];
};
_Static_assert(sizeof(struct stat64) == 144, "native stat ABI");
struct identity { u64 dev, ino; } markers[3];
struct stat64 supplied_stdio[3];

__asm__(".text\n.global _start\n.type _start,@function\n_start:\n"
        "mov %rsp,%r12\nmov $97,%rax\nmov $7,%rdi\n"
        "lea limits(%rip),%rsi\nsyscall\n"
        "mov %r12,%rdi\nmov %rax,%rsi\nand $-16,%rsp\ncall probe\nud2\n"
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
static unsigned length(const char *s) {
    unsigned n = 0;
    while (s[n]) { if (++n > 255) finish(14); }
    return n;
}
static int equal(const char *a, const char *b) {
    unsigned i = 0;
    while (a[i] && a[i] == b[i]) ++i;
    return a[i] == b[i];
}
static int prefix(const char *a, const char *b) {
    unsigned i = 0;
    while (b[i]) { if (a[i] != b[i]) return 0; ++i; }
    return 1;
}
static int numeric(const char *s) {
    unsigned i = 0;
    if (!s[0]) return 0;
    while (s[i]) {
        if (i == 20 || s[i] < '0' || s[i] > '9') return 0;
        ++i;
    }
    return 1;
}
static u64 number(const char *s) {
    u64 n = 0;
    if (!numeric(s)) finish(15);
    for (unsigned i = 0; s[i]; ++i) {
        unsigned d = s[i] - '0';
        if (n > (~(u64)0 - d) / 10) finish(15);
        n = n * 10 + d;
    }
    return n;
}
static void path(char *dst, const char *a, const char *b, const char *c) {
    unsigned n = 0;
    const char *parts[] = {a, b, c};
    for (unsigned p = 0; p < 3; ++p) {
        unsigned len = length(parts[p]);
        if (n + len >= 256) finish(16);
        for (unsigned i = 0; i < len; ++i) dst[n++] = parts[p][i];
    }
    dst[n] = 0;
}
static void deny_write(const char *name, int write_code, int rdwr_code) {
    long fd = raw(2, (long)name, 1 /* O_WRONLY */, 0);
    if (fd >= 0) { raw(3, fd, 0, 0); finish(write_code); }
    if (fd != -13 && fd != -1 && fd != -30) finish(22); /* EACCES/EPERM/EROFS */
    fd = raw(2, (long)name, 2 /* O_RDWR */, 0);
    if (fd >= 0) { raw(3, fd, 0, 0); finish(rdwr_code); }
    if (fd != -13 && fd != -1 && fd != -30) finish(22);
}
/* Return the next validated linux_dirent64 name. No unbounded proc walk. */
static const char *entry(char *buf, long count, long *off) {
    if (*off + 20 > count) finish(32);
    unsigned char *p = (unsigned char *)buf + *off;
    unsigned size = p[16] | ((unsigned)p[17] << 8);
    if (size < 20 || *off + size > count) finish(32);
    unsigned i;
    for (i = 19; i < size && p[i]; ++i) {}
    if (i == size || i - 19 > 20) finish(32);
    *off += size;
    return (const char *)p + 19;
}
static void task_memory(void) {
    long fd = raw(2, (long)"/proc/1/task", 0x90000 /* DIRECTORY|CLOEXEC */, 0);
    if (fd < 0) finish(30);
    unsigned tasks = 0, entries = 0;
    char buf[4096], name[256];
    for (unsigned reads = 0; ; ++reads) {
        if (reads == 128) finish(31);
        long n = raw(217, fd, (long)buf, sizeof(buf));
        if (n < 0 || n > (long)sizeof(buf)) finish(31);
        if (!n) break;
        for (long off = 0; off < n; ) {
            const char *s = entry(buf, n, &off);
            if (++entries > 128) finish(31);
            if (equal(s, ".") || equal(s, "..")) continue;
            if (!numeric(s)) finish(33);
            path(name, "/proc/1/task/", s, "/mem");
            deny_write(name, 35, 36);
            ++tasks;
        }
    }
    raw(3, fd, 0, 0);
    if (!tasks) finish(34);
}
static int pipe_link(const char *s) {
    if (!prefix(s, "pipe:[")) return 0;
    unsigned i = 6, digits = 0;
    while (s[i] >= '0' && s[i] <= '9') { ++i; if (++digits > 20) return 0; }
    return digits && s[i] == ']' && !s[i+1];
}
/* RLIMIT_NOFILE limits future allocation, NOT the numbers of existing FDs.
 * Enumerate our own proc directory before any libc/runtime (there is none).
 * Exclude ONLY the actual FD just opened for this enumeration. */
static void inherited_fd(long fd) {
    long r = raw(72, fd, 1 /* F_GETFD */, 0);
    if (r >= 0) finish(12);
    if (r != -9 /* EBADF */) finish(13);
}
static void inherited_fds(void) {
    long fd = raw(2, (long)"/proc/self/fd", 0x90000, 0);
    if (fd < 0) finish(56);
    char buf[4096];
    unsigned entries = 0, stdio = 0;
    for (unsigned reads = 0; ; ++reads) {
        if (reads == 1024) finish(57);
        long n = raw(217, fd, (long)buf, sizeof(buf));
        if (n < 0 || n > (long)sizeof(buf)) finish(57);
        if (!n) break;
        for (long off = 0; off < n; ) {
            const char *s = entry(buf, n, &off);
            if (++entries > 1048576) finish(57);
            if (equal(s, ".") || equal(s, "..")) continue;
            u64 candidate = number(s);
            if (candidate > 2147483647) finish(57);
            if (candidate == (u64)fd) continue;
            if (candidate > 2) inherited_fd(candidate);
            else {
                if (raw(5, candidate, (long)&supplied_stdio[candidate], 0)) finish(58);
                stdio |= 1u << candidate;
            }
        }
    }
    raw(3, fd, 0, 0);
    if (stdio != 7) finish(58);
}
/* Known authority comes from this fixture's supplied target stdio, NOT a
 * snapshot of potentially corrupted PID 1. No class-wide monitor exemption:
 * unrecognized nonstdio FDs refuse admission. Legitimate bwrap monitor roles
 * remain a pending compatibility gate until native admission/source evidence
 * permits an exact inventory; never turn that uncertainty into a false pass. */
static void inspect_init_role(u64 descriptor, const char *link, const struct stat64 *st) {
    if (descriptor > 2) finish(49);
    const struct stat64 *expected = &supplied_stdio[descriptor];
    if (st->dev != expected->dev || st->ino != expected->ino ||
        st->mode != expected->mode || st->rdev != expected->rdev) finish(59);
    if (descriptor == 1) {
        if (!pipe_link(link) || (st->mode & 0170000) != 0010000) finish(51);
    } else {
        if (!equal(link, "/dev/null") || (st->mode & 0170000) != 0020000 ||
            st->rdev != 259) finish(53);
    }
}
static void init_fds(const char *directory, int own_control) {
    long fd = raw(2, (long)directory, 0x90000, 0);
    if (fd < 0) finish(40); /* Lack of evidence is NOT a pass. */
    char buf[4096], name[256], link[256];
    unsigned entries = 0, stdio = 0;
    for (unsigned reads = 0; ; ++reads) {
        if (reads == 128) finish(41);
        long n = raw(217, fd, (long)buf, sizeof(buf));
        if (n < 0 || n > (long)sizeof(buf)) finish(41);
        if (!n) break;
        for (long off = 0; off < n; ) {
            const char *s = entry(buf, n, &off);
            if (++entries > 128) finish(41);
            if (equal(s, ".") || equal(s, "..")) continue;
            if (!numeric(s)) finish(42);
            u64 descriptor = number(s);
            if (own_control && descriptor == (u64)fd) continue;
            path(name, directory, "/", s);
            long size = raw(89, (long)name, (long)link, sizeof(link)-1);
            if (size <= 0 || size >= (long)sizeof(link)-1) finish(43);
            link[size] = 0;
            struct stat64 st;
            if (raw(4, (long)name, (long)&st, 0)) finish(50);
            for (unsigned m = 0; m < 3; ++m)
                if (st.dev == markers[m].dev && st.ino == markers[m].ino) finish(44 + m);
            if (prefix(link, "/memfd:") || prefix(link, "memfd:")) finish(47);
            if ((st.mode & 0170000) == 0040000) finish(48);
            inspect_init_role(descriptor, link, &st);
            stdio |= 1u << descriptor;
        }
    }
    raw(3, fd, 0, 0);
    if (stdio != 7) finish(54); /* Inspect each of 0, 1, 2, not a count. */
}
/* These controls touch only this executable's own synthetic FDs. They never
 * access PID 1, memory, namespaces, personal processes, or real fixture secrets.
 * The high-FD control re-execs the SAME detector with both limits lowered. */
static void self_control(char **argv) {
    if (equal(argv[1], "--high-fd-control")) {
        long fd = raw(2, (long)"/dev/null", 0, 0);
        if (fd < 3 || fd == 100 || raw(33, fd, 100, 0) != 100) finish(60);
        raw(3, fd, 0, 0);
        struct limit lowered = {64, 64};
        if (raw(160, 7, (long)&lowered, 0)) finish(60);
        char *args[] = {argv[0], 0};
        char *env[] = {0};
        raw(59, (long)argv[0], (long)args, (long)env);
        finish(60);
    }
    int pipe_control = equal(argv[1], "--self-pipe-control");
    int event_control = equal(argv[1], "--self-eventfd-control");
    int missing_control = equal(argv[1], "--self-missing-stdio-control");
    if (!pipe_control && !event_control && !missing_control &&
        !equal(argv[1], "--self-stdio-control")) finish(14);
    if (missing_control) raw(3, 2, 0, 0);
    if (pipe_control) {
        int ends[2];
        if (raw(293, (long)ends, 0, 0)) finish(61);
    }
    if (event_control && raw(290, 0, 0, 0) < 0) finish(61);
    init_fds("/proc/self/fd", 1);
    finish(0);
}
__attribute__((noreturn, used)) void probe(u64 *stack, long limit_result) {
    if (limit_result) finish(10);
    u64 bound = limits.soft > limits.hard ? limits.soft : limits.hard;
    if (bound < 3 || bound > 1048576) finish(11); /* No truncated scan. */
    for (u64 fd = 3; fd < bound; ++fd) inherited_fd(fd);
    inherited_fds();
    char **argv = (char **)(stack + 1);
    if (stack[0] == 2) self_control(argv);
    if (stack[0] != 9) finish(14);
    for (unsigned m = 0; m < 3; ++m) {
        markers[m].dev = number(argv[1 + 2*m]);
        markers[m].ino = number(argv[2 + 2*m]);
    }
    /* Before touching PID 1 authority, prove proc names the fixture's new PID
     * namespace, not the host's PID 1 (even if the candidate is broken). Only
     * namespace metadata is inspected here; no host process data is read. */
    struct stat64 self_ns, init_ns;
    if (raw(4, (long)"/proc/self/ns/pid", (long)&self_ns, 0) ||
        raw(4, (long)"/proc/1/ns/pid", (long)&init_ns, 0)) finish(17);
    if ((self_ns.dev == number(argv[7]) && self_ns.ino == number(argv[8])) ||
        self_ns.dev != init_ns.dev || self_ns.ino != init_ns.ino) finish(18);
    if (raw(110, 0, 0, 0) != 1 || raw(39, 0, 0, 0) <= 1) finish(19);
    deny_write("/proc/1/mem", 20, 21);
    task_memory();
    init_fds("/proc/1/fd", 0);
    const char ok[] = "exec-authority-ok\n";
    if (raw(1, 1, (long)ok, sizeof(ok)-1) != (long)sizeof(ok)-1) finish(55);
    finish(0);
}
