//go:build unix

package mcp

import (
	"os/exec"
	"syscall"
)

// ownGroup runs a command (a sign-in, a test probe) in a process group of its own, so cancelling it stops what it
// started too (a local web server waiting for the browser, the MCP server a probe runs).
func ownGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM) }
}
