package app

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const (
	scrubToken = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"
	// printToken prints scrubToken without the command holding it (the model's own call is stored as it wrote it).
	printToken = `printf 'ghp_%s%s\n' abcdefghijklmnopqrstuvwxyz 0123456789`
	// scrubModelKey is a provider key with no credential shape: it is hidden by its value alone.
	scrubModelKey = "model-key-plain-words-01"
)

// scrubAgent is an agent on a keyed fake model with workspace tools that ask for nothing.
func scrubAgent(t *testing.T, h *harness, extra map[string]any) (string, *fakeProvider) {
	t.Helper()
	fake := newFakeProvider(t, "openai", "plain reply")
	h.mustDo("POST", "/api/providers", map[string]any{"id": "script", "name": "Script", "kind": "openai-compatible", "baseUrl": fake.URL + "/v1", "apiKey": scrubModelKey}, 201)
	h.mustDo("PUT", "/api/providers/script/models/s1", map[string]any{"name": "Scripted"}, 200)
	body := map[string]any{"workspace": map[string]any{"tools": []string{"read", "write", "bash"}}, "approvals": map[string]any{"profile": "trusting"}}
	for k, v := range extra {
		body[k] = v
	}
	return h.agentOn("Worker", "script/s1", body), fake
}

func (h *harness) agentFile(agent string, parts ...string) string {
	return filepath.Join(append([]string{h.app.cfg.DataDir, "agents", agent}, parts...)...)
}

// lastChat is the body of the model's latest request, which holds everything it has been shown.
func lastChat(fake *fakeProvider) string {
	chats := fake.chats()
	return string(chats[len(chats)-1].Body)
}

func TestToolOutputIsScrubbedBeforeTheModelAndTheTranscript(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	defer h.close()
	agent, fake := scrubAgent(t, h, nil)

	// A command prints a token: the model's next request and the stored transcript both have the mark.
	v := h.sendAndWait(agent, "t1", "RUN:"+printToken, "r1")
	if got := toolResults(v); len(got) != 1 || !strings.Contains(got[0], "[redacted secret]") || strings.Contains(got[0], "abcdefghijklmnopqrstuvwxyz0123456789") {
		t.Fatalf("the stored result: %q", got)
	}
	if reply := lastReply(v); !strings.Contains(reply, "Got: [redacted secret]") {
		t.Fatalf("the model's next answer was built from %q", reply)
	}
	body := lastChat(fake)
	if !strings.Contains(body, "[redacted secret]") || strings.Contains(body, "abcdefghijklmnopqrstuvwxyz0123456789") {
		t.Fatalf("the model was shown the token: %.600s", body)
	}
	if raw := string(h.mustDo("GET", "/api/agents/"+agent+"/threads/t1", nil, 200)); strings.Contains(raw, "abcdefghijklmnopqrstuvwxyz0123456789") {
		t.Fatalf("the transcript API has the token: %.600s", raw)
	}

	// The model key, which is no credential by its shape, is hidden by its value wherever a tool finds it.
	os.WriteFile(h.agentFile(agent, "workspace", "notes.txt"), []byte("the key is "+scrubModelKey+" (do not share)"), 0o644)
	v = h.sendAndWait(agent, "t2", "READ:notes.txt", "r2")
	if got := toolResults(v); len(got) != 1 || got[0] != "the key is [redacted secret] (do not share)" {
		t.Fatalf("read output: %q", got)
	}
	if body := lastChat(fake); strings.Contains(body, scrubModelKey) {
		t.Fatalf("the model was shown its own key: %.600s", body)
	}

	// Credentials in a file's lines, but not the rest of it.
	os.WriteFile(h.agentFile(agent, "workspace", ".env"), []byte("DB_PASSWORD=hunter2hunter2\nPORT=8080\nSHA=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08\n"), 0o644)
	v = h.sendAndWait(agent, "t3", "READ:.env", "r3")
	if got := strings.Join(toolResults(v), ""); !strings.Contains(got, "DB_PASSWORD=[redacted secret]") || !strings.Contains(got, "PORT=8080") || !strings.Contains(got, "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08") {
		t.Fatalf(".env: %q", got)
	}
}

func TestAskRepliesAreScrubbed(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	defer h.close()
	agent, fake := scrubAgent(t, h, nil)
	h.mustDo("POST", "/api/agents/"+agent+"/threads/t1/messages", map[string]string{"text": `CALL:ask_person:{"question":"What is the token?"}`, "requestId": "r1"}, 202)
	var q elicitationJSON
	eventually(t, 30*time.Second, "the question", func() bool {
		list := decodeInto[[]elicitationJSON](t, h.mustDo("GET", "/api/elicitations", nil, 200))
		if len(list) == 1 {
			q = list[0]
		}
		return len(list) == 1
	})
	h.mustDo("POST", "/api/elicitations/"+q.ID, map[string]any{"action": "accept", "content": map[string]any{"answer": scrubToken}}, 200)
	v := h.waitReply(agent, "t1")
	if reply := lastReply(v); !strings.Contains(reply, "They answered: [redacted secret]") {
		t.Fatalf("the answer the agent got: %q", reply)
	}
	if body := lastChat(fake); strings.Contains(body, scrubToken) {
		t.Fatalf("the model was shown the answer: %.600s", body)
	}
}

func TestTheSecretScrubbingSwitch(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	defer h.close()
	agent, fake := scrubAgent(t, h, nil)
	type security struct {
		Security struct {
			ScrubSecrets bool `json:"scrubSecrets"`
		} `json:"security"`
	}
	if got := decodeInto[security](t, []byte(h.agentJSON(agent))); !got.Security.ScrubSecrets {
		t.Fatal("scrubbing should be on by default")
	}
	if yaml, _ := os.ReadFile(h.agentFile(agent, "agent.yaml")); strings.Contains(string(yaml), "security") {
		t.Fatalf("the default isn't written to agent.yaml:\n%s", yaml)
	}

	// Off: the agent restarts with the new setting and its tool output is as it came.
	if got := decodeInto[security](t, h.mustDo("PATCH", "/api/agents/"+agent, map[string]any{"security": map[string]any{"scrubSecrets": false}}, 200)); got.Security.ScrubSecrets {
		t.Fatal("the update should turn it off")
	}
	if yaml, _ := os.ReadFile(h.agentFile(agent, "agent.yaml")); !strings.Contains(string(yaml), "scrubSecrets: false") {
		t.Fatalf("agent.yaml:\n%s", yaml)
	}
	v := h.sendAndWait(agent, "t1", "RUN:"+printToken, "r1")
	if got := toolResults(v); len(got) != 1 || !strings.Contains(got[0], scrubToken) {
		t.Fatalf("with scrubbing off the output is as it came: %q", got)
	}
	if !strings.Contains(lastChat(fake), scrubToken) {
		t.Fatal("with scrubbing off the model sees the output as it came")
	}

	// On again.
	h.mustDo("PATCH", "/api/agents/"+agent, map[string]any{"security": map[string]any{"scrubSecrets": true}}, 200)
	if yaml, _ := os.ReadFile(h.agentFile(agent, "agent.yaml")); strings.Contains(string(yaml), "security") {
		t.Fatalf("back to the default, agent.yaml:\n%s", yaml)
	}
	v = h.sendAndWait(agent, "t2", "RUN:"+printToken, "r2")
	if got := toolResults(v); len(got) != 1 || strings.Contains(got[0], scrubToken) {
		t.Fatalf("scrubbing is on again: %q", got)
	}
	// Other updates leave it alone.
	h.mustDo("PATCH", "/api/agents/"+agent, map[string]any{"security": map[string]any{"scrubSecrets": false}}, 200)
	h.mustDo("PATCH", "/api/agents/"+agent, map[string]any{"description": "x"}, 200)
	if got := decodeInto[security](t, []byte(h.agentJSON(agent))); got.Security.ScrubSecrets {
		t.Fatal("an unrelated update turned scrubbing back on")
	}
}

func TestAnMCPServersOwnSecretsAreScrubbedAndKeptOutOfTheLog(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	defer h.close()
	node, _ := exec.LookPath("node")
	h.mustDo("POST", "/api/mcp/servers", map[string]any{
		"name": "Fixture", "transport": "stdio", "command": node, "args": []string{fixture("stdio-mcp-server.mjs")},
		"env": map[string]string{"FIXTURE_VALUE": "from-the-keychain", "FIXTURE_LOG_VALUE": "1"},
	}, 201)
	agent, fake := scrubAgent(t, h, map[string]any{"mcp": []map[string]any{{"server": "fixture"}}})

	v := h.sendAndWait(agent, "t1", `CALL:mcp__fixture__echo:{"text":"hi"}`, "r1")
	if got := toolResults(v); len(got) != 1 || !strings.Contains(got[0], "echo: hi") || !strings.Contains(got[0], "value: [redacted secret]") || strings.Contains(got[0], "from-the-keychain") {
		t.Fatalf("the MCP result: %q", got)
	}
	if body := lastChat(fake); strings.Contains(body, "from-the-keychain") {
		t.Fatalf("the model was shown the server's secret: %.600s", body)
	}
	// The server wrote its secret to stderr; the agent's log has it hidden.
	var log string
	eventually(t, 10*time.Second, "the server's line in the log", func() bool {
		raw, _ := os.ReadFile(h.agentFile(agent, "logs", "runtime.log"))
		log = string(raw)
		return strings.Contains(log, "fixture: value")
	})
	if strings.Contains(log, "from-the-keychain") || strings.Contains(log, scrubModelKey) || !strings.Contains(log, "fixture: value [redacted secret]") {
		t.Fatalf("the log:\n%s", log)
	}

	// Off for this agent: the result shows it.
	h.mustDo("PATCH", "/api/agents/"+agent, map[string]any{"security": map[string]any{"scrubSecrets": false}}, 200)
	v = h.sendAndWait(agent, "t2", `CALL:mcp__fixture__echo:{"text":"hi"}`, "r2")
	if got := toolResults(v); len(got) != 1 || !strings.Contains(got[0], "value: from-the-keychain") {
		t.Fatalf("with scrubbing off: %q", got)
	}
	// The log is clean whatever the switch says.
	raw, _ := os.ReadFile(h.agentFile(agent, "logs", "runtime.log"))
	if strings.Contains(string(raw), "from-the-keychain") {
		t.Fatalf("the log has the secret with scrubbing off:\n%s", raw)
	}
}
