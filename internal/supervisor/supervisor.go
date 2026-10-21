// Package supervisor runs agents: one Node runtime process per awake agent (runtime/, docs/runtime-contract.md),
// started on demand, reached over loopback with a per-start token, stopped when idle (hibernation), restarted when it
// crashes. Each start uses the agent's current configuration, resolved under the agent's own lock.
package supervisor

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/ncecere/pi-local/internal/process"
)

// Runtime is how to start the runtime process: `Node Args... Script` in Dir.
type Runtime struct {
	Node   string
	Args   []string
	Script string
	Dir    string
}

// Spec is what one start of an agent needs, resolved from its current configuration.
type Spec struct {
	AgentID  string
	Revision int
	LogDir   string
	// Env is the agent's variables (AGENT_*, MODEL_*, MCP_*, WORKSPACE_*, ...). The supervisor adds the token, the
	// gateway's address and key, where to listen, and the stdin watchdog.
	Env map[string]string
}

// Resolver resolves an agent's current Spec. It returns an error for an agent that no longer exists.
type Resolver func(ctx context.Context, agentID string) (Spec, error)

// Status is an agent's runtime state.
type Status string

const (
	Asleep   Status = "asleep"
	Starting Status = "starting"
	Awake    Status = "awake"
	Failed   Status = "error"
)

// StatusChange is reported whenever an agent's status changes.
type StatusChange struct {
	AgentID   string
	Status    Status
	LastError string
}

// RuntimeStatus is the runtime's GET /status (the fields the supervisor uses).
type RuntimeStatus struct {
	BusyThreads     int    `json:"busyThreads"`
	WaitingThreads  int    `json:"waitingThreads"`
	OpenStreams     int    `json:"openStreams"`
	LastActivityAt  int64  `json:"lastActivityAt"`
	ContractVersion int    `json:"contractVersion"`
	PiDurableVer    string `json:"piDurableVersion"`
	BackgroundWork  *struct {
		Tasks           int    `json:"tasks"`
		OldestStartedAt *int64 `json:"oldestStartedAt"`
	} `json:"backgroundWork"`
}

// Options configure a Supervisor.
type Options struct {
	Runtime    Runtime
	GatewayURL string
	Resolve    Resolver
	// BaseEnv is the environment every runtime starts with (PATH, HOME, NODE_COMPILE_CACHE...); nothing else of the
	// app's own environment reaches a runtime.
	BaseEnv map[string]string
	// OnStatus is told of every status change. OnStarted gets the runtime's status right after each start.
	OnStatus  func(StatusChange)
	OnStarted func(agentID string, status RuntimeStatus)
	// Refuse, when set, is asked before each start whether the agent may run on this runtime (the storage version
	// check): a non-nil error refuses the start with that error.
	Refuse func(agentID string) error
	// RedactLog, when set, makes the function that cleans each line a runtime writes to its log, given the runtime's whole
	// environment (so it can hide its own secret values). Without it, lines are written as they come.
	RedactLog func(env map[string]string) func(string) string

	IdleTimeout   time.Duration // default 10 min
	BackgroundMax time.Duration // default 2 h
	ReapInterval  time.Duration // default 30 s
	StartTimeout  time.Duration // default 30 s
	StopGrace     time.Duration // default 20 s
}

// ErrClosed: the supervisor is shutting down.
var ErrClosed = errors.New("supervisor closed")

// StartError is a runtime that could not be started; Message is for people (from its log when it said why).
type StartError struct {
	AgentID string
	Code    int // exit code, or -1
	Message string
}

func (e *StartError) Error() string {
	return fmt.Sprintf("agent %s did not start: %s", e.AgentID, e.Message)
}

// Supervisor runs agents.
type Supervisor struct {
	opts         Options
	client       *http.Client
	startProcess process.Starter // process.Start; injectable without launching a native app

	mu      sync.Mutex
	agents  map[string]*agentState
	keysMu  sync.Mutex
	keys    map[string]map[*proc]string // agent ID → its running (or starting) runtimes' gateway keys
	closed  bool
	stopped chan struct{}
	wg      sync.WaitGroup
}

type agentState struct {
	lock      sync.Mutex // serializes wake and stop of this agent
	proc      *proc      // guarded by Supervisor.mu
	status    Status     // guarded by Supervisor.mu
	lastError string     // guarded by Supervisor.mu
	failures  int        // consecutive crashes, for the restart backoff; guarded by Supervisor.mu
	// gen counts configuration changes (Invalidate); checked is the newest one a finished wake has applied. While
	// they differ, calls go through wake (and wait for a restart in progress). Guarded by Supervisor.mu.
	gen, checked uint64
}

type proc struct {
	agentID  string
	cmd      *exec.Cmd
	tree     process.Tree
	cleanup  sync.Once
	stdout   io.ReadCloser
	stdin    io.WriteCloser
	base     string
	token    string
	key      string
	revision int
	// fingerprint is a hash of the environment the runtime was started with: any difference (a new key, another
	// model, a changed instruction) means the agent restarts on its next wake.
	fingerprint string
	started     time.Time
	done        chan struct{}
	exitCode    int
	stopping    bool // guarded by Supervisor.mu: an intended stop
	log         *logFile
	// inflight counts calls on their way to it; lastCall is when the last one began (unix ns). The reaper keeps a
	// runtime awake meanwhile: a message it has accepted may not show in its status yet.
	inflight atomic.Int64
	lastCall atomic.Int64
}

// recentlyUsed reports whether the supervisor itself sent or started this runtime within idle, or a call is under way:
// the runtime's own status can't show work it is only just receiving (a fresh runtime has no activity at all).
func (p *proc) recentlyUsed(now time.Time, idle time.Duration) bool {
	if p.inflight.Load() > 0 {
		return true
	}
	last := max(p.started.UnixNano(), p.lastCall.Load())
	return now.Sub(time.Unix(0, last)) < idle
}

func (p *proc) alive() bool {
	select {
	case <-p.done:
		return false
	default:
		return true
	}
}

// New makes a supervisor and starts its idle reaper.
func New(opts Options) *Supervisor {
	if opts.IdleTimeout == 0 {
		opts.IdleTimeout = 10 * time.Minute
	}
	if opts.BackgroundMax == 0 {
		opts.BackgroundMax = 2 * time.Hour
	}
	if opts.ReapInterval == 0 {
		opts.ReapInterval = 30 * time.Second
	}
	if opts.StartTimeout == 0 {
		opts.StartTimeout = 30 * time.Second
	}
	if opts.StopGrace == 0 {
		opts.StopGrace = 20 * time.Second
	}
	if opts.OnStatus == nil {
		opts.OnStatus = func(StatusChange) {}
	}
	s := &Supervisor{
		opts:         opts,
		startProcess: process.Start,
		// No overall timeout: event streams stay open. Loopback only, so dialing is instant or refused.
		client:  &http.Client{Transport: &http.Transport{Proxy: nil, DisableCompression: true, MaxIdleConnsPerHost: 16}},
		agents:  map[string]*agentState{},
		keys:    map[string]map[*proc]string{},
		stopped: make(chan struct{}),
	}
	s.wg.Add(1)
	go s.reapLoop()
	return s
}

func (s *Supervisor) state(id string) *agentState {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, ok := s.agents[id]
	if !ok {
		st = &agentState{status: Asleep}
		s.agents[id] = st
	}
	return st
}

func (s *Supervisor) setStatus(id string, st *agentState, status Status, lastError string) {
	s.mu.Lock()
	changed := st.status != status || st.lastError != lastError
	st.status, st.lastError = status, lastError
	s.mu.Unlock()
	if changed {
		s.opts.OnStatus(StatusChange{AgentID: id, Status: status, LastError: lastError})
	}
}

// Recheck clears a failed agent's error when its configuration can now be resolved (its model is back, or it was
// given another): it is asleep again, and wakes on its next message. Anything else is left as it is.
func (s *Supervisor) Recheck(ctx context.Context, id string) {
	s.mu.Lock()
	st, ok := s.agents[id]
	failed := ok && st.status == Failed && (st.proc == nil || !st.proc.alive())
	s.mu.Unlock()
	if !failed {
		return
	}
	if _, err := s.opts.Resolve(ctx, id); err != nil {
		return
	}
	s.setStatus(id, st, Asleep, "")
}

// Status is an agent's current runtime status and, when it failed, why.
func (s *Supervisor) Status(id string) (Status, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, ok := s.agents[id]
	if !ok {
		return Asleep, ""
	}
	return st.status, st.lastError
}

// liveEnv are variables a running runtime takes new values of without restarting (the app tells it): a change in
// them doesn't make the configuration stale. The next start still gets the current value in its environment.
var liveEnv = map[string]bool{"TOOL_APPROVALS": true}

// fingerprint hashes an agent's resolved environment (in memory only: it covers secrets).
func fingerprint(env map[string]string) string {
	keys := make([]string, 0, len(env))
	for k := range env {
		if !liveEnv[k] {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	h := sha256.New()
	for _, k := range keys {
		h.Write([]byte(k))
		h.Write([]byte{0})
		h.Write([]byte(env[k]))
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil))
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// Wake makes sure the agent's runtime runs with its current configuration, starting it (or restarting it, when its
// configuration changed since it started) as needed.
func (s *Supervisor) Wake(ctx context.Context, id string) error {
	_, err := s.wake(ctx, id)
	return err
}

// Invalidate says an agent's configuration changed (its agent.yaml, model, keys, MCP servers, teams): its next call
// resolves it again, and restarts the runtime if it differs, before the call goes through. Call it in the request
// that made the change, so a message sent right after never reaches the old runtime.
func (s *Supervisor) Invalidate(id string) {
	st := s.state(id)
	s.mu.Lock()
	st.gen++
	s.mu.Unlock()
}

// running is the agent's runtime when it is up, not stopping and not stale: what a call uses as it is (resolving
// reads the keychain, under the agent's lock). After a change (Invalidate) the call goes through wake.
func (s *Supervisor) running(id string) *proc {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, ok := s.agents[id]
	if !ok || st.proc == nil || s.closed || st.gen != st.checked {
		return nil
	}
	if p := st.proc; p.alive() && !p.stopping {
		return p
	}
	return nil
}

func (s *Supervisor) wake(ctx context.Context, id string) (*proc, error) {
	st := s.state(id)
	st.lock.Lock()
	defer st.lock.Unlock()
	s.mu.Lock()
	closed := s.closed
	current := st.proc
	gen := st.gen // the changes this wake applies; a later one makes the agent stale again
	s.mu.Unlock()
	if closed {
		return nil, ErrClosed
	}
	applied := func(p *proc, err error) (*proc, error) {
		if err == nil {
			s.mu.Lock()
			st.checked = max(st.checked, gen)
			s.mu.Unlock()
		}
		return p, err
	}
	spec, err := s.opts.Resolve(ctx, id)
	if err != nil {
		// An agent that can't run as configured (its model was removed): that is its status until it changes.
		var se *StartError
		if errors.As(err, &se) {
			s.setStatus(id, st, Failed, se.Message)
		}
		return nil, err
	}
	if current != nil && current.alive() {
		if current.fingerprint == fingerprint(spec.Env) {
			return applied(current, nil)
		}
		slog.Info("agent configuration changed; restarting its runtime", "agent", id, "revision", spec.Revision)
		s.stopProc(st, current)
	}
	if s.opts.Refuse != nil {
		if err := s.opts.Refuse(id); err != nil {
			s.setStatus(id, st, Failed, err.Error())
			return nil, &StartError{AgentID: id, Code: -1, Message: err.Error()}
		}
	}
	return applied(s.start(ctx, id, st, spec))
}

const readyPrefix = "PI_RUNTIME_READY "

// start runs the process and waits for it to listen. Exit 3 (another process still owns the storage, e.g. the last
// runtime is still letting go) is retried until the start timeout.
func (s *Supervisor) start(ctx context.Context, id string, st *agentState, spec Spec) (*proc, error) {
	s.setStatus(id, st, Starting, "")
	deadline := time.Now().Add(s.opts.StartTimeout)
	for attempt := 0; ; attempt++ {
		p, err := s.spawn(ctx, id, spec, deadline)
		if err == nil {
			s.mu.Lock()
			st.proc = p
			s.mu.Unlock()
			s.setStatus(id, st, Awake, "")
			s.afterStart(ctx, p)
			s.wg.Add(1)
			go s.monitor(id, st, p)
			return p, nil
		}
		var se *StartError
		if errors.As(err, &se) && se.Code == 3 && time.Now().Before(deadline) && ctx.Err() == nil {
			time.Sleep(min(time.Duration(attempt+1)*200*time.Millisecond, time.Second))
			continue
		}
		msg := err.Error()
		if errors.As(err, &se) {
			msg = se.Message
		}
		s.setStatus(id, st, Failed, msg)
		return nil, err
	}
}

func (s *Supervisor) spawn(ctx context.Context, id string, spec Spec, deadline time.Time) (*proc, error) {
	launchCtx, cancelLaunch := context.WithDeadline(ctx, deadline)
	defer cancelLaunch()
	if err := launchCtx.Err(); err != nil {
		return nil, err
	}
	logs, err := openLog(spec.LogDir)
	if err != nil {
		return nil, err
	}
	p := &proc{agentID: id, token: randomHex(24), revision: spec.Revision, fingerprint: fingerprint(spec.Env), started: time.Now(), done: make(chan struct{}), log: logs}
	p.key = "pl." + id + "." + randomHex(24)

	env := map[string]string{}
	for k, v := range s.opts.BaseEnv {
		env[k] = v
	}
	for k, v := range spec.Env {
		env[k] = v
	}
	env["AGENT_ID"] = id
	env["RUNTIME_TOKEN"] = p.token
	env["HOST"] = "127.0.0.1"
	env["PORT"] = "0"
	env["RUNTIME_WATCH_STDIN"] = "true"
	if s.opts.GatewayURL != "" {
		env["PLATFORM_GATEWAY_URL"] = s.opts.GatewayURL
		env["PLATFORM_KEY"] = p.key
		if env["MODEL_USAGE_URL"] != "" {
			env["MODEL_USAGE_KEY"] = p.key
		}
	}
	args := append(append([]string{}, s.opts.Runtime.Args...), s.opts.Runtime.Script)
	cmd := exec.Command(s.opts.Runtime.Node, args...)
	p.cmd = cmd
	cmd.Dir = s.opts.Runtime.Dir
	cmd.Env = make([]string, 0, len(env))
	for k, v := range env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	// Bound exec's stderr copier even if an escaped descendant keeps it open.
	cmd.WaitDelay = 2 * time.Second
	if s.opts.RedactLog != nil {
		logs.redact = s.opts.RedactLog(env)
	}
	cmd.Stderr = logs
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		p.close()
		return nil, err
	}
	p.stdout = stdout
	if p.stdin, err = cmd.StdinPipe(); err != nil {
		p.close()
		return nil, err
	}
	// The key works from the first instant: the runtime reports its threads as soon as it starts.
	s.registerKey(p)
	logs.Note(fmt.Sprintf("starting runtime (revision %d)", spec.Revision))
	p.tree, err = s.startProcess(launchCtx, cmd)
	if err != nil {
		s.unregisterKey(p)
		p.close()
		return nil, &StartError{AgentID: id, Code: -1, Message: "could not run node: " + err.Error()}
	}
	ready := make(chan int, 1)
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 64*1024), 1024*1024)
		for scanner.Scan() {
			line := scanner.Text()
			if strings.HasPrefix(line, readyPrefix) {
				var r struct {
					Port int `json:"port"`
				}
				if json.Unmarshal([]byte(line[len(readyPrefix):]), &r) == nil && r.Port > 0 {
					select {
					case ready <- r.Port:
					default:
					}
				}
			}
			logs.Line(line)
		}
		io.Copy(io.Discard, stdout)
	}()
	go func() {
		err := p.tree.Wait()
		<-readDone
		p.exitCode = cmd.ProcessState.ExitCode()
		if err != nil && p.exitCode == -1 {
			p.exitCode = -1
		}
		logs.Note(fmt.Sprintf("runtime exited (code %d)", p.exitCode))
		close(p.done)
	}()

	timer := time.NewTimer(time.Until(deadline))
	defer timer.Stop()
	select {
	case port := <-ready:
		p.base = fmt.Sprintf("http://127.0.0.1:%d", port)
		return p, nil
	case <-p.done:
		s.unregisterKey(p)
		p.close()
		return nil, &StartError{AgentID: id, Code: p.exitCode, Message: exitReason(p.exitCode, logs.Tail())}
	case <-timer.C:
	case <-ctx.Done():
	}
	s.kill(p)
	<-p.done
	s.unregisterKey(p)
	p.close()
	return nil, &StartError{AgentID: id, Code: -1, Message: "the runtime did not start in time"}
}

func exitReason(code int, tail string) string {
	last := ""
	for _, line := range strings.Split(strings.TrimSpace(tail), "\n") {
		if strings.TrimSpace(line) != "" && !strings.Contains(line, "ExperimentalWarning") && !strings.Contains(line, "--trace-warnings") {
			last = strings.TrimSpace(line)
		}
	}
	switch code {
	case 2:
		if last != "" {
			return "misconfigured: " + last
		}
		return "misconfigured"
	case 3:
		return "another process owns the agent's storage"
	}
	if last != "" {
		return fmt.Sprintf("exited with code %d: %s", code, last)
	}
	return fmt.Sprintf("exited with code %d", code)
}

// afterStart reads the runtime's status once (its versions, for the storage version record).
func (s *Supervisor) afterStart(ctx context.Context, p *proc) {
	if s.opts.OnStarted == nil {
		return
	}
	status, err := s.readStatus(ctx, p)
	if err != nil {
		slog.Warn("reading a started runtime's status", "agent", p.agentID, "err", err)
		return
	}
	s.opts.OnStarted(p.agentID, status)
}

// monitor waits for a runtime to exit. An exit nobody asked for is a crash: the agent is started again after a
// backoff (1 s doubling to 30 s, reset after a minute of running), so work it left in storage resumes.
func (s *Supervisor) monitor(id string, st *agentState, p *proc) {
	defer s.wg.Done()
	<-p.done
	s.unregisterKey(p)
	p.close()
	s.mu.Lock()
	if st.proc == p {
		st.proc = nil
	}
	intended := p.stopping
	closed := s.closed
	if !intended {
		if time.Since(p.started) > time.Minute {
			st.failures = 0
		}
		st.failures++
	}
	failures := st.failures
	s.mu.Unlock()
	if intended || closed {
		s.setStatus(id, st, Asleep, "")
		return
	}
	reason := exitReason(p.exitCode, p.log.Tail())
	slog.Warn("agent runtime exited unexpectedly", "agent", id, "code", p.exitCode, "reason", reason)
	if p.exitCode == 2 {
		s.setStatus(id, st, Failed, reason)
		return
	}
	s.setStatus(id, st, Failed, reason)
	delay := min(time.Duration(1<<min(failures-1, 5))*time.Second, 30*time.Second)
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		select {
		case <-time.After(delay):
		case <-s.stopped:
			return
		}
		if _, err := s.wake(context.Background(), id); err != nil && !errors.Is(err, ErrClosed) {
			slog.Warn("restarting a crashed agent", "agent", id, "err", err)
		}
	}()
}

// close releases launch resources once, including on failures before Start.
// Keep Tree.Close after stopping/reaping: Windows will need its job handle here.
func (p *proc) close() {
	p.cleanup.Do(func() {
		if p.stdin != nil {
			p.stdin.Close()
		}
		if p.tree != nil {
			p.tree.Close()
		} else if p.cmd != nil {
			// A refusal before cmd.Start leaves both child pipe ends open;
			// os/exec only cleans them when Start itself is attempted.
			if f, ok := p.cmd.Stdin.(io.Closer); ok {
				f.Close()
			}
			if f, ok := p.cmd.Stdout.(io.Closer); ok {
				f.Close()
			}
		}
		if p.stdout != nil {
			p.stdout.Close()
		}
		p.log.Close()
	})
}

func (s *Supervisor) kill(p *proc) {
	if p.tree != nil {
		_ = p.tree.KillTree()
	}
}

// stopProc stops a runtime gracefully (SIGTERM to its process group: work in flight stays pending in storage), then
// kills it after the grace period. Called with the agent's lock held.
func (s *Supervisor) stopProc(st *agentState, p *proc) {
	s.mu.Lock()
	p.stopping = true
	s.mu.Unlock()
	_ = p.tree.GracefulStop(s.opts.StopGrace)
	<-p.done
	p.close()
	s.mu.Lock()
	if st.proc == p {
		st.proc = nil
	}
	s.mu.Unlock()
}

// Stop hibernates an agent: its runtime stops, its storage keeps everything, and the next request starts it again.
func (s *Supervisor) Stop(id string) {
	st := s.state(id)
	st.lock.Lock()
	defer st.lock.Unlock()
	s.mu.Lock()
	p := st.proc
	s.mu.Unlock()
	if p != nil && p.alive() {
		s.stopProc(st, p)
	}
	s.setStatus(id, st, Asleep, "")
}

// Quiesce stops an agent's runtime (gracefully: work in flight stays pending in its storage) and keeps it stopped
// while fn runs, so fn may read the agent's storage, which a running runtime holds open exclusively. Anything that
// would wake the agent waits until fn returns. It reports whether the agent was awake; the caller wakes it again
// (Wake) when it should be.
func (s *Supervisor) Quiesce(id string, fn func() error) (wasAwake bool, err error) {
	st := s.state(id)
	st.lock.Lock()
	defer st.lock.Unlock()
	s.mu.Lock()
	p := st.proc
	s.mu.Unlock()
	if p != nil && p.alive() {
		wasAwake = true
		s.stopProc(st, p)
		s.setStatus(id, st, Asleep, "")
	}
	return wasAwake, fn()
}

// Forget stops an agent and drops what the supervisor knows of it (the agent was deleted).
func (s *Supervisor) Forget(id string) {
	s.Stop(id)
	s.mu.Lock()
	delete(s.agents, id)
	s.mu.Unlock()
}

// Close stops every runtime gracefully and the reaper. Work in flight stays pending in each agent's storage.
func (s *Supervisor) Close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	close(s.stopped)
	ids := make([]string, 0, len(s.agents))
	for id := range s.agents {
		ids = append(ids, id)
	}
	s.mu.Unlock()
	var wg sync.WaitGroup
	for _, id := range ids {
		wg.Add(1)
		go func() {
			defer wg.Done()
			st := s.state(id)
			st.lock.Lock()
			defer st.lock.Unlock()
			s.mu.Lock()
			p := st.proc
			s.mu.Unlock()
			if p != nil && p.alive() {
				s.stopProc(st, p)
			}
		}()
	}
	wg.Wait()
	s.wg.Wait()
}

// Awake lists the agents whose runtime is running.
func (s *Supervisor) Awake() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var ids []string
	for id, st := range s.agents {
		if st.proc != nil && st.proc.alive() {
			ids = append(ids, id)
		}
	}
	return ids
}

// Call sends a request to the agent's runtime, starting it first if needed, with its token. pathAndQuery starts
// with "/". A runtime that died between the start and the request is started again once.
func (s *Supervisor) Call(ctx context.Context, id, method, pathAndQuery string, body []byte, header http.Header) (*http.Response, error) {
	for attempt := 0; ; attempt++ {
		p := s.running(id)
		if p == nil || attempt > 0 {
			var err error
			if p, err = s.wake(ctx, id); err != nil {
				return nil, err
			}
		}
		var reader io.Reader
		if body != nil {
			reader = strings.NewReader(string(body))
		}
		req, err := http.NewRequestWithContext(ctx, method, p.base+pathAndQuery, reader)
		if err != nil {
			return nil, err
		}
		for k, vs := range header {
			for _, v := range vs {
				req.Header.Add(k, v)
			}
		}
		req.Header.Set("Authorization", "Bearer "+p.token)
		p.inflight.Add(1)
		p.lastCall.Store(time.Now().UnixNano())
		resp, err := s.client.Do(req)
		p.inflight.Add(-1)
		if err == nil {
			return resp, nil
		}
		if attempt == 0 && ctx.Err() == nil && !p.alive() {
			continue
		}
		return nil, err
	}
}

// --- gateway keys -------------------------------------------------------------------------------------------

func (s *Supervisor) registerKey(p *proc) {
	s.keysMu.Lock()
	if s.keys[p.agentID] == nil {
		s.keys[p.agentID] = map[*proc]string{}
	}
	s.keys[p.agentID][p] = p.key
	s.keysMu.Unlock()
}

func (s *Supervisor) unregisterKey(p *proc) {
	s.keysMu.Lock()
	delete(s.keys[p.agentID], p)
	if len(s.keys[p.agentID]) == 0 {
		delete(s.keys, p.agentID)
	}
	s.keysMu.Unlock()
}

// AgentForKey is the agent a gateway key belongs to: a running (or starting) runtime's PLATFORM_KEY.
func (s *Supervisor) AgentForKey(key string) (string, bool) {
	rest, ok := strings.CutPrefix(key, "pl.")
	if !ok {
		return "", false
	}
	id, _, ok := strings.Cut(rest, ".")
	if !ok {
		return "", false
	}
	s.keysMu.Lock()
	defer s.keysMu.Unlock()
	for _, k := range s.keys[id] {
		if subtle.ConstantTimeCompare([]byte(k), []byte(key)) == 1 {
			return id, true
		}
	}
	return "", false
}

// --- idle reaper --------------------------------------------------------------------------------------------

func (s *Supervisor) reapLoop() {
	defer s.wg.Done()
	ticker := time.NewTicker(s.opts.ReapInterval)
	defer ticker.Stop()
	for {
		select {
		case <-s.stopped:
			return
		case <-ticker.C:
			s.ReapOnce(context.Background())
		}
	}
}

func (s *Supervisor) readStatus(ctx context.Context, p *proc) (RuntimeStatus, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, p.base+"/status", nil)
	req.Header.Set("Authorization", "Bearer "+p.token)
	resp, err := s.client.Do(req)
	if err != nil {
		return RuntimeStatus{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return RuntimeStatus{}, fmt.Errorf("status %d", resp.StatusCode)
	}
	var out struct {
		Data RuntimeStatus `json:"data"`
	}
	// An untrusted size: read at most 64 KiB.
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64*1024)).Decode(&out); err != nil {
		return RuntimeStatus{}, err
	}
	return out.Data, nil
}

// verdict is what the reaper does with an awake agent.
type verdict int

const (
	keepAwake verdict = iota
	hibernate
	abortBackgroundThenHibernate
)

// judge decides from a runtime's status: busy threads, open streams and recent activity keep it awake; so does
// background work, until it has run longer than the ceiling, when it is aborted. Work waiting only for a person
// keeps nothing awake (it survives in storage and the decision wakes the agent).
func judge(st RuntimeStatus, now time.Time, idle, backgroundMax time.Duration) verdict {
	if st.BusyThreads > 0 || st.OpenStreams > 0 {
		return keepAwake
	}
	if bw := st.BackgroundWork; bw != nil && bw.Tasks > 0 {
		if bw.OldestStartedAt == nil || now.Sub(time.UnixMilli(*bw.OldestStartedAt)) < backgroundMax {
			return keepAwake
		}
		return abortBackgroundThenHibernate
	}
	if now.Sub(time.UnixMilli(st.LastActivityAt)) < idle {
		return keepAwake
	}
	return hibernate
}

// ReapOnce looks at every awake agent once and hibernates those that are idle.
func (s *Supervisor) ReapOnce(ctx context.Context) {
	for _, id := range s.Awake() {
		st := s.state(id)
		s.mu.Lock()
		p := st.proc
		s.mu.Unlock()
		if p == nil || !p.alive() || p.recentlyUsed(time.Now(), s.opts.IdleTimeout) {
			continue
		}
		status, err := s.readStatus(ctx, p)
		if err != nil {
			continue
		}
		switch judge(status, time.Now(), s.opts.IdleTimeout, s.opts.BackgroundMax) {
		case keepAwake:
			continue
		case abortBackgroundThenHibernate:
			slog.Info("agent's background work passed the ceiling; aborting it", "agent", id)
			body := fmt.Sprintf(`{"olderThanMs":%d}`, s.opts.BackgroundMax.Milliseconds())
			if resp, err := s.Call(ctx, id, http.MethodPost, "/background/abort", []byte(body), http.Header{"Content-Type": {"application/json"}}); err == nil {
				resp.Body.Close()
			}
			if again, err := s.readStatus(ctx, p); err != nil || judge(again, time.Now(), s.opts.IdleTimeout, s.opts.BackgroundMax) == keepAwake {
				continue
			}
		}
		// Hibernate, unless something happened since the status was read (the agent's lock serializes with wakes).
		st.lock.Lock()
		s.mu.Lock()
		same := st.proc == p
		s.mu.Unlock()
		if same && p.alive() {
			if p.recentlyUsed(time.Now(), s.opts.IdleTimeout) {
				st.lock.Unlock()
				continue
			}
			if again, err := s.readStatus(ctx, p); err == nil && judge(again, time.Now(), s.opts.IdleTimeout, s.opts.BackgroundMax) == keepAwake {
				st.lock.Unlock()
				continue
			}
			slog.Info("hibernating idle agent", "agent", id)
			s.stopProc(st, p)
			st.lock.Unlock()
			s.setStatus(id, st, Asleep, "")
			continue
		}
		st.lock.Unlock()
	}
}

// --- logs ---------------------------------------------------------------------------------------------------

// logFile appends a runtime's output to <logs>/runtime.log (rotated at 5 MiB) and keeps the last few KiB in memory.
type logFile struct {
	mu   sync.Mutex
	f    *os.File
	path string
	size int64
	tail []byte
	buf  []byte
	// redact cleans each line before it is written (secrets never reach the log or the tail).
	redact func(string) string
}

const maxLogBytes = 5 << 20
const tailBytes = 8 << 10

func openLog(dir string) (*logFile, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	path := dir + "/runtime.log"
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, err
	}
	info, _ := f.Stat()
	l := &logFile{f: f, path: path}
	if info != nil {
		l.size = info.Size()
	}
	return l, nil
}

func (l *logFile) writeLocked(b []byte) {
	if l.f == nil {
		return
	}
	if l.size+int64(len(b)) > maxLogBytes {
		l.f.Close()
		os.Rename(l.path, l.path+".1")
		if f, err := os.OpenFile(l.path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600); err == nil {
			l.f, l.size = f, 0
		} else {
			l.f = nil
			return
		}
	}
	n, _ := l.f.Write(b)
	l.size += int64(n)
	l.tail = append(l.tail, b...)
	if len(l.tail) > tailBytes {
		l.tail = l.tail[len(l.tail)-tailBytes:]
	}
}

// Write takes stderr, stamping each complete line.
func (l *logFile) Write(b []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.buf = append(l.buf, b...)
	for {
		i := strings.IndexByte(string(l.buf), '\n')
		if i < 0 {
			break
		}
		line := string(l.buf[:i+1])
		if l.redact != nil {
			line = l.redact(strings.TrimSuffix(line, "\n")) + "\n"
		}
		l.writeLocked([]byte(time.Now().Format("2006-01-02T15:04:05.000 ") + line))
		l.buf = l.buf[i+1:]
	}
	return len(b), nil
}

// Line writes one line of stdout.
func (l *logFile) Line(line string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.redact != nil {
		line = l.redact(line)
	}
	l.writeLocked([]byte(time.Now().Format("2006-01-02T15:04:05.000 ") + line + "\n"))
}

// Note writes a line from the supervisor itself.
func (l *logFile) Note(line string) { l.Line("[pi-local] " + line) }

// Tail is the last few KiB written.
func (l *logFile) Tail() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return string(l.tail) + string(l.buf)
}

func (l *logFile) Close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f != nil {
		l.f.Close()
		l.f = nil
	}
}

// PID is the agent's runtime process ID, or 0 when it isn't running (for diagnostics and tests).
func (s *Supervisor) PID(id string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, ok := s.agents[id]
	if !ok || st.proc == nil || !st.proc.alive() || st.proc.cmd.Process == nil {
		return 0
	}
	return st.proc.cmd.Process.Pid
}
