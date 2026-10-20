// Package app wires Pi Local together: the data directory, app.db, the agents, the thread index, the supervisor
// that runs agents, the gateway runtimes report to, and the UI API. The Wails app and the headless server both run
// one App.
package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/ncecere/pi-local/internal/agents"
	"github.com/ncecere/pi-local/internal/api"
	"github.com/ncecere/pi-local/internal/appdb"
	"github.com/ncecere/pi-local/internal/events"
	"github.com/ncecere/pi-local/internal/gateway"
	"github.com/ncecere/pi-local/internal/supervisor"
	"github.com/ncecere/pi-local/internal/threads"
)

// Config configures an App.
type Config struct {
	// DataDir holds app.db and the agents' folders. Only one App may use it at a time.
	DataDir string
	// Runtime is how to run the agent runtime (node and runtime.mjs).
	Runtime supervisor.Runtime
	// DemoTokensPerSecond, when set, is the demo model's speed (tests make it slow to stop a reply midway).
	DemoTokensPerSecond string
	// Supervisor timings; zero values take the supervisor's defaults.
	IdleTimeout, ReapInterval, StopGrace time.Duration
}

// App is a running Pi Local.
type App struct {
	cfg     Config
	Agents  *agents.Store
	Threads *threads.Index
	Hub     *events.Hub
	Sup     *supervisor.Supervisor
	API     *api.API

	runtimeVersion string
	lock           *os.File
	gateway        *http.Server
	closeDB        func() error
}

// ErrAlreadyRunning: another Pi Local uses the data directory.
var ErrAlreadyRunning = errors.New("Pi Local is already running with this data directory")

// DefaultDataDir is ~/Library/Application Support/Pi Local (or the OS's equivalent).
func DefaultDataDir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "Pi Local"), nil
}

// RuntimeVersions is what `runtime.mjs version` prints.
type RuntimeVersions struct {
	ContractVersion  int    `json:"contractVersion"`
	PiDurableVersion string `json:"piDurableVersion"`
}

// ReadRuntimeVersions asks the runtime which versions it implements.
func ReadRuntimeVersions(ctx context.Context, rt supervisor.Runtime) (RuntimeVersions, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	args := append(append([]string{}, rt.Args...), rt.Script, "version")
	cmd := exec.CommandContext(ctx, rt.Node, args...)
	cmd.Dir = rt.Dir
	out, err := cmd.Output()
	if err != nil {
		return RuntimeVersions{}, fmt.Errorf("running the agent runtime (%s %s): %w", rt.Node, rt.Script, err)
	}
	var v RuntimeVersions
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &v); err != nil || v.PiDurableVersion == "" {
		return RuntimeVersions{}, fmt.Errorf("the agent runtime printed no version: %q", out)
	}
	return v, nil
}

// New opens the data directory and starts everything but the UI.
func New(ctx context.Context, cfg Config) (*App, error) {
	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
		return nil, err
	}
	lock, err := lockDir(cfg.DataDir)
	if err != nil {
		return nil, err
	}
	a := &App{cfg: cfg, lock: lock, Hub: events.NewHub()}
	ok := false
	defer func() {
		if !ok {
			a.Close()
		}
	}()

	versions, err := ReadRuntimeVersions(ctx, cfg.Runtime)
	if err != nil {
		return nil, err
	}
	a.runtimeVersion = versions.PiDurableVersion

	db, err := appdb.Open(ctx, filepath.Join(cfg.DataDir, "app.db"))
	if err != nil {
		return nil, err
	}
	a.closeDB = db.Close
	if a.Agents, err = agents.Open(ctx, db, filepath.Join(cfg.DataDir, "agents")); err != nil {
		return nil, err
	}
	a.Threads = threads.NewIndex(db, func(c threads.Change) {
		a.Hub.Publish("thread", map[string]any{"agentId": c.AgentID, "threadId": c.ThreadID, "deleted": c.Deleted, "thread": c.Thread})
	})

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	gatewayURL := "http://" + listener.Addr().String()

	a.Sup = supervisor.New(supervisor.Options{
		Runtime:      cfg.Runtime,
		GatewayURL:   gatewayURL,
		Resolve:      a.resolve,
		BaseEnv:      baseEnv(cfg.DataDir),
		OnStatus:     func(c supervisor.StatusChange) { a.publishAgent(c.AgentID) },
		OnStarted:    a.started,
		Refuse:       a.refuse,
		IdleTimeout:  cfg.IdleTimeout,
		ReapInterval: cfg.ReapInterval,
		StopGrace:    cfg.StopGrace,
	})
	a.gateway = &http.Server{Handler: &gateway.Handler{Keys: a.Sup, Threads: a.Threads}, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := a.gateway.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("gateway stopped", "err", err)
		}
	}()

	a.API = &api.API{DB: db, Agents: a.Agents, Threads: a.Threads, Runtimes: a.Sup, Hub: a.Hub}
	a.Agents.OnChange(func(c agents.Change) {
		if c.Deleted {
			a.Hub.Publish("agent", map[string]any{"agentId": c.AgentID, "deleted": true})
			return
		}
		a.publishAgent(c.AgentID)
		// A running agent picks up its new configuration now (the supervisor restarts it on the new revision).
		if status, _ := a.Sup.Status(c.AgentID); status == supervisor.Awake {
			go func() {
				if err := a.Sup.Wake(context.Background(), c.AgentID); err != nil {
					slog.Warn("restarting an agent with its new configuration", "agent", c.AgentID, "err", err)
				}
			}()
		}
	})
	ok = true
	return a, nil
}

// ResumeUnfinished wakes every agent the index shows with a reply in progress: the app was quit (or crashed) while
// it was answering, and its runtime picks the work up from storage.
func (a *App) ResumeUnfinished(ctx context.Context) {
	ids, err := a.Threads.AgentsWithBusyThreads(ctx)
	if err != nil {
		slog.Warn("finding unfinished replies", "err", err)
		return
	}
	for _, id := range ids {
		if _, err := a.Agents.Get(id); err != nil {
			continue
		}
		go func() {
			slog.Info("resuming an agent's unfinished work", "agent", id)
			if err := a.Sup.Wake(ctx, id); err != nil {
				slog.Warn("resuming an agent", "agent", id, "err", err)
			}
		}()
	}
}

func (a *App) publishAgent(id string) {
	ag, err := a.Agents.Get(id)
	if err != nil {
		return
	}
	a.Hub.Publish("agent", map[string]any{"agentId": id, "deleted": false, "agent": a.API.AgentJSON(ag)})
}

// resolve is an agent's current configuration as the runtime's environment.
func (a *App) resolve(ctx context.Context, id string) (supervisor.Spec, error) {
	ag, err := a.Agents.Get(id)
	if err != nil {
		return supervisor.Spec{}, err
	}
	env := map[string]string{
		"AGENT_NAME":         ag.Config.Name,
		"AGENT_STORAGE":      ag.StoragePath(),
		"WORKSPACE_DIR":      ag.WorkspaceDir(),
		"WORKSPACE_TEMP_DIR": ag.TempDir(),
	}
	if ag.Config.Instructions != "" {
		env["AGENT_INSTRUCTIONS"] = ag.Config.Instructions
	}
	if ag.Config.Kind != "" && ag.Config.Kind != "assistant" {
		env["AGENT_KIND"] = ag.Config.Kind
	}
	if len(ag.Config.KindSettings) > 0 {
		raw, err := json.Marshal(ag.Config.KindSettings)
		if err != nil {
			return supervisor.Spec{}, err
		}
		env["AGENT_KIND_SETTINGS"] = string(raw)
	}
	// Phase 1: every agent is on the scripted demo model.
	env["MODEL_PROVIDER"] = "demo"
	if a.cfg.DemoTokensPerSecond != "" {
		env["DEMO_TOKENS_PER_SECOND"] = a.cfg.DemoTokensPerSecond
	}
	return supervisor.Spec{AgentID: id, Revision: ag.Revision, LogDir: ag.LogDir(), Env: env}, nil
}

// refuse stops a runtime older than the one that last wrote an agent's storage from opening it: pi-durable storage
// can't be read by older code.
func (a *App) refuse(id string) error {
	ag, err := a.Agents.Get(id)
	if err != nil {
		return err
	}
	if agents.CompareVersions(a.runtimeVersion, ag.PiDurableVersion) < 0 {
		return fmt.Errorf("this agent was last run by a newer Pi Local (pi-durable %s; this one has %s). Update Pi Local to open it", ag.PiDurableVersion, a.runtimeVersion)
	}
	return nil
}

func (a *App) started(id string, status supervisor.RuntimeStatus) {
	if status.PiDurableVer == "" {
		return
	}
	if err := a.Agents.RecordStorageVersion(context.Background(), id, status.PiDurableVer); err != nil {
		slog.Warn("recording an agent's storage version", "agent", id, "err", err)
	}
}

// baseEnv is what every runtime's environment starts from: enough to run node and tools, none of the app's secrets.
func baseEnv(dataDir string) map[string]string {
	env := map[string]string{"NODE_COMPILE_CACHE": filepath.Join(dataDir, "cache", "node")}
	for _, k := range []string{"PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ", "TMPDIR", "SHELL"} {
		if v, ok := os.LookupEnv(k); ok {
			env[k] = v
		}
	}
	return env
}

// Close stops every agent gracefully (work in flight stays pending in its storage) and closes everything.
func (a *App) Close() {
	if a.Sup != nil {
		a.Sup.Close()
	}
	if a.gateway != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		a.gateway.Shutdown(ctx)
		cancel()
	}
	if a.closeDB != nil {
		a.closeDB()
	}
	if a.lock != nil {
		syscall.Flock(int(a.lock.Fd()), syscall.LOCK_UN)
		a.lock.Close()
	}
}

// lockDir takes the data directory's single-instance lock (released by the OS if the app dies).
func lockDir(dir string) (*os.File, error) {
	f, err := os.OpenFile(filepath.Join(dir, ".lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, ErrAlreadyRunning
		}
		return nil, err
	}
	return f, nil
}
