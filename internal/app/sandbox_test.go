package app

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/ncecere/pi-local/internal/agents"
)

// These run the real runtime and the real sandbox: macOS only (sandbox-exec).
func needSandbox(t *testing.T) {
	t.Helper()
	if runtime.GOOS != "darwin" {
		t.Skip("the shell sandbox is macOS only for now")
	}
}

func (h *harness) agentYAML(id string) string {
	h.t.Helper()
	raw, err := os.ReadFile(filepath.Join(h.app.cfg.DataDir, "agents", id, "agent.yaml"))
	if err != nil {
		h.t.Fatal(err)
	}
	return string(raw)
}

func TestNewAgentsWithAShellRunItInTheSandbox(t *testing.T) {
	needSandbox(t)
	h := start(t, t.TempDir(), Config{})
	defer h.close()
	scripted(t, h)

	withBash := h.agentOn("Coder", "script/s1", map[string]any{"workspace": map[string]any{"tools": []string{"read", "write", "bash"}}})
	got := h.agentJSON(withBash)
	for _, want := range []string{`"sandbox":true`, `"network":true`, `"sandboxAvailable":true`, `"profile":"balanced"`} {
		if !strings.Contains(got, want) {
			t.Errorf("a new agent with a shell lacks %s: %s", want, got)
		}
	}
	if y := h.agentYAML(withBash); !strings.Contains(y, "sandbox:") || strings.Contains(y, "network:") {
		t.Fatalf("agent.yaml says the sandbox, and leaves the default network out:\n%s", y)
	}
	// The coding template's agents too; an agent without a shell has nothing to sandbox.
	coding := h.agentOn("Coder 2", "script/s1", map[string]any{"templateId": "coding"})
	if got := h.agentJSON(coding); !strings.Contains(got, `"sandbox":true`) {
		t.Fatalf("the coding agent: %s", got)
	}
	noShell := h.agentOn("Reader", "script/s1", map[string]any{"workspace": map[string]any{"tools": []string{"read"}}})
	if got := h.agentJSON(noShell); !strings.Contains(got, `"sandbox":false`) {
		t.Fatalf("an agent without a shell: %s", got)
	}
	// Asked for off, it is off.
	off := h.agentOn("Plain", "script/s1", map[string]any{"workspace": map[string]any{"tools": []string{"bash"}, "sandbox": false}})
	if got := h.agentJSON(off); !strings.Contains(got, `"sandbox":false`) {
		t.Fatalf("an agent made with the sandbox off: %s", got)
	}
	// Something that isn't a switch is refused.
	if code, data := h.do("POST", "/api/agents", map[string]any{"name": "Bad", "modelId": "script/s1", "workspace": map[string]any{"tools": []string{"bash"}, "sandbox": "maybe"}}); code != 400 {
		t.Fatalf("a sandbox that isn't a switch: %d %s", code, data)
	}
}

func TestASandboxedShellRunsWithoutAskingAndStaysInItsWorkspace(t *testing.T) {
	needSandbox(t)
	h := start(t, t.TempDir(), Config{})
	defer h.close()
	scripted(t, h)
	agent := h.agentOn("Coder", "script/s1", map[string]any{"workspace": map[string]any{"tools": []string{"read", "write", "bash"}}})
	data := h.app.cfg.DataDir
	agentDir := filepath.Join(data, "agents", agent)

	// Balanced, sandboxed: a plain command runs without asking, in the workspace.
	req, reply := h.run(agent, "t1", "echo hello > made.txt && cat made.txt")
	if req != nil || !strings.Contains(reply, "Got: hello") {
		t.Fatalf("a sandboxed command should just run: %+v %q", req, reply)
	}
	if raw, _ := os.ReadFile(filepath.Join(agentDir, "workspace", "made.txt")); strings.TrimSpace(string(raw)) != "hello" {
		t.Fatalf("the command's file: %q", raw)
	}

	// A write outside the workspace is refused by the sandbox, and the model is told so plainly.
	home, _ := os.UserHomeDir()
	name := fmt.Sprintf("sandbox-test-%d", time.Now().UnixNano())
	target := filepath.Join(home, name)
	t.Cleanup(func() { os.Remove(target) })
	req, reply = h.run(agent, "t2", `touch "$HOME/`+name+`"`)
	if req != nil || !strings.Contains(reply, "Operation not permitted") || !strings.Contains(reply, "The sandbox blocked writing outside the workspace: "+target) {
		t.Fatalf("a write to the home folder: %+v %q", req, reply)
	}
	if _, err := os.Stat(target); err == nil {
		t.Fatal("the sandbox let a command write to the home folder")
	}

	// The app's data is closed except for this agent's own folder, which is readable, not writable.
	req, reply = h.run(agent, "t3", "cat "+filepath.Join(data, "app.db")+" | head -c 16; cat "+filepath.Join(agentDir, "agent.yaml")+" | head -n 1")
	if req != nil || strings.Contains(reply, "SQLite format") || !strings.Contains(reply, "Operation not permitted") || !strings.Contains(reply, "# Pi Local agent") {
		t.Fatalf("reading the app's data: %+v %q", req, reply)
	}
	before := h.agentYAML(agent)
	req, reply = h.run(agent, "t4", "echo 'workspace: {sandbox: off}' >> "+filepath.Join(agentDir, "agent.yaml"))
	if req != nil || !strings.Contains(reply, "Operation not permitted") || h.agentYAML(agent) != before {
		t.Fatalf("a command changed its own configuration: %+v %q", req, reply)
	}

	// The built-in rules still ask.
	req, _ = h.run(agent, "t5", "rm -rf nothing-here")
	if req == nil || req.Summary == nil || !strings.Contains(*req.Summary, "built-in rule") {
		t.Fatalf("rm -rf should still ask: %+v", req)
	}
	h.settle(agent, "t5", req, "deny")
}

func TestTheNetworkSwitchReachesTheSandbox(t *testing.T) {
	needSandbox(t)
	h := start(t, t.TempDir(), Config{})
	defer h.close()
	scripted(t, h)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "served by the test") }))
	defer srv.Close()
	agent := h.agentOn("Coder", "script/s1", map[string]any{"workspace": map[string]any{"tools": []string{"read", "bash"}}})
	tools := []string{"read", "bash"}
	curl := "curl -sS -m 10 " + srv.URL

	if req, reply := h.run(agent, "n1", curl); req != nil || !strings.Contains(reply, "served by the test") {
		t.Fatalf("the network is on by default: %+v %q", req, reply)
	}
	h.mustDo("PATCH", "/api/agents/"+agent, map[string]any{"workspace": map[string]any{"tools": tools, "network": false}}, 200)
	if got := h.agentJSON(agent); !strings.Contains(got, `"network":false`) || !strings.Contains(got, `"sandbox":true`) {
		t.Fatalf("after turning the network off: %s", got)
	}
	if y := h.agentYAML(agent); !strings.Contains(y, "network:") {
		t.Fatalf("agent.yaml:\n%s", y)
	}
	req, reply := h.run(agent, "n2", curl)
	if req != nil || strings.Contains(reply, "served by the test") || !strings.Contains(reply, "The network is off for this agent") {
		t.Fatalf("with the network off: %+v %q", req, reply)
	}
	// Saving the tools again (a client that knows nothing of the switches) keeps both.
	h.mustDo("PATCH", "/api/agents/"+agent, map[string]any{"workspace": map[string]any{"tools": tools}}, 200)
	if got := h.agentJSON(agent); !strings.Contains(got, `"network":false`) || !strings.Contains(got, `"sandbox":true`) {
		t.Fatalf("saving the tools reset the switches: %s", got)
	}
	h.mustDo("PATCH", "/api/agents/"+agent, map[string]any{"workspace": map[string]any{"tools": tools, "network": true}}, 200)
	if req, reply := h.run(agent, "n3", curl); req != nil || !strings.Contains(reply, "served by the test") {
		t.Fatalf("the network back on: %+v %q", req, reply)
	}
}

func TestWithoutTheSandboxTheBalancedProfileAsksAgain(t *testing.T) {
	needSandbox(t)
	h := start(t, t.TempDir(), Config{})
	defer h.close()
	scripted(t, h)
	agent := h.agentOn("Coder", "script/s1", map[string]any{"workspace": map[string]any{"tools": []string{"bash"}}})
	if req, _ := h.run(agent, "a1", "echo one"); req != nil {
		t.Fatalf("sandboxed and balanced asked: %+v", req)
	}

	// Turned off: the running agent restarts without the sandbox, and bash asks.
	h.mustDo("PATCH", "/api/agents/"+agent, map[string]any{"workspace": map[string]any{"tools": []string{"bash"}, "sandbox": false}}, 200)
	req, _ := h.run(agent, "a2", "echo two")
	if req == nil {
		t.Fatal("balanced without the sandbox should ask before a command")
	}
	if got := h.settle(agent, "a2", req, "approve"); !strings.Contains(got, "two") {
		t.Fatalf("after approving: %q", got)
	}
	if y := h.agentYAML(agent); !strings.Contains(y, "sandbox:") {
		t.Fatalf("agent.yaml says it was turned off:\n%s", y)
	}

	// An agent from before the sandbox has no setting: off, and it stays off.
	if _, err := h.app.Agents.Update(context.Background(), agent, func(c *agents.Config) { c.Workspace.Sandbox = "" }); err != nil {
		t.Fatal(err)
	}
	if got := h.agentJSON(agent); !strings.Contains(got, `"sandbox":false`) {
		t.Fatalf("an agent without the setting: %s", got)
	}
	if req, _ := h.run(agent, "a3", "echo three"); req == nil {
		t.Fatal("an agent from before the sandbox should keep asking")
	} else {
		h.settle(agent, "a3", req, "deny")
	}
}
