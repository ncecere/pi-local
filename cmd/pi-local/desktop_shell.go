package main

// An explicit generic marker replaces any desktop-mac marker stored by an earlier
// session. Only Darwin opts into the existing macOS window-control styling.
func desktopShellURL(platform string) string {
	if platform == "darwin" {
		return "/?shell=desktop-mac"
	}
	return "/?shell=desktop"
}
