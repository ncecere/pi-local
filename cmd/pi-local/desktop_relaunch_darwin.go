//go:build darwin

package main

import (
	"log/slog"
	"os"
	"os/exec"
	"strconv"
	"syscall"

	"github.com/ncecere/pi-local/internal/update"
)

// Keep source constant: bundle paths are data, never shell syntax. This retains
// the legacy PID-existence wait, not proof of process identity: PID reuse can
// delay it indefinitely, and an early parent death can bypass graceful shutdown.
const macRelaunchScript = `while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; /usr/bin/open -n -- "$2"`

type relaunchProcess interface {
	Start() error
	Wait() error
}

type macRelaunchDependencies struct {
	currentBundle func() string
	pid           func() int
	command       func(string, ...string) relaunchProcess
	quit          func()
	startFailed   func(error)
}

func detachedRelaunchCommand(name string, args ...string) relaunchProcess {
	cmd := exec.Command(name, args...)
	// Deliberately outlive the parent/session; do not use CommandContext or kill
	// this helper on shutdown. No extra environment, data paths or diagnostic IO.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	return cmd
}

func wireDesktopRelaunch(relaunch *func(string), restart *func(), quit func()) {
	wireMacRelaunch(relaunch, restart, macRelaunchDependencies{
		currentBundle: update.CurrentBundle,
		pid:           os.Getpid,
		command:       detachedRelaunchCommand,
		quit:          quit,
		startFailed:   func(err error) { slog.Error("relaunching", "err", err) },
	})
}

func wireMacRelaunch(relaunch *func(string), restart *func(), deps macRelaunchDependencies) {
	launch := func(bundle string) {
		cmd := deps.command("/bin/sh", "-c", macRelaunchScript, "pi-local-relaunch", strconv.Itoa(deps.pid()), bundle)
		if err := cmd.Start(); err != nil {
			deps.startFailed(err)
			return // Preserve the running app when the helper cannot start.
		}
		// Own/reap the child if it exits while we are still alive (including when
		// Quit is delayed). Do not block Quit on a helper waiting for our exit.
		// After parent exit the OS inherits it; this is not PID cleanup or a new
		// helper protocol. Wait errors are not logged with argv/environment.
		go func() { _ = cmd.Wait() }()
		deps.quit()
	}
	*relaunch = launch
	*restart = nil
	// Restore restart is only possible from an installed Mac app. Development
	// builds still ask the person to quit and reopen. Discovery is Darwin-only.
	if bundle := deps.currentBundle(); bundle != "" {
		*restart = func() { launch(bundle) }
	}
}
