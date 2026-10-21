//go:build !darwin && !linux && !windows

package process

import "os/exec"

// Platforms without a reviewed containment backend fail before launching.
type unsupported struct{}

func platformContainment() containment            { return &unsupported{} }
func (*unsupported) prepare(*exec.Cmd) error      { return ErrUnsupported }
func (*unsupported) exited(*exec.Cmd) error       { return ErrUnsupported }
func (*unsupported) signal(*exec.Cmd, bool) error { return ErrUnsupported }
func (*unsupported) close() error                 { return nil }
