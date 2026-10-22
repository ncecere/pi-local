// Pi Local: the desktop app. One window with the chat UI, a menu-bar (tray) icon, and the agents running behind it.
// Closing the window keeps the app (and its agents and schedules) running; Quit in the tray stops every agent
// gracefully, leaving unfinished work in each agent's storage for the next start.
package main

import (
	"context"
	"flag"
	"fmt"
	"html"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
	"github.com/wailsapp/wails/v3/pkg/icons"
	"github.com/wailsapp/wails/v3/pkg/services/notifications"

	"github.com/ncecere/pi-local/frontend"
	"github.com/ncecere/pi-local/internal/app"
	"github.com/ncecere/pi-local/internal/host"
	"github.com/ncecere/pi-local/internal/runtimeenv"
	"github.com/ncecere/pi-local/internal/update"
	runtimebundle "github.com/ncecere/pi-local/runtime"
)

func main() {
	defaultData, _ := app.DefaultDataDir()
	dataDir := flag.String("data", envOr("PI_LOCAL_DATA", defaultData), "data directory")
	hidden := flag.Bool("hidden", false, "start in the menu bar without opening the window (launch at login)")
	flag.Parse()

	ctx := context.Background()
	core, setupErr := setup(ctx, *dataDir)

	var apiHandler http.Handler
	if core != nil {
		apiHandler = core.API.Handler()
	}
	var window *application.WebviewWindow
	var services []application.Service
	note := &notifier{}
	if bundled() {
		// Native notifications need an app bundle; without one (development) they go through osascript.
		note.native = notifications.New()
		services = append(services, application.NewService(note.native))
	}
	wails := application.New(application.Options{
		Services:    services,
		Name:        "Pi Local",
		Description: "Your own Pi Durable agents, on this computer",
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(frontend.Dist),
			Middleware: func(next http.Handler) http.Handler {
				return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if setupErr != nil {
						startupFailure(w, r, setupErr)
						return
					}
					if strings.HasPrefix(r.URL.Path, "/api/") {
						apiHandler.ServeHTTP(w, r)
						return
					}
					next.ServeHTTP(w, r)
				})
			},
		},
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID: "dev.bitop.pi-local",
			OnSecondInstanceLaunch: func(application.SecondInstanceData) {
				if window != nil {
					window.Show()
					window.Focus()
				}
			},
		},
		Mac: application.MacOptions{
			// A tray app: closing the window keeps it running.
			ApplicationShouldTerminateAfterLastWindowClosed: false,
		},
		// app.Run doesn't return after Quit (Wails beta.22): everything is stopped here.
		OnShutdown: func() {
			if core != nil {
				slog.Info("quitting: stopping agents gracefully")
				core.Close()
			}
		},
	})

	window = wails.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:             "main",
		Title:            "Pi Local",
		Width:            1200,
		Height:           800,
		MinWidth:         420,
		MinHeight:        480,
		URL:              "/?shell=desktop-mac",
		Hidden:           *hidden,
		BackgroundColour: application.NewRGB(10, 10, 10),
		Mac: application.MacWindow{
			TitleBar:                application.MacTitleBarHiddenInset,
			InvisibleTitleBarHeight: 40,
		},
	})
	// Closing the window hides it; the app keeps running in the menu bar.
	window.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
		window.Hide()
		e.Cancel()
	})
	show := func() {
		window.Show()
		window.Focus()
	}
	wails.Event.OnApplicationEvent(events.Mac.ApplicationShouldHandleReopen, func(*application.ApplicationEvent) { show() })

	tray := wails.SystemTray.New()
	tray.SetTemplateIcon(icons.SystrayMacTemplate)
	tray.SetTooltip("Pi Local")
	menu := wails.NewMenu()
	menu.Add("Open Pi Local").OnClick(func(*application.Context) { show() })
	menu.AddSeparator()
	workingItem := menu.Add("Nothing working").SetEnabled(false)
	needsItem := menu.Add("Nothing needs you").OnClick(func(*application.Context) { show() })
	menu.AddSeparator()
	updateItem := menu.Add("Check for updates…")
	menu.Add("Quit Pi Local").OnClick(func(*application.Context) { wails.Quit() })
	tray.SetMenu(menu)

	if core != nil {
		core.API.Desktop = desktop{dataDir: *dataDir}
		// An installed update: wait for this process to have stopped (its agents included), then open the new app.
		relaunch := func(bundle string) {
			script := fmt.Sprintf("while kill -0 %d 2>/dev/null; do sleep 0.2; done; /usr/bin/open -n %q", os.Getpid(), bundle)
			cmd := exec.Command("/bin/sh", "-c", script)
			cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
			if err := cmd.Start(); err != nil {
				slog.Error("relaunching", "err", err)
				return
			}
			wails.Quit()
		}
		core.Updater.Relaunch = relaunch
		// A restore is applied as the app starts: restart it. (Only an installed app can open itself again; a
		// development build asks the person to quit and open it.)
		if exe, err := os.Executable(); err == nil {
			if bundle := update.BundleOf(exe); bundle != "" {
				core.API.Restart = func() { relaunch(bundle) }
			}
		}
		updateItem.OnClick(func(*application.Context) {
			if st := core.Updater.Status(); st.Available {
				if err := core.Updater.Install(ctx); err != nil {
					slog.Warn("installing the update", "err", err)
				}
				return
			}
			core.Updater.Check(ctx)
			show()
		})
		core.Hub.Publish("update", core.Updater.Status())
		go func() {
			events, _ := core.Hub.Subscribe()
			for ev := range events {
				if ev.Name != "update" {
					continue
				}
				st := core.Updater.Status()
				switch {
				case st.Stage != nil && *st.Stage != "failed":
					updateItem.SetLabel("Updating… (" + *st.Stage + ")")
				case st.Available && st.Latest != nil:
					updateItem.SetLabel("Update to " + st.Latest.Version)
				default:
					updateItem.SetLabel("Check for updates…")
				}
				menu.Update()
			}
		}()
		go core.Updater.AutoChecks(ctx, 30*time.Second, 12*time.Hour)
		note.registerActions(core, show)
		watch(core, window, note, func(working, needsYou int) {
			workingItem.SetLabel(plural(working, "agent working", "agents working", "Nothing working"))
			needsItem.SetLabel(plural(needsYou, "request needs you", "requests need you", "Nothing needs you"))
			menu.Update()
		})
		if note.native != nil {
			go func() {
				if ok, _ := note.native.CheckNotificationAuthorization(); !ok {
					note.native.RequestNotificationAuthorization()
				}
			}()
		}
		core.API.OpenURL = func(u string) error { return wails.Browser.OpenURL(u) }
		core.API.FolderDialog = func(title string) (string, error) {
			return wails.Dialog.OpenFile().SetTitle(title).CanChooseDirectories(true).CanChooseFiles(false).CanCreateDirectories(true).AttachToWindow(window).PromptForSingleSelection()
		}
		core.API.SaveDialog = func(name string) (string, error) {
			dialog := wails.Dialog.SaveFile().SetFilename(name).CanCreateDirectories(true).AttachToWindow(window)
			switch {
			case strings.HasSuffix(name, ".zip"):
				dialog.AddFilter("Zip archive", "*.zip")
			case strings.HasSuffix(name, ".yaml"):
				dialog.AddFilter("Template", "*.yaml")
			case strings.HasSuffix(name, ".json"):
				dialog.AddFilter("JSON", "*.json")
			}
			return dialog.PromptForSingleSelection()
		}
		core.ResumeUnfinished(ctx)
	}
	// A signal (logout, `kill`) quits like the tray's Quit, so agents stop gracefully.
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-signals
		slog.Info("signal received; quitting")
		wails.Quit()
	}()
	if err := wails.Run(); err != nil {
		slog.Error("Pi Local stopped", "err", err)
		os.Exit(1)
	}
}

// setup finds Node and the person's PATH, writes out the runtime bundle, and opens the data directory.
func setup(ctx context.Context, dataDir string) (*app.App, error) {
	// Agents (and later their tools and MCP servers) get the person's own PATH, not a Finder-launched app's.
	path := runtimeenv.LoginPath(ctx)
	os.Setenv("PATH", path)
	node, err := runtimeenv.FindNode(ctx, path, bundledNode())
	if err != nil {
		return nil, err
	}
	rt, err := runtimeenv.WriteBundle(filepath.Join(dataDir, "runtime"), runtimebundle.Script, node)
	if err != nil {
		return nil, fmt.Errorf("writing the agent runtime: %w", err)
	}
	// Build identity denies SDK server/mcp modes; external dev servers and
	// unverified platforms remain denied. This is not API authorization.
	policy := host.DesktopHumanConfirmationPolicy(os.Getenv("FRONTEND_DEVSERVER_URL"))
	core, err := app.New(ctx, app.Config{DataDir: dataDir, Runtime: rt, TrustedHumanConfirmations: policy.TrustedHumanConfirmations})
	if err != nil {
		return nil, err
	}
	slog.Info("Pi Local ready", "data", dataDir, "node", node)
	return core, nil
}

// bundledNode is Node shipped inside the app bundle (Contents/Resources/node), when there is one (Phase 8).
func bundledNode() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	return filepath.Join(filepath.Dir(exe), "..", "Resources", "node")
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// startupFailure explains, in the window, why Pi Local could not start.
func startupFailure(w http.ResponseWriter, r *http.Request, err error) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		fmt.Fprintf(w, `{"error":{"code":"not_started","message":%q}}`, err.Error())
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprintf(w, `<!doctype html><meta charset="utf-8"><title>Pi Local</title>
<body style="font:15px/1.5 -apple-system,system-ui,sans-serif;background:#0a0a0a;color:#e5e5e5;display:grid;place-items:center;min-height:90vh;margin:0">
<main style="max-width:34rem;padding:2rem"><h1 style="font-size:1.25rem">Pi Local couldn't start</h1>
<p style="color:#f5a3a3">%s</p>
<p style="color:#a3a3a3">Fix this and open Pi Local again. If Node.js is missing, install Node %d.%d or newer (for example <code>brew install node</code>).</p></main>`,
		html.EscapeString(err.Error()), runtimeenv.MinNodeMajor, runtimeenv.MinNodeMinor)
}

func plural(n int, one, many, none string) string {
	switch n {
	case 0:
		return none
	case 1:
		return "1 " + one
	default:
		return fmt.Sprintf("%d %s", n, many)
	}
}
