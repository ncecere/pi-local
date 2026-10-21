//go:build linux && amd64

package linuxsandbox

import (
	"bytes"
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func runExecAuthorityControl(t *testing.T, executable string, args []string, files []*os.File) (int, []byte) {
	t.Helper()
	// No caller can accidentally supply arbitrary argv/identity lists or an
	// unbounded ExtraFiles table to these standalone-only helpers.
	if len(args) > 4 || len(files) > 2 {
		t.Fatal("standalone control input bound exceeded")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, executable, args...)
	// Explicit stdio: null stdin/stderr, stdout pipe. Never mutate parent FDs.
	var stdout bytes.Buffer
	cmd.Stdout, cmd.ExtraFiles = &stdout, files
	code := 0
	if err := cmd.Run(); err != nil {
		exit, ok := err.(*exec.ExitError)
		if !ok {
			t.Fatal("standalone control execution failed")
		}
		code = exit.ExitCode()
	}
	return code, stdout.Bytes()
}

func checkExecAuthorityControl(t *testing.T, code int, output []byte, want int, stage, fd, kind uint64) {
	t.Helper()
	if code == 71 {
		t.Fatal("standalone launcher close_range(CLOSE_RANGE_CLOEXEC) unavailable or refused; not a skip")
	}
	d, err := decodeExecAuthorityFDDiagnostic(output)
	if code != want {
		// No arbitrary child output, paths, or contents in diagnostics.
		t.Fatalf("same unchanged detector: got assertion %d (%s), want %d; %s",
			code, execAuthorityAssertion(code), want, d.summary(err))
	}
	if code == 12 {
		if err != nil {
			t.Fatal("inherited-FD rejection lacks valid bounded diagnostic")
		}
		if d.stage != stage || d.fd != fd || d.flags != 0 || d.fileType != kind || d.statResult != 0 {
			t.Fatalf("negative control did not reach intended raw detector path: %s", d.summary(nil))
		}
	} else if len(output) != 0 {
		t.Fatal("standalone control produced unexpected output")
	}
}

func checkExecAuthorityLauncherArguments(t *testing.T, launcher, payload string, null, pipe *os.File) {
	t.Helper()
	for _, tc := range []struct {
		name  string
		args  []string
		files []*os.File
		want  int
	}{
		{"no-arguments", nil, nil, 70},
		{"missing-target", []string{"none"}, nil, 70},
		{"invalid-mode", []string{"ignore-142", payload}, nil, 70},
		{"empty-target", []string{"none", ""}, nil, 70},
		{"relative-target", []string{"none", "relative"}, nil, 70},
		{"long-target", []string{"none", "/" + strings.Repeat("x", 4095)}, nil, 70},
		{"long-mode", []string{strings.Repeat("x", 4096), payload}, nil, 70},
		{"unknown-detector-argument", []string{"none", payload, "--not-own-control"}, nil, 70},
		{"too-many-arguments", []string{"none", payload, "--self-stdio-control", "extra"}, nil, 70},
		{"keep-with-detector-argument", []string{"keep-fd3", payload, "--self-stdio-control"}, []*os.File{null}, 70},
		{"fresh-with-detector-argument", []string{"new-pipe-fd3", payload, "--self-stdio-control"}, nil, 70},
		{"keep-wrong-input-role", []string{"keep-fd3", payload}, []*os.File{pipe}, 72},
		{"exec-failure", []string{"none", filepath.Join(t.TempDir(), "absent")}, nil, 73},
	} {
		t.Run("launcher-contract/"+tc.name, func(t *testing.T) {
			code, output := runExecAuthorityControl(t, launcher, tc.args, tc.files)
			checkExecAuthorityControl(t, code, output, tc.want, 0, 0, 0)
		})
	}
}

func checkExecAuthorityParentInputs(t *testing.T, files ...*os.File) {
	t.Helper()
	if len(files) != 3 {
		t.Fatal("parent synthetic FD check input bound")
	}
	for _, file := range files {
		flags, err := unix.FcntlInt(file.Fd(), unix.F_GETFD, 0)
		if err != nil || flags != unix.FD_CLOEXEC {
			t.Fatal("parent synthetic FD CLOEXEC changed or unavailable")
		}
	}
}

type execAuthorityParentFD struct{ flags, fileType uint64 }

// Native opt-in diagnostic of THIS test process only. Read at most 4096 own-FD
// names, retain only numeric metadata, log at most 16 non-CLOEXEC records. No
// readlink, paths, inode identities, contents, other processes, or mutations.
// This is a point-in-time observation, not an atomic inheritance/source proof.
func snapshotExecAuthorityParentFDs(t *testing.T) map[uint64]execAuthorityParentFD {
	t.Helper()
	dir, err := os.Open("/proc/self/fd")
	if err != nil {
		t.Fatal("parent FD snapshot unavailable")
	}
	defer dir.Close()
	enumerationFD := int(dir.Fd())
	found := make(map[uint64]execAuthorityParentFD)
	var inherited []uint64
	entries := 0
	for {
		names, err := dir.Readdirnames(256)
		entries += len(names)
		if entries > 4096 {
			t.Fatal("parent FD snapshot entry bound exceeded")
		}
		for _, name := range names {
			fd, parseErr := strconv.ParseUint(name, 10, 31)
			if parseErr != nil {
				t.Fatal("parent FD snapshot invalid descriptor number")
			}
			if fd < 3 || int(fd) == enumerationFD {
				continue
			}
			flags, flagErr := unix.FcntlInt(uintptr(fd), unix.F_GETFD, 0)
			if flagErr == unix.EBADF {
				continue // Own Go runtime FD may have disappeared during snapshot.
			}
			if flagErr != nil {
				t.Fatal("parent FD snapshot F_GETFD failed")
			}
			var st unix.Stat_t
			if statErr := unix.Fstat(int(fd), &st); statErr != nil {
				if statErr == unix.EBADF {
					continue
				}
				t.Fatal("parent FD snapshot fstat failed")
			}
			found[fd] = execAuthorityParentFD{uint64(flags), uint64(st.Mode & unix.S_IFMT)}
			if flags&unix.FD_CLOEXEC == 0 {
				inherited = append(inherited, fd)
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal("parent FD snapshot enumeration failed")
		}
	}
	sort.Slice(inherited, func(i, j int) bool { return inherited[i] < inherited[j] })
	listed := min(len(inherited), 16)
	t.Logf("parent-before-launch count=%d noncloexec-count=%d listed-count=%d", len(found), len(inherited), listed)
	for _, fd := range inherited[:listed] {
		d := found[fd]
		t.Logf("parent-before-launch fd=%d F_GETFD=%d type=%#o", fd, d.flags, d.fileType)
	}
	return found
}
