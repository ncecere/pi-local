package main

import (
	"embed"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
	"github.com/wailsapp/wails/v3/pkg/icons"
)

//go:embed all:frontend/dist
var assets embed.FS

const defaultResultsDir = "/Users/nicholascecere/projects/pai-local/spikes/wails-sse"

var resultsMu sync.Mutex

func modeLabel() string {
	if os.Getenv("SPIKE_LABEL") != "" {
		return os.Getenv("SPIKE_LABEL")
	}
	if os.Getenv("FRONTEND_DEVSERVER_URL") != "" {
		return buildMode + "+vite-devserver"
	}
	return buildMode
}

// mergeResult stores data under results.json[mode][key].
func mergeResult(key string, data any) {
	resultsMu.Lock()
	defer resultsMu.Unlock()
	dir := os.Getenv("SPIKE_RESULTS_DIR")
	if dir == "" {
		dir = defaultResultsDir
	}
	path := filepath.Join(dir, "results.json")
	all := map[string]map[string]any{}
	if b, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(b, &all)
	}
	m := modeLabel()
	if all[m] == nil {
		all[m] = map[string]any{}
	}
	all[m][key] = data
	all[m]["updatedAt"] = time.Now().Format(time.RFC3339)
	b, _ := json.MarshalIndent(all, "", "  ")
	if err := os.WriteFile(path, b, 0o644); err != nil {
		log.Printf("[results] write error: %v", err)
		return
	}
	log.Printf("[results] wrote %s[%s][%s]", path, m, key)
}

func main() {
	api := newAPIServer()
	api.loop = startLoopback()
	apiHandler := api.Handler()

	var app *application.App

	app = application.New(application.Options{
		Name:        "wailssse",
		Description: "SSE through the Wails v3 asset server spike",
		Services: []application.Service{
			application.NewService(&GreetService{}),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
			// Mount the plain http.Handler for /api/* in front of the asset server.
			Middleware: func(next http.Handler) http.Handler {
				return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if strings.HasPrefix(r.URL.Path, "/api/") {
						apiHandler.ServeHTTP(w, r)
						return
					}
					next.ServeHTTP(w, r)
				})
			},
		},
		OnShutdown: func() {
			log.Printf("[app] OnShutdown called")
			mergeResult("onShutdownCalled", true)
		},
		PostShutdown: func() { log.Printf("[app] PostShutdown called") },
		Mac: application.MacOptions{
			// Keep running when the last window is closed (tray app).
			ApplicationShouldTerminateAfterLastWindowClosed: false,
		},
	})

	// Fallback (b1): Wails events. Emit a tick every 250ms for dur ms.
	api.onEvent = func(id string, dur int) {
		end := time.Now().Add(time.Duration(dur) * time.Millisecond)
		n := 0
		for time.Now().Before(end) {
			time.Sleep(250 * time.Millisecond)
			n++
			app.Event.Emit("tick", map[string]any{"id": id, "n": n, "t": time.Now().UnixMilli()})
		}
		app.Event.Emit("tick", map[string]any{"id": id, "done": true, "t": time.Now().UnixMilli()})
		log.Printf("[events %s] emitted %d ticks", id, n)
	}

	// Fallback (b2): Wails v3 Streams (beta.22 feature).
	app.HandleStream("ticks", func(c *application.StreamConn) {
		defer c.Close()
		log.Printf("[wails-stream] connected")
		tk := time.NewTicker(250 * time.Millisecond)
		defer tk.Stop()
		end := time.After(10 * time.Second)
		n := 0
		for {
			select {
			case <-c.Context().Done():
				log.Printf("[wails-stream] ctx done after %d", n)
				return
			case <-end:
				_ = c.SendJSON(map[string]any{"done": true})
				log.Printf("[wails-stream] sent %d", n)
				// give the frontend a moment to read the final frame
				time.Sleep(500 * time.Millisecond)
				return
			case <-tk.C:
				n++
				if err := c.SendJSON(map[string]any{"n": n, "t": time.Now().UnixMilli()}); err != nil {
					log.Printf("[wails-stream] send err: %v", err)
					return
				}
			}
		}
	})

	window := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:   "main",
		Title:  "wails-sse spike",
		Width:  1000,
		Height: 700,
		URL:    "/",
	})

	// Hide instead of close.
	window.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
		log.Printf("[window] WindowClosing hook -> Hide() + Cancel()")
		window.Hide()
		e.Cancel()
	})

	// Dock icon click re-shows the window.
	app.Event.OnApplicationEvent(events.Mac.ApplicationShouldHandleReopen, func(*application.ApplicationEvent) {
		window.Show()
	})

	// System tray with Open / Quit.
	tray := app.SystemTray.New()
	tray.SetTemplateIcon(icons.SystrayMacTemplate)
	tray.SetTooltip("wails-sse spike")
	openFn := func() { window.Show(); window.Focus() }
	menu := app.NewMenu()
	menu.Add("Open").OnClick(func(*application.Context) { log.Printf("[tray] Open clicked"); openFn() })
	menu.AddSeparator()
	menu.Add("Quit").OnClick(func(*application.Context) { log.Printf("[tray] Quit clicked"); app.Quit() })
	tray.SetMenu(menu)

	// Called when the frontend posts its measurements.
	api.onReport = func(body []byte) {
		var v any
		_ = json.Unmarshal(body, &v)
		mergeResult("frontend", v)
		mergeResult("serverStreams", api.snapshotStreams())
		mergeResult("loopbackSeen", api.loop.Seen())
		log.Printf("[report] %s", truncate(string(body), 4000))
		go postReportChecks(app, window)
	}

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
	log.Printf("[app] Run() returned, exiting")
}

var postOnce sync.Once

// postReportChecks verifies hide-on-close and that the app keeps running, then
// optionally quits (SPIKE_AUTOQUIT=1).
func postReportChecks(app *application.App, window *application.WebviewWindow) {
	postOnce.Do(func() {
		res := map[string]any{}
		time.Sleep(300 * time.Millisecond)
		res["visibleBeforeClose"] = window.IsVisible()
		window.Close() // emits WindowClosing like the red close button does
		time.Sleep(700 * time.Millisecond)
		res["visibleAfterClose"] = window.IsVisible()
		res["windowsAfterClose"] = len(app.Window.GetAll())
		res["appStillRunningAfterClose"] = true // we are still executing inside the app process
		window.Show()
		time.Sleep(700 * time.Millisecond)
		res["visibleAfterShow"] = window.IsVisible()
		log.Printf("[hide-on-close] %v", res)
		mergeResult("hideOnClose", res)
		if os.Getenv("SPIKE_AUTOQUIT") == "1" {
			log.Printf("[app] auto-quit in 2s")
			time.Sleep(2 * time.Second)
			app.Quit()
		}
	})
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "...(truncated)"
}
