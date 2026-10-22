package update

import (
	"errors"
	"fmt"
	"runtime"
)

// Availability describes the installer implemented in this build, not a probe of
// the filesystem or a promise that an individual app can be replaced.
type Availability struct {
	Available bool
	Reason    string
}

// InstallationCapability is read-only and side-effect free. Release checking and
// signature verification do not require installation support.
func InstallationCapability() Availability {
	if installationAvailable {
		return Availability{true, "macOS app-bundle installer implemented; an installed app and relaunch hook are still required"}
	}
	return Availability{false, "in-place update installation is only implemented for macOS app bundles"}
}

// ErrUnsupported identifies installation attempts on a build without an installer.
var ErrUnsupported = errors.New("update installation unsupported")

// UnavailableError reports an unsupported build before installation does any I/O.
// Its fields contain build information only, never paths or release metadata.
type UnavailableError struct {
	Platform string
	Reason   string
}

func (e *UnavailableError) Error() string {
	return fmt.Sprintf("update installation on %s: %s: %v", e.Platform, e.Reason, ErrUnsupported)
}
func (e *UnavailableError) Unwrap() error { return ErrUnsupported }

func requireInstallation() error {
	capability := InstallationCapability()
	if !capability.Available {
		return &UnavailableError{Platform: runtime.GOOS, Reason: capability.Reason}
	}
	return nil
}
