# Spike: SSE and /api through the Wails v3 asset server (macOS)

Date: 2026-10-20. Wails CLI and Go module v3.0.0-beta.22, Go 1.26.7 darwin/arm64, macOS 26.6 (WKWebView), Node 22, pnpm 11, Vite 8.3.4, `@wailsio/runtime` 3.0.0-beta.32 (npm "latest").

## TL;DR

**SSE streams incrementally through the Wails v3 asset server on macOS. Nothing is buffered until the handler returns.** This holds for `EventSource` and for `fetch()` + `response.body.getReader()`, in the production build and in `wails3 dev` (with Vite). Arrival latency, measured as client receive time minus the server timestamp, is 0–3 ms. Closing the stream on the client cancels `r.Context()` in Go within one tick, for all three close methods tested. POST bodies work, except `Blob` bodies, which arrive empty (a beta.22 bug).

**Recommendation: (a). Serve `/api` and SSE through the asset server** with a plain `http.Handler` mounted via `AssetOptions.Middleware`. Wails events and the new Wails Streams also work (about 1 ms). Keep them as a fallback, or use them for push-to-all-windows cases. They don't need to be the main transport. Avoid the loopback server: it works, but it needs CORS and adds a local attack surface with no benefit.

## Layout

```
spikes/wails-sse/
  app/                      Wails v3 project (wails3 init -t vanilla-js), hand-edited
    main.go                 app, middleware mount, tray, hide-on-close, Wails events/Streams fallback, results writer
    api.go                  plain http.Handler: /api/ping, /api/stream (SSE), /api/echo, /api/report, ...
    loopback.go             fallback (c): 127.0.0.1:<random> HTTP server (with and without CORS)
    mode_dev.go/mode_prod.go  build-tag label
    frontend/index.html, frontend/src/main.js   auto-running test page, POSTs results to /api/report
  results.json              raw measurements, keyed by mode ("production-binary", "dev-build+vite-devserver")
  run-*.log                 Go-side logs (stream start/complete/CANCELLED lines)
  summarize.py              prints a compact view of results.json
```

## What I ran (exact commands)

```bash
cd ~/projects/pai-local/spikes
~/go/bin/wails3 init -nocolour -n wailssse -t vanilla-js -d wails-sse -productidentifier dev.spike.wailssse
mv wails-sse/wailssse wails-sse/app            # then hand-edited the files listed above
cd wails-sse/app/frontend && pnpm install
# Taskfile.yml: PACKAGE_MANAGER default "npm" -> "pnpm"

cd ~/projects/pai-local/spikes/wails-sse/app
export PATH=$HOME/go/bin:$PATH                  # REQUIRED: the Taskfile calls bare `wails3`
wails3 build                                    # production: go build -tags production -trimpath -ldflags="-w -s"

# production run (auto-runs the tests, writes results.json, hides/re-shows the window, then quits)
SPIKE_AUTOQUIT=1 SPIKE_LABEL=production-binary ./bin/wailssse

# dev mode (Vite dev server on 9245, app built with DEV=true, packaged as bin/wailssse.dev.app)
SPIKE_AUTOQUIT=1 wails3 dev -config ./build/config.yml -port 9245

# real UI interactions on the production binary (no autoquit), via System Events:
osascript -e 'tell application "System Events" to tell (first process whose name is "wailssse") to click (first button of window 1 whose subrole is "AXCloseButton")'
osascript -e '... click menu bar item 1 of menu bar 2'   # tray icon
osascript -e '... click menu item "Open" of menu 1 of menu bar item 1 of menu bar 2'
osascript -e '... click menu item "Quit" of menu 1 of menu bar item 1 of menu bar 2'

python3 ../summarize.py
```

All app runs used the process tool in the background. The page runs the tests on load and POSTs them to `/api/report`, and Go writes them to `results.json`.

## Measured results

Each stream sends one tick every 250 ms for 10 s (40 events). Latency = `Date.now()` at receipt minus server `t` (same machine clock, 1 ms resolution). "Bursts" counts arrival groups separated by more than 100 ms: 40 bursts for 40 events means fully incremental, and 1 burst would mean buffered.

| Test | Prod build: count / bursts / latency p50, p95, max (ms) | Dev (`wails3 dev` + Vite): same |
|---|---|---|
| SSE via `EventSource` (10 s) | 40 / 40 / 0, 2, 3 | 40 / 40 / 0, 1, 1 |
| SSE via `fetch` + `getReader()` (10 s) | 40 / 40 / 0, 1, 1 (42 chunks) | 40 / 40 / 0, 1, 3 (42 chunks) |
| SSE fetch, **no Flush() calls** (3 s) | 12 / 12 / 0, 1, 1 | 12 / 12 / 1, 1, 1 |
| 6 concurrent EventSources + `/api/ping` mid-stream | all 12/12 incremental, max 1; ping 1–3 ms | all incremental, max 1; ping 1 ms |
| Wails events (`app.Event.Emit` → `Events.On`) | 40 / 40 / 1, 1, 1 | 40 / 40 / 1, 1, 2 |
| Wails Streams (`app.HandleStream` → `JSONStream`) | 40 / 40 / 1, 2, 2 | 40 / 40 / 1, 2, 2 |
| Loopback `http://127.0.0.1:<rand>` EventSource with CORS (3 s) | 12 / 12 / 0–1, ≤2, ≤2 | 12 / 12 / 1, 2, 2 |
| Loopback fetch-stream with CORS (3 s) | 12 / 12 / 0, 0–1, ≤1 | 12 / 12 / 1, 3, 3 |

- First tick arrived about 250 ms after open, which is the first tick interval. Headers and the `: open` comment reached the client in 0–4 ms.
- Go side: the `ResponseWriter` is `*assetserver.contentTypeSniffer`. It implements `http.Flusher`, and `http.NewResponseController(w).Flush()` returns nil.
- Dev and prod behave the same for `/api`. In dev mode the page is still served from `wails://localhost:9245/`. Only static assets are reverse-proxied to Vite, and `/api/*` goes straight to the Go handler. `r.Host` is `localhost:9245` in dev and `localhost` in prod.
- `location.origin` is `wails://localhost` (prod) or `wails://localhost:9245` (dev). `isSecureContext` is true. The `Origin` header is empty on same-origin requests.

### Request context cancellation: yes, it propagates

| Client action after about 1.2 s | Go `r.Context()` | Logged |
|---|---|---|
| `es.close()` | cancelled | `REQUEST CONTEXT CANCELLED after 1200ms, 4 events sent (err=context canceled)` |
| `AbortController.abort()` on fetch | cancelled | `... after 1201ms` |
| `reader.cancel()` (no abort) | cancelled | `... after 1201ms` |

The path: WKWebView `stopURLSchemeTask` calls `cancelURLRequest`, which cancels the per-request context (`webview.CancelRequest`). Results were the same in dev and prod.

### POST bodies

| Body type | Bytes received by Go |
|---|---|
| JSON string (72 B), round-trip equal | OK |
| JSON string, 1 MiB, round trip 7–8 ms | OK |
| `ArrayBuffer`, `Uint8Array` | OK |
| `FormData` (multipart), `URLSearchParams` | OK |
| **`Blob`** | **0 bytes (BUG)** |

The `Content-Length` request header is never present, so `r.ContentLength` is 0. Read the body with `io.ReadAll`/a decoder and don't trust `ContentLength`.

### Tray and hide-on-close

Tested on the production binary, run directly from `bin/` and not as a `.app` bundle.

- The tray icon appears in the menu bar (System Events: "status menu"). Its menu items are `Open`, separator, `Quit`.
- Programmatic `window.Close()` runs the `WindowClosing` hook, which calls `Hide()` and `Cancel()`. After that, `IsVisible()` is false, the window count is still 1, and the app keeps running. `Show()` brings it back.
- **Real red close button**: the window disappears, the hook logs, and the process keeps running.
- **Tray → Open** re-shows the window. **Tray → Quit** calls `app.Quit()` and the process exits with code 0.
- `OnShutdown` and `PostShutdown` both run on `app.Quit()`. **`app.Run()` never returns** because `[NSApp terminate:]` ends the process, so code after `Run()` doesn't execute. Put cleanup in `OnShutdown`.

## API snippets that worked (beta.22)

Mount a plain `http.Handler` for `/api/*` in front of the asset server:

```go
apiHandler := api.Handler() // *http.ServeMux with "GET /api/ping", "GET /api/stream", "POST /api/echo", ...

app := application.New(application.Options{
    Name: "wailssse",
    Assets: application.AssetOptions{
        Handler: application.AssetFileServerFS(assets), // embed.FS of frontend/dist (proxies to Vite in dev)
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
    OnShutdown: func() { /* stop runtime, flush DB, etc. */ },
    Mac: application.MacOptions{
        ApplicationShouldTerminateAfterLastWindowClosed: false, // tray app keeps running
    },
})
```

An SSE handler with no special Wails code:

```go
w.Header().Set("Content-Type", "text/event-stream") // set BEFORE first write (see gotchas)
w.Header().Set("Cache-Control", "no-cache")
w.WriteHeader(200)
rc := http.NewResponseController(w)
for {
    select {
    case <-r.Context().Done(): return // fires on es.close()/abort()/reader.cancel()
    case <-ticker.C:
        fmt.Fprintf(w, "event: tick\ndata: %s\n\n", payload)
        _ = rc.Flush()
    }
}
```

Tray, hide on close, and Dock reopen:

```go
window := app.Window.NewWithOptions(application.WebviewWindowOptions{Name: "main", Title: "...", URL: "/"})
window.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
    window.Hide()
    e.Cancel()
})
app.Event.OnApplicationEvent(events.Mac.ApplicationShouldHandleReopen, func(*application.ApplicationEvent) { window.Show() })

tray := app.SystemTray.New()
tray.SetTemplateIcon(icons.SystrayMacTemplate) // github.com/wailsapp/wails/v3/pkg/icons
menu := app.NewMenu()
menu.Add("Open").OnClick(func(*application.Context) { window.Show(); window.Focus() })
menu.AddSeparator()
menu.Add("Quit").OnClick(func(*application.Context) { app.Quit() })
tray.SetMenu(menu)
// Optional (not tested): Mac: application.MacOptions{ActivationPolicy: application.ActivationPolicyAccessory} to drop the Dock icon.
```

Fallbacks, both working:

```go
app.Event.Emit("tick", map[string]any{"n": n, "t": time.Now().UnixMilli()})       // JS: Events.On("tick", ev => ev.data)
app.HandleStream("ticks", func(c *application.StreamConn) { defer c.Close(); c.SendJSON(v); <-c.Context().Done() })
// JS: import {JSONStream} from "@wailsio/runtime"; const s = JSONStream("ticks"); s.onmessage = ev => ev.data
```

## Gotchas and bugs in beta.22

1. **Blob request bodies arrive empty.** `fetch(url, {method: "POST", body: new Blob([...])})` gives Go 0 bytes in dev and prod. WebKit delivers Blob bodies as `HTTPBodyStream`. Wails' `URLSchemeTaskRequestBodyStreamRead` returns 0, which maps to `io.EOF`, when `!stream.hasBytesAvailable` right after open, so the likely cause is reading the stream too early. Strings, `ArrayBuffer`, typed arrays, `FormData`, and `URLSearchParams` all work. Workaround: on the frontend, convert Blob/File to `await blob.arrayBuffer()` before sending. File uploads need this too.
2. **No `Content-Length` on incoming requests**, so `r.ContentLength == 0`.
3. **Writes after cancellation are silently discarded.** `requestContextResponseWriter.Write` returns `(len(buf), nil)` once the context is cancelled. A handler that only checks write errors will never notice the client is gone. Always `select` on `r.Context().Done()`.
4. **The content-type sniffer can hold back up to 512 bytes.** Each response goes through `contentTypeSniffer`, twice. If `Content-Type` is not set before the first write and you never `Flush()`, small chunks stay buffered until 512 bytes accumulate or the handler returns. Setting `Content-Type: text/event-stream` first is enough: the no-Flush test still streamed. Do both anyway.
5. **WebSockets are not supported** through the asset server (`isWebSocket` returns 501). Use SSE or Wails Streams.
6. **`app.Run()` does not return on Quit.** Use `OnShutdown`/`PostShutdown`.
7. **The `@wailsio/runtime` version does not match the Go version.** The template pins `"latest"`, which installed 3.0.0-beta.32 next to Go beta.22. It worked here, but pin it.
8. **Tooling:**
   - The Taskfile shells out to bare `wails3`, so `~/go/bin` must be on `PATH` or `wails3 build` fails with exit 127.
   - `PACKAGE_MANAGER` defaults to npm. Override it in Taskfile vars for pnpm.
   - After the app quits, `wails3 dev` leaves its file watcher running.
   - Killing `wails3 dev` with SIGTERM **left the Vite process (port 9245) orphaned**. I had to kill it by hand.
9. **Dev mode has no TCP server for `/api`.** Opening the Vite URL (`http://127.0.0.1:9245`) in a normal browser won't reach the Go API. Only the Wails webview can, since `/api` lives on the `wails://` scheme. If you want browser-based frontend dev, add a dev-only `http.ListenAndServe` of the same handler plus a Vite `server.proxy`.
10. **Loopback fallback details:**
    - WKWebView allows `fetch`/`EventSource` from `wails://localhost` to `http://127.0.0.1:<port>`. There was no mixed-content block.
    - **CORS is required.** Without `Access-Control-Allow-Origin` the request still reaches the server, but JS gets `TypeError: Load failed`. With `ACAO: *`, fetch, fetch-streaming and EventSource all work with 0–3 ms latency.
    - The cost: a listening socket that any local process or browser tab can call. It would need token auth and Origin checks.

## Recommendation

**(a) Serve `/api/*` and SSE through the Wails asset server via `AssetOptions.Middleware` + a plain `http.Handler`.**

- Streaming is truly incremental: 40 of 40 events arrived separately, at 0–3 ms latency, in dev and prod, with both EventSource and the fetch reader.
- Request-context cancellation works.
- Concurrent long-lived streams don't block other requests, because each request gets its own goroutine (`dispatchWorkers == 0`).
- The existing React code keeps relative `fetch('/api/...')` and `EventSource` URLs unchanged.

Notes for the real app:

- Always set `Content-Type` and `Flush()`, and watch `r.Context().Done()`.
- Convert Blob/File bodies to ArrayBuffer until the Blob bug is fixed.
- Put shutdown logic in `OnShutdown`.
- If you also want to run the frontend in a plain browser during development, expose the same handler on a dev-only loopback port.
- Keep option (b), Wails events or `HandleStream`, as a fallback for future WebKit/Wails regressions or for broadcast-style push. Both measured about 1 ms.
- Option (c), loopback, is not needed.
