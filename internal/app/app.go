// Package app wires Pi Local together: the data directory, app.db, the agents, the thread index, the supervisor
// that runs agents, the gateway runtimes report to, and the UI API. The Wails app and the headless server both run
// one App.
package app

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	goruntime "runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/ncecere/pi-local/internal/activity"
	"github.com/ncecere/pi-local/internal/agents"
	"github.com/ncecere/pi-local/internal/api"
	"github.com/ncecere/pi-local/internal/appdb"
	"github.com/ncecere/pi-local/internal/applog"
	"github.com/ncecere/pi-local/internal/approvals"
	"github.com/ncecere/pi-local/internal/asks"
	"github.com/ncecere/pi-local/internal/backup"
	"github.com/ncecere/pi-local/internal/budget"
	"github.com/ncecere/pi-local/internal/diagnostics"
	"github.com/ncecere/pi-local/internal/elicitations"
	"github.com/ncecere/pi-local/internal/events"
	"github.com/ncecere/pi-local/internal/gateway"
	"github.com/ncecere/pi-local/internal/judge"
	"github.com/ncecere/pi-local/internal/mcp"
	"github.com/ncecere/pi-local/internal/memory"
	"github.com/ncecere/pi-local/internal/models"
	"github.com/ncecere/pi-local/internal/schedules"
	"github.com/ncecere/pi-local/internal/search"
	"github.com/ncecere/pi-local/internal/secrets"
	"github.com/ncecere/pi-local/internal/supervisor"
	"github.com/ncecere/pi-local/internal/teams"
	"github.com/ncecere/pi-local/internal/templates"
	"github.com/ncecere/pi-local/internal/threads"
	"github.com/ncecere/pi-local/internal/update"
	"github.com/ncecere/pi-local/internal/usage"
	"github.com/ncecere/pi-local/internal/web"
	"gopkg.in/yaml.v3"
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
	// Secrets is where provider keys go (default: the OS keychain).
	Secrets secrets.Store
}

// App is a running Pi Local.
type App struct {
	// policyMu serializes telling runtimes their approval rules (pushApprovalPolicy).
	policyMu  sync.Mutex
	cfg       Config
	Agents    *agents.Store
	Threads   *threads.Index
	Hub       *events.Hub
	Sup       *supervisor.Supervisor
	API       *api.API
	Catalog   *models.Catalog
	Usage     *usage.Store
	Budget    *budget.Service
	Teams     *teams.Store
	Asks      *asks.Broker
	Approvals *approvals.Store
	// Activity is the audit log.
	Activity   *activity.Store
	MCP        *mcp.Catalog
	Schedules  *schedules.Store
	Search     *search.Store
	Updater    *update.Updater
	notifyMu   sync.Mutex
	lastNotify map[string]time.Time
	// Judge is the optional fast-judgments layer.
	Judge *judge.Service
	// Memory is what agents know about the person, and each agent's own notes.
	Memory *memory.Store
	// Templates are the New agent gallery's starting points, built-in and the person's.
	Templates *templates.Store
	// Web is web search and page reading for agents.
	Web *web.Service
	// Elicitations are MCP servers' questions to the person, while a tool call waits (memory only).
	Elicitations *elicitations.Store
	// DB is app.db (diagnostics and tests).
	DB *sql.DB
	// Backups makes, lists and restores backups of the data folder, and the daily automatic one.
	Backups *backup.Service
	// Log is the app's own recent log lines (diagnostics).
	Log *applog.Ring

	mcpProber       *mcp.Prober
	runtimeVersion  string
	contractVersion int
	nodeVersion     string
	gatewayURL      string
	lock            *os.File
	gateway         *http.Server
	closeDB         func() error
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
	a.Log = applog.Install()
	// A restore the person asked for is carried out first, before anything opens app.db or the agents' folders.
	if res, err := backup.ApplyPending(cfg.DataDir, time.Now()); err != nil {
		return nil, fmt.Errorf("finishing the restore: %w", err)
	} else if res != nil {
		slog.Info("applied a restore", "ok", res.OK, "backup", res.ID, "movedTo", res.MovedTo, "error", res.Error)
	}

	versions, err := ReadRuntimeVersions(ctx, cfg.Runtime)
	if err != nil {
		return nil, err
	}
	a.runtimeVersion = versions.PiDurableVersion
	a.contractVersion = versions.ContractVersion
	if out, err := exec.CommandContext(ctx, cfg.Runtime.Node, "--version").Output(); err == nil {
		a.nodeVersion = strings.TrimSpace(string(out))
	}

	db, err := appdb.Open(ctx, filepath.Join(cfg.DataDir, "app.db"))
	if err != nil {
		return nil, err
	}
	a.closeDB = db.Close
	a.DB = db
	if a.Agents, err = agents.Open(ctx, db, filepath.Join(cfg.DataDir, "agents")); err != nil {
		return nil, err
	}
	a.Activity = activity.New(db)
	a.Activity.AgentName = a.Agents.NameOf
	if cfg.Secrets == nil {
		cfg.Secrets = secrets.Keychain{}
	}
	a.Catalog = models.New(db, cfg.Secrets)
	a.Usage = usage.New(db)
	a.Budget = budget.New(db, a.Usage)
	a.Budget.Prices = func(model string) (usage.Price, bool) { return a.Catalog.UsagePrice(context.Background(), model) }
	a.Budget.Agent = func(id string) (string, *agents.Budget, bool) {
		ag, err := a.Agents.Get(id)
		if err != nil {
			return "", nil, false
		}
		return ag.Config.Name, ag.Config.Budget, true
	}
	a.Budget.All = func() []budget.AgentBudget {
		var out []budget.AgentBudget
		for _, ag := range a.Agents.List() {
			if ag.Config.Budget != nil {
				out = append(out, budget.AgentBudget{ID: ag.ID, Name: ag.Config.Name, Budget: *ag.Config.Budget})
			}
		}
		return out
	}
	a.Budget.Publish = func(ev budget.Event) { a.Hub.Publish("budget", ev) }
	a.Agents.ModelAvailable = func(m agents.ModelRef) bool { return a.Catalog.Available(context.Background(), m.String()) }
	a.Catalog.UsedBy = func(model string) []models.AgentRef {
		provider, id, _ := models.SplitModelID(model)
		var out []models.AgentRef
		for _, ag := range a.Agents.UsingModel(agents.ModelRef{Provider: provider, ID: id}) {
			out = append(out, models.AgentRef{ID: ag.ID, Name: ag.Config.Name})
		}
		return out
	}
	a.Catalog.OnChange = a.catalogChanged
	a.MCP = mcp.New(db, cfg.Secrets)
	a.Agents.MCPExists = a.MCP.Exists
	a.MCP.UsedBy = func(slug string) []mcp.Ref {
		var out []mcp.Ref
		for _, ag := range a.Agents.UsingMCP(slug) {
			out = append(out, mcp.Ref{ID: ag.ID, Name: ag.Config.Name})
		}
		return out
	}
	a.MCP.OnChange = a.mcpChanged
	a.MCP.OnLogin = func(st mcp.LoginStatus) { a.Hub.Publish("mcp-login", st) }
	a.MCP.OnAuth = a.recordSignIn
	a.Web = web.New(db, cfg.Secrets)
	a.Memory = memory.New(db)
	a.Judge = judge.New(db, cfg.Secrets)
	a.lastNotify = map[string]time.Time{}
	a.Memory.OnChange = func(agentID string) { a.Hub.Publish("memory", map[string]string{"agentId": agentID}) }
	if a.Templates, err = templates.New(filepath.Join(cfg.DataDir, "templates")); err != nil {
		return nil, fmt.Errorf("templates: %w", err)
	}
	a.Elicitations = elicitations.New(0)
	a.Elicitations.OnChange = func(e elicitations.Elicitation) { a.Hub.Publish("elicitation", e) }
	a.Elicitations.AgentName = func(id string) string {
		if ag, err := a.Agents.Get(id); err == nil {
			return ag.Config.Name
		}
		return id
	}
	a.Search = search.New(db)
	a.Threads = threads.NewIndex(db, func(c threads.Change) {
		a.Hub.Publish("thread", map[string]any{"agentId": c.AgentID, "threadId": c.ThreadID, "deleted": c.Deleted, "thread": c.Thread})
		if c.Thread != nil && !c.Thread.Busy {
			a.recordReplyError(c.AgentID, c.Thread)
			// A reply ended: its scheduled run (if any) is done, and its text is kept searchable.
			if a.Schedules != nil {
				a.Schedules.ThreadChanged(c.AgentID, c.Thread)
			}
			go a.indexThread(c.AgentID, c.ThreadID, c.Thread.Title)
		}
	})
	a.Threads.NameOf = a.Agents.NameOf
	a.Teams = teams.New(db, a.Agents)
	a.Teams.OnChange = a.teamChanged

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	gatewayURL := "http://" + listener.Addr().String()
	a.gatewayURL = gatewayURL
	appKey := "pl.app." + randomKey()
	a.mcpProber = &mcp.Prober{
		Runtime:     cfg.Runtime,
		Env:         baseEnv(cfg.DataDir),
		OAuthURL:    gatewayURL + "/mcp/oauth",
		Key:         appKey,
		Scratch:     filepath.Join(cfg.DataDir, "mcp-scratch"),
		OpenBrowser: func(u string) error { return a.Reveal(u) },
	}
	a.MCP.SetProber(a.mcpProber)

	a.Sup = supervisor.New(supervisor.Options{
		Runtime:    cfg.Runtime,
		GatewayURL: gatewayURL,
		Resolve:    a.resolve,
		BaseEnv:    baseEnv(cfg.DataDir),
		OnStatus: func(c supervisor.StatusChange) {
			// A stopped runtime's MCP connections are gone, and with them anyone to answer its servers' questions.
			if c.Status == supervisor.Asleep || c.Status == supervisor.Failed {
				a.Elicitations.ForgetAgent(c.AgentID)
			}
			if c.Status == supervisor.Failed {
				a.recordAgentFailed(c.AgentID, c.LastError)
			}
			a.publishAgent(c.AgentID)
		},
		OnStarted:    a.started,
		Refuse:       a.refuse,
		RedactLog:    agents.LogRedactor,
		IdleTimeout:  cfg.IdleTimeout,
		ReapInterval: cfg.ReapInterval,
		StopGrace:    cfg.StopGrace,
	})
	a.Asks = asks.New(db, a.Sup, a.Agents, permissions{a}, a.Threads)
	a.Asks.Budget = a.budgetCheck("ask")
	a.Asks.OnFinish = a.recordAsk
	a.Schedules = schedules.New(db, a.Sup, a.Agents, a.Threads)
	a.Schedules.Budget = a.budgetCheck("schedule")
	a.Schedules.OnChange = func(id string, sc *schedules.Schedule) {
		if sc == nil {
			a.Hub.Publish("schedule", map[string]any{"scheduleId": id, "deleted": true})
			return
		}
		a.Hub.Publish("schedule", map[string]any{"scheduleId": id, "deleted": false, "schedule": sc})
	}
	a.Schedules.OnRunEnd = func(sc *schedules.Schedule, run *schedules.Run) {
		a.Hub.Publish("schedule_run", map[string]any{"scheduleId": sc.ID, "agentId": sc.AgentID, "name": sc.Name, "run": run})
		a.recordScheduleRun(sc, run)
	}
	a.Approvals = approvals.New(db, a.Sup, approvalAgents{a})
	a.Approvals.Person = localPersonName()
	a.Approvals.OnChange = func(ap *approvals.Approval) {
		a.Hub.Publish("approval", map[string]any{"agentId": ap.AgentID, "approval": ap})
		a.publishAgent(ap.AgentID) // its pendingApprovals count
		if ap.Status != "pending" {
			a.recordApproval(ap)
		}
	}
	a.gateway = &http.Server{Handler: &gateway.Handler{Keys: a.Sup, Threads: a.Threads, Usage: a, Asks: askGateway{a}, Approvals: a.Approvals, Activity: a.Activity, OAuth: oauthGateway{a}, AppKey: appKey, Schedules: a.Schedules, Elicitations: a.Elicitations, Web: webGateway{a}, Memory: memoryGateway{a}, PickTools: a.Judge.PickTools, JudgeApproval: a.Judge.RiskyCall, Notify: a.notifyPerson, ModelEnv: a.conversationModelEnv}, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := a.gateway.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("gateway stopped", "err", err)
		}
	}()

	a.API = &api.API{DB: db, Agents: a.Agents, Threads: a.Threads, Runtimes: a.Sup, Hub: a.Hub, Catalog: a.Catalog, Usage: a.Usage, Budget: a.Budget, Teams: a.Teams, Manager: a, Approvals: a.Approvals, Activity: a.Activity, MCP: a.MCP, Schedules: a.Schedules, Search: a.Search, Elicitations: a.Elicitations, Web: a.Web, Templates: a.Templates, Memory: a.Memory, MemoryDefaults: basicsDefaults, Judge: a.Judge, SecretsInKeychain: secrets.InKeychain(cfg.Secrets)}
	a.Agents.OnChange(func(c agents.Change) {
		if c.Deleted {
			a.Hub.Publish("agent", map[string]any{"agentId": c.AgentID, "deleted": true})
			a.Approvals.ForgetAgent(context.Background(), c.AgentID)
			a.Elicitations.ForgetAgent(c.AgentID)
			a.Schedules.ForgetAgent(context.Background(), c.AgentID)
			a.Search.Forget(context.Background(), c.AgentID, "")
			if err := a.Teams.RemoveAgent(context.Background(), c.AgentID); err != nil {
				slog.Warn("removing a deleted agent from its teams", "agent", c.AgentID, "err", err)
			}
			return
		}
		a.Sup.Invalidate(c.AgentID)
		a.publishAgent(c.AgentID)
		// A failed agent given a working configuration (another model) is no longer failed.
		a.Sup.Recheck(context.Background(), c.AgentID)
		// A running agent picks up its new configuration now (the supervisor restarts it on the new revision); a change
		// to its approval rules or profile alone is told to the running runtime instead.
		if status, _ := a.Sup.Status(c.AgentID); status == supervisor.Awake {
			go func() {
				if err := a.Sup.Wake(context.Background(), c.AgentID); err != nil {
					slog.Warn("restarting an agent with its new configuration", "agent", c.AgentID, "err", err)
					return
				}
				a.pushApprovalPolicy(c.AgentID)
			}()
		}
	})
	// Updates from GitHub releases: checking works anywhere; installing needs the installed app (the desktop sets how
	// it relaunches).
	exe, _ := os.Executable()
	a.Updater = update.New(Version, update.BundleOf(exe))
	a.Updater.LoadAutoCheck = func() bool {
		var v string
		db.QueryRow(`SELECT value FROM settings WHERE key = 'update_auto_check'`).Scan(&v)
		return v != "off"
	}
	a.Updater.SaveAutoCheck = func(on bool) error {
		v := "on"
		if !on {
			v = "off"
		}
		_, err := db.Exec(`INSERT INTO settings (key, value) VALUES ('update_auto_check', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, v)
		return err
	}
	a.Updater.OnChange = func(st update.Status) { a.Hub.Publish("update", st) }
	a.API.Updater = a.Updater
	a.Backups = backup.New(backup.Config{
		DataDir: cfg.DataDir, DB: db, Version: Version,
		Agents: func() []backup.AgentInfo {
			var out []backup.AgentInfo
			for _, ag := range a.Agents.List() {
				out = append(out, backup.AgentInfo{ID: ag.ID, Name: ag.Config.Name, Dir: ag.Dir, ProjectFolder: ag.Config.Workspace.Folder})
			}
			return out
		},
		Quiesce: a.Sup.Quiesce,
		Wake:    a.Sup.Wake,
		Keys:    a.backupKeys,
		Busy: func(ctx context.Context) bool {
			ids, err := a.Threads.AgentsWithBusyThreads(ctx)
			return err == nil && len(ids) > 0
		},
		OnChange: func() { a.Hub.Publish("backup", map[string]any{}) },
	})
	a.API.Backups = a.Backups
	// An update backs the data up first.
	a.Updater.BeforeInstall = func(ctx context.Context) error {
		_, err := a.Backups.Create(ctx, backup.BeforeUpdate, "")
		return err
	}
	a.Schedules.Start()
	a.Backups.Start()
	ok = true
	return a, nil
}

// ResumeUnfinished wakes every agent the index shows with a reply in progress: the app was quit (or crashed) while
// it was answering, and its runtime picks the work up from storage.
func (a *App) ResumeUnfinished(ctx context.Context) {
	a.Asks.Resume(ctx)
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

// pushApprovalPolicy tells an awake agent's runtime its current approval rules and profile (POST /approvals/policy).
// Pushes are serialized and read the configuration when they run, so the last change always wins. A runtime that
// can't be told is stopped (it starts again with the current policy on its next call): a rule the person removed
// must not keep allowing.
func (a *App) pushApprovalPolicy(id string) {
	a.policyMu.Lock()
	defer a.policyMu.Unlock()
	if status, _ := a.Sup.Status(id); status != supervisor.Awake {
		return // it starts with the current policy
	}
	ag, err := a.Agents.Get(id)
	if err != nil {
		return
	}
	raw, _ := json.Marshal(ag.Config.ApprovalPolicy())
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	resp, err := a.Sup.Call(ctx, id, http.MethodPost, "/approvals/policy", raw, http.Header{"Content-Type": {"application/json"}})
	if err == nil {
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if resp.StatusCode == http.StatusOK {
			return
		}
	}
	slog.Warn("telling an agent its new approval rules failed; restarting it", "agent", id, "err", err)
	a.Sup.Stop(id)
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
	// Workspace tools, and the tools that ask first (the runtime waits durably; the app decides when they expire).
	if len(ag.Config.Workspace.Tools) > 0 {
		env["WORKSPACE_TOOLS"] = strings.Join(ag.Config.Workspace.Tools, ",")
	}
	// The shell's sandbox (macOS: sandbox-exec): on or off, the network inside it, and the app's data folder, which the
	// sandboxed shell may not read outside this agent's own folder.
	if ag.Config.Workspace.SandboxOn() {
		env["WORKSPACE_SANDBOX"] = "on"
		env["WORKSPACE_SANDBOX_NETWORK"] = "on"
		if !ag.Config.Workspace.NetworkOn() {
			env["WORKSPACE_SANDBOX_NETWORK"] = "off"
		}
		env["WORKSPACE_SANDBOX_DATA_DIR"] = a.cfg.DataDir
		env["WORKSPACE_SANDBOX_AGENT_DIR"] = ag.Dir
	}
	// The approval policy: profile, rules, the built-in rules (always sent). Changes to it reach a running runtime
	// without a restart (pushApprovalPolicy), so it is not part of what makes a configuration stale.
	raw, _ := json.Marshal(ag.Config.ApprovalPolicy())
	env["TOOL_APPROVALS"] = string(raw)
	// MCP servers: resolved here (secrets and paths filled in); the runtime connects to them itself.
	if len(ag.Config.MCP) > 0 {
		var choices []mcp.Choice
		for _, m := range ag.Config.MCP {
			choices = append(choices, mcp.Choice{Server: m.Server, Tools: m.Tools})
		}
		servers, skipped, err := a.MCP.ForAgent(ctx, choices, ag.WorkspaceDir(), ag.Dir)
		if err != nil {
			return supervisor.Spec{}, err
		}
		for _, sk := range skipped {
			slog.Info("an agent's MCP server is left out", "agent", id, "server", sk)
		}
		if len(servers) > 0 {
			raw, _ := json.Marshal(servers)
			env["MCP_SERVERS"] = string(raw)
			env["MCP_OAUTH_URL"] = a.gatewayURL + "/mcp/oauth"
			// The servers may ask the person a question mid-call (MCP elicitation); the runtime relays it here.
			env["MCP_ELICIT_URL"] = a.gatewayURL + "/mcp/elicitations"
		}
	}
	// Web tools (through the gateway, which holds the search key and refuses private addresses).
	var webTools []string
	if ag.Config.Web.Search {
		webTools = append(webTools, "search")
	}
	if ag.Config.Web.Fetch {
		webTools = append(webTools, "fetch")
	}
	if len(webTools) > 0 {
		env["WEB_TOOLS"] = strings.Join(webTools, ",")
	}
	// Secret scrubbing of what tools return (on unless the agent's agent.yaml turns it off); logs are always cleaned.
	env["SCRUB_SECRETS"] = strconv.FormatBool(ag.Config.Security.Scrub())
	// ask_person, notify_person and todo.
	env["PERSON_TOOLS"] = "on"
	// Memory: the "about you" and "your notes" sections and the remember / recall / forget tools (on unless off).
	if !ag.Config.Memory.Off {
		env["MEMORY"] = "on"
	}
	// Its own schedules (the schedule tools), when its agent.yaml allows them.
	if ag.Config.Schedules.AgentMade {
		env["PLATFORM_SCHEDULES"] = "true"
	}
	// Asking other agents: the tools are there when it may ask someone (who exactly is decided at each ask).
	if callees, err := a.Teams.Callable(ctx, id); err == nil && len(callees) > 0 {
		env["AGENT_CALLS"] = "true"
	}
	if len(ag.Config.KindSettings) > 0 {
		raw, err := json.Marshal(ag.Config.KindSettings)
		if err != nil {
			return supervisor.Spec{}, err
		}
		env["AGENT_KIND_SETTINGS"] = string(raw)
	}
	model := ag.Config.Model.String()
	modelEnv, err := a.Catalog.RuntimeEnv(ctx, model)
	if err != nil {
		var unavailable *models.UnavailableError
		if errors.As(err, &unavailable) {
			return supervisor.Spec{}, &supervisor.StartError{AgentID: id, Code: -1, Message: unavailable.Message}
		}
		return supervisor.Spec{}, err
	}
	for k, v := range modelEnv {
		env[k] = v
	}
	if model == models.DemoModelID {
		if a.cfg.DemoTokensPerSecond != "" {
			env["DEMO_TOKENS_PER_SECOND"] = a.cfg.DemoTokensPerSecond
		}
	} else {
		// The runtime counts what its model uses and reports it here, naming the model it was started on.
		env["MODEL_USAGE_URL"] = a.gatewayURL + "/usage?model=" + url.QueryEscape(model)
	}
	return supervisor.Spec{AgentID: id, Revision: ag.Revision, LogDir: ag.LogDir(), Env: env}, nil
}

// teamChanged: who may ask whom changed. Awake agents of the team pick up (or lose) the ask tools; everyone hears
// of the change.
func (a *App) teamChanged(teamID string, team *teams.Team) {
	if team == nil {
		a.Hub.Publish("team", map[string]any{"teamId": teamID, "deleted": true})
	} else {
		a.Hub.Publish("team", map[string]any{"teamId": teamID, "deleted": false, "team": team})
	}
	for _, id := range a.Sup.Awake() {
		a.Sup.Invalidate(id)
		go func() {
			if err := a.Sup.Wake(context.Background(), id); err != nil {
				slog.Info("an agent's team changed", "agent", id, "err", err)
			}
		}()
		a.publishAgent(id)
	}
}

// indexThread keeps a conversation's text searchable after a reply, without waking a sleeping agent for it.
func (a *App) indexThread(agentID, threadID, title string) {
	if status, _ := a.Sup.Status(agentID); status != supervisor.Awake {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	resp, err := a.Sup.Call(ctx, agentID, http.MethodGet, "/threads/"+threadID, nil, nil)
	if err != nil {
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return
	}
	var wrapped struct {
		Data json.RawMessage `json:"data"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 64<<20)).Decode(&wrapped) != nil {
		return
	}
	if err := a.Search.Put(ctx, agentID, threadID, title, search.Text(wrapped.Data)); err != nil {
		slog.Warn("indexing a conversation", "agent", agentID, "err", err)
	}
}

// mcpChanged: an MCP server changed (nil: deleted). Everyone hears of it; awake agents using it restart with it.
func (a *App) mcpChanged(slug string, server *mcp.Server) {
	if server == nil {
		a.Hub.Publish("mcp", map[string]any{"slug": slug, "deleted": true})
	} else {
		a.Hub.Publish("mcp", map[string]any{"slug": slug, "deleted": false, "server": server})
	}
	for _, ag := range a.Agents.UsingMCP(slug) {
		a.Sup.Invalidate(ag.ID)
		if status, _ := a.Sup.Status(ag.ID); status != supervisor.Awake {
			continue
		}
		id := ag.ID
		go func() {
			if err := a.Sup.Wake(context.Background(), id); err != nil {
				slog.Info("an agent's MCP server changed", "agent", id, "err", err)
			}
		}()
	}
}

// oauthGateway: agents read and refresh the OAuth state of the MCP servers they use.
type oauthGateway struct{ a *App }

func (g oauthGateway) Uses(agentID, slug string) bool {
	if !g.a.MCP.Exists(slug) {
		return false
	}
	if agentID == "" {
		return true // the app's own probe
	}
	ag, err := g.a.Agents.Get(agentID)
	if err != nil {
		return false
	}
	for _, m := range ag.Config.MCP {
		if m.Server == slug {
			return true
		}
	}
	return false
}

func (g oauthGateway) OAuthState(slug string) (json.RawMessage, error) {
	return g.a.MCP.OAuthState(slug)
}
func (g oauthGateway) SaveOAuthState(slug string, state json.RawMessage) error {
	return g.a.MCP.SaveOAuthState(slug, state)
}

func randomKey() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// approvalAgents tells the approvals store about agents.
type approvalAgents struct{ a *App }

func (x approvalAgents) ApprovalTimeout(id string) time.Duration {
	if ag, err := x.a.Agents.Get(id); err == nil {
		return time.Duration(ag.Config.Approvals.Timeout()) * time.Second
	}
	return time.Duration(agents.DefaultApprovalTimeout) * time.Second
}

func (x approvalAgents) NameOf(id string) string { return x.a.Agents.NameOf(id) }
func (x approvalAgents) Exists(id string) bool   { return x.a.Agents.Exists(id) }

// localPersonName is the person deciding approvals, as the model is told ("denied by Ann").
func localPersonName() string {
	if u, err := user.Current(); err == nil {
		if u.Name != "" {
			return u.Name
		}
		return u.Username
	}
	return "you"
}

// permissions answers the asks broker from the teams and the agents' own canCall.
type permissions struct{ a *App }

func (p permissions) MayCall(ctx context.Context, caller, target string) bool {
	return p.a.Teams.MayCall(ctx, caller, target)
}

func (p permissions) CallableIDs(ctx context.Context, caller string) []string {
	list, _ := p.a.Teams.Callable(ctx, caller)
	ids := make([]string, 0, len(list))
	for _, c := range list {
		ids = append(ids, c.ID)
	}
	return ids
}

// askGateway is what the gateway serves runtimes for asks.
type askGateway struct{ a *App }

func (g askGateway) Peers(ctx context.Context, caller string) []gateway.Peer {
	list, _ := g.a.Teams.Callable(ctx, caller)
	out := []gateway.Peer{}
	for _, c := range list {
		ag, err := g.a.Agents.Get(c.ID)
		if err != nil {
			continue
		}
		out = append(out, gateway.Peer{ID: ag.ID, Name: ag.Config.Name, Description: ag.Config.Description, Kind: ag.Config.Kind, Via: c.Via})
	}
	return out
}

func (g askGateway) Start(ctx context.Context, caller string, req asks.Request) (*asks.Started, error) {
	return g.a.Asks.Start(ctx, caller, req)
}

func (g askGateway) Wait(ctx context.Context, caller, id string, wait time.Duration) (*asks.State, error) {
	return g.a.Asks.Wait(ctx, caller, id, wait)
}

func (g askGateway) Stop(ctx context.Context, caller, id string) error {
	return g.a.Asks.Stop(ctx, caller, id)
}

// Version is Pi Local's version (set at build time: -ldflags "-X github.com/ncecere/pi-local/internal/app.Version=…").
var Version = "0.1.0-dev"

// About is what Settings → About shows.
func (a *App) About() map[string]any {
	return map[string]any{
		"version": Version,
		"dataDir": a.cfg.DataDir,
		"runtime": map[string]any{
			"node":             a.cfg.Runtime.Node,
			"nodeVersion":      a.nodeVersion,
			"piDurableVersion": a.runtimeVersion,
			"contractVersion":  a.contractVersion,
		},
		"agents": len(a.Agents.List()),
	}
}

// RevealFile shows a file selected in the Finder (on Linux, its folder in the file manager).
func (a *App) RevealFile(path string) error {
	if goruntime.GOOS == "linux" {
		return exec.Command("xdg-open", filepath.Dir(path)).Start()
	}
	return exec.Command("open", "-R", path).Start()
}

// Reveal opens a folder in the Finder (or the system's file manager).
func (a *App) Reveal(path string) error {
	opener := "open"
	if goruntime.GOOS == "linux" {
		opener = "xdg-open"
	}
	return exec.Command(opener, path).Start()
}

// catalogChanged: a provider or one of its models changed. Awake agents on it restart with the change (their
// runtime's environment differs now); an agent whose model is no longer available stops.
func (a *App) catalogChanged(provider string) {
	for _, ag := range a.Agents.List() {
		if ag.Config.Model.Provider != provider {
			continue
		}
		a.Sup.Invalidate(ag.ID)
		if status, _ := a.Sup.Status(ag.ID); status != supervisor.Awake {
			// One that failed because of this provider (its model was turned off) is fine again once it's back.
			a.Sup.Recheck(context.Background(), ag.ID)
			continue
		}
		id := ag.ID
		go func() {
			if !a.Catalog.Available(context.Background(), ag.Config.Model.String()) {
				a.Sup.Stop(id)
			}
			if err := a.Sup.Wake(context.Background(), id); err != nil {
				slog.Info("an agent's model changed", "agent", id, "err", err)
			}
		}()
	}
}

// RecordUsage keeps what a runtime reports its model used (the gateway's /usage).
func (a *App) RecordUsage(ctx context.Context, agentID, model string, c usage.Counts) error {
	name := agentID
	if ag, err := a.Agents.Get(agentID); err == nil {
		name = ag.Config.Name
	}
	if err := a.Usage.Record(ctx, agentID, name, model, a.Catalog.ModelName(ctx, model), c); err != nil {
		return err
	}
	// The report may have brought a budget to 80% or 100%.
	a.Budget.Evaluate(ctx, agentID)
	return nil
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
	if a.Backups != nil {
		a.Backups.Close()
	}
	if a.Asks != nil {
		a.Asks.Close()
	}
	if a.Approvals != nil {
		a.Approvals.Close()
	}
	if a.Schedules != nil {
		a.Schedules.Close()
	}
	if a.MCP != nil {
		a.MCP.Close()
	}
	if a.Sup != nil {
		a.Sup.Close()
	}
	if a.gateway != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		a.gateway.Shutdown(ctx)
		cancel()
	}
	if a.Activity != nil {
		a.Activity.Close() // writes what is queued, before app.db closes
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

// webGateway gives runtimes the web, for agents whose agent.yaml allows each tool.
type webGateway struct{ a *App }

func (g webGateway) Allowed(agentID, tool string) bool {
	ag, err := g.a.Agents.Get(agentID)
	if err != nil {
		return false
	}
	return (tool == "search" && ag.Config.Web.Search) || (tool == "fetch" && ag.Config.Web.Fetch)
}

func (g webGateway) Search(ctx context.Context, query string, count int) ([]web.Result, error) {
	return g.a.Web.Search(ctx, query, count)
}

func (g webGateway) Fetch(ctx context.Context, url string, offset, maxChars int) (*web.Page, error) {
	return g.a.Web.Fetch(ctx, url, offset, maxChars)
}

// notifyPerson relays an agent's notify_person (at most one every 20 seconds per agent): the desktop app shows it as
// a system notification, a browser as a toast.
func (a *App) notifyPerson(agentID, threadID, title, message string) bool {
	a.notifyMu.Lock()
	if last, ok := a.lastNotify[agentID]; ok && time.Since(last) < 20*time.Second {
		a.notifyMu.Unlock()
		return false
	}
	a.lastNotify[agentID] = time.Now()
	a.notifyMu.Unlock()
	clip := func(s string, n int) string {
		s = strings.Join(strings.Fields(s), " ")
		if r := []rune(s); len(r) > n {
			return string(r[:n-1]) + "…"
		}
		return s
	}
	a.Hub.Publish("notification", map[string]string{
		"agentId": agentID, "agentName": a.Agents.NameOf(agentID), "threadId": threadID,
		"title": clip(title, 80), "message": clip(message, 300),
	})
	return true
}

// conversationModelEnv: a model the person chose for one of the agent's conversations, for its runtime. Only while
// the choice is on, and only a usable catalog model (never the demo one); its usage is counted under its own name.
func (a *App) conversationModelEnv(ctx context.Context, agentID, modelID string) (map[string]string, error) {
	if !a.Catalog.PerConversation() {
		return nil, errors.New("Choosing a conversation's model is turned off (Settings → Models).")
	}
	if modelID == "" || modelID == models.DemoModelID {
		return nil, errors.New("That model can't be chosen for a conversation.")
	}
	env, err := a.Catalog.RuntimeEnv(ctx, modelID)
	if err != nil {
		return nil, err
	}
	env["MODEL_USAGE_URL"] = a.gatewayURL + "/usage?model=" + url.QueryEscape(modelID)
	return env, nil
}

// backupKeys lists what a backup can't carry: the secrets in the keychain, by name, for the manifest.
func (a *App) backupKeys(ctx context.Context) []backup.KeyNeed {
	var out []backup.KeyNeed
	if providers, err := a.Catalog.Providers(ctx); err == nil {
		for _, p := range providers {
			var items []string
			if p.HasKey {
				items = append(items, "API key")
			}
			for _, h := range p.HeaderNames {
				items = append(items, "Header "+h)
			}
			if len(items) > 0 {
				out = append(out, backup.KeyNeed{Kind: "provider", ID: p.ID, Name: p.Name, Items: items})
			}
		}
	}
	if servers, err := a.MCP.List(ctx); err == nil {
		for _, s := range servers {
			var items []string
			for _, n := range s.EnvNames {
				items = append(items, "Variable "+n)
			}
			for _, n := range s.HeaderNames {
				items = append(items, "Header "+n)
			}
			if s.OAuth && s.SignedIn {
				items = append(items, "Sign-in")
			}
			if len(items) > 0 {
				out = append(out, backup.KeyNeed{Kind: "mcp", ID: s.Slug, Name: s.Name, Items: items})
			}
		}
	}
	if a.Web.Settings().HasKey {
		out = append(out, backup.KeyNeed{Kind: "web-search", ID: "web-search", Name: "Web search", Items: []string{"API key"}})
	}
	if a.Judge.Settings().HasKey {
		out = append(out, backup.KeyNeed{Kind: "judgments", ID: "judgments", Name: "Fast judgments", Items: []string{"API key"}})
	}
	return out
}

// WriteDiagnostics writes the diagnostics zip (see package diagnostics): no secrets, no conversations.
func (a *App) WriteDiagnostics(w io.Writer) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	settings := map[string]string{}
	if rows, err := a.DB.QueryContext(ctx, `SELECT key, value FROM settings`); err == nil {
		for rows.Next() {
			var k, v string
			if rows.Scan(&k, &v) == nil {
				settings[k] = v
			}
		}
		rows.Close()
	}
	in := diagnostics.Input{
		Now: time.Now(), Version: Version, DataDir: a.cfg.DataDir, Node: a.nodeVersion, PiDurable: a.runtimeVersion,
		Contract: a.contractVersion, SecretsInKeychain: secrets.InKeychain(a.cfg.Secrets), Settings: settings,
		AppLog: a.Log.Lines(),
	}
	if providers, err := a.Catalog.Providers(ctx); err == nil {
		in.Providers = providers
	}
	if servers, err := a.MCP.List(ctx); err == nil {
		in.MCPServers = servers
		for _, server := range servers {
			if server.LastError != nil && *server.LastError != "" {
				in.ServiceErrors = append(in.ServiceErrors, fmt.Sprintf("[MCP: %s] %s", server.Name, *server.LastError))
			}
		}
	}
	for _, ag := range a.Agents.List() {
		status, lastErr := a.Sup.Status(ag.ID)
		cfg := ag.Config
		cfg.Instructions = fmt.Sprintf("[omitted, %d characters]", len([]rune(cfg.Instructions)))
		raw, _ := yaml.Marshal(cfg)
		d := diagnostics.Agent{ID: ag.ID, Name: ag.Config.Name, Kind: ag.Config.Kind, Model: ag.Config.Model.String(),
			Status: string(status), LastError: lastErr, PiDurable: ag.PiDurableVersion, Revision: ag.Revision,
			ConfigYAML: string(raw), LogPath: filepath.Join(ag.LogDir(), "runtime.log")}
		if st, err := os.Stat(ag.StoragePath()); err == nil {
			d.StorageBytes = st.Size()
		}
		in.Agents = append(in.Agents, d)
	}
	return diagnostics.Write(w, in)
}
