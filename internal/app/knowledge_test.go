package app

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ncecere/pi-local/internal/knowledge/knowledgetest"
)

type knowledgeStatus struct {
	Folders []struct {
		Path     string `json:"path"`
		State    string `json:"state"`
		Files    int    `json:"files"`
		Passages int    `json:"passages"`
		Problems int    `json:"problems"`
	} `json:"folders"`
}

func (h *harness) knowledge(agent string) knowledgeStatus {
	h.t.Helper()
	return decodeInto[knowledgeStatus](h.t, h.mustDo("GET", "/api/agents/"+agent+"/knowledge", nil, 200))
}

func (h *harness) knowledgeReady(agent string, files int) {
	h.t.Helper()
	eventually(h.t, 60*time.Second, "the knowledge folder to be indexed", func() bool {
		k := h.knowledge(agent)
		return len(k.Folders) > 0 && k.Folders[0].State == "ready" && k.Folders[0].Files == files
	})
}

type openedFile struct {
	path   string
	reveal bool
}

func docsFolder(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	must := func(err error) {
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.WriteFile(filepath.Join(dir, "policy.md"), []byte("# Returns policy\n\nCustomers may return goods within 30 days for a refund.\n"), 0o644))
	must(os.WriteFile(filepath.Join(dir, "contract.pdf"), knowledgetest.PDF("This agreement starts on 1 March.", "The refund window is 45 days from delivery."), 0o644))
	must(os.WriteFile(filepath.Join(dir, "plan.docx"), knowledgetest.DOCX("Project plan", "Milestones", "The prototype ships in June.", "Budget refunds are not planned."), 0o644))
	must(os.WriteFile(filepath.Join(dir, "broken.pdf"), []byte("not a pdf"), 0o644))
	return dir
}

func TestAnAgentSearchesItsKnowledgeFoldersAndCitesWithLinksThatOpenTheFiles(t *testing.T) {
	var mu sync.Mutex
	var opened []openedFile
	h := start(t, t.TempDir(), Config{
		KnowledgeInterval: 200 * time.Millisecond,
		OpenFile: func(path string, reveal bool) error {
			mu.Lock()
			defer mu.Unlock()
			opened = append(opened, openedFile{path, reveal})
			return nil
		},
	})
	defer h.close()
	scripted(t, h)
	dir := docsFolder(t)

	// A folder must be a folder on this computer; the disk and the home folder are too much.
	h.mustDo("POST", "/api/agents", map[string]any{"name": "Nope", "knowledge": map[string]any{"folders": []string{filepath.Join(dir, "missing")}}}, 400)
	h.mustDo("POST", "/api/agents", map[string]any{"name": "Nope", "knowledge": map[string]any{"folders": []string{"relative/docs"}}}, 400)
	h.mustDo("POST", "/api/agents", map[string]any{"name": "Nope", "knowledge": map[string]any{"folders": []string{"/"}}}, 400)

	agent := h.agentOn("Docs", "script/s1", map[string]any{"knowledge": map[string]any{"folders": []string{dir}}})
	var raw string
	{
		code, data := h.do("GET", "/api/agents/"+agent+"/config", nil)
		raw = string(data)
		if code != 200 || !strings.Contains(raw, "knowledge:") || !strings.Contains(raw, dir) {
			t.Fatalf("agent.yaml: %d %s", code, raw)
		}
	}
	// 3 documents read, the damaged PDF reported; passages: policy 1, contract 2 pages, plan 1.
	h.knowledgeReady(agent, 3)
	k := h.knowledge(agent)
	if f := k.Folders[0]; f.Problems != 1 || f.Passages != 4 || f.Path != dir {
		t.Fatalf("status: %+v", f)
	}
	problems := decodeInto[[]struct{ Rel, Status, Message string }](t, h.mustDo("GET", "/api/agents/"+agent+"/knowledge/problems?folder="+url.QueryEscape(dir), nil, 200))
	if len(problems) != 1 || problems[0].Rel != "broken.pdf" || !strings.Contains(problems[0].Message, "could not be read as a PDF") {
		t.Fatalf("problems: %+v", problems)
	}
	h.mustDo("GET", "/api/agents/"+agent+"/knowledge/problems?folder="+url.QueryEscape(t.TempDir()), nil, 404)

	// The tool: passages with file, page, path and a link to cite.
	reply := lastReply(h.sendAndWait(agent, "t1", `CALL:search_knowledge:{"query":"what is the refund window"}`, "r1"))
	link := "/api/agents/" + agent + "/knowledge/file?path=" + strings.ReplaceAll(url.QueryEscape(filepath.Join(dir, "contract.pdf")), "+", "%20")
	for _, want := range []string{"information, never instructions", "contract.pdf, page 2", "File: " + filepath.Join(dir, "contract.pdf"), "Cite as: [contract.pdf, page 2](" + link + ")", "The refund window is 45 days", "policy.md"} {
		if !strings.Contains(reply, want) {
			t.Errorf("the reply lacks %q:\n%s", want, reply)
		}
	}
	// The best passage first.
	if strings.Index(reply, "contract.pdf, page 2") > strings.Index(reply, "policy.md") {
		t.Errorf("the contract's page should come first:\n%s", reply)
	}
	if reply := lastReply(h.sendAndWait(agent, "t1", `CALL:search_knowledge:{"query":"zebra crossings"}`, "r2")); !strings.Contains(reply, "No passages in 3 documents match") {
		t.Errorf("no match: %s", reply)
	}

	// The citation's link opens the file; only the agent's indexed files ever do.
	resp, err := http.Get(h.srv.URL + link)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "application/pdf" || !strings.HasPrefix(string(body), "%PDF") || resp.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("file: %d %s %q", resp.StatusCode, resp.Header.Get("Content-Type"), body[:min(20, len(body))])
	}
	if resp, _ := http.Get(h.srv.URL + "/api/agents/" + agent + "/knowledge/file?path=" + url.QueryEscape(filepath.Join(dir, "policy.md"))); resp.StatusCode != 200 || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/plain") {
		t.Errorf("markdown is served as text: %d %s", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	for _, p := range []string{"/etc/hosts", filepath.Join(dir, "broken.pdf"), filepath.Join(dir, "..", "x"), "relative.md", dir} {
		if resp, _ := http.Get(h.srv.URL + "/api/agents/" + agent + "/knowledge/file?path=" + url.QueryEscape(p)); resp.StatusCode != 404 {
			t.Errorf("served %s: %d", p, resp.StatusCode)
		}
	}
	open := func(path string, reveal bool, want int) {
		t.Helper()
		h.mustDo("POST", "/api/agents/"+agent+"/knowledge/open", map[string]any{"path": path, "reveal": reveal}, want)
	}
	open(filepath.Join(dir, "contract.pdf"), false, 200)
	open(filepath.Join(dir, "plan.docx"), true, 200)
	open("/etc/hosts", false, 404)
	open(filepath.Join(dir, "broken.pdf"), false, 404)
	canonicalDir, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	if len(opened) != 2 || opened[0] != (openedFile{filepath.Join(canonicalDir, "contract.pdf"), false}) || opened[1] != (openedFile{filepath.Join(canonicalDir, "plan.docx"), true}) {
		t.Fatalf("opened: %+v", opened)
	}
	mu.Unlock()
	// Another agent can't open this agent's files.
	other := h.agentOn("Other", "script/s1", nil)
	h.mustDo("POST", "/api/agents/"+other+"/knowledge/open", map[string]any{"path": filepath.Join(dir, "contract.pdf")}, 404)
	// A page elsewhere can't make it open (no JSON content type).
	req, _ := http.NewRequest("POST", h.srv.URL+"/api/agents/"+agent+"/knowledge/open", strings.NewReader(`{"path":"`+filepath.Join(dir, "contract.pdf")+`"}`))
	req.Header.Set("Content-Type", "text/plain")
	if resp, _ := http.DefaultClient.Do(req); resp.StatusCode != 415 {
		t.Errorf("a plain-text POST: %d", resp.StatusCode)
	}
	mu.Lock()
	if len(opened) != 2 {
		t.Errorf("opened by a refused request: %+v", opened)
	}
	mu.Unlock()

	// The agent can read a whole file outside its workspace (read-only), and not change anything there.
	if reply := lastReply(h.sendAndWait(agent, "t2", "READ:"+filepath.Join(dir, "contract.pdf"), "r1")); !strings.Contains(reply, "The refund window is 45 days from delivery.") {
		t.Errorf("read: %s", reply)
	}
	writer := h.agentOn("Writer", "script/s1", map[string]any{"knowledge": map[string]any{"folders": []string{dir}}, "workspace": map[string]any{"tools": []string{"write"}}})
	reply = lastReply(h.sendAndWait(writer, "t1", "WRITE:"+filepath.Join(dir, "planted.md")+":hello", "r1"))
	if !strings.Contains(reply, "outside the agent's workspace") {
		t.Errorf("write: %s", reply)
	}
	if _, err := os.Stat(filepath.Join(dir, "planted.md")); err == nil {
		t.Fatal("the agent wrote into its knowledge folder")
	}
	// Another agent's `read` doesn't reach the folder.
	scriptedRead := lastReply(h.sendAndWait(other, "t1", "READ:"+filepath.Join(dir, "policy.md"), "r1"))
	if strings.Contains(scriptedRead, "within 30 days") {
		t.Errorf("an agent without the folder read it: %s", scriptedRead)
	}

	// Watching: a file added to the folder is searchable soon; one deleted is not.
	os.WriteFile(filepath.Join(dir, "faq.txt"), []byte("Warranty claims are answered within two business days by the support desk."), 0o644)
	os.Remove(filepath.Join(dir, "policy.md"))
	search := func(q string) string {
		return string(h.mustDo("GET", "/api/agents/"+agent+"/knowledge/search?q="+url.QueryEscape(q), nil, 200))
	}
	eventually(t, 30*time.Second, "the watcher", func() bool {
		return strings.Contains(search("warranty claims"), "faq.txt") && !strings.Contains(search("returns policy"), "policy.md")
	})
	h.knowledgeReady(agent, 3) // contract, plan, faq

	// Without folders there is no tool; the gateway says why if asked anyway.
	if reply := lastReply(h.sendAndWait(other, "t2", `CALL:search_knowledge:{"query":"anything"}`, "r1")); strings.Contains(reply, "contract.pdf") {
		t.Errorf("an agent without folders searched: %s", reply)
	}

	// The index is shared by the agents that use a folder: it is forgotten when the last one lets it go.
	h.mustDo("PATCH", "/api/agents/"+agent, map[string]any{"knowledge": map[string]any{"folders": []string{}}}, 200)
	time.Sleep(600 * time.Millisecond)
	var left int
	h.app.DB.QueryRow(`SELECT COUNT(*) FROM knowledge_files`).Scan(&left)
	if left != 4 { // contract, plan, faq, and the damaged PDF
		t.Fatalf("%d files left while another agent still uses the folder", left)
	}
	h.mustDo("PATCH", "/api/agents/"+writer, map[string]any{"knowledge": map[string]any{"folders": []string{}}}, 200)
	eventually(t, 30*time.Second, "the index to forget the folder", func() bool {
		var n int
		h.app.DB.QueryRow(`SELECT COUNT(*) FROM knowledge_files`).Scan(&n)
		return n == 0
	})
	if k := h.knowledge(agent); len(k.Folders) != 0 {
		t.Fatalf("status without folders: %+v", k)
	}
}

func TestKnowledgeIsRankedByFastJudgmentsWhenOnAndFallsBackWhenTheyFail(t *testing.T) {
	h := start(t, t.TempDir(), Config{KnowledgeInterval: time.Hour})
	defer h.close()
	scripted(t, h)
	dir := t.TempDir()
	// Seven documents that all mention returns; the judgment likes only the one about "restocking".
	for i := 1; i <= 7; i++ {
		text := "Notes about returns, number " + string(rune('0'+i)) + ". Returns are mentioned here."
		if i == 5 {
			text = "Returns carry a restocking fee of 15 percent, which the customer pays."
		}
		os.WriteFile(filepath.Join(dir, "doc"+string(rune('0'+i))+".txt"), []byte(text), 0o644)
	}
	agent := h.agentOn("Docs", "script/s1", map[string]any{"knowledge": map[string]any{"folders": []string{dir}}})
	h.knowledgeReady(agent, 7)

	// Off: the index's order, five passages.
	reply := lastReply(h.sendAndWait(agent, "t1", `CALL:search_knowledge:{"query":"returns"}`, "r1"))
	if n := strings.Count(reply, "Cite as:"); n != 5 {
		t.Fatalf("%d passages without judgments:\n%s", n, reply)
	}

	ts, calls := fakeSystemOne(t, nil, func(instructions string) float64 {
		if strings.Contains(instructions, "restocking") {
			return 0.95
		}
		return 0.1
	})
	h.mustDo("PUT", "/api/settings/judgments", map[string]any{"enabled": true, "url": ts.URL, "apiKey": "ts-key", "uses": map[string]bool{"knowledge": true}}, 200)
	before := calls.Load()
	reply = lastReply(h.sendAndWait(agent, "t1", `CALL:search_knowledge:{"query":"what is the restocking fee on returns"}`, "r2"))
	if calls.Load() != before+1 {
		t.Fatalf("%d judgment requests", calls.Load()-before)
	}
	if n := strings.Count(reply, "Cite as:"); n != 1 || !strings.Contains(reply, "restocking fee of 15 percent") {
		t.Fatalf("judged passages: %d\n%s", n, reply)
	}

	// None judged relevant: the index's own best five stand (a judgment never empties an answer).
	h.mustDo("PUT", "/api/settings/judgments", map[string]any{"threshold": 0.99}, 200)
	ts2, _ := fakeSystemOne(t, nil, func(string) float64 { return 0.2 })
	h.mustDo("PUT", "/api/settings/judgments", map[string]any{"url": ts2.URL}, 200)
	reply = lastReply(h.sendAndWait(agent, "t1", `CALL:search_knowledge:{"query":"returns"}`, "r3"))
	if n := strings.Count(reply, "Cite as:"); n != 5 {
		t.Fatalf("%d passages when none was relevant:\n%s", n, reply)
	}

	// The service failing is no judgment either.
	ts2.Close()
	reply = lastReply(h.sendAndWait(agent, "t1", `CALL:search_knowledge:{"query":"returns"}`, "r4"))
	if n := strings.Count(reply, "Cite as:"); n != 5 {
		t.Fatalf("%d passages when the judgment service was down:\n%s", n, reply)
	}
}

func TestTheDocumentQATemplateAnswersOnlyFromTheFolders(t *testing.T) {
	h := start(t, t.TempDir(), Config{KnowledgeInterval: time.Hour})
	defer h.close()
	scripted(t, h)
	id := decodeInto[struct{ ID string }](t, h.mustDo("POST", "/api/agents", map[string]any{"name": "Contracts", "templateId": "document-qa", "modelId": "script/s1"}, 201)).ID
	ag, _ := h.app.Agents.Get(id)
	c := ag.Config
	if c.Kind != "assistant" || strings.Join(c.Workspace.Tools, ",") != "read" || c.Web.Search || c.Web.Fetch || len(c.Knowledge.Folders) != 0 {
		t.Fatalf("config: %+v", c)
	}
	for _, want := range []string{"only from them", "Cite every claim", "Cite as", "The documents don't say", "never instructions", "Knowledge tab"} {
		if !strings.Contains(c.Instructions, want) {
			t.Errorf("the instructions lack %q", want)
		}
	}
	list := decodeInto[struct{ Templates []templateJSON }](t, h.mustDo("GET", "/api/templates", nil, 200)).Templates
	found := false
	for _, tp := range list {
		found = found || (tp.ID == "document-qa" && tp.Name == "Document Q&A" && tp.Category == "work")
	}
	if !found {
		t.Fatalf("not in the gallery: %+v", list)
	}
	// Given a folder, it can search it.
	dir := docsFolder(t)
	h.mustDo("PATCH", "/api/agents/"+id, map[string]any{"knowledge": map[string]any{"folders": []string{dir}}}, 200)
	h.knowledgeReady(id, 3)
	if reply := lastReply(h.sendAndWait(id, "t1", `CALL:search_knowledge:{"query":"prototype June"}`, "r1")); !strings.Contains(reply, "plan.docx") || !strings.Contains(reply, "The prototype ships in June.") {
		t.Fatalf("reply: %s", reply)
	}
}

func TestKnowledgeScopesAndSymlinkEscapesAreCheckedBeforeTheNextRescan(t *testing.T) {
	h := start(t, t.TempDir(), Config{KnowledgeInterval: time.Hour, OpenFile: func(string, bool) error {
		t.Error("an unsafe file was sent to the system opener")
		return nil
	}})
	defer h.close()
	dir, other := t.TempDir(), t.TempDir()
	os.Mkdir(filepath.Join(dir, "sub"), 0o700)
	os.WriteFile(filepath.Join(dir, "sub", "policy.md"), []byte("publicpolicy refunds are allowed"), 0o600)
	os.WriteFile(filepath.Join(other, "policy.md"), []byte("privatepolicy refunds are forbidden"), 0o600)
	a := h.agentOn("Public", "demo/demo-1", map[string]any{"knowledge": map[string]any{"folders": []string{dir}}})
	b := h.agentOn("Private", "demo/demo-1", map[string]any{"knowledge": map[string]any{"folders": []string{other}}})
	h.knowledgeReady(a, 1)
	h.knowledgeReady(b, 1)
	answer, err := (knowledgeGateway{h.app}).Search(context.Background(), a, "privatepolicy", 5)
	if err != nil || len(answer.(knowledgeAnswer).Passages) != 0 {
		t.Fatalf("another agent's knowledge: %+v %v", answer, err)
	}
	os.RemoveAll(filepath.Join(dir, "sub"))
	os.Symlink(other, filepath.Join(dir, "sub"))
	path := filepath.Join(dir, "sub", "policy.md")
	h.mustDo("GET", KnowledgeLink(a, path), nil, 404)
	h.mustDo("POST", "/api/agents/"+a+"/knowledge/open", map[string]any{"path": path}, 404)
	answer, err = (knowledgeGateway{h.app}).Search(context.Background(), a, "publicpolicy", 5)
	if err != nil || len(answer.(knowledgeAnswer).Passages) != 0 {
		t.Fatalf("escaping stale citation: %+v %v", answer, err)
	}
	// Revocation is immediate, even while the global index still holds this folder for another agent.
	h.mustDo("PATCH", "/api/agents/"+a, map[string]any{"knowledge": map[string]any{"folders": []string{other}}}, 200)
	h.mustDo("PATCH", "/api/agents/"+a, map[string]any{"knowledge": map[string]any{"folders": []string{}}}, 200)
	_, err = (knowledgeGateway{h.app}).Search(context.Background(), a, "privatepolicy", 5)
	if err == nil {
		t.Fatal("an agent with no enabled folders searched the shared index")
	}
	h.mustDo("POST", "/api/agents/"+a+"/knowledge/open", map[string]any{"path": filepath.Join(other, "policy.md")}, 404)
}

// A folder that has gone while the app was closed: the agent can still be renamed, and says so.
func TestAnAgentWithAFolderThatWentAwayKeepsWorking(t *testing.T) {
	dataDir := t.TempDir()
	dir := docsFolder(t)
	h := start(t, dataDir, Config{KnowledgeInterval: time.Hour})
	scripted(t, h)
	agent := h.agentOn("Docs", "script/s1", map[string]any{"knowledge": map[string]any{"folders": []string{dir}}})
	h.knowledgeReady(agent, 3)
	h.close()

	os.RemoveAll(dir)
	h = start(t, dataDir, Config{KnowledgeInterval: time.Hour})
	defer h.close()
	h.mustDo("PATCH", "/api/agents/"+agent, map[string]any{"name": "Renamed"}, 200)
	eventually(t, 30*time.Second, "the missing status", func() bool {
		k := h.knowledge(agent)
		return len(k.Folders) == 1 && k.Folders[0].State == "missing"
	})
	// Not as a new folder, though.
	h.mustDo("PATCH", "/api/agents/"+agent, map[string]any{"knowledge": map[string]any{"folders": []string{dir, filepath.Join(dir, "other")}}}, 400)
	// An exported agent comes back without folders this computer doesn't have.
	if _, err := os.Stat(dir); err == nil {
		t.Fatal("the folder is back")
	}
}
