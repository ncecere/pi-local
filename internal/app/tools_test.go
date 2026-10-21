package app

import (
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ncecere/pi-local/internal/supervisor"
)

type approvalJSON struct {
	ID        string          `json:"id"`
	AgentID   string          `json:"agentId"`
	ThreadID  *string         `json:"threadId"`
	Tool      string          `json:"tool"`
	Arguments json.RawMessage `json:"arguments"`
	Status    string          `json:"status"`
	Reason    *string         `json:"reason"`
}

// toolsAgent is an agent on the scripted model with workspace tools; bash asks first.
func toolsAgent(t *testing.T, h *harness, tools []string, ask []string) string {
	t.Helper()
	scripted(t, h)
	return h.agentOn("Worker", "script/s1", map[string]any{
		"workspace": map[string]any{"tools": tools},
		"approvals": map[string]any{"tools": ask},
	})
}

func (h *harness) pendingApproval(agent string) approvalJSON {
	h.t.Helper()
	var found approvalJSON
	eventually(h.t, 20*time.Second, "an approval request", func() bool {
		list := decodeInto[[]approvalJSON](h.t, h.mustDo("GET", "/api/approvals", nil, 200))
		for _, a := range list {
			if a.AgentID == agent && a.Status == "pending" {
				found = a
				return true
			}
		}
		return false
	})
	return found
}

func (h *harness) waitReply(agent, thread string) view {
	h.t.Helper()
	var v view
	eventually(h.t, 30*time.Second, "the reply", func() bool {
		for _, th := range h.threads(agent) {
			if th.ThreadID == thread && !th.Busy && th.LastReplyAt != nil {
				v = h.view(agent, thread)
				return len(v.Messages) > 0 && v.Messages[len(v.Messages)-1].Role == "assistant"
			}
		}
		return false
	})
	return v
}

func TestACommandWaitsForApproval(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	agent := toolsAgent(t, h, []string{"read", "write", "bash"}, []string{"bash"})
	h.mustDo("POST", "/api/agents/"+agent+"/threads/t1/messages", map[string]string{"text": "RUN:echo hello > made.txt && cat made.txt", "requestId": "r1"}, 202)

	req := h.pendingApproval(agent)
	if req.Tool != "bash" || !strings.Contains(string(req.Arguments), "echo hello") || req.ThreadID == nil || *req.ThreadID != "t1" {
		t.Fatalf("the request: %+v %s", req, req.Arguments)
	}
	ws := filepath.Join(h.app.cfg.DataDir, "agents", agent, "workspace")
	if _, err := os.Stat(filepath.Join(ws, "made.txt")); err == nil {
		t.Fatal("the command ran before it was approved")
	}
	// The thread's view shows what waits; the agent counts it.
	if got := string(h.mustDo("GET", "/api/agents/"+agent+"/threads/t1", nil, 200)); !strings.Contains(got, `"approvals":[`) || !strings.Contains(got, req.ID) {
		t.Fatalf("the view doesn't show the pending request: %s", got)
	}
	if got := string(h.mustDo("GET", "/api/agents", nil, 200)); !strings.Contains(got, `"pendingApprovals":1`) {
		t.Fatalf("pendingApprovals: %s", got)
	}

	h.mustDo("POST", "/api/agents/"+agent+"/approvals/"+req.ID, map[string]string{"decision": "approve"}, 200)
	v := h.waitReply(agent, "t1")
	if reply := lastReply(v); !strings.Contains(reply, "Got: hello") {
		t.Fatalf("after approving: %q", reply)
	}
	if raw, _ := os.ReadFile(filepath.Join(ws, "made.txt")); strings.TrimSpace(string(raw)) != "hello" {
		t.Fatalf("the command's file: %q", raw)
	}
	if code, data := h.do("POST", "/api/agents/"+agent+"/approvals/"+req.ID, map[string]string{"decision": "deny"}); code != 409 || !strings.Contains(string(data), "approval_decided") {
		t.Fatalf("deciding twice: %d %s", code, data)
	}
	// write doesn't ask (only bash does).
	v = h.sendAndWait(agent, "t1", "WRITE:notes.md:# hi", "r2")
	if raw, _ := os.ReadFile(filepath.Join(ws, "notes.md")); string(raw) != "# hi" {
		t.Fatalf("write without approval: %q (%q)", raw, lastReply(v))
	}
}

func TestADenialAndATimeoutReachTheModel(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	agent := toolsAgent(t, h, []string{"bash"}, []string{"bash"})
	h.mustDo("POST", "/api/agents/"+agent+"/threads/t1/messages", map[string]string{"text": "RUN:rm -rf something", "requestId": "r1"}, 202)
	req := h.pendingApproval(agent)
	h.mustDo("POST", "/api/agents/"+agent+"/approvals/"+req.ID, map[string]string{"decision": "deny", "reason": "not today"}, 200)
	if reply := lastReply(h.waitReply(agent, "t1")); !strings.Contains(reply, "denied by") || !strings.Contains(reply, "not today") {
		t.Fatalf("the model should read the denial: %q", reply)
	}

	// A request nobody answers times out (its expiry moved to the past to keep the test short).
	h.mustDo("POST", "/api/agents/"+agent+"/threads/t2/messages", map[string]string{"text": "RUN:sleep 1", "requestId": "r2"}, 202)
	req = h.pendingApproval(agent)
	if _, err := h.app.DB.Exec(`UPDATE approvals SET expires_at = 1 WHERE id = ?`, req.ID); err != nil {
		t.Fatal(err)
	}
	h.app.Approvals.Kick()
	if reply := lastReply(h.waitReply(agent, "t2")); !strings.Contains(reply, "nobody approved it in time") {
		t.Fatalf("a timed-out request: %q", reply)
	}
}

func TestAnApprovalSurvivesSleepAndQuitting(t *testing.T) {
	dir := t.TempDir()
	first := start(t, dir, Config{})
	agent := toolsAgent(t, first, []string{"bash"}, []string{"bash"})
	first.mustDo("POST", "/api/agents/"+agent+"/threads/t1/messages", map[string]string{"text": "RUN:echo survived", "requestId": "r1"}, 202)
	req := first.pendingApproval(agent)

	// Asleep while it waits: approving wakes it, and the call runs.
	first.mustDo("POST", "/api/agents/"+agent+"/sleep", nil, 200)
	if s := first.status(agent); s != supervisor.Asleep {
		t.Fatalf("status: %s", s)
	}
	// Quitting the app doesn't lose it either.
	first.close()
	second := start(t, dir, Config{})
	second.app.ResumeUnfinished(t.Context())
	list := decodeInto[[]approvalJSON](t, second.mustDo("GET", "/api/approvals", nil, 200))
	if len(list) != 1 || list[0].ID != req.ID || list[0].Status != "pending" {
		t.Fatalf("after reopening: %+v", list)
	}
	second.mustDo("POST", "/api/agents/"+agent+"/approvals/"+req.ID, map[string]string{"decision": "approve"}, 200)
	if reply := lastReply(second.waitReply(agent, "t1")); !strings.Contains(reply, "Got: survived") {
		t.Fatalf("after approving a request from before the restart: %q", reply)
	}
}

func TestAttachments(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	scripted(t, h)
	blind := h.agentOn("Blind", "script/s1", nil)
	if code, _, body := h.raw("POST", "/api/agents/"+blind+"/attachments?name=a.txt", "text/plain", []byte("x")); code != 409 || !strings.Contains(string(body), "no_read_tool") {
		t.Fatalf("an agent without read: %d %s", code, body)
	}
	agent := h.agentOn("Reader", "script/s1", map[string]any{"workspace": map[string]any{"tools": []string{"read"}}})
	upload := func(name, content string) map[string]any {
		code, _, body := h.raw("POST", "/api/agents/"+agent+"/attachments?name="+url.QueryEscape(name), "application/octet-stream", []byte(content))
		if code != 201 {
			t.Fatalf("upload %q: %d %s", name, code, body)
		}
		return decodeInto[struct{ Data map[string]any }](t, body).Data
	}
	day := time.Now().Format(time.DateOnly)
	first := upload("report.txt", "quarterly numbers")
	if first["path"] != "attachments/"+day+"/report.txt" || first["size"] != float64(17) || first["mediaType"] != "text/plain; charset=utf-8" {
		t.Fatalf("upload: %+v", first)
	}
	if second := upload("report.txt", "again"); second["name"] != "report (2).txt" {
		t.Fatalf("a taken name: %+v", second)
	}
	// A name can't climb out of the attachments folder.
	if sneaky := upload("../../../../etc/passwd", "nope"); sneaky["path"] != "attachments/"+day+"/passwd" {
		t.Fatalf("a path in the name: %+v", sneaky)
	}
	if code, _, _ := h.raw("POST", "/api/agents/"+agent+"/attachments?name=empty.txt", "", nil); code != 400 {
		t.Fatalf("an empty upload: %d", code)
	}
	// The agent opens it with read.
	v := h.sendAndWait(agent, "t1", "READ:"+first["path"].(string), "r1")
	if reply := lastReply(v); !strings.Contains(reply, "quarterly numbers") {
		t.Fatalf("the agent reading the attachment: %q", reply)
	}
}

// A command never sees the runtime's environment: its model key, its gateway key, its MCP servers' secrets.
func TestBashDoesNotSeeTheRuntimesKeys(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	defer h.close()
	agent := toolsAgent(t, h, []string{"bash"}, []string{})
	v := h.sendAndWait(agent, "t1", "RUN:echo model=[$MODEL_API_KEY] platform=[$PLATFORM_KEY] gw=[$PLATFORM_GATEWAY_URL] n=$(env | grep -c -E 'KEY|TOKEN|SECRET|PLATFORM_|MODEL_') home=[${HOME:+set}]", "r1")
	out := strings.Join(toolResults(v), "\n")
	if !strings.Contains(out, "model=[] platform=[] gw=[] n=0") || !strings.Contains(out, "home=[set]") {
		t.Fatalf("the command's environment: %q", out)
	}
}
