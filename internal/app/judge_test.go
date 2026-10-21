package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"
)

// fakeSystemOne answers like TypeSafe's /v1/systemone: a Choice by the configured pick, a Noul from a function.
func fakeSystemOne(t *testing.T, choice func(criteria map[string]string) (string, float64), noul func(instructions string) float64) (*httptest.Server, *atomic.Int32) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer ts-key" {
			w.WriteHeader(401)
			return
		}
		calls.Add(1)
		var req struct {
			Model     string
			Questions map[string]struct {
				Type         string
				Instructions string
				Criteria     map[string]string
			}
		}
		json.NewDecoder(r.Body).Decode(&req)
		answers := map[string]any{}
		for name, q := range req.Questions {
			switch q.Type {
			case "choice":
				pick, conf := choice(q.Criteria)
				probs := map[string]float64{}
				for k := range q.Criteria {
					probs[k] = (1 - conf) / float64(max(len(q.Criteria)-1, 1))
				}
				probs[pick] = conf
				answers[name] = map[string]any{"type": "choice", "choice": pick, "confidence": conf, "probabilities": probs}
			case "noul":
				answers[name] = map[string]any{"type": "noul", "noul": noul(q.Instructions)}
			}
		}
		json.NewEncoder(w).Encode(map[string]any{"model": req.Model, "answers": answers, "usage": map[string]int{"input_tokens": 10, "output_tokens": 1}})
	}))
	t.Cleanup(srv.Close)
	return srv, &calls
}

func TestFastJudgmentsRouteMessagesAndPreselectTools(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	defer h.close()
	scripted(t, h)
	writer := h.agentOn("Writer", "script/s1", map[string]any{"description": "Writes and edits documents"})
	h.agentOn("Grafana", "script/s1", map[string]any{"description": "Checks dashboards and metrics"})
	confidence := 0.9
	ts, calls := fakeSystemOne(t, func(criteria map[string]string) (string, float64) {
		for id, desc := range criteria {
			if strings.Contains(desc, "Writes and edits") {
				return id, confidence
			}
		}
		return "", 0
	}, func(instructions string) float64 {
		if strings.Contains(instructions, `__bulk_7"`) {
			return 0.95
		}
		return 0.05
	})

	// Off by default: routing says so (the UI asks the person), and nothing is sent.
	h.mustDo("POST", "/api/route", map[string]any{"text": "tighten this paragraph"}, 409)
	// Turning it on needs a key for TypeSafe's own service; a self-hosted URL works too.
	h.mustDo("PUT", "/api/settings/judgments", map[string]any{"enabled": true}, 400)
	h.mustDo("PUT", "/api/settings/judgments", map[string]any{"enabled": true, "url": ts.URL, "apiKey": "ts-key", "model": "jev-1.14.0", "uses": map[string]bool{"agentRouting": true, "toolPreselection": true}}, 200)
	if got := string(h.mustDo("POST", "/api/settings/judgments/test", nil, 200)); !strings.Contains(got, `"noul"`) {
		t.Fatalf("test: %s", got)
	}

	route := decodeInto[struct {
		AgentID string `json:"agentId"`
		Decided bool   `json:"decided"`
	}](t, h.mustDo("POST", "/api/route", map[string]any{"text": "tighten this paragraph"}, 200))
	if route.AgentID != writer || !route.Decided {
		t.Fatalf("route: %+v", route)
	}
	confidence = 0.4 // unsure: not decided, so the UI offers the top choices
	if r := decodeInto[struct{ Decided bool }](t, h.mustDo("POST", "/api/route", map[string]any{"text": "hmm"}, 200)); r.Decided {
		t.Fatal("an unsure route was decided")
	}

	// Tool preselection: an MCP server with 27 tools (more than 20: deferred behind tool_search).
	node, _ := exec.LookPath("node")
	h.mustDo("POST", "/api/mcp/servers", map[string]any{
		"name": "Fixture", "transport": "stdio", "command": node, "args": []string{fixture("stdio-mcp-server.mjs")},
		"env": map[string]string{"FIXTURE_MANY_TOOLS": "24"},
	}, 201)
	fake := newFakeProvider(t, "openai", "plain reply")
	h.mustDo("POST", "/api/providers", map[string]any{"id": "watch", "name": "Watch", "kind": "openai-compatible", "baseUrl": fake.URL + "/v1"}, 201)
	h.mustDo("PUT", "/api/providers/watch/models/w1", map[string]any{"name": "Watched"}, 200)
	toolsAgent := h.agentOn("Tooly", "watch/w1", map[string]any{"mcp": []map[string]any{{"server": "fixture"}}})
	before := calls.Load()
	h.sendAndWait(toolsAgent, "t1", "run bulk number seven", "r1")
	body := string(fake.chats()[0].Body)
	if !strings.Contains(body, "mcp__fixture__bulk_7") || strings.Contains(body, "mcp__fixture__bulk_8") || !strings.Contains(body, "tool_search") {
		var req struct {
			Tools []struct{ Function struct{ Name string } }
		}
		json.Unmarshal(fake.chats()[0].Body, &req)
		var names []string
		for _, tl := range req.Tools {
			names = append(names, tl.Function.Name)
		}
		t.Fatalf("the first request should offer bulk_7 (preselected) and tool_search, not bulk_8: %v", names)
	}
	if calls.Load() == before {
		t.Fatal("no judgment was asked for")
	}

	// Preselection off: nothing preloaded.
	h.mustDo("PUT", "/api/settings/judgments", map[string]any{"uses": map[string]bool{"toolPreselection": false}}, 200)
	h.sendAndWait(toolsAgent, "t2", "run bulk number seven", "r1")
	chats := fake.chats()
	if last := string(chats[len(chats)-1].Body); strings.Contains(last, "mcp__fixture__bulk_7") {
		t.Fatal("preselection off still preloaded a tool")
	}
}

// The settings form lists the service's models with what was typed, before it is saved.
func TestFastJudgmentsListModelsWithTheTypedAddressAndKey(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	defer h.close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" || r.Header.Get("Authorization") != "Bearer typed-key" {
			w.WriteHeader(401)
			return
		}
		w.Write([]byte(`{"models":[{"name":"jev-1.14.0"}]}`))
	}))
	defer srv.Close()
	got := decodeInto[[]string](t, h.mustDo("POST", "/api/settings/judgments/models", map[string]string{"url": srv.URL, "apiKey": "typed-key"}, 200))
	if len(got) != 1 || got[0] != "jev-1.14.0" {
		t.Fatalf("models: %v", got)
	}
	// Nothing was saved.
	if s := string(h.mustDo("GET", "/api/settings/judgments", nil, 200)); strings.Contains(s, srv.URL) || strings.Contains(s, `"hasKey":true`) {
		t.Fatalf("saved by listing: %s", s)
	}
	h.mustDo("POST", "/api/settings/judgments/models", map[string]string{"url": srv.URL, "apiKey": "wrong"}, 502)
	h.mustDo("POST", "/api/settings/judgments/models", map[string]string{"url": "ftp://x"}, 400)
}
