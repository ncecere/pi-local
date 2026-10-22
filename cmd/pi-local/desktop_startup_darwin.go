//go:build darwin

package main

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/ncecere/pi-local/internal/api"
	"github.com/ncecere/pi-local/internal/host"
)

// Capabilities describes implemented operations without probing the filesystem.
func (desktop) Capabilities() api.DesktopCapabilities {
	return api.DesktopCapabilities{
		api.DesktopLaunchAtLogin: host.Availability{Available: true, Reason: "macOS LaunchAgent startup is implemented."},
	}
}

const launchLabel = "dev.bitop.pi-local"

func launchAgentPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "LaunchAgents", launchLabel+".plist")
}

func (desktop) LaunchAtLogin() (bool, error) {
	_, err := os.Stat(launchAgentPath())
	if os.IsNotExist(err) {
		return false, nil
	}
	return err == nil, err
}

// SetLaunchAtLogin writes (or removes) a LaunchAgent that opens Pi Local, hidden in the menu bar, when you log in.
func (d desktop) SetLaunchAtLogin(on bool) error {
	path := launchAgentPath()
	if !on {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	esc := func(s string) string {
		return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(s)
	}
	plist := `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>` + launchLabel + `</string>
	<key>ProgramArguments</key>
	<array>
		<string>` + esc(exe) + `</string>
		<string>-hidden</string>
		<string>-data</string>
		<string>` + esc(d.dataDir) + `</string>
	</array>
	<key>RunAtLoad</key><true/>
	<key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(plist), 0o644)
}
