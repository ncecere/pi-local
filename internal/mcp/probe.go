package mcp

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/ncecere/pi-local/internal/supervisor"
)

// Prober runs the runtime's MCP probe (runtime.mjs mcp-probe): one server config on stdin, JSON lines out.
type Prober struct {
	Runtime supervisor.Runtime
	// Env is the probe's environment (the same minimal one agents start with).
	Env map[string]string
	// OAuthURL and Key: the gateway's OAuth state store, and the app's own key for it.
	OAuthURL string
	Key      string
	// Scratch stands in for ${workspace} and ${agentDir} when a server is tested outside any agent.
	Scratch string
	// OpenBrowser opens a sign-in page.
	OpenBrowser func(url string) error
}

type probeEvent struct {
	Type        string          `json:"type"`
	URL         string          `json:"url"`
	RedirectURL string          `json:"redirectUrl"`
	Code        string          `json:"code"`
	Message     string          `json:"message"`
	Stderr      string          `json:"stderr"`
	Tools       []Tool          `json:"tools"`
	ServerInfo  json.RawMessage `json:"serverInfo"`
}

// run starts the probe and hands each event to onEvent; it returns the final event (result or error).
func (p *Prober) run(ctx context.Context, request map[string]any, onEvent func(probeEvent)) (probeEvent, error) {
	args := append(append([]string{}, p.Runtime.Args...), p.Runtime.Script, "mcp-probe")
	cmd := exec.CommandContext(ctx, p.Runtime.Node, args...)
	cmd.Dir = p.Runtime.Dir
	for k, v := range p.Env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	raw, _ := json.Marshal(request)
	cmd.Stdin = strings.NewReader(string(raw))
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return probeEvent{}, err
	}
	var stderr strings.Builder
	cmd.Stderr = &limitedWriter{b: &stderr, max: 16 << 10}
	cmd.WaitDelay = 2 * time.Second
	// Cancelled (a timeout, the app quitting): stop the server it started too, not only the probe.
	ownGroup(cmd)
	if err := cmd.Start(); err != nil {
		return probeEvent{}, fmt.Errorf("could not run the probe: %w", err)
	}
	var last probeEvent
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64<<10), 16<<20)
	for scanner.Scan() {
		var ev probeEvent
		if json.Unmarshal(scanner.Bytes(), &ev) != nil || ev.Type == "" {
			continue
		}
		last = ev
		if onEvent != nil {
			onEvent(ev)
		}
	}
	cmd.Wait()
	if last.Type != "result" && last.Type != "error" {
		if ctx.Err() != nil {
			return probeEvent{Type: "error", Code: "timeout", Message: "The server took too long to answer."}, nil
		}
		msg := strings.TrimSpace(stderr.String())
		if len(msg) > 2000 {
			msg = msg[len(msg)-2000:]
		}
		return probeEvent{Type: "error", Code: "probe_failed", Message: "The test didn't finish.", Stderr: msg}, nil
	}
	return last, nil
}

type limitedWriter struct {
	b   *strings.Builder
	max int
}

func (w *limitedWriter) Write(p []byte) (int, error) {
	if w.b.Len() < w.max {
		w.b.Write(p[:min(len(p), w.max-w.b.Len())])
	}
	return len(p), nil
}

// request builds the probe's request for a server: as an agent would get it, paths in the scratch folder.
func (c *Catalog) request(ctx context.Context, slug string, signIn bool) (map[string]any, error) {
	p := c.prober
	s, err := c.Get(ctx, slug)
	if err != nil {
		return nil, err
	}
	os.MkdirAll(p.Scratch, 0o700)
	enabled := *s
	enabled.Enabled = true
	now := time.Now().UnixMilli()
	enabled.TestedAt = &now // ForAgent leaves untested servers out
	resolved, err := c.resolveOne(ctx, &enabled, p.Scratch, p.Scratch)
	if err != nil {
		return nil, err
	}
	req := map[string]any{"server": resolved, "signIn": signIn, "oauthUrl": p.OAuthURL, "key": p.Key}
	if signIn {
		req["timeoutMs"] = 5 * 60 * 1000
		if u, err := url.Parse(s.redirectURL); err == nil && u.Port() != "" {
			if port, err := strconv.Atoi(u.Port()); err == nil {
				req["callbackPort"] = port
			}
		}
	} else {
		req["timeoutMs"] = 60 * 1000
	}
	return req, nil
}

// resolveOne is one server as a test gets it: every tool, paths in the scratch folder.
func (c *Catalog) resolveOne(_ context.Context, s *Server, workspace, agentDir string) (RuntimeServer, error) {
	return c.runtimeServer(s, Choice{Server: s.Slug}, workspace, agentDir)
}

func describe(ev probeEvent) string {
	msg := ev.Message
	if ev.Code == "needs_sign_in" {
		msg = "needs_sign_in: " + msg + " Choose Sign in."
	}
	if ev.Stderr != "" {
		tail := strings.TrimSpace(ev.Stderr)
		if len(tail) > 1500 {
			tail = "…" + tail[len(tail)-1500:]
		}
		msg += "\n\n" + tail
	}
	return msg
}

// Test connects to a server and lists its tools (at most a minute), and keeps the outcome.
func (c *Catalog) Test(ctx context.Context, slug string) (*Server, error) {
	req, err := c.request(ctx, slug, false)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 75*time.Second)
	defer cancel()
	final, err := c.prober.run(ctx, req, nil)
	if err != nil {
		return nil, err
	}
	if final.Type == "result" {
		c.recordTest(context.Background(), slug, final.Tools, "")
	} else {
		c.recordTest(context.Background(), slug, nil, describe(final))
	}
	s, err := c.Get(context.Background(), slug)
	if err == nil {
		c.OnChange(slug, s)
	}
	return s, err
}

// SignIn starts an OAuth sign-in: the probe listens for the redirect and names the page to open, which is opened in
// the browser. It returns that page's URL; the outcome is kept (and announced through OnChange) when the person is
// done, within five minutes.
func (c *Catalog) SignIn(ctx context.Context, slug string) (string, error) {
	s, err := c.Get(ctx, slug)
	if err != nil {
		return "", err
	}
	if !s.OAuth {
		return "", bad("not_oauth", "%s doesn't sign in with OAuth.", s.Name)
	}
	if _, busy := c.signings.LoadOrStore(slug, struct{}{}); busy {
		return "", &Error{Status: 409, Code: "signing_in", Message: "A sign-in to " + s.Name + " is already in progress: finish it in your browser."}
	}
	req, err := c.request(ctx, slug, true)
	if err != nil {
		c.signings.Delete(slug)
		return "", err
	}
	authorize := make(chan string, 1)
	go func() {
		defer c.signings.Delete(slug)
		runCtx, cancel := context.WithTimeout(context.Background(), 6*time.Minute)
		defer cancel()
		final, err := c.prober.run(runCtx, req, func(ev probeEvent) {
			if ev.Type == "authorize" {
				c.setRedirect(context.Background(), slug, ev.RedirectURL)
				if c.prober.OpenBrowser != nil {
					if err := c.prober.OpenBrowser(ev.URL); err != nil {
						slog.Warn("opening the sign-in page", "server", slug, "err", err)
					}
				}
				select {
				case authorize <- ev.URL:
				default:
				}
			}
		})
		close(authorize)
		if err != nil {
			c.recordTest(context.Background(), slug, nil, err.Error())
		} else if final.Type == "result" {
			c.recordTest(context.Background(), slug, final.Tools, "")
		} else {
			c.recordTest(context.Background(), slug, nil, describe(final))
		}
		if s, err := c.Get(context.Background(), slug); err == nil {
			c.OnChange(slug, s)
		}
	}()
	select {
	case u, ok := <-authorize:
		if ok {
			return u, nil
		}
		// Done without a page to open: already signed in (or it failed at once; the server says which).
		return "", nil
	case <-time.After(30 * time.Second):
		return "", &Error{Status: 504, Code: "sign_in_slow", Message: "The server didn't start a sign-in in time."}
	}
}
