package main

import (
	"context"
	"fmt"
	"log/slog"
	"os/exec"
	"strings"
	"time"

	"github.com/wailsapp/wails/v3/pkg/services/notifications"

	"github.com/ncecere/pi-local/internal/host"
)

// This narrow interface uses the pinned Wails beta.22 signatures. Tests never
// construct the SDK service (which initializes platform notification machinery).
type nativeNotifications interface {
	RegisterNotificationCategory(notifications.NotificationCategory) error
	OnNotificationResponse(func(notifications.NotificationResult))
	SendNotification(notifications.NotificationOptions) error
	SendNotificationWithActions(notifications.NotificationOptions) error
}

var _ nativeNotifications = (*notifications.NotificationService)(nil)

type notificationHelper func(context.Context, string, ...string) error

// notifier preserves only the legacy Darwin inline decision capability. Native
// delivery/activation is separate from that capability, not proof of a human.
type notifier struct {
	native        nativeNotifications
	platform      string
	inlineActions bool
	runHelper     notificationHelper
}

func newNotifier(platform string, policy host.HumanPolicy) *notifier {
	return &notifier{
		platform: platform, inlineActions: platform == "darwin" && policy.TrustedHumanConfirmations,
		runHelper: notificationCommandRunner{}.Run,
	}
}

const (
	approvalCategory = "pi-approval"
	confirmCategory  = "pi-confirm"
)

type notificationCallbacks struct {
	decide func(agentID, id string, approve bool) error
	answer func(id, action string, content map[string]any) error
	show   func()
}

func (n *notifier) registerCallbacks(callbacks notificationCallbacks) {
	if n.native == nil {
		return
	}
	if n.inlineActions {
		if err := n.native.RegisterNotificationCategory(notifications.NotificationCategory{ID: approvalCategory, Actions: []notifications.NotificationAction{
			{ID: "approve", Title: "Approve"}, {ID: "deny", Title: "Deny", Destructive: true},
		}}); err != nil {
			slog.Warn("registering notification approval category failed")
		}
		if err := n.native.RegisterNotificationCategory(notifications.NotificationCategory{ID: confirmCategory, Actions: []notifications.NotificationAction{
			{ID: "yes", Title: "Yes, go ahead"}, {ID: "decline", Title: "Decline", Destructive: true},
		}}); err != nil {
			slog.Warn("registering notification confirmation category failed")
		}
	}
	n.native.OnNotificationResponse(func(result notifications.NotificationResult) {
		// Recheck at dispatch, including callbacks from old notifications. Payload
		// fields (including anything resembling HTTP headers) cannot grant trust.
		dispatchNotification(n.inlineActions, result, callbacks)
	})
}

// dispatchNotification validates the known legacy payload before any mutation.
// Stale decisions are rejected by the stores and return the person to the UI.
// This is a compatibility boundary, not centralized API authorization.
func dispatchNotification(inlineActions bool, result notifications.NotificationResult, callbacks notificationCallbacks) {
	if !inlineActions || result.Error != nil {
		callbacks.show()
		return
	}
	r := result.Response
	str := func(key string) string { s, _ := r.UserInfo[key].(string); return s }
	id := str("id")
	valid := func(s string) bool { return strings.TrimSpace(s) != "" }
	var err error
	switch r.ActionIdentifier {
	case "approve", "deny":
		if r.CategoryID != approvalCategory || !valid(id) || !valid(str("agentId")) || r.ID != "approval-"+id || callbacks.decide == nil {
			callbacks.show()
			return
		}
		err = callbacks.decide(str("agentId"), id, r.ActionIdentifier == "approve")
	case "yes", "decline":
		if r.CategoryID != confirmCategory || !valid(id) || !valid(str("field")) || r.ID != "elicitation-"+id || callbacks.answer == nil {
			callbacks.show()
			return
		}
		action, content := "decline", map[string]any(nil)
		if r.ActionIdentifier == "yes" {
			action, content = "accept", map[string]any{str("field"): true}
		}
		err = callbacks.answer(id, action, content)
	default:
		callbacks.show()
		return
	}
	if err != nil {
		// Store errors may contain identifiers or supplied content; don't log them.
		slog.Warn("answering notification failed")
		callbacks.show()
	}
}

// AppleScript cannot display buttons. Denied modes always use plain delivery,
// with native UI activation retained where a native service already exists.
func (n *notifier) sendWithButtons(id, title, body, category string, data map[string]any) {
	if n.inlineActions && n.native != nil {
		opts := notifications.NotificationOptions{ID: id, Title: title, Body: body, CategoryID: category, Data: data}
		if err := n.native.SendNotificationWithActions(opts); err == nil {
			return
		}
	}
	n.send(id, title, body)
}

const notificationHelperTimeout = 3 * time.Second
const notificationHelperWaitDelay = time.Second

func (n *notifier) send(id, title, body string) {
	if n.native != nil {
		if err := n.native.SendNotification(notifications.NotificationOptions{ID: id, Title: title, Body: body}); err == nil {
			return
		}
	}
	if n.platform != "darwin" || n.runHelper == nil {
		return
	}
	// The existing watch goroutine waits here; no goroutine is created per send.
	ctx, cancel := context.WithTimeout(context.Background(), notificationHelperTimeout)
	defer cancel()
	script := fmt.Sprintf("display notification %s with title %s", appleString(body), appleString(title))
	if err := n.runHelper(ctx, "/usr/bin/osascript", "-e", script); err != nil {
		slog.Debug("notification helper failed")
	}
}

// Run owns and reaps the short-lived helper. The factory is injectable only for
// synthetic test-binary children; production uses no shell, PATH lookup or pipes.
type notificationCommandRunner struct {
	command func(context.Context, string, ...string) *exec.Cmd
}

func (r notificationCommandRunner) Run(ctx context.Context, name string, args ...string) error {
	command := r.command
	if command == nil {
		command = exec.CommandContext
	}
	cmd := command(ctx, name, args...)
	cmd.WaitDelay = notificationHelperWaitDelay
	err := cmd.Run()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return err
}

// appleString quotes a string for AppleScript.
func appleString(s string) string {
	if len([]rune(s)) > 240 {
		s = string([]rune(s)[:239]) + "…"
	}
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", " ").Replace(s) + `"`
}
