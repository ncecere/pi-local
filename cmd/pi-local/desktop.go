package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

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

// Notification categories with buttons (macOS shows them on the notification).
const (
	approvalCategory = "pi-approval"
	confirmCategory  = "pi-confirm"
)

// registerActions sets up the notification buttons, and what a click does: approve or deny a tool call, answer a
// yes/no question, or open the app (a click on the notification itself).
func (n *notifier) registerActions(core *app.App, show func()) {
	if n.native == nil {
		return
	}
	n.native.RegisterNotificationCategory(notifications.NotificationCategory{ID: approvalCategory, Actions: []notifications.NotificationAction{
		{ID: "approve", Title: "Approve"}, {ID: "deny", Title: "Deny", Destructive: true},
	}})
	n.native.RegisterNotificationCategory(notifications.NotificationCategory{ID: confirmCategory, Actions: []notifications.NotificationAction{
		{ID: "yes", Title: "Yes, go ahead"}, {ID: "decline", Title: "Decline", Destructive: true},
	}})
	n.native.OnNotificationResponse(func(result notifications.NotificationResult) {
		if result.Error != nil {
			return
		}
		r := result.Response
		data := r.UserInfo
		str := func(k string) string { s, _ := data[k].(string); return s }
		ctx := context.Background()
		switch r.ActionIdentifier {
		case "approve", "deny":
			if _, err := core.Approvals.Decide(ctx, str("agentId"), str("id"), r.ActionIdentifier == "approve", ""); err != nil {
				slog.Warn("answering an approval from a notification", "err", err)
				show()
			}
		case "yes", "decline":
			action, content := "decline", map[string]any(nil)
			if r.ActionIdentifier == "yes" {
				action, content = "accept", map[string]any{str("field"): true}
			}
			if _, err := core.Elicitations.Answer(str("id"), action, content); err != nil {
				slog.Warn("answering a question from a notification", "err", err)
				show()
			}
		default:
			show()
		}
	})
}

// sendWithButtons shows a notification with a category's buttons (natively; osascript has no buttons).
func (n *notifier) sendWithButtons(id, title, body, category string, data map[string]any) {
	if n.native != nil {
		opts := notifications.NotificationOptions{ID: id, Title: title, Body: body, CategoryID: category, Data: data}
		if err := n.native.SendNotificationWithActions(opts); err == nil {
			return
		}
	}
	n.send(id, title, body)
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
						ID, AgentID, AgentName, Tool, Status string
					} `json:"approval"`
				}
				if json.Unmarshal(ev.Data, &e) == nil && e.Approval.Status == "pending" && away {
					n.sendWithButtons("approval-"+e.Approval.ID, e.Approval.AgentName+" asks first", "It wants to run "+e.Approval.Tool+".", approvalCategory,
						map[string]any{"id": e.Approval.ID, "agentId": e.Approval.AgentID})
				}
				refresh()
			case "elicitation":
				var e struct {
					ID, AgentName, ServerName, State, Message string
					Schema                                    struct {
						Properties map[string]struct{ Type string }
					} `json:"requestedSchema"`
				}
				if json.Unmarshal(ev.Data, &e) == nil && e.State == "pending" && away {
					// A lone yes/no field (a confirmation) can be answered on the notification; anything else opens the app.
					confirmField := ""
					if len(e.Schema.Properties) == 1 {
						for field, p := range e.Schema.Properties {
							if p.Type == "boolean" {
								confirmField = field
							}
						}
					}
					if confirmField != "" {
						n.sendWithButtons("elicitation-"+e.ID, e.ServerName+" asks you", e.Message, confirmCategory, map[string]any{"id": e.ID, "field": confirmField})
					} else {
						n.send("elicitation-"+e.ID, e.ServerName+" asks you", e.AgentName+" is waiting for your answer. Open Pi Local to see the question.")
					}
				}
				refresh()
			case "notification":
				// An agent's notify_person: a system notification when the window isn't in front (the UI toasts).
				var e struct{ AgentID, AgentName, ThreadID, Title, Message string }
				if json.Unmarshal(ev.Data, &e) == nil && away {
					n.send("notify-"+e.AgentID+"-"+strconv.FormatInt(time.Now().UnixMilli(), 10), e.AgentName+": "+e.Title, e.Message)
				}
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
