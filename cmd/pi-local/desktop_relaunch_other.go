//go:build !darwin

package main

// No executable, bundle, filesystem or command probes on unsupported platforms.
// Windows/Linux restart is not implemented; nil hooks retain the manual-restart
// behavior in the updater/API. Even stale hooks must not enable relaunch here.
func wireDesktopRelaunch(relaunch *func(string), restart *func(), _ func()) {
	*relaunch = nil
	*restart = nil
}
