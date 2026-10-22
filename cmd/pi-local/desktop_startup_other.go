//go:build !darwin

package main

import (
	"runtime"

	"github.com/ncecere/pi-local/internal/api"
	"github.com/ncecere/pi-local/internal/host"
)

const startupUnsupportedReason = "Launching at login is not supported on this platform."

// Capabilities is static: no home, executable, filesystem, or command probes.
func (desktop) Capabilities() api.DesktopCapabilities {
	return api.DesktopCapabilities{
		api.DesktopLaunchAtLogin: {Available: false, Reason: startupUnsupportedReason},
	}
}

func startupUnsupported() error {
	return &host.UnavailableError{
		Platform:  runtime.GOOS,
		Operation: host.Capability(api.DesktopLaunchAtLogin),
		Reason:    startupUnsupportedReason,
	}
}

func (desktop) LaunchAtLogin() (bool, error) { return false, startupUnsupported() }
func (desktop) SetLaunchAtLogin(bool) error  { return startupUnsupported() }
