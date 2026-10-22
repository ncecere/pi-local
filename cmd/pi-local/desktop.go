package main

import (
	"context"
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/ncecere/pi-local/internal/app"
)

// bundled reports whether this binary runs inside a macOS app bundle (Pi Local.app/Contents/MacOS/…): native
// notifications need one.
func bundled() bool {
	exe, err := os.Executable()
	return err == nil && strings.Contains(exe, ".app/Contents/MacOS/")
}

// registerActions adapts the stores to the independently testable dispatcher.
func (n *notifier) registerActions(core *app.App, show func()) {
	n.registerCallbacks(notificationCallbacks{
		decide: func(agentID, id string, approve bool) error {
			_, err := core.Approvals.Decide(context.Background(), agentID, id, approve, "")
			return err
		},
		answer: func(id, action string, content map[string]any) error {
			_, err := core.Elicitations.Answer(id, action, content)
			return err
		},
		show: show,
	})
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
			case "budget":
				// A budget reached 80% or 100% of its limit (level 0: a budget was changed, nothing to say).
				var e struct {
					Level   int    `json:"level"`
					Message string `json:"message"`
					Status  struct {
						Scope, AgentID, Month string
					} `json:"status"`
				}
				if json.Unmarshal(ev.Data, &e) == nil && e.Level > 0 && away {
					title := "Budget used up"
					if e.Level < 100 {
						title = "Budget nearly used up"
					}
					n.send("budget-"+e.Status.Scope+"-"+e.Status.AgentID+"-"+e.Status.Month+"-"+strconv.Itoa(e.Level), title, e.Message)
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
