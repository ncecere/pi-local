package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// agentJSON is an agent as the list shows it.
func (h *harness) agentJSON(id string) string {
	h.t.Helper()
	var list []json.RawMessage
	json.Unmarshal(h.mustDo("GET", "/api/agents", nil, 200), &list)
	for _, raw := range list {
		if strings.Contains(string(raw), `"id":"`+id+`"`) {
			return string(raw)
		}
	}
	h.t.Fatalf("no agent %s", id)
	return ""
}

// approvalsFor lists every request an agent has made, of any status.
func (h *harness) approvalsFor(agent string) []approvalJSON {
	h.t.Helper()
	var mine []approvalJSON
	for _, a := range decodeInto[[]approvalJSON](h.t, h.mustDo("GET", "/api/approvals?status=all", nil, 200)) {
		if a.AgentID == agent {
			mine = append(mine, a)
		}
	}
	return mine
}

// outcome waits for what a message in a new thread ends with: a pending approval request (the call asks), or the
// reply (the call ran, or was refused).
func (h *harness) outcome(agent, thread string) (*approvalJSON, string) {
	h.t.Helper()
	var asked *approvalJSON
	var reply string
	eventually(h.t, 30*time.Second, "an approval request or the reply in "+thread, func() bool {
		for _, a := range h.approvalsFor(agent) {
			if a.Status == "pending" {
				asked = &a
				return true
			}
		}
		for _, th := range h.threads(agent) {
			if th.ThreadID == thread && !th.Busy && th.LastReplyAt != nil {
				v := h.view(agent, thread)
				if last := v.Messages[len(v.Messages)-1]; last.Role == "assistant" {
					reply = last.Text
					return true
				}
			}
		}
		return false
	})
	return asked, reply
}

// say sends a message in a new thread and returns its outcome.
func (h *harness) say(agent, thread, text string) (*approvalJSON, string) {
	h.t.Helper()
	h.mustDo("POST", "/api/agents/"+agent+"/threads/"+thread+"/messages", map[string]string{"text": text, "requestId": "r-" + thread}, 202)
	return h.outcome(agent, thread)
}

// run sends a command for the model to run (in a new thread) and returns its outcome.
func (h *harness) run(agent, thread, command string) (*approvalJSON, string) {
	h.t.Helper()
	return h.say(agent, thread, "RUN:"+command)
}

// settle approves or denies a pending request and waits for the reply.
func (h *harness) settle(agent, thread string, req *approvalJSON, decision string) string {
	h.t.Helper()
	h.mustDo("POST", "/api/agents/"+agent+"/approvals/"+req.ID, map[string]string{"decision": decision}, 200)
	return lastReply(h.waitReply(agent, thread))
}

func TestDenyRulesAskRulesAndBuiltInRules(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	scripted(t, h)
	// Trusting: nothing asks but the built-in rules and the person's own.
	agent := h.agentOn("Worker", "script/s1", map[string]any{
		"workspace": map[string]any{"tools": []string{"read", "write", "bash"}},
		"approvals": map[string]any{"profile": "trusting", "rules": []map[string]any{
			{"tool": "bash", "args": map[string]string{"command": "echo secret*"}, "action": "deny"},
			{"tool": "bash", "args": map[string]string{"command": "echo careful*"}, "action": "ask"},
			{"tool": "bash", "args": map[string]string{"command": "echo fine*"}, "action": "allow"},
		}},
	})

	// Nothing matches: it runs without asking.
	if req, reply := h.run(agent, "t1", "echo hello"); req != nil || !strings.Contains(reply, "hello") {
		t.Fatalf("a trusting agent should just run: %+v %q", req, reply)
	}
	// Deny: refused without asking; the model reads why.
	req, reply := h.run(agent, "t2", "echo secret stuff")
	if req != nil || !strings.Contains(reply, "Not allowed by your approval rules") || strings.Contains(reply, "secret stuff\n") {
		t.Fatalf("a deny rule: %+v %q", req, reply)
	}
	for _, a := range h.approvalsFor(agent) {
		if strings.Contains(string(a.Arguments), "secret stuff") {
			t.Fatalf("a refused call became a request: %+v", a)
		}
	}
	// Ask: asks, and says it was a rule.
	req, _ = h.run(agent, "t3", "echo careful now")
	if req == nil || req.Tool != "bash" || req.Summary == nil || !strings.Contains(*req.Summary, "approval rules") {
		t.Fatalf("an ask rule: %+v", req)
	}
	if got := h.settle(agent, "t3", req, "approve"); !strings.Contains(got, "careful now") {
		t.Fatalf("after approving: %q", got)
	}
	// Built-in rules ask under every profile, and an allow rule doesn't loosen them.
	req, _ = h.run(agent, "t4", "sudo -n true")
	if req == nil || req.Summary == nil || !strings.Contains(*req.Summary, "built-in rule") {
		t.Fatalf("a built-in rule: %+v", req)
	}
	if got := h.settle(agent, "t4", req, "deny"); !strings.Contains(got, "denied by") {
		t.Fatalf("after denying: %q", got)
	}
	h.mustDo("POST", "/api/agents/"+agent+"/approval-rules", map[string]any{"tool": "bash", "args": map[string]string{"command": "git push --force*"}}, 201)
	req, _ = h.run(agent, "t5", "git push --force origin nothing")
	if req == nil {
		t.Fatal("an allow rule loosened a built-in rule")
	}
	h.settle(agent, "t5", req, "deny")
	// A compound command doesn't ride on an allow rule's glob.
	h.mustDo("POST", "/api/agents/"+agent+"/approval-rules", map[string]any{"tool": "bash", "args": map[string]string{"command": "echo fine*"}}, 200) // already there
	req, _ = h.run(agent, "t6", "echo fine && sudo -n true")
	if req == nil {
		t.Fatal("a command chained after an allowed one ran without asking")
	}
	h.settle(agent, "t6", req, "deny")
}

func TestProfiles(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	scripted(t, h)
	// Without the sandbox (a sandboxed shell stops asking under balanced: sandbox_test.go).
	tools := map[string]any{"tools": []string{"read", "write", "edit", "bash"}, "sandbox": false}

	// A new agent is balanced.
	made := h.agentOn("Fresh", "script/s1", map[string]any{"workspace": tools})
	if got := h.agentJSON(made); !strings.Contains(got, `"profile":"balanced"`) || !strings.Contains(got, `"builtinRules":[{"id":"builtin-rm-rf"`) {
		t.Fatalf("a new agent's approvals: %s", got)
	}
	// An agent with only `tools` is custom, and behaves as it always did: bash asks, write doesn't.
	legacy := h.agentOn("Legacy", "script/s1", map[string]any{"workspace": tools, "approvals": map[string]any{"tools": []string{"bash"}}})
	if got := h.agentJSON(legacy); !strings.Contains(got, `"profile":"custom"`) || !strings.Contains(got, `"tools":["bash"]`) {
		t.Fatalf("a legacy agent's approvals: %s", got)
	}
	careful := h.agentOn("Careful", "script/s1", map[string]any{"workspace": tools, "approvals": map[string]any{"profile": "careful"}})
	trusting := h.agentOn("Trusting", "script/s1", map[string]any{"workspace": tools, "approvals": map[string]any{"profile": "trusting"}})

	write := func(agent, thread, path string) (*approvalJSON, string) {
		return h.say(agent, thread, "WRITE:"+path+":x")
	}

	// write: careful asks; balanced, custom (as today) and trusting don't.
	if req, _ := write(careful, "w", "a.txt"); req == nil || req.Tool != "write" {
		t.Fatalf("careful should ask before writing: %+v", req)
	} else {
		h.settle(careful, "w", req, "approve")
	}
	for name, agent := range map[string]string{"balanced": made, "custom": legacy, "trusting": trusting} {
		if req, reply := write(agent, "w", "a.txt"); req != nil {
			t.Fatalf("%s asked before writing: %+v (%q)", name, req, reply)
		}
	}
	// bash: careful, balanced and custom ask; trusting doesn't.
	for name, agent := range map[string]string{"careful": careful, "balanced": made, "custom": legacy} {
		req, _ := h.run(agent, "b", "echo hi")
		if req == nil {
			t.Fatalf("%s should ask before a command", name)
		}
		h.settle(agent, "b", req, "approve")
	}
	if req, reply := h.run(trusting, "b", "echo hi"); req != nil || !strings.Contains(reply, "hi") {
		t.Fatalf("trusting should run it: %+v %q", req, reply)
	}

	// Changing the profile reaches the running agent without a restart; the old client's save keeps the profile.
	pid := h.app.Sup.PID(made)
	h.mustDo("PATCH", "/api/agents/"+made, map[string]any{"approvals": map[string]any{"profile": "trusting"}}, 200)
	if req, _ := h.run(made, "b2", "echo again"); req != nil {
		t.Fatalf("after switching to trusting it still asked: %+v", req)
	}
	if h.app.Sup.PID(made) != pid {
		t.Fatal("changing the profile restarted the agent")
	}
	if code, data := h.do("PATCH", "/api/agents/"+made, map[string]any{"approvals": map[string]any{"profile": "reckless"}}); code != 400 || !strings.Contains(string(data), "invalid_approval_profile") {
		t.Fatalf("an unknown profile: %d %s", code, data)
	}
	h.mustDo("PATCH", "/api/agents/"+made, map[string]any{"approvals": map[string]any{"tools": []string{"write"}, "timeoutSeconds": 3600}}, 200)
	if got := h.agentJSON(made); !strings.Contains(got, `"profile":"trusting"`) {
		t.Fatalf("saving the tools list cleared the profile: %s", got)
	}
}

func TestAlwaysAllowAddsARuleThatIsListedAndRemoved(t *testing.T) {
	dir := t.TempDir()
	h := start(t, dir, Config{})
	scripted(t, h)
	agent := h.agentOn("Worker", "script/s1", map[string]any{"workspace": map[string]any{"tools": []string{"read", "bash"}, "sandbox": false}})

	req, _ := h.run(agent, "t1", "echo one")
	if req == nil {
		t.Fatal("balanced should ask before a command")
	}
	pid := h.app.Sup.PID(agent)
	// What the card does: add the rule, then approve.
	added := decodeInto[struct {
		Rule struct {
			ID, Tool, Action string
			Args             map[string]string
		}
		Rules []json.RawMessage
	}](t, h.mustDo("POST", "/api/agents/"+agent+"/approval-rules", map[string]any{"tool": "bash", "args": map[string]string{"command": "echo*"}}, 201))
	if added.Rule.Action != "allow" || !strings.HasPrefix(added.Rule.ID, "r_") || added.Rule.Args["command"] != "echo*" || len(added.Rules) != 1 {
		t.Fatalf("the new rule: %+v", added)
	}
	if got := h.settle(agent, "t1", req, "approve"); !strings.Contains(got, "one") {
		t.Fatalf("after approving: %q", got)
	}

	// The next one runs without asking, in the same runtime (the rule was told to it, not a restart).
	if req, reply := h.run(agent, "t2", "echo two"); req != nil || !strings.Contains(reply, "two") {
		t.Fatalf("an always-allowed command asked: %+v %q", req, reply)
	}
	if h.app.Sup.PID(agent) != pid {
		t.Fatal("adding a rule restarted the agent")
	}
	// Only what the rule says: a different command and a chained one still ask.
	for i, command := range []string{"ls", "echo three; ls"} {
		req, _ := h.run(agent, "t"+string(rune('3'+i)), command)
		if req == nil {
			t.Fatalf("%q ran without asking", command)
		}
		h.settle(agent, "t"+string(rune('3'+i)), req, "deny")
	}

	// Listed (on the agent and on its own route), saved in agent.yaml, not added twice.
	list := string(h.mustDo("GET", "/api/agents/"+agent+"/approval-rules", nil, 200))
	if !strings.Contains(list, added.Rule.ID) || !strings.Contains(list, `"profile":"balanced"`) || !strings.Contains(list, "builtin-sudo") {
		t.Fatalf("the rules: %s", list)
	}
	if got := h.agentJSON(agent); !strings.Contains(got, `"rules":[{"id":"`+added.Rule.ID+`"`) {
		t.Fatalf("the agent's rules: %s", got)
	}
	if raw, _ := os.ReadFile(filepath.Join(dir, "agents", agent, "agent.yaml")); !strings.Contains(string(raw), "echo*") || !strings.Contains(string(raw), "profile: balanced") {
		t.Fatalf("agent.yaml: %s", raw)
	}
	again := decodeInto[struct{ Rule struct{ ID string } }](t, h.mustDo("POST", "/api/agents/"+agent+"/approval-rules", map[string]any{"tool": "bash", "args": map[string]string{"command": "echo*"}}, 200))
	if again.Rule.ID != added.Rule.ID {
		t.Fatalf("the same rule twice: %+v", again)
	}
	for _, bad := range []map[string]any{
		{"tool": "bad tool!"}, {"tool": "bash", "action": "maybe"}, {"tool": "bash", "args": map[string]string{"bad name": "x"}}, {"tool": "bash", "args": map[string]string{"command": ""}},
	} {
		if code, data := h.do("POST", "/api/agents/"+agent+"/approval-rules", bad); code != 400 || !strings.Contains(string(data), "invalid_approval_rules") {
			t.Fatalf("%v: %d %s", bad, code, data)
		}
	}

	// A save from a client that doesn't know rules keeps them.
	h.mustDo("PATCH", "/api/agents/"+agent, map[string]any{"approvals": map[string]any{"tools": []string{}, "timeoutSeconds": 7200}}, 200)
	if got := string(h.mustDo("GET", "/api/agents/"+agent+"/approval-rules", nil, 200)); !strings.Contains(got, added.Rule.ID) {
		t.Fatalf("a save without rules dropped them: %s", got)
	}

	// Removed: it asks again, and the runtime isn't restarted for that either. A rule that isn't there is a 404.
	h.mustDo("DELETE", "/api/agents/"+agent+"/approval-rules/"+added.Rule.ID, nil, 200)
	h.mustDo("DELETE", "/api/agents/"+agent+"/approval-rules/"+added.Rule.ID, nil, 404)
	if req, _ := h.run(agent, "t6", "echo six"); req == nil {
		t.Fatal("a removed rule still allowed the command")
	} else {
		h.settle(agent, "t6", req, "deny")
	}
	if h.app.Sup.PID(agent) != pid {
		t.Fatal("removing a rule restarted the agent")
	}
}

func TestRulesWrittenByHandGetStableIDs(t *testing.T) {
	dir := t.TempDir()
	first := start(t, dir, Config{})
	scripted(t, first)
	agent := first.agentOn("Worker", "script/s1", nil)
	first.close()

	path := filepath.Join(dir, "agents", agent, "agent.yaml")
	raw, _ := os.ReadFile(path)
	edited := strings.Replace(string(raw), "approvals:", "approvals:\n  rules:\n    - tool: bash\n      args: {command: \"ls*\"}\n      action: allow", 1)
	if edited == string(raw) {
		t.Fatalf("no approvals in agent.yaml to edit:\n%s", raw)
	}
	os.WriteFile(path, []byte(edited), 0o644)

	second := start(t, dir, Config{})
	list := decodeInto[struct{ Rules []struct{ ID, Tool string } }](t, second.mustDo("GET", "/api/agents/"+agent+"/approval-rules", nil, 200))
	if len(list.Rules) != 1 || !strings.HasPrefix(list.Rules[0].ID, "r_") {
		t.Fatalf("the hand-written rule: %+v", list)
	}
	second.mustDo("DELETE", "/api/agents/"+agent+"/approval-rules/"+list.Rules[0].ID, nil, 200)
}

// --- MCP annotations -----------------------------------------------------------------------------------------

func TestMCPAnnotationsDecideWhatProfilesAsk(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	scripted(t, h)
	node, _ := exec.LookPath("node")
	h.mustDo("POST", "/api/mcp/servers", map[string]any{
		"name": "Fixture", "transport": "stdio", "command": node, "args": []string{fixture("stdio-mcp-server.mjs")},
		"env": map[string]string{"FIXTURE_ACTIONS": "1"},
	}, 201)
	use := map[string]any{"mcp": []map[string]any{{"server": "fixture"}}}
	balanced := h.agentOn("Balanced", "script/s1", use)
	careful := h.agentOn("Careful", "script/s1", map[string]any{"mcp": use["mcp"], "approvals": map[string]any{"profile": "careful"}})

	call := func(agent, thread, tool string) (*approvalJSON, string) {
		return h.say(agent, thread, `CALL:mcp__fixture__`+tool+`:{"text":"x"}`)
	}

	// The server's annotations reached the agent: read-only runs; destructive asks; unannotated and named like it asks.
	if req, reply := call(balanced, "a", "list_items"); req != nil || !strings.Contains(reply, "list_items: x") {
		t.Fatalf("a read-only tool under balanced: %+v %q", req, reply)
	}
	if req, _ := call(balanced, "b", "delete_item"); req == nil {
		t.Fatal("a destructive tool should ask under balanced")
	} else if got := h.settle(balanced, "b", req, "approve"); !strings.Contains(got, "delete_item: x") {
		t.Fatalf("after approving: %q", got)
	}
	if req, _ := call(balanced, "c", "send_note"); req == nil {
		t.Fatal("an unannotated tool named send_note should ask under balanced")
	} else {
		h.settle(balanced, "c", req, "deny")
	}
	// Careful asks for what isn't marked read-only, and runs what is.
	if req, reply := call(careful, "a", "list_items"); req != nil || !strings.Contains(reply, "list_items: x") {
		t.Fatalf("a read-only tool under careful: %+v %q", req, reply)
	}
	if req, _ := call(careful, "b", "send_note"); req == nil {
		t.Fatal("a tool not marked read-only should ask under careful")
	} else {
		h.settle(careful, "b", req, "deny")
	}
	// A rule for the tool, by name pattern.
	h.mustDo("POST", "/api/agents/"+balanced+"/approval-rules", map[string]any{"tool": "mcp__fixture__send_*"}, 201)
	if req, reply := call(balanced, "d", "send_note"); req != nil || !strings.Contains(reply, "send_note: x") {
		t.Fatalf("an always-allowed MCP tool: %+v %q", req, reply)
	}
}

// --- fast judgments ------------------------------------------------------------------------------------------

// judgeServer answers /v1/systemone: a noul for each question, high when the state's tool arguments mention "danger".
type judgeServer struct {
	*httptest.Server
	calls  atomic.Int32
	mu     sync.Mutex
	states []string
	fail   atomic.Bool
}

func newJudgeServer(t *testing.T) *judgeServer {
	j := &judgeServer{}
	j.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Model     string
			State     json.RawMessage
			Questions map[string]struct{ Type, Instructions string }
		}
		json.NewDecoder(r.Body).Decode(&req)
		j.calls.Add(1)
		if j.fail.Load() {
			w.WriteHeader(500)
			return
		}
		j.mu.Lock()
		j.states = append(j.states, string(req.State))
		j.mu.Unlock()
		noul := 0.05
		if strings.Contains(string(req.State), "danger") || strings.Contains(r.URL.RawQuery, "danger") {
			noul = 0.95
		}
		answers := map[string]any{}
		for name := range req.Questions {
			answers[name] = map[string]any{"type": "noul", "noul": noul}
		}
		json.NewEncoder(w).Encode(map[string]any{"model": req.Model, "answers": answers})
	}))
	t.Cleanup(j.Close)
	return j
}

func TestFastJudgmentsTightenApprovals(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	scripted(t, h)
	judge := newJudgeServer(t)
	agent := h.agentOn("Worker", "script/s1", map[string]any{
		"workspace": map[string]any{"tools": []string{"read", "bash"}},
		"approvals": map[string]any{"profile": "trusting", "rules": []map[string]any{{"tool": "bash", "args": map[string]string{"command": "echo allowed*"}, "action": "allow"}}},
	})

	// Off (the default): nothing is judged, and a command the rules let run runs.
	if req, reply := h.run(agent, "t1", "echo danger zone"); req != nil || !strings.Contains(reply, "danger zone") {
		t.Fatalf("with judgments off: %+v %q", req, reply)
	}
	if judge.calls.Load() != 0 {
		t.Fatal("something was judged with fast judgments off")
	}

	// On, with the approvals use: a risky-looking call asks, and says why; a harmless one runs.
	h.mustDo("PUT", "/api/settings/judgments", map[string]any{"enabled": true, "url": judge.URL, "apiKey": "k", "uses": map[string]bool{"approvals": true}}, 200)
	req, _ := h.run(agent, "t2", "echo danger zone")
	if req == nil || req.Summary == nil || *req.Summary != "Asked because fast judgments thought it could be risky." {
		t.Fatalf("a risky call should ask: %+v", req)
	}
	if got := h.settle(agent, "t2", req, "approve"); !strings.Contains(got, "danger zone") {
		t.Fatalf("after approving: %q", got)
	}
	if req, reply := h.run(agent, "t3", "echo calm waters"); req != nil || !strings.Contains(reply, "calm waters") {
		t.Fatalf("a harmless call: %+v %q", req, reply)
	}
	// It saw the tool and the command.
	judge.mu.Lock()
	seen := strings.Join(judge.states, "\n")
	judge.mu.Unlock()
	if !strings.Contains(seen, `"tool":"bash"`) || !strings.Contains(seen, "echo calm waters") {
		t.Fatalf("what the judge was shown: %s", seen)
	}

	// The person's own allow rule is not second-guessed; reading isn't judged (it changes nothing).
	before := judge.calls.Load()
	if req, reply := h.run(agent, "t4", "echo allowed danger"); req != nil || !strings.Contains(reply, "allowed danger") {
		t.Fatalf("an allow rule: %+v %q", req, reply)
	}
	h.mustDo("POST", "/api/agents/"+agent+"/threads/t5/messages", map[string]string{"text": "READ:nothing.txt", "requestId": "rd"}, 202)
	h.waitReply(agent, "t5")
	if judge.calls.Load() != before {
		t.Fatal("a rule's allow or a read was judged")
	}

	// A judge that fails changes nothing: the rules stand (fails open). It never loosens: an ask stays an ask.
	judge.fail.Store(true)
	if req, reply := h.run(agent, "t6", "echo danger again"); req != nil || !strings.Contains(reply, "danger again") {
		t.Fatalf("with a failing judge: %+v %q", req, reply)
	}
	h.mustDo("POST", "/api/agents/"+agent+"/approval-rules", map[string]any{"tool": "bash", "args": map[string]string{"command": "echo hold*"}, "action": "ask"}, 201)
	judge.fail.Store(false)
	if req, _ := h.run(agent, "t7", "echo hold on"); req == nil {
		t.Fatal("an ask rule was loosened")
	} else {
		h.settle(agent, "t7", req, "approve")
	}
}
