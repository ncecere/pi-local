package app

import (
	"bufio"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/ncecere/pi-local/internal/mcp"
	"github.com/ncecere/pi-local/internal/secrets"
)

func fixture(name string) string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "..", "runtime", "test", "fixtures", name)
}

type mcpServerJSON struct {
	Slug      string `json:"slug"`
	SignedIn  bool   `json:"signedIn"`
	TestedAt  *int64 `json:"testedAt"`
	LastError *string
	Tools     []struct {
		Name         string `json:"name"`
		ModelVisible bool   `json:"modelVisible"`
	} `json:"tools"`
	EnvNames []string `json:"envNames"`
}

func TestAStdioMCPServer(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	node, _ := exec.LookPath("node")
	keychain := h.app.cfg.Secrets.(*secrets.Memory)

	// Added and tested at once: its tools, the app-only one marked.
	s := decodeInto[mcpServerJSON](t, h.mustDo("POST", "/api/mcp/servers", map[string]any{
		"name": "Fixture", "transport": "stdio", "command": node, "args": []string{fixture("stdio-mcp-server.mjs")},
		"env": map[string]string{"FIXTURE_VALUE": "from-the-keychain"},
	}, 201))
	if s.Slug != "fixture" || s.TestedAt == nil || len(s.Tools) != 3 || s.Tools[1].Name != "app_only" || s.Tools[1].ModelVisible {
		t.Fatalf("the tested server: %+v (error %v)", s, s.LastError)
	}
	if v, _ := keychain.Get("mcp:fixture:env"); !strings.Contains(v, "from-the-keychain") {
		t.Fatalf("the env value should be in the keychain: %q", v)
	}
	if strings.Contains(string(dbBytes(t, h.app.cfg.DataDir)), "from-the-keychain") {
		t.Fatal("an env value was written to app.db")
	}

	// An agent using it: the tool runs in the agent's workspace, with the secret env.
	scripted(t, h)
	agent := h.agentOn("Toolsmith", "script/s1", map[string]any{"mcp": []map[string]any{{"server": "fixture"}}})
	v := h.sendAndWait(agent, "t1", `CALL:mcp__fixture__echo:{"text":"hi"}`, "r1")
	reply := lastReply(v)
	ws, _ := filepath.EvalSymlinks(filepath.Join(h.app.cfg.DataDir, "agents", agent, "workspace"))
	if !strings.Contains(reply, "echo: hi") || !strings.Contains(reply, "value: from-the-keychain") || !strings.Contains(reply, "cwd: "+ws) {
		t.Fatalf("the MCP tool's answer: %q (workspace %s)", reply, ws)
	}

	// Only some tools: the others aren't there.
	h.mustDo("PATCH", "/api/agents/"+agent, map[string]any{"mcp": []map[string]any{{"server": "fixture", "tools": []string{"fail"}}}}, 200)
	v = h.sendAndWait(agent, "t2", `CALL:mcp__fixture__echo:{"text":"hi"}`, "r2")
	if reply := lastReply(v); strings.Contains(reply, "echo: hi") {
		t.Fatalf("a tool that wasn't chosen ran: %q", reply)
	}
	if code, data := h.do("PATCH", "/api/agents/"+agent, map[string]any{"mcp": []map[string]any{{"server": "nope"}}}); code != 400 || !strings.Contains(string(data), "invalid_mcp") {
		t.Fatalf("an unknown server: %d %s", code, data)
	}

	// In use: it can't be deleted; once no agent uses it, it goes with its keychain items.
	if code, data := h.do("DELETE", "/api/mcp/servers/fixture", nil); code != 409 || !strings.Contains(string(data), "Toolsmith") {
		t.Fatalf("deleting a server in use: %d %s", code, data)
	}
	h.mustDo("PATCH", "/api/agents/"+agent, map[string]any{"mcp": []any{}}, 200)
	h.mustDo("DELETE", "/api/mcp/servers/fixture", nil, 200)
	for _, n := range keychain.Names() {
		if strings.HasPrefix(n, "mcp:fixture:") {
			t.Fatalf("keychain item left: %s", n)
		}
	}
}

func TestAServerThatWontStartSaysWhy(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	node, _ := exec.LookPath("node")
	s := decodeInto[mcpServerJSON](t, h.mustDo("POST", "/api/mcp/servers", map[string]any{
		"name": "Broken", "transport": "stdio", "command": node, "args": []string{fixture("stdio-mcp-server.mjs")},
		"env": map[string]string{"FIXTURE_CRASH": "1"},
	}, 201))
	if s.LastError == nil || !strings.Contains(*s.LastError, "missing configuration") || s.TestedAt != nil {
		t.Fatalf("a server that won't start: %+v", s)
	}
	// An agent may choose it, but starts without it until it passes a test.
	scripted(t, h)
	agent := h.agentOn("Patient", "script/s1", map[string]any{"mcp": []map[string]any{{"server": "broken"}}})
	if v := h.sendAndWait(agent, "t1", "hello", "r1"); lastReply(v) == "" {
		t.Fatal("the agent should still answer")
	}
}

// startOAuthFixture runs the runtime's OAuth MCP fixture server and returns its URL.
func startOAuthFixture(t *testing.T) string {
	t.Helper()
	rt := testRuntime(t)
	cmd := exec.Command(rt.Node, "--import", "tsx", "test/fixtures/serve-oauth-mcp.ts")
	cmd.Dir = rt.Dir
	stdin, _ := cmd.StdinPipe()
	stdout, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stdin.Close(); cmd.Wait() })
	line, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil {
		t.Fatalf("the OAuth fixture didn't start: %v", err)
	}
	var out struct{ URL string }
	json.Unmarshal([]byte(line), &out)
	return out.URL
}

func TestAnOAuthMCPServer(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	url := startOAuthFixture(t)
	// The person approves in the browser at once: follow the authorization redirect back to the probe.
	h.app.MCP.SetProber(withBrowser(h.app, func(u string) error {
		go func() {
			client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
			resp, err := client.Get(u)
			if err != nil {
				return
			}
			resp.Body.Close()
			if loc := resp.Header.Get("Location"); loc != "" {
				if r, err := http.Get(loc); err == nil {
					r.Body.Close()
				}
			}
		}()
		return nil
	}))

	s := decodeInto[mcpServerJSON](t, h.mustDo("POST", "/api/mcp/servers", map[string]any{"name": "Remote", "transport": "http", "url": url, "oauth": true}, 201))
	if s.SignedIn || s.LastError == nil || !strings.Contains(*s.LastError, "needs_sign_in") {
		t.Fatalf("before signing in: %+v", s)
	}
	got := decodeInto[struct {
		AuthorizeURL *string `json:"authorizeUrl"`
	}](t, h.mustDo("POST", "/api/mcp/servers/remote/sign-in", nil, 200))
	if got.AuthorizeURL == nil || !strings.Contains(*got.AuthorizeURL, "/authorize?") {
		t.Fatalf("sign-in: %+v", got)
	}
	t.Cleanup(func() {
		if t.Failed() {
			t.Logf("servers: %s", h.mustDo("GET", "/api/mcp/servers", nil, 200))
		}
	})
	eventually(t, 30*time.Second, "the sign-in to finish", func() bool {
		for _, srv := range decodeInto[[]mcpServerJSON](t, h.mustDo("GET", "/api/mcp/servers", nil, 200)) {
			if srv.Slug == "remote" && srv.SignedIn && len(srv.Tools) == 1 {
				return true
			}
		}
		return false
	})
	// The tokens are in the keychain; an agent using the server calls it as the signed-in person.
	if v, _ := h.app.cfg.Secrets.(*secrets.Memory).Get("mcp:remote:oauth"); !strings.Contains(v, "access_token") {
		t.Fatalf("the OAuth state should be in the keychain: %q", v)
	}
	scripted(t, h)
	agent := h.agentOn("Caller", "script/s1", map[string]any{"mcp": []map[string]any{{"server": "remote"}}})
	if reply := lastReply(h.sendAndWait(agent, "t1", "CALL:mcp__remote__whoami:{}", "r1")); !strings.Contains(reply, "you are the signed-in person") {
		t.Fatalf("the agent calling the signed-in server: %q", reply)
	}
	// Signed out: the agent is told to sign in (and never starts a sign-in itself).
	h.mustDo("POST", "/api/mcp/servers/remote/sign-out", nil, 200)
	if reply := lastReply(h.sendAndWait(agent, "t2", "CALL:mcp__remote__whoami:{}", "r2")); !strings.Contains(reply, "needs you to sign in") {
		t.Fatalf("after signing out: %q", reply)
	}
}

// withBrowser is the app's prober with another way to open sign-in pages.
func withBrowser(a *App, open func(string) error) *mcp.Prober {
	p := *a.mcpProber
	p.OpenBrowser = open
	return &p
}

func TestImportingFromOtherApps(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	node, _ := exec.LookPath("node")
	dir := t.TempDir()
	claude := filepath.Join(dir, "claude.json")
	os.WriteFile(claude, []byte(`{"mcpServers": {
		"My Fixture": {"command": "`+node+`", "args": ["`+fixture("stdio-mcp-server.mjs")+`"], "env": {"FIXTURE_VALUE": "imported"}},
		"Old SSE": {"url": "https://example.com/sse"}
	}}`), 0o600)
	saved := mcp.SourcePaths
	mcp.SourcePaths = func() map[string][]string { return map[string][]string{"claude": {claude}} }
	t.Cleanup(func() { mcp.SourcePaths = saved })

	sources := string(h.mustDo("GET", "/api/mcp/import", nil, 200))
	if !strings.Contains(sources, `"name":"My Fixture"`) || !strings.Contains(sources, `"envNames":["FIXTURE_VALUE"]`) || !strings.Contains(sources, "old HTTP+SSE") {
		t.Fatalf("sources: %s", sources)
	}
	res := decodeInto[struct {
		Servers []mcpServerJSON
		Skipped []struct{ Name, Reason string }
	}](t, h.mustDo("POST", "/api/mcp/import", map[string]any{"source": "claude", "names": []string{"My Fixture", "Old SSE"}}, 200))
	if len(res.Servers) != 1 || res.Servers[0].Slug != "my_fixture" || len(res.Servers[0].Tools) != 3 || len(res.Skipped) != 1 {
		t.Fatalf("import: %+v", res)
	}
	// Importing it again is skipped: it's here.
	again := decodeInto[struct {
		Skipped []struct{ Name, Reason string }
	}](t, h.mustDo("POST", "/api/mcp/import", map[string]any{"source": "claude", "names": []string{"My Fixture"}}, 200))
	if len(again.Skipped) != 1 || !strings.Contains(again.Skipped[0].Reason, "already") {
		t.Fatalf("importing twice: %+v", again)
	}
}

func TestOneEnvValueOrHeaderCanBeChangedShownOrRemoved(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	defer h.close()
	node, _ := exec.LookPath("node")
	keychain := h.app.cfg.Secrets.(*secrets.Memory)
	h.mustDo("POST", "/api/mcp/servers", map[string]any{
		"name": "Fixture", "transport": "stdio", "command": node, "args": []string{fixture("stdio-mcp-server.mjs")},
		"env": map[string]string{"FIXTURE_VALUE": "first", "TOKEN": "s3cret", "OLD": "x"},
	}, 201)
	env := func() map[string]string {
		raw, _ := keychain.Get("mcp:fixture:env")
		m := map[string]string{}
		json.Unmarshal([]byte(raw), &m)
		return m
	}

	// Change one, add one, drop one: the others are kept.
	s := decodeInto[mcpServerJSON](t, h.mustDo("PATCH", "/api/mcp/servers/fixture", map[string]any{
		"envSet": map[string]string{"FIXTURE_VALUE": "second", "NEW": "y"}, "envRemove": []string{"OLD"},
	}, 200))
	if got := env(); got["FIXTURE_VALUE"] != "second" || got["TOKEN"] != "s3cret" || got["NEW"] != "y" || len(got) != 3 {
		t.Fatalf("after the patch: %v", got)
	}
	if strings.Join(s.EnvNames, ",") != "FIXTURE_VALUE,NEW,TOKEN" {
		t.Fatalf("names: %v", s.EnvNames)
	}
	// A bad name in a patch is refused like anywhere else, and changes nothing.
	h.mustDo("PATCH", "/api/mcp/servers/fixture", map[string]any{"envSet": map[string]string{"not a name": "z"}}, 400)

	// Shown on request, one at a time; only as JSON.
	revealed := decodeInto[struct{ Value string }](t, h.mustDo("POST", "/api/mcp/servers/fixture/reveal", map[string]string{"kind": "env", "name": "TOKEN"}, 200))
	if revealed.Value != "s3cret" {
		t.Fatalf("revealed: %q", revealed.Value)
	}
	if code, _, _ := h.raw("POST", "/api/mcp/servers/fixture/reveal", "text/plain", []byte(`{"kind":"env","name":"TOKEN"}`)); code != 415 {
		t.Fatalf("a form-like reveal: %d", code)
	}
	h.mustDo("POST", "/api/mcp/servers/fixture/reveal", map[string]string{"kind": "env", "name": "NOPE"}, 404)
	h.mustDo("POST", "/api/mcp/servers/nope/reveal", map[string]string{"kind": "env", "name": "TOKEN"}, 404)

	// The server runs with the changed value (an agent's copy restarts with it).
	scripted(t, h)
	agent := h.agentOn("Toolsmith", "script/s1", map[string]any{"mcp": []map[string]any{{"server": "fixture"}}})
	if reply := lastReply(h.sendAndWait(agent, "t1", `CALL:mcp__fixture__echo:{"text":"hi"}`, "r1")); !strings.Contains(reply, "value: second") {
		t.Fatalf("the tool saw: %q", reply)
	}
	h.mustDo("PATCH", "/api/mcp/servers/fixture", map[string]any{"envSet": map[string]string{"FIXTURE_VALUE": "third"}}, 200)
	if reply := lastReply(h.sendAndWait(agent, "t1", `CALL:mcp__fixture__echo:{"text":"hi"}`, "r2")); !strings.Contains(reply, "value: third") {
		t.Fatalf("after changing the value, the tool saw: %q", reply)
	}
}

type loginJSON struct {
	State    string `json:"state"`
	Output   string `json:"output"`
	ExitCode *int   `json:"exitCode"`
}

func TestALocalServersSignInCommand(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	defer h.close()
	node, _ := exec.LookPath("node")
	h.mustDo("POST", "/api/mcp/servers", map[string]any{
		"name": "Fixture", "transport": "stdio", "command": node, "args": []string{fixture("stdio-mcp-server.mjs")},
		"env": map[string]string{"FIXTURE_VALUE": "from-the-keychain"},
		// Prints a link (in colour, as CLIs do), sees the server's env, and succeeds.
		"loginArgs": []string{"-e", `console.log("\x1b[1mOpen https://login.example.test/device and enter ABCD-1234\x1b[0m"); console.error("value=" + process.env.FIXTURE_VALUE); setTimeout(() => process.exit(0), 300)`},
	}, 201)
	state := func() loginJSON {
		return decodeInto[loginJSON](t, h.mustDo("GET", "/api/mcp/servers/fixture/login", nil, 200))
	}
	if st := state(); st.State != "idle" {
		t.Fatalf("before: %+v", st)
	}
	events, cancel := h.app.Hub.Subscribe()
	defer cancel()

	if st := decodeInto[loginJSON](t, h.mustDo("POST", "/api/mcp/servers/fixture/login", nil, 202)); st.State != "running" {
		t.Fatalf("started: %+v", st)
	}
	h.mustDo("POST", "/api/mcp/servers/fixture/login", nil, 409) // one at a time
	var st loginJSON
	eventually(t, 15*time.Second, "the sign-in to finish", func() bool { st = state(); return st.State != "running" })
	if st.State != "succeeded" || st.ExitCode == nil || *st.ExitCode != 0 {
		t.Fatalf("finished: %+v", st)
	}
	if !strings.Contains(st.Output, "Open https://login.example.test/device and enter ABCD-1234\n") || strings.Contains(st.Output, "\x1b") {
		t.Fatalf("output (escape codes dropped): %q", st.Output)
	}
	if !strings.Contains(st.Output, "value=from-the-keychain") {
		t.Fatalf("the sign-in should run with the server's env: %q", st.Output)
	}
	sawLogin := false
	deadline := time.After(5 * time.Second)
	for !sawLogin {
		select {
		case ev := <-events:
			sawLogin = ev.Name == "mcp-login"
		case <-deadline:
			t.Fatal("no mcp-login event")
		}
	}

	// A failing sign-in says so, with its exit code; a cancelled one stops.
	h.mustDo("PATCH", "/api/mcp/servers/fixture", map[string]any{"loginArgs": []string{"-e", `console.error("AADSTS65001 consent needed"); process.exit(3)`}}, 200)
	h.mustDo("POST", "/api/mcp/servers/fixture/login", nil, 202)
	eventually(t, 15*time.Second, "the failure", func() bool { st = state(); return st.State != "running" })
	if st.State != "failed" || *st.ExitCode != 3 || !strings.Contains(st.Output, "consent needed") {
		t.Fatalf("failed: %+v", st)
	}
	h.mustDo("PATCH", "/api/mcp/servers/fixture", map[string]any{"loginArgs": []string{"-e", `console.log("waiting"); setTimeout(() => {}, 60000)`}}, 200)
	h.mustDo("POST", "/api/mcp/servers/fixture/login", nil, 202)
	eventually(t, 10*time.Second, "it to print", func() bool { return strings.Contains(state().Output, "waiting") })
	h.mustDo("DELETE", "/api/mcp/servers/fixture/login", nil, 200)
	eventually(t, 10*time.Second, "the cancel", func() bool { st = state(); return st.State != "running" })
	if st.State != "cancelled" {
		t.Fatalf("cancelled: %+v", st)
	}

	// Refused: per-agent placeholders, and a server without a sign-in command.
	h.mustDo("PATCH", "/api/mcp/servers/fixture", map[string]any{"loginArgs": []string{"${workspace}/login"}}, 400)
	h.mustDo("PATCH", "/api/mcp/servers/fixture", map[string]any{"loginArgs": []string{}}, 200)
	h.mustDo("POST", "/api/mcp/servers/fixture/login", nil, 400)
	list := decodeInto[[]struct {
		LoginArgs []string `json:"loginArgs"`
	}](t, h.mustDo("GET", "/api/mcp/servers", nil, 200))
	if len(list) != 1 || list[0].LoginArgs == nil || len(list[0].LoginArgs) != 0 {
		t.Fatalf("cleared: %+v", list)
	}
}
