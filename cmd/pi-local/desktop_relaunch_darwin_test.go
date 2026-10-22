//go:build darwin

package main

import (
	"errors"
	"os/exec"
	"slices"
	"strings"
	"testing"
	"time"
)

type fakeRelaunchProcess struct {
	startErr    error
	startCalls  int
	waitCalls   chan struct{}
	waitRelease <-chan struct{}
	waitErr     error
}

func (p *fakeRelaunchProcess) Start() error {
	p.startCalls++
	return p.startErr
}

func (p *fakeRelaunchProcess) Wait() error {
	p.waitCalls <- struct{}{}
	if p.waitRelease != nil {
		<-p.waitRelease
	}
	return p.waitErr
}

func awaitRelaunchWait(t *testing.T, p *fakeRelaunchProcess) {
	t.Helper()
	select {
	case <-p.waitCalls:
	case <-time.After(5 * time.Second):
		t.Fatal("started helper was not given to Wait while parent remains alive")
	}
}

func TestMacRelaunchArguments(t *testing.T) {
	bundles := []string{
		"/Applications/Pi Local.app",
		"/Applications/音楽 café.app",
		"/Applications/single' double\" slash\\.app",
		"/Applications/$(not-executed).app",
		"/Applications/`not-executed`.app",
		"/Applications/semicolon;not-executed.app",
		"/Applications/line\nnot-executed.app",
		"/Applications/音楽 ' \" $(not-executed) `not-executed`;\n.app",
	}
	for _, bundle := range bundles {
		for _, hook := range []string{"update", "restore"} {
			t.Run(hook+"/"+bundle, func(t *testing.T) {
				p := &fakeRelaunchProcess{waitCalls: make(chan struct{}, 1)}
				commands, quits, discoveries, pids := 0, 0, 0, 0
				var relaunch func(string)
				var restart func()
				wireMacRelaunch(&relaunch, &restart, macRelaunchDependencies{
					currentBundle: func() string { discoveries++; return bundle },
					pid:           func() int { pids++; return 12345 },
					command: func(name string, args ...string) relaunchProcess {
						commands++
						want := []string{"-c", macRelaunchScript, "pi-local-relaunch", "12345", bundle}
						if name != "/bin/sh" || !slices.Equal(args, want) {
							t.Fatalf("raw argv changed: %q %q", name, args)
						}
						if strings.Contains(args[1], bundle) || strings.Contains(args[1], "12345") {
							t.Fatal("bundle/PID embedded in shell source")
						}
						return p
					},
					quit: func() {
						if p.startCalls != 1 {
							t.Fatal("Quit before successful Start")
						}
						quits++
					},
					startFailed: func(error) { t.Fatal("unexpected start failure") },
				})
				if relaunch == nil || restart == nil || discoveries != 1 || commands != 0 || pids != 0 || quits != 0 {
					t.Fatal("wiring should only discover the installed bundle")
				}
				if hook == "restore" {
					restart()
				} else {
					relaunch(bundle)
				}
				awaitRelaunchWait(t, p)
				if commands != 1 || pids != 1 || quits != 1 || p.startCalls != 1 {
					t.Fatal("relaunch lifecycle changed")
				}
			})
		}
	}
}

func TestMacRelaunchDevelopmentWiring(t *testing.T) {
	var relaunch func(string)
	restart := func() { panic("stale restart") }
	wireMacRelaunch(&relaunch, &restart, macRelaunchDependencies{
		currentBundle: func() string { return "" },
		pid:           func() int { panic("PID probed during wiring") },
		command: func(string, ...string) relaunchProcess {
			panic("command constructed during wiring")
		},
		quit:        func() { panic("quit during wiring") },
		startFailed: func(error) { panic("start failure during wiring") },
	})
	if relaunch == nil || restart != nil {
		t.Fatal("development must retain update hook but not restore restart")
	}
}

func TestMacRelaunchStartFailureKeepsAppAlive(t *testing.T) {
	failure := errors.New("synthetic start failure")
	p := &fakeRelaunchProcess{startErr: failure, waitCalls: make(chan struct{}, 1)}
	failures := 0
	var relaunch func(string)
	var restart func()
	wireMacRelaunch(&relaunch, &restart, macRelaunchDependencies{
		currentBundle: func() string { return "/synthetic/Installed.app" },
		pid:           func() int { return 12345 },
		command:       func(string, ...string) relaunchProcess { return p },
		quit:          func() { t.Fatal("Quit after failed Start") },
		startFailed: func(err error) {
			failures++
			if err != failure {
				t.Fatal("start failure lost")
			}
		},
	})
	restart()
	if failures != 1 || p.startCalls != 1 || len(p.waitCalls) != 0 {
		t.Fatal("failed Start must report once without Wait or Quit")
	}
}

func TestMacRelaunchWaitDoesNotBlockQuit(t *testing.T) {
	release := make(chan struct{})
	defer close(release)
	p := &fakeRelaunchProcess{
		waitCalls: make(chan struct{}, 1), waitRelease: release,
		waitErr: errors.New("synthetic early helper exit"),
	}
	quits := 0
	var relaunch func(string)
	var restart func()
	wireMacRelaunch(&relaunch, &restart, macRelaunchDependencies{
		currentBundle: func() string { return "" },
		pid:           func() int { return 12345 },
		command:       func(string, ...string) relaunchProcess { return p },
		quit:          func() { quits++ },
		startFailed:   func(error) { t.Fatal("unexpected failure") },
	})
	returned := make(chan struct{})
	go func() {
		defer close(returned)
		relaunch("/synthetic/Installed.app")
	}()
	select {
	case <-returned:
	case <-time.After(5 * time.Second):
		t.Fatal("relaunch blocked on the helper")
	}
	awaitRelaunchWait(t, p)
	if quits != 1 {
		t.Fatal("Quit must not wait for the helper waiting for the parent")
	}
}

func TestMacRelaunchDetachedConstruction(t *testing.T) {
	// Construction only: never Start the real shell, open, kill, or Quit.
	cmd := detachedRelaunchCommand("/bin/sh", "-c", macRelaunchScript, "pi-local-relaunch", "12345", "/synthetic/Installed.app").(*exec.Cmd)
	if cmd.SysProcAttr == nil || !cmd.SysProcAttr.Setsid {
		t.Fatal("detached helper semantics lost")
	}
	if cmd.Env != nil || cmd.Dir != "" || cmd.Stdin != nil || cmd.Stdout != nil || cmd.Stderr != nil || len(cmd.ExtraFiles) != 0 || cmd.Process != nil {
		t.Fatal("must not add environment/data/diagnostic handles or start during construction")
	}
	const want = `while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; /usr/bin/open -n "$2"`
	if macRelaunchScript != want {
		t.Fatal("shell source must remain constant with quoted positional arguments, no eval")
	}
}
