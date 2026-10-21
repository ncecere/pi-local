package app

import (
	"bytes"
	"encoding/json"
	"math"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ncecere/pi-local/internal/secrets"
	"github.com/ncecere/pi-local/internal/supervisor"
)

func decodeInto[T any](t *testing.T, raw json.RawMessage) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("decoding %s: %v", raw, err)
	}
	return v
}

func (h *harness) mustDo(method, path string, body any, want int) json.RawMessage {
	h.t.Helper()
	code, data := h.do(method, path, body)
	if code != want {
		h.t.Fatalf("%s %s: got %d, want %d: %s", method, path, code, want, data)
	}
	return data
}

func (h *harness) sendAndWait(agent, thread, text, requestID string) view {
	h.t.Helper()
	h.mustDo("POST", "/api/agents/"+agent+"/threads/"+thread+"/messages", map[string]string{"text": text, "requestId": requestID}, 202)
	var v view
	eventually(h.t, 30*time.Second, "the reply to "+text, func() bool {
		got := h.threads(agent)
		for _, th := range got {
			if th.ThreadID == thread && !th.Busy && th.LastReplyAt != nil {
				v = h.view(agent, thread)
				last := v.Messages[len(v.Messages)-1]
				return last.Role == "assistant" && strings.Count(viewUsers(v), "\x00") >= 0
			}
		}
		return false
	})
	return v
}

func viewUsers(v view) string {
	var b strings.Builder
	for _, m := range v.Messages {
		if m.Role == "user" {
			b.WriteString(m.Text + "\x00")
		}
	}
	return b.String()
}

func lastReply(v view) string {
	for i := len(v.Messages) - 1; i >= 0; i-- {
		if v.Messages[i].Role == "assistant" {
			return v.Messages[i].Text + v.Messages[i].Error
		}
	}
	return ""
}

// Everything app.db holds on disk, to show a secret never lands there.
func dbBytes(t *testing.T, dir string) []byte {
	t.Helper()
	var all []byte
	for _, f := range []string{"app.db", "app.db-wal"} {
		raw, _ := os.ReadFile(filepath.Join(dir, f))
		all = append(all, raw...)
	}
	return all
}

func TestAnOpenAICompatibleProviderEndToEnd(t *testing.T) {
	dir := t.TempDir()
	h := start(t, dir, Config{})
	keychain := h.app.cfg.Secrets.(*secrets.Memory)
	fake := newFakeProvider(t, "openai", "Hello from the fake model.")
	fake.models = []map[string]any{{"id": "fake-large", "context_window": 64000}, {"id": "fake-small", "name": "Fake Small"}}

	p := decodeInto[struct {
		ID          string   `json:"id"`
		HasKey      bool     `json:"hasKey"`
		HeaderNames []string `json:"headerNames"`
	}](t, h.mustDo("POST", "/api/providers", map[string]any{
		"name": "Fake AI", "kind": "openai-compatible", "baseUrl": fake.URL + "/v1/", "apiKey": "sk-test-secret-123",
		"headers": map[string]string{"X-Org": "acme"},
	}, 201))
	if p.ID != "fake-ai" || !p.HasKey || len(p.HeaderNames) != 1 || p.HeaderNames[0] != "X-Org" {
		t.Fatalf("created provider: %+v", p)
	}

	found := decodeInto[struct {
		Models []struct {
			ModelID       string `json:"modelId"`
			Name          string `json:"name"`
			ContextWindow *int   `json:"contextWindow"`
		} `json:"models"`
	}](t, h.mustDo("POST", "/api/providers/fake-ai/discover", nil, 200))
	byID := map[string]int{}
	for i, m := range found.Models {
		byID[m.ModelID] = i
	}
	large, small := found.Models[byID["fake-large"]], found.Models[byID["fake-small"]]
	if len(found.Models) != 2 || large.ContextWindow == nil || *large.ContextWindow != 64000 || small.Name != "Fake Small" || large.Name != "fake-large" {
		t.Fatalf("discovered: %+v", found)
	}
	if got := fake.seen()[0]; got.Auth != "Bearer sk-test-secret-123" || got.Header.Get("X-Org") != "acme" {
		t.Fatalf("discovery wasn't authenticated: %+v", got)
	}

	h.mustDo("PUT", "/api/providers/fake-ai/models/fake-large", map[string]any{"name": "Fake Large", "contextWindow": 64000, "inputPrice": 3, "outputPrice": 15}, 200)
	h.mustDo("PUT", "/api/settings/default-model", map[string]string{"modelId": "fake-ai/fake-large"}, 200)
	if catalog := string(h.mustDo("GET", "/api/agents/catalog", nil, 200)); !strings.Contains(catalog, `"defaultModelId":"fake-ai/fake-large"`) || !strings.Contains(catalog, `"providerName":"Fake AI"`) {
		t.Fatalf("catalog: %s", catalog)
	}

	// A new agent gets the default model.
	agent := h.createAgent("Real")
	if got := string(h.mustDo("GET", "/api/agents", nil, 200)); !strings.Contains(got, `"name":"Fake Large"`) {
		t.Fatalf("the agent isn't on the default model: %s", got)
	}
	v := h.sendAndWait(agent, "t1", "Hi model", "r1")
	if got := lastReply(v); got != "Hello from the fake model." {
		t.Fatalf("reply: %q (%+v)", got, v.Messages)
	}
	chats := fake.chats()
	if len(chats) != 1 {
		t.Fatalf("chat requests: %+v", chats)
	}
	if c := chats[0]; c.Auth != "Bearer sk-test-secret-123" || c.Header.Get("X-Org") != "acme" || c.Model != "fake-large" || !c.Stream || c.Message != "Hi model" {
		t.Fatalf("the model request: %+v", c)
	}

	// The key is in the keychain, and nowhere in app.db or the agent's folder.
	if v, _ := keychain.Get("provider:fake-ai:key"); v != "sk-test-secret-123" {
		t.Fatalf("keychain: %q", v)
	}
	if bytes.Contains(dbBytes(t, dir), []byte("sk-test-secret-123")) {
		t.Fatal("the API key was written to app.db")
	}
	filepath.Walk(filepath.Join(dir, "agents"), func(path string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			if raw, _ := os.ReadFile(path); bytes.Contains(raw, []byte("sk-test-secret-123")) {
				t.Errorf("the API key is in %s", path)
			}
		}
		return nil
	})

	// Usage, with its cost from the model's prices: (1200 × $3 + 300 × $15) / 1M.
	eventually(t, 20*time.Second, "usage to be reported", func() bool {
		r := decodeInto[struct {
			Total struct {
				Requests int     `json:"requests"`
				Cost     float64 `json:"costUsd"`
			} `json:"total"`
		}](t, h.mustDo("GET", "/api/me/usage?days=7", nil, 200))
		return r.Total.Requests >= 1
	})
	report := decodeInto[struct {
		Total struct {
			Requests, InputTokens, OutputTokens int
			CostUSD                             float64 `json:"costUsd"`
			UnpricedRequests                    int     `json:"unpricedRequests"`
		} `json:"total"`
		Agents []struct{ AgentID, Name string } `json:"agents"`
		Models []struct{ ModelID, Name string } `json:"models"`
		ByDay  []struct{ Day string }           `json:"byDay"`
	}](t, h.mustDo("GET", "/api/me/usage?days=7", nil, 200))
	if report.Total.Requests != 1 || report.Total.InputTokens != 1200 || report.Total.OutputTokens != 300 || math.Abs(report.Total.CostUSD-0.0081) > 1e-9 || report.Total.UnpricedRequests != 0 {
		t.Fatalf("usage totals: %+v", report.Total)
	}
	if len(report.Agents) != 1 || report.Agents[0].Name != "Real" || len(report.Models) != 1 || report.Models[0].ModelID != "fake-ai/fake-large" || report.Models[0].Name != "Fake Large" || len(report.ByDay) != 7 {
		t.Fatalf("usage report: %+v", report)
	}

	// A new key reaches the provider from the next reply on (the awake agent restarts with it).
	h.mustDo("PATCH", "/api/providers/fake-ai", map[string]any{"apiKey": "sk-rotated-456"}, 200)
	h.sendAndWait(agent, "t1", "Again", "r2")
	if chats := fake.chats(); chats[len(chats)-1].Auth != "Bearer sk-rotated-456" {
		t.Fatalf("after the key changed the model was called with %q", chats[len(chats)-1].Auth)
	}
}

func TestAnAnthropicCompatibleProvider(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	fake := newFakeProvider(t, "anthropic", "Claude-shaped answer.")
	fake.models = []map[string]any{{"id": "claude-fake", "display_name": "Claude Fake"}}
	h.mustDo("POST", "/api/providers", map[string]any{"id": "anth", "name": "Anthropic test", "kind": "anthropic-compatible", "baseUrl": fake.URL, "apiKey": "ak-123"}, 201)
	found := string(h.mustDo("POST", "/api/providers/anth/discover", nil, 200))
	if !strings.Contains(found, `"name":"Claude Fake"`) {
		t.Fatalf("discovered: %s", found)
	}
	if got := fake.seen()[0]; got.Auth != "ak-123" || got.Header.Get("anthropic-version") == "" {
		t.Fatalf("anthropic discovery headers: %+v", got.Header)
	}
	h.mustDo("PUT", "/api/providers/anth/models/claude-fake", map[string]any{"name": "Claude Fake"}, 200)
	agent := decodeInto[struct{ ID string }](t, h.mustDo("POST", "/api/agents", map[string]any{"name": "Claudette", "modelId": "anth/claude-fake"}, 201)).ID
	v := h.sendAndWait(agent, "t1", "Hello Claude", "r1")
	if got := lastReply(v); got != "Claude-shaped answer." {
		t.Fatalf("reply: %q", got)
	}
	if c := fake.chats()[0]; c.Auth != "ak-123" || c.Model != "claude-fake" || c.Message != "Hello Claude" {
		t.Fatalf("model request: %+v", c)
	}
	// No prices: counted, but as unpriced.
	eventually(t, 20*time.Second, "usage", func() bool {
		return strings.Contains(string(h.mustDo("GET", "/api/me/usage", nil, 200)), `"unpricedRequests":1`)
	})
}

func TestAModelThatGoesAwayStopsItsAgentsUntilTheyGetAnother(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	fake := newFakeProvider(t, "openai", "ok")
	h.mustDo("POST", "/api/providers", map[string]any{"name": "Local", "kind": "openai-compatible", "baseUrl": fake.URL + "/v1"}, 201)
	h.mustDo("PUT", "/api/providers/local/models/m1", map[string]any{"name": "Model One"}, 200)
	agent := decodeInto[struct{ ID string }](t, h.mustDo("POST", "/api/agents", map[string]any{"name": "Dependent", "modelId": "local/m1"}, 201)).ID
	h.sendAndWait(agent, "t1", "hi", "r1")
	// A keyless provider (Ollama, LM Studio) gets a placeholder, and nothing breaks.
	if c := fake.chats()[0]; c.Auth != "Bearer no-key" {
		t.Fatalf("keyless auth: %q", c.Auth)
	}

	// In use: it can't be removed.
	code, data := h.do("DELETE", "/api/providers/local/models/m1", nil)
	if code != 409 || !strings.Contains(string(data), `"in_use"`) || !strings.Contains(string(data), `"name":"Dependent"`) {
		t.Fatalf("deleting a model in use: %d %s", code, data)
	}
	if code, _ := h.do("DELETE", "/api/providers/local", nil); code != 409 {
		t.Fatalf("deleting a provider in use: %d", code)
	}

	// Turned off: the agent stops, says why, and refuses messages until it gets another model.
	h.mustDo("PUT", "/api/providers/local/models/m1", map[string]any{"enabled": false}, 200)
	eventually(t, 20*time.Second, "the agent to stop", func() bool { return h.status(agent) != supervisor.Awake })
	code, data = h.do("POST", "/api/agents/"+agent+"/threads/t1/messages", map[string]string{"text": "still there?", "requestId": "r2"})
	if code != 503 || !strings.Contains(string(data), "turned off") {
		t.Fatalf("a message to an agent whose model is off: %d %s", code, data)
	}
	if s, why := h.app.Sup.Status(agent); s != supervisor.Failed || !strings.Contains(why, "Model One is turned off") {
		t.Fatalf("status: %s %q", s, why)
	}
	// Turned on again: the error goes (it's asleep, and wakes on its next message); then off again for what follows.
	h.mustDo("PUT", "/api/providers/local/models/m1", map[string]any{"enabled": true}, 200)
	eventually(t, 10*time.Second, "the error to clear", func() bool { s, _ := h.app.Sup.Status(agent); return s == supervisor.Asleep })
	h.mustDo("PUT", "/api/providers/local/models/m1", map[string]any{"enabled": false}, 200)
	// Renaming still works (only a changed model is checked), and a model that isn't offered is refused.
	h.mustDo("PATCH", "/api/agents/"+agent, map[string]string{"name": "Dependent 2"}, 200)
	if code, data := h.do("PATCH", "/api/agents/"+agent, map[string]string{"modelId": "local/nope"}); code != 400 || !strings.Contains(string(data), "invalid_model") {
		t.Fatalf("an unknown model: %d %s", code, data)
	}
	h.mustDo("PATCH", "/api/agents/"+agent, map[string]string{"modelId": "demo/demo-1"}, 200)
	h.sendAndWait(agent, "t1", "back on demo", "r3")

	h.mustDo("DELETE", "/api/providers/local/models/m1", nil, 200)
	h.mustDo("DELETE", "/api/providers/local", nil, 200)
}

func TestProviderValidationAndDiscoveryErrors(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	cases := []struct {
		body map[string]any
		code string
	}{
		{map[string]any{"name": "Remote", "kind": "openai-compatible", "baseUrl": "http://example.com/v1"}, "invalid_base_url"},
		{map[string]any{"name": "Bad", "kind": "openai-compatible", "baseUrl": "https://x.example/v1", "headers": map[string]string{"Authorization": "x"}}, "invalid_headers"},
		{map[string]any{"name": "Bad", "kind": "nope", "baseUrl": "https://x.example/v1"}, "invalid_kind"},
		{map[string]any{"id": "Has Spaces", "name": "Bad", "kind": "openai"}, "invalid_id"},
		{map[string]any{"id": "demo", "name": "Demo", "kind": "openai"}, "invalid_id"},
	}
	for _, c := range cases {
		if code, data := h.do("POST", "/api/providers", c.body); code != 400 || !strings.Contains(string(data), c.code) {
			t.Errorf("%v: %d %s", c.body, code, data)
		}
	}
	// The kind's default base URL.
	if got := string(h.mustDo("POST", "/api/providers", map[string]any{"name": "OpenAI", "kind": "openai", "apiKey": "sk-x"}, 201)); !strings.Contains(got, `"baseUrl":"https://api.openai.com/v1"`) {
		t.Fatalf("default base URL: %s", got)
	}
	if code, data := h.do("POST", "/api/providers", map[string]any{"name": "OpenAI", "kind": "openai"}); code != 409 || !strings.Contains(string(data), "id_taken") {
		t.Fatalf("a taken ID: %d %s", code, data)
	}

	refusing := newFakeProvider(t, "openai", "")
	refusing.status = 401
	h.mustDo("POST", "/api/providers", map[string]any{"name": "Refusing", "kind": "openai-compatible", "baseUrl": refusing.URL + "/v1", "apiKey": "bad"}, 201)
	if code, data := h.do("POST", "/api/providers/refusing/discover", nil); code != 502 || !strings.Contains(string(data), "refused the key") || strings.Contains(string(data), "nope") {
		t.Fatalf("a refused key: %d %s", code, data)
	}
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	closed := l.Addr().String()
	l.Close()
	h.mustDo("POST", "/api/providers", map[string]any{"name": "Gone", "kind": "openai-compatible", "baseUrl": "http://" + closed + "/v1"}, 201)
	if code, data := h.do("POST", "/api/providers/gone/discover", nil); code != 502 || !strings.Contains(string(data), "Nothing is answering") {
		t.Fatalf("nothing listening: %d %s", code, data)
	}

	// Removing a provider removes its secrets.
	keychain := h.app.cfg.Secrets.(*secrets.Memory)
	h.mustDo("DELETE", "/api/providers/refusing", nil, 200)
	for _, n := range keychain.Names() {
		if strings.Contains(n, "refusing") {
			t.Fatalf("keychain item left behind: %s", n)
		}
	}
}
