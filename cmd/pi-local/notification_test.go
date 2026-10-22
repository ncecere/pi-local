package main

import (
	"bytes"
	"context"
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"log/slog"
	"os"
	"os/exec"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/wailsapp/wails/v3/pkg/services/notifications"

	"github.com/ncecere/pi-local/internal/host"
)

type fakeNotifications struct {
	categories                       []notifications.NotificationCategory
	plain, actions                   []notifications.NotificationOptions
	callback                         func(notifications.NotificationResult)
	plainErr, actionErr, categoryErr error
}

func (f *fakeNotifications) RegisterNotificationCategory(c notifications.NotificationCategory) error {
	f.categories = append(f.categories, c)
	return f.categoryErr
}
func (f *fakeNotifications) OnNotificationResponse(cb func(notifications.NotificationResult)) {
	f.callback = cb
}
func (f *fakeNotifications) SendNotification(o notifications.NotificationOptions) error {
	f.plain = append(f.plain, o)
	return f.plainErr
}
func (f *fakeNotifications) SendNotificationWithActions(o notifications.NotificationOptions) error {
	f.actions = append(f.actions, o)
	return f.actionErr
}

func TestNotifierConstructorPolicy(t *testing.T) {
	for _, platform := range []string{"darwin", "windows", "linux", "unknown", ""} {
		for _, transport := range []host.Transport{host.EmbeddedNative, host.DevHTTP, host.Headless, host.Unknown} {
			n := newNotifier(platform, host.HumanConfirmationPolicy(platform, transport))
			want := platform == "darwin" && transport == host.EmbeddedNative
			if n.inlineActions != want || n.platform != platform || n.runHelper == nil {
				t.Fatalf("constructor policy for %s/%s = %v", platform, transport, n.inlineActions)
			}
		}
		if platform != "darwin" && newNotifier(platform, host.HumanPolicy{TrustedHumanConfirmations: true}).inlineActions {
			t.Fatal("platform guard bypassed")
		}
	}
	for _, override := range []string{"", "http://localhost:5173", " "} {
		t.Setenv("FRONTEND_DEVSERVER_URL", override)
		policy := host.DesktopHumanConfirmationPolicy(os.Getenv("FRONTEND_DEVSERVER_URL"))
		n := newNotifier(runtime.GOOS, policy)
		if n.inlineActions != (runtime.GOOS == "darwin" && policy.TrustedHumanConfirmations) || override != "" && n.inlineActions {
			t.Fatal("actual build-aware policy/dev override lost")
		}
	}
}

// Lock production constructor wiring without starting Wails or the application.
func TestNotifierEntrypointWiring(t *testing.T) {
	file, err := parser.ParseFile(token.NewFileSet(), "main.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	selector := func(e ast.Expr, pkg, name string) bool {
		s, ok := e.(*ast.SelectorExpr)
		if !ok {
			return false
		}
		i, ok := s.X.(*ast.Ident)
		return ok && i.Name == pkg && s.Sel.Name == name
	}
	found := false
	ast.Inspect(file, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok {
			return true
		}
		name, ok := call.Fun.(*ast.Ident)
		if !ok || name.Name != "newNotifier" {
			return true
		}
		if len(call.Args) != 2 || !selector(call.Args[0], "runtime", "GOOS") {
			t.Fatal("notifier must use runtime platform")
		}
		policy, ok := call.Args[1].(*ast.CallExpr)
		if !ok || !selector(policy.Fun, "host", "DesktopHumanConfirmationPolicy") || len(policy.Args) != 1 {
			t.Fatal("notifier must use same build-aware policy as setup")
		}
		env, ok := policy.Args[0].(*ast.CallExpr)
		if !ok || !selector(env.Fun, "os", "Getenv") || len(env.Args) != 1 {
			t.Fatal("missing dev override")
		}
		key, ok := env.Args[0].(*ast.BasicLit)
		if !ok || key.Value != `"FRONTEND_DEVSERVER_URL"` {
			t.Fatal("wrong dev override")
		}
		found = true
		return true
	})
	if !found {
		t.Fatal("missing production notifier constructor")
	}
}

func approvalResult(action string) notifications.NotificationResult {
	return notifications.NotificationResult{Response: notifications.NotificationResponse{
		ID: "approval-request", CategoryID: approvalCategory, ActionIdentifier: action,
		UserInfo: map[string]any{"id": "request", "agentId": "agent"},
	}}
}
func confirmResult(action string) notifications.NotificationResult {
	return notifications.NotificationResult{Response: notifications.NotificationResponse{
		ID: "elicitation-request", CategoryID: confirmCategory, ActionIdentifier: action,
		UserInfo: map[string]any{"id": "request", "field": "confirmed"},
	}}
}

func TestNotifierNativeDeliveryAndForgedCallbacks(t *testing.T) {
	for _, mode := range []struct {
		platform  string
		transport host.Transport
	}{
		{"darwin", host.EmbeddedNative}, {"darwin", host.DevHTTP},
		{"darwin", host.Headless}, {"darwin", host.Unknown},
		{"windows", host.EmbeddedNative}, {"linux", host.EmbeddedNative}, {"unknown", host.EmbeddedNative},
	} {
		n := newNotifier(mode.platform, host.HumanConfirmationPolicy(mode.platform, mode.transport))
		allow := n.inlineActions
		f := &fakeNotifications{}
		n.native = f
		n.runHelper = func(context.Context, string, ...string) error { t.Fatal("unexpected helper"); return nil }
		decisions, answers, shows := 0, 0, 0
		n.registerCallbacks(notificationCallbacks{
			decide: func(string, string, bool) error { decisions++; return nil },
			answer: func(string, string, map[string]any) error { answers++; return nil },
			show:   func() { shows++ },
		})
		n.sendWithButtons("approval-request", "title", "body", approvalCategory, map[string]any{"id": "request", "agentId": "agent"})
		if allow {
			if len(f.categories) != 2 || len(f.actions) != 1 || len(f.plain) != 0 {
				t.Fatal("legacy native buttons lost")
			}
			if f.categories[0].ID != approvalCategory || f.categories[1].ID != confirmCategory || len(f.categories[0].Actions) != 2 || len(f.categories[1].Actions) != 2 {
				t.Fatal("unexpected category registration")
			}
			f.callback(approvalResult("approve"))
			f.callback(confirmResult("yes"))
			if decisions != 1 || answers != 1 || shows != 0 {
				t.Fatal("registered legacy dispatch lost")
			}
			decisions, answers = 0, 0
			// Simulate a queued old callback after policy has denied actions.
			n.inlineActions = false
		} else if len(f.categories) != 0 || len(f.actions) != 0 || len(f.plain) != 1 || f.plain[0].CategoryID != "" || f.plain[0].Data != nil {
			t.Fatal("denied mode sent actionable notification")
		}
		for _, result := range []notifications.NotificationResult{approvalResult("approve"), approvalResult("deny"), confirmResult("yes"), confirmResult("decline")} {
			result.Response.UserInfo["Host"] = "localhost"
			result.Response.UserInfo["Origin"] = "wails://localhost"
			result.Response.UserInfo["TrustedHumanConfirmations"] = true
			f.callback(result)
		}
		f.callback(notifications.NotificationResult{Response: notifications.NotificationResponse{ActionIdentifier: notifications.DefaultActionIdentifier}})
		if decisions != 0 || answers != 0 || shows != 5 {
			t.Fatalf("forged/stale callbacks mutated stores: %d/%d/%d", decisions, answers, shows)
		}
	}
}

func TestNotificationLegacyDispatch(t *testing.T) {
	for _, action := range []string{"approve", "deny", "yes", "decline"} {
		t.Run(action, func(t *testing.T) {
			calls := 0
			callbacks := notificationCallbacks{
				show: func() { t.Fatal("valid legacy callback opened UI") },
				decide: func(agent, id string, approve bool) error {
					calls++
					if agent != "agent" || id != "request" || approve != (action == "approve") {
						t.Fatal("wrong decision")
					}
					return nil
				},
				answer: func(id, answer string, content map[string]any) error {
					calls++
					want, data := "decline", map[string]any(nil)
					if action == "yes" {
						want, data = "accept", map[string]any{"confirmed": true}
					}
					if id != "request" || answer != want || !reflect.DeepEqual(content, data) {
						t.Fatal("wrong answer")
					}
					return nil
				},
			}
			result := approvalResult(action)
			if action == "yes" || action == "decline" {
				result = confirmResult(action)
			}
			dispatchNotification(true, result, callbacks)
			if calls != 1 {
				t.Fatal("missing decision")
			}
		})
	}
}

func TestNotificationMalformedAndErrorsOpenUI(t *testing.T) {
	mutations := []struct {
		name   string
		change func(*notifications.NotificationResult)
	}{
		{"sdk-error", func(r *notifications.NotificationResult) { r.Error = errors.New("sensitive body path id") }},
		{"unknown-action", func(r *notifications.NotificationResult) { r.Response.ActionIdentifier = "other" }},
		{"default-action", func(r *notifications.NotificationResult) {
			r.Response.ActionIdentifier = notifications.DefaultActionIdentifier
		}},
		{"nil-data", func(r *notifications.NotificationResult) { r.Response.UserInfo = nil }},
		{"missing-id", func(r *notifications.NotificationResult) { delete(r.Response.UserInfo, "id") }},
		{"wrong-id-type", func(r *notifications.NotificationResult) { r.Response.UserInfo["id"] = 1 }},
		{"blank-id", func(r *notifications.NotificationResult) { r.Response.UserInfo["id"] = " " }},
		{"missing-agent-or-field", func(r *notifications.NotificationResult) {
			delete(r.Response.UserInfo, "agentId")
			delete(r.Response.UserInfo, "field")
		}},
		{"wrong-agent-or-field-type", func(r *notifications.NotificationResult) {
			r.Response.UserInfo["agentId"] = true
			r.Response.UserInfo["field"] = 1
		}},
		{"blank-agent-or-field", func(r *notifications.NotificationResult) {
			r.Response.UserInfo["agentId"] = " "
			r.Response.UserInfo["field"] = " "
		}},
		{"wrong-category", func(r *notifications.NotificationResult) { r.Response.CategoryID = "other" }},
		{"missing-category", func(r *notifications.NotificationResult) { r.Response.CategoryID = "" }},
		{"mismatched-notification-id", func(r *notifications.NotificationResult) { r.Response.ID = "approval-other" }},
		{"missing-notification-id", func(r *notifications.NotificationResult) { r.Response.ID = "" }},
	}
	for _, action := range []string{"approve", "deny", "yes", "decline"} {
		for _, mutation := range mutations {
			t.Run(action+"/"+mutation.name, func(t *testing.T) {
				r := approvalResult(action)
				if action == "yes" || action == "decline" {
					r = confirmResult(action)
				}
				mutation.change(&r)
				shows := 0
				dispatchNotification(true, r, notificationCallbacks{
					show:   func() { shows++ },
					decide: func(string, string, bool) error { t.Fatal("malformed approval mutated"); return nil },
					answer: func(string, string, map[string]any) error { t.Fatal("malformed answer mutated"); return nil },
				})
				if shows != 1 {
					t.Fatal("malformed callback did not open UI")
				}
			})
		}
	}
	for _, r := range []notifications.NotificationResult{approvalResult("approve"), confirmResult("yes")} {
		shows := 0
		cb := notificationCallbacks{show: func() { shows++ }}
		dispatchNotification(true, r, cb) // Missing store wiring must also fail closed.
		cb.decide = func(string, string, bool) error { return errors.New("stale approval") }
		cb.answer = func(string, string, map[string]any) error { return errors.New("stale question") }
		dispatchNotification(true, r, cb)
		if shows != 2 {
			t.Fatal("missing wiring/store error did not open UI")
		}
	}
}

func TestNotificationFallbackPolicyAndArguments(t *testing.T) {
	for _, platform := range []string{"darwin", "windows", "linux", "unknown", ""} {
		for _, nativeMode := range []string{"absent", "success", "failure"} {
			t.Run(platform+"/"+nativeMode, func(t *testing.T) {
				n := newNotifier(platform, host.HumanPolicy{TrustedHumanConfirmations: true})
				if nativeMode != "absent" {
					f := &fakeNotifications{actionErr: errors.New("no actions")}
					if nativeMode == "failure" {
						f.plainErr = errors.New("no plain")
					}
					n.native = f
				}
				calls := 0
				var helperContext context.Context
				n.runHelper = func(ctx context.Context, name string, args ...string) error {
					calls++
					helperContext = ctx
					deadline, ok := ctx.Deadline()
					if !ok || time.Until(deadline) <= 0 || time.Until(deadline) > notificationHelperTimeout {
						t.Fatal("missing bounded deadline")
					}
					if name != "/usr/bin/osascript" || !reflect.DeepEqual(args, []string{"-e", `display notification "say \"hi\" \\ there next" with title "title"`}) {
						t.Fatalf("unexpected helper invocation: %q %q", name, args)
					}
					return errors.New("helper failure with private details")
				}
				n.sendWithButtons("id", "title", "say \"hi\" \\ there\nnext", approvalCategory, map[string]any{"id": "id"})
				want := 0
				if platform == "darwin" && nativeMode != "success" {
					want = 1
				}
				if calls != want {
					t.Fatalf("helper calls = %d, want %d", calls, want)
				}
				if helperContext != nil && !errors.Is(helperContext.Err(), context.Canceled) {
					t.Fatal("helper context not cancelled after return")
				}
			})
		}
	}
}

// Only this test binary is executed; no real notification/helper or profile.
func TestNotificationHelperProcess(t *testing.T) {
	if len(os.Args) < 3 || os.Args[len(os.Args)-2] != "notification-test-helper" {
		return
	}
	switch os.Args[len(os.Args)-1] {
	case "success":
		os.Exit(0)
	case "failure":
		os.Exit(17)
	case "stall":
		time.Sleep(time.Hour)
		os.Exit(0)
	default:
		os.Exit(18)
	}
}

func TestNotificationCommandOwnership(t *testing.T) {
	for _, mode := range []string{"success", "failure", "stall", "cancelled", "start-failure"} {
		t.Run(mode, func(t *testing.T) {
			var cmd *exec.Cmd
			r := notificationCommandRunner{command: func(ctx context.Context, _ string, _ ...string) *exec.Cmd {
				cmd = exec.CommandContext(ctx, os.Args[0], "-test.run=^TestNotificationHelperProcess$", "--", "notification-test-helper", mode)
				cmd.Dir = t.TempDir()
				if mode == "start-failure" {
					cmd = exec.CommandContext(ctx, "")
				}
				return cmd
			}}
			timeout := 5 * time.Second
			if mode == "stall" {
				timeout = 200 * time.Millisecond
			}
			ctx, cancel := context.WithTimeout(context.Background(), timeout)
			defer cancel()
			if mode == "cancelled" {
				cancel()
			}
			start := time.Now()
			err := r.Run(ctx, "never-a-real-notification-helper")
			if time.Since(start) > 6*time.Second || cmd == nil || cmd.WaitDelay != notificationHelperWaitDelay {
				t.Fatal("unbounded helper lifecycle")
			}
			switch mode {
			case "success":
				if err != nil || cmd.ProcessState == nil || !cmd.ProcessState.Success() {
					t.Fatalf("not reaped: %v", err)
				}
			case "failure":
				var exit *exec.ExitError
				if !errors.As(err, &exit) || cmd.ProcessState == nil || cmd.ProcessState.ExitCode() != 17 {
					t.Fatalf("failure lost/not reaped: %v", err)
				}
			case "stall":
				if !errors.Is(err, context.DeadlineExceeded) || cmd.ProcessState == nil || cmd.ProcessState.Success() {
					t.Fatalf("not killed/reaped: %v", err)
				}
			case "cancelled":
				if !errors.Is(err, context.Canceled) || cmd.Process != nil {
					t.Fatalf("cancelled helper started: %v", err)
				}
			case "start-failure":
				if err == nil || cmd.Process != nil {
					t.Fatal("start failure hidden")
				}
			}
		})
	}
}

func TestNotificationDiagnosticsExcludePayload(t *testing.T) {
	var logs bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	defer slog.SetDefault(old)
	secret := "private-title-body-path-id"
	n := newNotifier("darwin", host.HumanPolicy{TrustedHumanConfirmations: true})
	n.native = &fakeNotifications{plainErr: errors.New(secret), actionErr: errors.New(secret), categoryErr: errors.New(secret)}
	n.runHelper = func(context.Context, string, ...string) error { return errors.New(secret) }
	cb := notificationCallbacks{show: func() {}, decide: func(string, string, bool) error { return errors.New(secret) }}
	n.registerCallbacks(cb)
	n.sendWithButtons(secret, secret, secret, approvalCategory, map[string]any{"id": secret})
	dispatchNotification(true, approvalResult("approve"), cb)
	if logs.Len() == 0 || strings.Contains(logs.String(), secret) {
		t.Fatalf("diagnostics leak payload or absent: %s", logs.String())
	}
}
