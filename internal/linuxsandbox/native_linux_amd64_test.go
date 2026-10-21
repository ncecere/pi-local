//go:build linux && amd64

package linuxsandbox

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// TestMain is compiled only into a disposable native test driver. It gives
// native gates a candidate execution path without enabling any production API.
// These private dispatch strings do not exist in cmd/pi-local-sandbox.
func TestMain(m *testing.M) {
	args := os.Args[1:]
	if len(args) > 0 && (args[0] == "fixture-run" || args[0] == "guard") {
		var err error
		if args[0] == "guard" {
			err = guardCandidate(args[1:])
		} else {
			if len(args) < 5 || args[1] != "--policy" || args[3] != "--" {
				err = fail("usage", "invalid fixture invocation")
			} else {
				var p Policy
				p, err = ParsePolicy(args[2])
				if err == nil {
					err = validateArgv(args[4:])
				}
				var env []string
				if err == nil {
					env, err = targetEnvironment(os.Environ(), p)
				}
				if err == nil {
					err = launchCandidate(p, args[4:], env)
				}
			}
		}
		var typed *Error
		if !errors.As(err, &typed) {
			typed = &Error{Code: "setup_failed", Message: "native fixture setup failed"}
		}
		_ = json.NewEncoder(os.Stderr).Encode(typed)
		os.Exit(125)
	}
	os.Exit(m.Run())
}

func TestProductionRemainsDisabled(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "not-executed")
	err := Main([]string{"run", "--policy", policyJSON(fixturePolicy()), "--", "/bin/sh", "-c", "touch " + marker}, nil)
	errorCode(t, err, "engine_unavailable")
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("review-stage production helper executed target")
	}
	errorCode(t, Main([]string{"guard", "9999", "9998"}, nil), "engine_unavailable")
}

func TestSealedHandoff(t *testing.T) {
	fd, err := sealed("fixture", []byte("fixture-only"))
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(fd)
	raw, err := readSealed(fd, 128)
	if err != nil || string(raw) != "fixture-only" {
		t.Fatal("seal roundtrip", err)
	}
	if _, err := unix.Pwrite(fd, []byte("x"), 0); err == nil {
		t.Fatal("sealed data writable")
	}
	if err := unix.Ftruncate(fd, 0); err == nil {
		t.Fatal("sealed data shrinkable")
	}
	if _, err := readSealed(fd, 1); err == nil {
		t.Fatal("handoff bounds ignored")
	}
	fd2, err := unix.MemfdCreate("unsealed-fixture", unix.MFD_CLOEXEC|unix.MFD_ALLOW_SEALING)
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(fd2)
	if _, err := readSealed(fd2, 128); err == nil {
		t.Fatal("unsealed handoff accepted")
	}
}
func TestOpenat2RejectsFixtureSymlinks(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "directory"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "directory"), filepath.Join(root, "alias")); err != nil {
		t.Fatal(err)
	}
	if fd, err := pinned(filepath.Join(root, "alias"), true); err == nil {
		unix.Close(fd)
		t.Fatal("symlink root accepted")
	}
}
func TestManagedPinAndProtectedAliasFixtures(t *testing.T) {
	root := t.TempDir()
	p := fixturePolicy()
	p.Home = root + "/home"
	p.DataDir = p.Home + "/data"
	p.AgentDir = p.DataDir + "/one"
	p.Workspace = p.AgentDir + "/workspace"
	p.TempDir = p.AgentDir + "/temp"
	for _, d := range []string{p.Workspace, p.TempDir} {
		if err := os.MkdirAll(d, 0700); err != nil {
			t.Fatal(err)
		}
	}
	fd, err := pinnedManaged(p, p.Workspace)
	if err != nil {
		errorCode(t, err, "layout_unsupported")
		t.Log("managed pin refused fixture topology; not a confinement pass")
		fd, err = pinned(p.Workspace, true)
		if err != nil {
			t.Fatal(err)
		}
	}
	id, err := fdIdentity(fd)
	unix.Close(fd)
	if err != nil {
		t.Fatal(err)
	}
	if err := checkProtectedAliases(p, []binding{{Writable: true, Identity: id}}); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(p.Workspace, p.Home+"/.ssh"); err != nil {
		t.Fatal(err)
	}
	if err := checkProtectedAliases(p, []binding{{Writable: true, Identity: id}}); err == nil {
		t.Fatal("credential alias accepted")
	}
	if err := os.Chmod(p.Workspace, 0755); err != nil {
		t.Fatal(err)
	}
	if fd, err := pinnedManaged(p, p.Workspace); err == nil {
		unix.Close(fd)
		t.Fatal("non-private managed leaf accepted")
	}
}

func TestGuardRejectsUnsealedOrAbsentHandoff(t *testing.T) {
	if err := guardCandidate([]string{"9999", "9998"}); err == nil {
		t.Fatal("direct guard invocation accepted")
	}
}

type nativeFixture struct {
	helper string
	p      Policy
	root   string
}

func nativeSetup(t *testing.T) nativeFixture {
	t.Helper()
	if os.Getenv("PI_LOCAL_SANDBOX_NATIVE_TESTS") != "1" {
		t.Skip("native confinement NOT exercised; opt in with PI_LOCAL_SANDBOX_NATIVE_TESTS=1")
	}
	root := t.TempDir()
	p := Policy{Version: Version, Home: filepath.Join(root, "home")}
	p.DataDir = p.Home + "/data"
	p.AgentDir = p.DataDir + "/agents/one"
	p.Workspace = p.AgentDir + "/workspace"
	p.TempDir = p.AgentDir + "/temp"
	for _, d := range []string{p.Workspace, p.TempDir, p.Home + "/.ssh", p.DataDir + "/agents/two"} {
		if err := os.MkdirAll(d, 0700); err != nil {
			t.Fatal(err)
		}
	}
	for _, f := range []string{p.Home + "/.ssh/credential", p.DataDir + "/agents/two/credential"} {
		if err := os.WriteFile(f, []byte("fixture-only-protected"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	helper := filepath.Join(root, "helper")
	// Build a static test-only candidate driver in temp. The shipped command
	// remains disabled; no Go module or host policy is changed.
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "go", "test", "-c", "-o", helper, ".")
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("fixture helper build: %v\n%s", err, out)
	}
	f := nativeFixture{helper, p, root}
	// This gate MUST fail (not skip) if an opted-in worker lacks the engine,
	// private mount propagation, user namespaces, or any actual guard invariant.
	out, err := f.run(t, "/bin/sh", "-c", "printf gate-ok")
	if err != nil || string(out) != "gate-ok" {
		t.Fatalf("NATIVE CONFINEMENT UNAVAILABLE (not a pass): %v\n%s", err, out)
	}
	return f
}
func (f nativeFixture) command(ctx context.Context, argv ...string) *exec.Cmd {
	args := append([]string{"fixture-run", "--policy", policyJSON(f.p), "--"}, argv...)
	cmd := exec.CommandContext(ctx, f.helper, args...)
	cmd.Env = []string{"LANG=C", "TOKEN=fixture-target-secret"}
	// No sockets as inherited stdio. Go exec uses /dev/null and pipes here.
	return cmd
}
func (f nativeFixture) run(t *testing.T, argv ...string) ([]byte, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return f.command(ctx, argv...).CombinedOutput()
}
func TestNativeFilesystemAndEnvironment(t *testing.T) {
	f := nativeSetup(t)
	// Exactly one missing-preload warning is expected, from the dynamic target
	// shell. A poisoned dynamic bwrap would emit another; the guard is static.
	script := `set -eu
 test "$TOKEN" = fixture-target-secret
 test "$HOME" = /home/sandbox
 test "$PATH" = /usr/bin:/bin
 test ! -e /sys
 test ! -e "$1/.ssh/credential"
 test ! -e "$2/agents/two/credential"
 test ! -e /etc/shadow
 test ! -e /run/user
 printf written > "$3/result"
 printf temporary > "$TMPDIR/result"
 test ! -e /proc/1/root/etc/shadow
 if printf x > /usr/forbidden 2>/dev/null; then exit 71; fi
 printf confined-ok
 `
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := f.command(ctx, "/bin/sh", "-c", script, "fixture", f.p.Home, f.p.DataDir, f.p.Workspace)
	cmd.Env = append(cmd.Env, "LD_PRELOAD=/fixture-does-not-exist.so", "LD_LIBRARY_PATH=/fixture-does-not-exist", "NODE_OPTIONS=--no-warnings")
	out, err := cmd.CombinedOutput()
	if err != nil || !bytes.Contains(out, []byte("confined-ok")) {
		t.Fatalf("filesystem/env: %v\n%s", err, out)
	}
	if bytes.Count(out, []byte("cannot be preloaded")) != 1 {
		t.Fatalf("loader poison was not target-only: %s", out)
	}
	for _, p := range []string{f.p.Workspace + "/result", f.p.TempDir + "/result"} {
		if _, err := os.Stat(p); err != nil {
			t.Fatal(err)
		}
	}
}
func TestNativeShellAndNodeOffline(t *testing.T) {
	f := nativeSetup(t)
	out, err := f.run(t, "/bin/sh", "-c", "printf benign > result; /bin/cat result")
	if err != nil || !bytes.Contains(out, []byte("benign")) {
		t.Fatalf("shell: %v\n%s", err, out)
	}
	t.Run("node", func(t *testing.T) {
		if _, err := os.Stat("/usr/bin/node"); err != nil {
			t.Skip("Node not installed: no Node capability claim")
		}
		out, err := f.run(t, "/usr/bin/node", "-e", `const fs=require('fs');fs.writeFileSync('node-result','offline');const net=require('net');const s=net.connect({host:'127.0.0.1',port:9});s.on('connect',()=>process.exit(81));s.on('error',()=>console.log('offline-ok'));`)
		if err != nil || !bytes.Contains(out, []byte("offline-ok")) {
			t.Fatalf("Node is NOT certified by this allowlist: %v\n%s", err, out)
		}
	})
}
func TestNativeConcurrentSourceAndDestinationSwaps(t *testing.T) {
	f := nativeSetup(t)
	roots := []string{f.p.Workspace, f.p.TempDir}
	protected := f.p.DataDir + "/agents/two"
	var wg sync.WaitGroup
	stop := make(chan struct{})
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			for _, root := range roots {
				park := root + ".park"
				if os.Rename(root, park) == nil {
					_ = os.Symlink(protected, root)
					_ = os.Remove(root)
					_ = os.Rename(park, root)
				}
			}
		}
	}()
	defer func() {
		close(stop)
		wg.Wait()
		for _, root := range roots {
			if st, err := os.Lstat(root); err == nil && st.Mode()&os.ModeSymlink != 0 {
				_ = os.Remove(root)
			}
			_ = os.Rename(root+".park", root)
		}
	}()
	successes := 0
	for i := 0; i < 20; i++ {
		// Swaps at the other destination must not redirect later setup operations
		// through a writable tree. The only user code runs after guard identity tests.
		out, err := f.run(t, "/bin/sh", "-c", `if test -e credential || test -e "$TMPDIR/credential"; then printf protected-visible; exit 82; fi; printf swap-safe`)
		if bytes.Contains(out, []byte("fixture-only-protected")) || bytes.Contains(out, []byte("protected-visible")) {
			t.Fatalf("protected source exposed: %s", out)
		}
		if err == nil {
			successes++
			if !bytes.Contains(out, []byte("swap-safe")) {
				t.Fatalf("unexpected successful output %s", out)
			}
		}
	}
	t.Logf("%d/20 adversarial attempts safely executed; refusals are expected", successes)
}

// Supervisor is a test-only parent process, not the helper's process strategy.
func TestNativeSupervisorChild(t *testing.T) {
	config := os.Getenv("PI_LOCAL_SANDBOX_FIXTURE_SUPERVISOR")
	if config == "" {
		t.Skip("test-only supervisor child")
	}
	raw, err := os.ReadFile(config)
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Helper string
		Policy Policy
		Script string
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(f.Helper, "fixture-run", "--policy", policyJSON(f.Policy), "--", "/bin/sh", "-c", f.Script)
	cmd.Env = []string{"LANG=C"}
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
}
func descendants(root int) ([]int, error) {
	return fixtureDescendants("/proc", root)
}

// namespacePID reads only fixture process identity, never environment or argv.
func namespacePID(pid int) (int, error) {
	raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
	if err != nil {
		return 0, fmt.Errorf("fixture status unavailable")
	}
	for _, line := range strings.Split(string(raw), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && fields[0] == "NSpid:" {
			n, err := strconv.Atoi(fields[len(fields)-1])
			if err == nil && n > 0 {
				return n, nil
			}
		}
	}
	return 0, fmt.Errorf("fixture namespace identity unavailable")
}
func TestNativeNamespaceCleanup(t *testing.T) {
	f := nativeSetup(t)
	daemon := `if test "$1" != child; then /bin/sh "$0" child & exit 0; fi
while :; do
 parent=0
 while read -r key value tail; do if test "$key" = PPid:; then parent=$value; fi; done < /proc/$$/status
 test "$parent" = 1 && break
done
printf 'escaped-ready %s\n' "$$"
exec /bin/sleep 60
`
	if err := os.WriteFile(f.p.TempDir+"/daemon.sh", []byte(daemon), 0600); err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"kill-bwrap", "kill-calling-parent"} {
		t.Run(mode, func(t *testing.T) {
			// setsid + double-fork leaves the descendant outside the original process
			// group. pidfds below check real namespace teardown, not killpg behavior.
			script := `/usr/bin/setsid /bin/sh "$TMPDIR/daemon.sh" & wait; /bin/sleep 60`
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			cmd := f.command(ctx, "/bin/sh", "-c", script)
			cmd.Env = []string{"LANG=C"}
			if mode == "kill-calling-parent" {
				config := filepath.Join(f.root, "supervisor.json")
				raw, _ := json.Marshal(struct {
					Helper string
					Policy Policy
					Script string
				}{f.helper, f.p, script})
				if err := os.WriteFile(config, raw, 0600); err != nil {
					t.Fatal(err)
				}
				cmd = exec.CommandContext(ctx, os.Args[0], "-test.run=^TestNativeSupervisorChild$")
				cmd.Env = []string{"PI_LOCAL_SANDBOX_FIXTURE_SUPERVISOR=" + config}
			}
			pipe, err := cmd.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			var stderr synchronizedBuffer
			cmd.Stderr = &stderr
			if err := cmd.Start(); err != nil {
				_ = pipe.Close()
				t.Fatal(err)
			}
			owned := ownFixtureCommand(cmd, pipe)
			defer func() {
				if err := owned.close(); err != nil {
					t.Error(err)
				}
			}()
			escapedPID := 0
			select {
			case r := <-owned.ready:
				if r.err != nil || r.pid <= 1 {
					t.Fatal("fixture did not provide escaped descendant readiness")
				}
				escapedPID = r.pid
			case <-ctx.Done():
				t.Fatal("fixture readiness timeout")
			}
			pids, err := descendants(cmd.Process.Pid)
			if err != nil {
				t.Fatal(err)
			}
			if len(pids) < 3 {
				t.Fatal("did not observe minimum escaped namespace tree")
			}
			var handles []int
			escapedCount, initCount := 0, 0
			escapedGroup, escapedSession, initGroup, initSession := 0, 0, 0, 0
			for _, pid := range pids {
				// Retain the handle before ANY identity/session assertion can fail.
				fd, err := retainFixturePIDFD(owned, pid)
				if err != nil {
					t.Fatal(err)
				}
				handles = append(handles, fd)
				nsPID, err := namespacePID(pid)
				if err != nil {
					t.Fatal(err) // Do not silently lose a previously observed child.
				}
				if nsPID == escapedPID || nsPID == 1 {
					group, err := unix.Getpgid(pid)
					if err != nil {
						t.Fatal("fixture process group unavailable")
					}
					session, err := unix.Getsid(pid)
					if err != nil {
						t.Fatal("fixture session unavailable")
					}
					if nsPID == 1 {
						initCount++
						initGroup, initSession = group, session
					} else {
						escapedCount++
						escapedGroup, escapedSession = group, session
					}
				}
			}
			if escapedCount != 1 || initCount != 1 {
				t.Fatal("escaped setsid descendant or namespace init missing from observed pidfd set")
			}
			// Compare with namespace init, NOT the host-side caller: bwrap already
			// creates a session, so comparing only with the caller is insufficient.
			if escapedGroup == initGroup || escapedSession == initSession {
				t.Fatal("escaped descendant did not leave the original sandbox group/session")
			}
			if err := owned.killAndWait(); err != nil {
				t.Fatal(err)
			}
			for _, fd := range handles {
				poll := []unix.PollFd{{Fd: int32(fd), Events: unix.POLLIN}}
				n, err := unix.Poll(poll, 5000)
				if err != nil || n != 1 || poll[0].Revents&unix.POLLIN == 0 {
					t.Fatalf("escaped descendant survived namespace teardown: poll=%v err=%v", poll, err)
				}
			}
		})
	}
}

// Called only for a discovered fixture descendant (or our single owned root in
// fault-injection tests), never an arbitrary host PID.
func retainFixturePIDFD(owned *fixtureCommand, pid int) (int, error) {
	fd, err := unix.PidfdOpen(pid, 0)
	if err != nil {
		return -1, err
	}
	owned.retained = append(owned.retained, func() {
		_ = unix.PidfdSendSignal(fd, unix.SIGKILL, nil, 0)
		_ = unix.Close(fd)
	})
	return fd, nil
}

func TestFixtureCleanupAfterPartialPIDFDCollection(t *testing.T) {
	for _, failure := range []string{"identity-assertion", "collection-error"} {
		t.Run(failure, func(t *testing.T) {
			owned := startCleanupFixture(t)
			var captured []int
			injected := errors.New("injected identity assertion")
			err := func() error {
				defer func() {
					if err := owned.close(); err != nil {
						t.Error(err)
					}
				}()
				for i := 0; i < 2; i++ {
					fd, err := retainFixturePIDFD(owned, owned.cmd.Process.Pid)
					if err != nil {
						return err
					}
					captured = append(captured, fd)
				}
				if failure == "identity-assertion" {
					return injected
				}
				// Invalid PID cannot acquire authority or create untracked descendants.
				_, err := retainFixturePIDFD(owned, -1)
				return err
			}()
			if err == nil || len(captured) != 2 {
				t.Fatalf("fault was not reached: %v", err)
			}
			if failure == "identity-assertion" && !errors.Is(err, injected) {
				t.Fatal(err)
			}
			assertFixtureClosed(t, owned)
			for _, fd := range captured {
				if _, err := unix.FcntlInt(uintptr(fd), unix.F_GETFD, 0); err != unix.EBADF {
					t.Fatalf("partial pidfd collection leaked: %v", err)
				}
			}
		})
	}
}
