//go:build !darwin && !linux

package process

import "os/exec"

// Windows is deliberately unsupported until race-free Job Object ownership can
// be established before user code. No Process.Kill, taskkill, no-op containment,
// or launch-then-assign fallback is acceptable.
type unsupported struct{}

func platformContainment() containment            { return &unsupported{} }
func (*unsupported) prepare(*exec.Cmd) error      { return ErrUnsupported }
func (*unsupported) exited(*exec.Cmd) error       { return ErrUnsupported }
func (*unsupported) signal(*exec.Cmd, bool) error { return ErrUnsupported }
func (*unsupported) close() error                 { return nil }
