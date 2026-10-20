package app

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/ncecere/pi-local/internal/secrets"
	"github.com/ncecere/pi-local/internal/supervisor"
)

// testRuntime runs the runtime from source (node --import tsx src/main.ts), so the tests need `pnpm install` in
// runtime/ but no bundle.
func testRuntime(t *testing.T) supervisor.Runtime {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	dir := filepath.Join(filepath.Dir(file), "..", "..", "runtime")
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	return supervisor.Runtime{Node: node, Args: []string{"--disable-warning=ExperimentalWarning", "--import", "tsx"}, Script: "src/main.ts", Dir: dir}
}

type harness struct {
	t   *testing.T
	app *App
	srv *httptest.Server
}

func start(t *testing.T, dataDir string, cfg Config) *harness {
	t.Helper()
	cfg.DataDir = dataDir
	cfg.Runtime = testRuntime(t)
	if cfg.Secrets == nil {
		// Never the real keychain in tests.
		cfg.Secrets = secrets.NewMemory()
	}
	if cfg.StopGrace == 0 {
		cfg.StopGrace = 10 * time.Second
	}
	a, err := New(context.Background(), cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	h := &harness{t: t, app: a, srv: httptest.NewServer(a.API.Handler())}
	t.Cleanup(h.close)
	// A failure explains itself: every agent's runtime log.
	t.Cleanup(func() {
		if !t.Failed() {
			return
		}
		logs, _ := filepath.Glob(filepath.Join(dataDir, "agents", "*", "logs", "runtime.log"))
		for _, f := range logs {
			raw, _ := os.ReadFile(f)
			if len(raw) > 6000 {
				raw = raw[len(raw)-6000:]
			}
			t.Logf("--- %s ---\n%s", f, raw)
		}
	})
	return h
}

func (h *harness) close() {
	if h.srv != nil {
		h.srv.CloseClientConnections()
		h.srv.Close()
		h.srv = nil
	}
	if h.app != nil {
		h.app.Close()
		h.app = nil
	}
}

func (h *harness) do(method, path string, body any) (int, json.RawMessage) {
	h.t.Helper()
	var reader io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		reader = bytes.NewReader(raw)
	}
	req, _ := http.NewRequest(method, h.srv.URL+path, reader)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	var out struct {
		Data  json.RawMessage `json:"data"`
		Error json.RawMessage `json:"error"`
	}
	raw, _ := io.ReadAll(resp.Body)
	json.Unmarshal(raw, &out)
	if out.Data == nil {
		return resp.StatusCode, raw
	}
	return resp.StatusCode, out.Data
}

func (h *harness) createAgent(name string) string {
	h.t.Helper()
	code, data := h.do("POST", "/api/agents", map[string]string{"name": name})
	if code != 201 {
		h.t.Fatalf("create agent: %d %s", code, data)
	}
	var ag struct {
		ID string `json:"id"`
	}
	json.Unmarshal(data, &ag)
	return ag.ID
}

type thread struct {
	ThreadID    string  `json:"threadId"`
	Title       string  `json:"title"`
	Busy        bool    `json:"busy"`
	LastReplyAt *int64  `json:"lastReplyAt"`
	LastError   *string `json:"lastError"`
}

func (h *harness) threads(agent string) []thread {
	h.t.Helper()
	code, data := h.do("GET", "/api/agents/"+agent+"/threads", nil)
	if code != 200 {
		h.t.Fatalf("list threads: %d %s", code, data)
	}
	var list []thread
	json.Unmarshal(data, &list)
	return list
}

type view struct {
	Busy     bool `json:"busy"`
	Messages []struct {
		Role       string `json:"role"`
		Text       string `json:"text"`
		Error      string `json:"error"`
		StopReason string `json:"stopReason"`
	} `json:"messages"`
	Partial *struct {
		Text string `json:"text"`
	} `json:"partial"`
}

func (h *harness) view(agent, thread string) view {
	h.t.Helper()
	code, data := h.do("GET", "/api/agents/"+agent+"/threads/"+thread, nil)
	if code != 200 {
		h.t.Fatalf("view: %d %s", code, data)
	}
	var v view
	json.Unmarshal(data, &v)
	return v
}

func eventually(t *testing.T, within time.Duration, what string, check func() bool) {
	t.Helper()
	deadline := time.Now().Add(within)
	for !check() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func (h *harness) status(agent string) supervisor.Status {
	s, _ := h.app.Sup.Status(agent)
	return s
}

// The Phase 1 milestone: chat, quit the app mid-reply, open it again, and the reply finishes by itself.
func TestQuitMidReplyAndTheReplyFinishesAfterReopening(t *testing.T) {
	dir := t.TempDir()
	first := start(t, dir, Config{DemoTokensPerSecond: "15"})
	agent := first.createAgent("Helper")

	// Listing an agent's threads never starts it.
	if got := first.threads(agent); len(got) != 0 {
		t.Fatalf("a new agent has threads: %v", got)
	}
	if s := first.status(agent); s != supervisor.Asleep {
		t.Fatalf("listing woke the agent: %s", s)
	}

	code, data := first.do("POST", "/api/agents/"+agent+"/threads/t1/messages", map[string]string{"text": "Hello there\nsecond line", "requestId": "r1"})
	if code != 202 {
		t.Fatalf("send: %d %s", code, data)
	}
	list := first.threads(agent)
	if len(list) != 1 || list[0].ThreadID != "t1" || !list[0].Busy || list[0].Title != "Hello there" {
		t.Fatalf("thread list after the first message: %+v", list)
	}
	eventually(t, 15*time.Second, "a partial reply", func() bool {
		v := first.view(agent, "t1")
		return v.Busy && v.Partial != nil && v.Partial.Text != ""
	})

	// Quit: every runtime stops gracefully; the reply in progress stays pending in the agent's storage.
	first.close()

	second := start(t, dir, Config{DemoTokensPerSecond: "100000"})
	if got := second.threads(agent); len(got) != 1 || !got[0].Busy {
		t.Fatalf("after reopening, the index should still show the reply in progress: %+v", got)
	}
	second.app.ResumeUnfinished(context.Background())
	// Nobody opens the thread: the runtime resumes, finishes, and reports the end to the index.
	eventually(t, 30*time.Second, "the resumed reply to finish (as the index reports it)", func() bool {
		got := second.threads(agent)
		return len(got) == 1 && !got[0].Busy && got[0].LastReplyAt != nil
	})
	v := second.view(agent, "t1")
	last := v.Messages[len(v.Messages)-1]
	if last.Role != "assistant" || last.Text == "" || last.Error != "" {
		t.Fatalf("the last message should be the finished reply: %+v", v.Messages)
	}
}

func TestIdleAgentsHibernateAndListingDoesNotWakeThem(t *testing.T) {
	h := start(t, t.TempDir(), Config{DemoTokensPerSecond: "100000", IdleTimeout: 2 * time.Second, ReapInterval: 250 * time.Millisecond})
	agent := h.createAgent("Sleeper")
	if code, data := h.do("POST", "/api/agents/"+agent+"/threads/t1/messages", map[string]string{"text": "hi", "requestId": "r1"}); code != 202 {
		t.Fatalf("send: %d %s", code, data)
	}
	eventually(t, 20*time.Second, "the reply", func() bool {
		got := h.threads(agent)
		return len(got) == 1 && !got[0].Busy && got[0].LastReplyAt != nil
	})
	eventually(t, 20*time.Second, "hibernation", func() bool { return h.status(agent) == supervisor.Asleep })
	for range 3 {
		h.threads(agent)
		h.do("GET", "/api/agents", nil)
	}
	time.Sleep(300 * time.Millisecond)
	if s := h.status(agent); s != supervisor.Asleep {
		t.Fatalf("listing woke a hibernated agent: %s", s)
	}
	// Opening the thread wakes it, and its conversation is all there.
	v := h.view(agent, "t1")
	if len(v.Messages) < 2 {
		t.Fatalf("conversation after waking: %+v", v)
	}
	if s := h.status(agent); s != supervisor.Awake {
		t.Fatalf("opening a thread should wake the agent: %s", s)
	}
}

func TestACrashedRuntimeIsRestartedAndFinishesItsReply(t *testing.T) {
	h := start(t, t.TempDir(), Config{DemoTokensPerSecond: "15"})
	agent := h.createAgent("Crashy")
	if code, data := h.do("POST", "/api/agents/"+agent+"/threads/t1/messages", map[string]string{"text": "hi", "requestId": "r1"}); code != 202 {
		t.Fatalf("send: %d %s", code, data)
	}
	eventually(t, 15*time.Second, "a partial reply", func() bool {
		v := h.view(agent, "t1")
		return v.Partial != nil && v.Partial.Text != ""
	})
	pid := h.app.Sup.PID(agent)
	if pid == 0 {
		t.Fatal("no runtime process")
	}
	syscall.Kill(-pid, syscall.SIGKILL)
	eventually(t, 10*time.Second, "a new runtime process", func() bool {
		p := h.app.Sup.PID(agent)
		return p != 0 && p != pid
	})
	eventually(t, 60*time.Second, "the reply to finish after the crash", func() bool {
		got := h.threads(agent)
		return len(got) == 1 && !got[0].Busy && got[0].LastReplyAt != nil
	})
}

func TestARefusedFirstMessageLeavesNoThread(t *testing.T) {
	h := start(t, t.TempDir(), Config{DemoTokensPerSecond: "100000"})
	agent := h.createAgent("Strict")
	code, _ := h.do("POST", "/api/agents/"+agent+"/threads/t1/messages", map[string]string{"text": "hi", "requestId": "not a valid id!"})
	if code != 400 {
		t.Fatalf("expected the runtime's 400, got %d", code)
	}
	if got := h.threads(agent); len(got) != 0 {
		t.Fatalf("a refused first message left a thread: %+v", got)
	}
	if code, _ := h.do("POST", "/api/agents/"+agent+"/threads/bad%20id/messages", map[string]string{"text": "hi"}); code != 400 {
		t.Fatalf("a malformed thread ID: %d", code)
	}
}

func TestRenameDeleteAndConfigChange(t *testing.T) {
	h := start(t, t.TempDir(), Config{DemoTokensPerSecond: "100000"})
	agent := h.createAgent("Original")
	h.do("POST", "/api/agents/"+agent+"/threads/t1/messages", map[string]string{"text": "first", "requestId": "r1"})
	eventually(t, 20*time.Second, "the reply", func() bool {
		got := h.threads(agent)
		return len(got) == 1 && !got[0].Busy && got[0].LastReplyAt != nil
	})
	if code, data := h.do("PATCH", "/api/agents/"+agent+"/threads/t1", map[string]string{"title": "  My   chat "}); code != 200 || !strings.Contains(string(data), `"title":"My chat"`) {
		t.Fatalf("rename: %d %s", code, data)
	}
	if got := h.threads(agent); got[0].Title != "My chat" {
		t.Fatalf("renamed title not listed: %+v", got)
	}

	// A config change restarts an awake agent on the new revision.
	pid := h.app.Sup.PID(agent)
	if code, data := h.do("PATCH", "/api/agents/"+agent, map[string]string{"name": "Renamed", "instructions": "Be terse."}); code != 200 {
		t.Fatalf("patch agent: %d %s", code, data)
	}
	eventually(t, 20*time.Second, "a restart on the new configuration", func() bool {
		p := h.app.Sup.PID(agent)
		return p != 0 && p != pid
	})
	if code, data := h.do("PATCH", "/api/agents/"+agent, map[string]string{"name": ""}); code != 400 || !strings.Contains(string(data), "invalid_name") {
		t.Fatalf("an empty name: %d %s", code, data)
	}

	if code, _ := h.do("DELETE", "/api/agents/"+agent+"/threads/t1", nil); code != 200 {
		t.Fatalf("delete thread: %d", code)
	}
	if got := h.threads(agent); len(got) != 0 {
		t.Fatalf("deleted thread still listed: %+v", got)
	}
	if code, _ := h.do("DELETE", "/api/agents/"+agent, nil); code != 200 {
		t.Fatalf("delete agent: %d", code)
	}
	if code, _ := h.do("GET", "/api/agents/"+agent+"/threads", nil); code != 404 {
		t.Fatalf("a deleted agent's threads: %d", code)
	}
	if h.app.Sup.PID(agent) != 0 {
		t.Fatal("a deleted agent's runtime is still running")
	}
}

func TestLiveEventsFollowAThread(t *testing.T) {
	h := start(t, t.TempDir(), Config{DemoTokensPerSecond: "100000"})
	agent := h.createAgent("Eventful")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", h.srv.URL+"/api/events", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	type ev struct {
		name string
		data string
	}
	evs := make(chan ev, 100)
	go func() {
		sc := bufio.NewScanner(resp.Body)
		var name string
		for sc.Scan() {
			line := sc.Text()
			if v, ok := strings.CutPrefix(line, "event: "); ok {
				name = v
			} else if v, ok := strings.CutPrefix(line, "data: "); ok {
				evs <- ev{name, v}
			}
		}
		close(evs)
	}()
	if first := <-evs; first.name != "ready" {
		t.Fatalf("first event: %+v", first)
	}
	h.do("POST", "/api/agents/"+agent+"/threads/t1/messages", map[string]string{"text": "hi", "requestId": "r1"})
	sawBusy, sawDone, sawAwake := false, false, false
	timeout := time.After(20 * time.Second)
	for !(sawBusy && sawDone && sawAwake) {
		select {
		case e, open := <-evs:
			if !open {
				t.Fatal("event stream ended")
			}
			switch e.name {
			case "thread":
				var te struct {
					ThreadID string  `json:"threadId"`
					Thread   *thread `json:"thread"`
				}
				json.Unmarshal([]byte(e.data), &te)
				if te.ThreadID == "t1" && te.Thread != nil && te.Thread.Busy {
					sawBusy = true
				}
				if te.ThreadID == "t1" && te.Thread != nil && !te.Thread.Busy && te.Thread.LastReplyAt != nil {
					sawDone = true
				}
			case "agent":
				if strings.Contains(e.data, `"status":"awake"`) {
					sawAwake = true
				}
			}
		case <-timeout:
			t.Fatalf("events: busy %v done %v awake %v", sawBusy, sawDone, sawAwake)
		}
	}
}

func TestOneAppPerDataDirectory(t *testing.T) {
	dir := t.TempDir()
	start(t, dir, Config{})
	_, err := New(context.Background(), Config{DataDir: dir, Runtime: testRuntime(t), Secrets: secrets.NewMemory()})
	if !errors.Is(err, ErrAlreadyRunning) {
		t.Fatalf("a second app on the same data directory: %v", err)
	}
}

func TestPrefs(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	if code, _ := h.do("PUT", "/api/me/prefs/appearance", map[string]any{"value": map[string]string{"theme": "dark"}}); code != 200 {
		t.Fatalf("put pref: %d", code)
	}
	if code, _ := h.do("PUT", "/api/me/prefs/nope", map[string]any{"value": map[string]string{}}); code != 404 {
		t.Fatalf("unknown pref: %d", code)
	}
	if code, _ := h.do("PUT", "/api/me/prefs/inbox", map[string]any{"value": []int{1}}); code != 400 {
		t.Fatalf("non-object pref: %d", code)
	}
	_, data := h.do("GET", "/api/me/prefs", nil)
	if !strings.Contains(string(data), `"appearance":{"theme":"dark"}`) {
		t.Fatalf("prefs: %s", data)
	}
	_ = fmt.Sprint()
}
