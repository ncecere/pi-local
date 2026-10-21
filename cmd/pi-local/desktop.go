package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/services/notifications"

	"github.com/ncecere/pi-local/internal/app"
)

// bundled reports whether this binary runs inside a macOS app bundle (Pi Local.app/Contents/MacOS/…): native
// notifications need one.
func bundled() bool {
	exe, err := os.Executable()
	return err == nil && strings.Contains(exe, ".app/Contents/MacOS/")
}

// notifier shows a notification: natively from a bundled app, through osascript otherwise (development).
type notifier struct {
	native *notifications.NotificationService
}

func (n *notifier) send(id, title, body string) {
	slog.Info("notification", "id", id, "title", title)
	if n.native != nil {
		if err := n.native.SendNotification(notifications.NotificationOptions{ID: id, Title: title, Body: body}); err == nil {
			return
		}
	}
	script := fmt.Sprintf("display notification %s with title %s", appleString(body), appleString(title))
	if err := exec.Command("osascript", "-e", script).Start(); err != nil {
		slog.Debug("notification", "err", err)
	}
}

// appleString quotes a string for AppleScript.
func appleString(s string) string {
	if len([]rune(s)) > 240 {
		s = string([]rune(s)[:239]) + "…"
	}
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", " ").Replace(s) + `"`
}

// watch turns the app's live events into notifications (while the window isn't in front) and keeps the tray's
// status lines current.
func watch(core *app.App, window *application.WebviewWindow, n *notifier, status func(working, needsYou int)) {
	events, unsubscribe := core.Hub.Subscribe()
	_ = unsubscribe
	var mu sync.Mutex
	agentStatus := map[string]string{}
	refresh := func() {
		working := 0
		for _, id := range core.Sup.Awake() {
			if list, err := core.Threads.List(context.Background(), id); err == nil {
				for _, t := range list {
					if t.Busy {
						working++
						break
					}
				}
			}
		}
		pending, _ := core.Approvals.List(context.Background(), false)
		status(working, len(pending)+len(core.Elicitations.Pending()))
	}
	refresh()
	go func() {
		for ev := range events {
			away := !window.IsVisible() || !window.IsFocused()
			switch ev.Name {
			case "approval":
				var e struct {
					Approval struct {
						ID, AgentName, Tool, Status string
					} `json:"approval"`
				}
				if json.Unmarshal(ev.Data, &e) == nil && e.Approval.Status == "pending" && away {
					n.send("approval-"+e.Approval.ID, e.Approval.AgentName+" asks first", "It wants to run "+e.Approval.Tool+". Open Pi Local to approve or deny it.")
				}
				refresh()
			case "elicitation":
				var e struct {
					ID, AgentName, ServerName, State string
				}
				if json.Unmarshal(ev.Data, &e) == nil && e.State == "pending" && away {
					n.send("elicitation-"+e.ID, e.ServerName+" asks you", e.AgentName+" is waiting for your answer. Open Pi Local to see the question.")
				}
				refresh()
			case "schedule_run":
				var e struct {
					Name string `json:"name"`
					Run  struct {
						ID, Status string
						Error      *string `json:"error"`
					} `json:"run"`
				}
				if json.Unmarshal(ev.Data, &e) == nil && away {
					if e.Run.Status == "failed" {
						why := ""
						if e.Run.Error != nil {
							why = *e.Run.Error
						}
						n.send("run-"+e.Run.ID, "Scheduled run failed: "+e.Name, why)
					} else {
						n.send("run-"+e.Run.ID, "Scheduled run finished", e.Name)
					}
				}
			case "agent":
				var e struct {
					AgentID string `json:"agentId"`
					Agent   *struct {
						Name, Status string
						LastError    *string `json:"lastError"`
					} `json:"agent"`
				}
				if json.Unmarshal(ev.Data, &e) != nil || e.Agent == nil {
					continue
				}
				mu.Lock()
				was := agentStatus[e.AgentID]
				agentStatus[e.AgentID] = e.Agent.Status
				mu.Unlock()
				if e.Agent.Status == "error" && was != "error" && away {
					why := ""
					if e.Agent.LastError != nil {
						why = *e.Agent.LastError
					}
					n.send("agent-"+e.AgentID, e.Agent.Name+" ran into a problem", why)
				}
				refresh()
			case "thread":
				refresh()
			}
		}
	}()
}

// --- launch at login ----------------------------------------------------------------------------------------------

const launchLabel = "dev.bitop.pi-local"

func launchAgentPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "LaunchAgents", launchLabel+".plist")
}

// desktop is the desktop app's own settings, for the API.
type desktop struct{ dataDir string }

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
