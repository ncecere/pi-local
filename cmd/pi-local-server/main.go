// pi-local-server runs Pi Local without the desktop shell: the same app and UI API, on a loopback port, serving the
// built frontend. For development in a browser (with `pnpm dev`'s proxy, or the built UI) and browser tests.
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/ncecere/pi-local/internal/app"
	"github.com/ncecere/pi-local/internal/secrets"
	"github.com/ncecere/pi-local/internal/supervisor"
)

func main() {
	defaultData, _ := app.DefaultDataDir()
	addr := flag.String("addr", "127.0.0.1:5190", "where to listen (loopback only)")
	data := flag.String("data", defaultData, "data directory")
	frontend := flag.String("frontend", "frontend/dist", "the built UI to serve (empty: API only)")
	runtimeScript := flag.String("runtime", "runtime/dist/runtime.mjs", "the agent runtime bundle (or runtime/src/main.ts with -dev)")
	dev := flag.Bool("dev", false, "run the runtime from source (node --import tsx runtime/src/main.ts)")
	node := flag.String("node", "", "the node binary (default: from PATH)")
	demoSpeed := flag.String("demo-speed", "", "the demo model's tokens per second")
	secretStore := flag.String("secrets", "keychain", "where provider keys go: keychain, or memory (forgotten on exit: for development)")
	flag.Parse()

	host, _, err := net.SplitHostPort(*addr)
	if err != nil || (host != "127.0.0.1" && host != "localhost" && host != "::1") {
		slog.Error("-addr must be a loopback address: the API has no authentication")
		os.Exit(2)
	}
	nodePath := *node
	if nodePath == "" {
		if nodePath, err = exec.LookPath("node"); err != nil {
			slog.Error("node not found on PATH; pass -node")
			os.Exit(2)
		}
	}
	rt := supervisor.Runtime{Node: nodePath, Args: []string{"--disable-warning=ExperimentalWarning"}}
	if *dev {
		dir, _ := filepath.Abs("runtime")
		rt.Dir, rt.Script = dir, "src/main.ts"
		rt.Args = append(rt.Args, "--import", "tsx")
	} else {
		script, _ := filepath.Abs(*runtimeScript)
		rt.Script, rt.Dir = script, filepath.Dir(script)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	var store secrets.Store = secrets.Keychain{}
	switch *secretStore {
	case "keychain":
	case "memory":
		store = secrets.NewMemory()
		slog.Warn("provider keys are kept in memory only (-secrets memory)")
	default:
		slog.Error("-secrets is keychain or memory")
		os.Exit(2)
	}
	a, err := app.New(ctx, app.Config{DataDir: *data, Runtime: rt, DemoTokensPerSecond: *demoSpeed, Secrets: store})
	if err != nil {
		slog.Error("starting Pi Local", "err", err)
		os.Exit(1)
	}
	a.ResumeUnfinished(ctx)

	mux := http.NewServeMux()
	mux.Handle("/api/", a.API.Handler())
	if *frontend != "" {
		mux.Handle("/", spa(*frontend))
	}
	// Requests share a context that ends at shutdown, so open event streams end at once instead of holding it up.
	streams, endStreams := context.WithCancel(context.Background())
	srv := &http.Server{Addr: *addr, Handler: mux, ReadHeaderTimeout: 10 * time.Second, BaseContext: func(net.Listener) context.Context { return streams }}
	go func() {
		slog.Info("Pi Local (headless) listening", "url", "http://"+*addr, "data", *data)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("serving", "err", err)
			stop()
		}
	}()
	<-ctx.Done()
	slog.Info("stopping: agents finish gracefully, work in flight stays pending")
	endStreams()
	shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	srv.Shutdown(shutdown)
	cancel()
	a.Close()
}

// spa serves the built UI: files as they are, and index.html for every route the client-side router owns.
func spa(dir string) http.Handler {
	files := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := filepath.Join(dir, filepath.Clean("/"+r.URL.Path))
		if info, err := os.Stat(path); err == nil && !info.IsDir() {
			if strings.HasPrefix(r.URL.Path, "/assets/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			}
			files.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		http.ServeFile(w, r, filepath.Join(dir, "index.html"))
	})
}
