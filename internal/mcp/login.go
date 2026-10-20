package mcp

// A local (stdio) server's own sign-in: its command run with its sign-in arguments (`m365-mcp login`, `tdx-mcp login`),
// on request, once at a time per server. MCP's OAuth only covers remote servers; a local one signs in however its
// program does (a browser it opens, a device code or a link it prints), so the app runs it and shows what it says.
// The output is kept in memory only (the last 16 KiB) and never logged.

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"
)

// LoginStatus is how a sign-in command is doing.
type LoginStatus struct {
	Slug string `json:"slug"`
	// State: idle (never run), running, succeeded, failed or cancelled.
	State      string `json:"state"`
	Output     string `json:"output"`
	ExitCode   *int   `json:"exitCode"`
	StartedAt  *int64 `json:"startedAt"`
	FinishedAt *int64 `json:"finishedAt"`
}

const (
	loginTimeout   = 10 * time.Minute
	loginOutputMax = 16 << 10
	loginNotifyGap = 150 * time.Millisecond
)

type loginRun struct {
	mu        sync.Mutex
	status    LoginStatus
	out       []byte
	cancel    context.CancelFunc
	cancelled bool
}

func (r *loginRun) snapshot() LoginStatus {
	r.mu.Lock()
	defer r.mu.Unlock()
	st := r.status
	st.Output = string(r.out)
	return st
}

// ansi matches terminal escape sequences (colours, cursor moves) and the OSC hyperlinks some CLIs print.
var ansi = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]`)

// Write takes the command's output: escape sequences dropped, carriage-return redraws kept as lines, the tail kept.
func (r *loginRun) Write(p []byte) (int, error) {
	clean := ansi.ReplaceAll(p, nil)
	clean = bytes.ReplaceAll(clean, []byte("\r\n"), []byte("\n"))
	clean = bytes.ReplaceAll(clean, []byte("\r"), []byte("\n"))
	r.mu.Lock()
	r.out = append(r.out, clean...)
	if over := len(r.out) - loginOutputMax; over > 0 {
		r.out = r.out[over:]
	}
	r.mu.Unlock()
	return len(p), nil
}

// Login starts a stdio server's sign-in command. Its progress goes to OnLogin; Status reads it.
func (c *Catalog) Login(ctx context.Context, slug string) (LoginStatus, error) {
	s, err := c.Get(ctx, slug)
	if err != nil {
		return LoginStatus{}, err
	}
	if s.Transport != "stdio" || len(s.LoginArgs) == 0 || s.Command == nil {
		return LoginStatus{}, bad("no_login", "%s has no sign-in command: add its sign-in arguments in its settings.", s.Name)
	}
	select {
	case <-c.closed:
		return LoginStatus{}, &Error{Status: http.StatusServiceUnavailable, Code: "closing", Message: "Pi Local is quitting."}
	default:
	}
	if prev, ok := c.logins.Load(slug); ok && prev.(*loginRun).snapshot().State == "running" {
		return prev.(*loginRun).snapshot(), &Error{Status: http.StatusConflict, Code: "login_running", Message: "A sign-in to " + s.Name + " is already running."}
	}
	env, err := c.secretMap(envKey(slug))
	if err != nil {
		return LoginStatus{}, err
	}

	runCtx, cancel := context.WithTimeout(context.Background(), loginTimeout)
	cmd := exec.CommandContext(runCtx, *s.Command, s.LoginArgs...)
	cmd.Env = loginEnv(env)
	cmd.Dir = loginDir(s.Cwd)
	run := &loginRun{cancel: cancel}
	cmd.Stdout, cmd.Stderr = run, run // stdin is /dev/null: a sign-in can't wait for typing here
	cmd.WaitDelay = 3 * time.Second
	ownGroup(cmd)

	now := time.Now().UnixMilli()
	run.status = LoginStatus{Slug: slug, State: "running", StartedAt: &now}
	if err := cmd.Start(); err != nil {
		cancel()
		end := time.Now().UnixMilli()
		run.status.State, run.status.FinishedAt = "failed", &end
		run.out = []byte("Couldn't start " + *s.Command + ": " + err.Error() + "\n")
		c.logins.Store(slug, run)
		c.OnLogin(run.snapshot())
		return run.snapshot(), nil
	}
	c.logins.Store(slug, run)
	c.OnLogin(run.snapshot())
	c.loginsWG.Add(2)

	// Output as it comes, at most every loginNotifyGap.
	done := make(chan struct{})
	go func() {
		defer c.loginsWG.Done()
		tick := time.NewTicker(loginNotifyGap)
		defer tick.Stop()
		sent := 0
		for {
			select {
			case <-done:
				return
			case <-tick.C:
				run.mu.Lock()
				n := len(run.out)
				run.mu.Unlock()
				if n != sent {
					sent = n
					c.OnLogin(run.snapshot())
				}
			}
		}
	}()
	go func() {
		defer c.loginsWG.Done()
		err := cmd.Wait()
		close(done)
		cancel()
		end := time.Now().UnixMilli()
		run.mu.Lock()
		code := cmd.ProcessState.ExitCode()
		run.status.ExitCode, run.status.FinishedAt = &code, &end
		switch {
		case run.cancelled:
			run.status.State = "cancelled"
		case err == nil:
			run.status.State = "succeeded"
		default:
			run.status.State = "failed"
			if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
				run.out = append(run.out, []byte("\nStopped: the sign-in took longer than 10 minutes.\n")...)
			}
		}
		state := run.status.State
		run.mu.Unlock()
		c.OnLogin(run.snapshot())
		if state == "succeeded" {
			// Signed in: test it again, so its tools (and any "not signed in" error) are current (unless quitting).
			testCtx, stop := context.WithTimeout(context.Background(), 2*time.Minute)
			defer stop()
			go func() {
				select {
				case <-c.closed:
					stop()
				case <-testCtx.Done():
				}
			}()
			c.Test(testCtx, slug)
		}
	}()
	return run.snapshot(), nil
}

// LoginState is the current or last sign-in command of a server (state idle when there was none).
func (c *Catalog) LoginState(ctx context.Context, slug string) (LoginStatus, error) {
	if _, err := c.Get(ctx, slug); err != nil {
		return LoginStatus{}, err
	}
	if run, ok := c.logins.Load(slug); ok {
		return run.(*loginRun).snapshot(), nil
	}
	return LoginStatus{Slug: slug, State: "idle"}, nil
}

// CancelLogin stops a running sign-in command.
func (c *Catalog) CancelLogin(ctx context.Context, slug string) (LoginStatus, error) {
	st, err := c.LoginState(ctx, slug)
	if err != nil || st.State != "running" {
		return st, err
	}
	v, _ := c.logins.Load(slug)
	run := v.(*loginRun)
	run.mu.Lock()
	run.cancelled = true
	run.mu.Unlock()
	run.cancel()
	return run.snapshot(), nil
}

// Close stops running sign-in commands and waits for them (and a re-test after one) to end.
func (c *Catalog) Close() {
	select {
	case <-c.closed:
	default:
		close(c.closed)
	}
	c.logins.Range(func(_, v any) bool {
		v.(*loginRun).cancel()
		return true
	})
	c.loginsWG.Wait()
}

// forgetLogin stops and drops a deleted server's sign-in.
func (c *Catalog) forgetLogin(slug string) {
	if v, ok := c.logins.LoadAndDelete(slug); ok {
		v.(*loginRun).cancel()
	}
}

// loginEnv is the app's own environment and the server's env values (theirs win), as a person's terminal would have.
func loginEnv(server map[string]string) []string {
	env := map[string]string{}
	for _, kv := range os.Environ() {
		if k, v, ok := strings.Cut(kv, "="); ok {
			env[k] = v
		}
	}
	for k, v := range server {
		env[k] = v
	}
	out := make([]string, 0, len(env))
	for k, v := range env {
		out = append(out, k+"="+v)
	}
	return out
}

// loginDir is the server's working directory when it is a plain folder, else the home folder (${workspace} is per agent).
func loginDir(cwd *string) string {
	if cwd != nil && *cwd != "" && !strings.Contains(*cwd, "${") {
		if info, err := os.Stat(*cwd); err == nil && info.IsDir() {
			return *cwd
		}
	}
	home, _ := os.UserHomeDir()
	return home
}
