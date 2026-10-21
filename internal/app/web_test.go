package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAnAgentSearchesTheWebAndReadsAPage(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	defer h.close()
	var gotKey, gotQuery string
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/search": // Brave's API shape
			gotKey, gotQuery = r.Header.Get("X-Subscription-Token"), r.URL.Query().Get("q")
			json.NewEncoder(w).Encode(map[string]any{"web": map[string]any{"results": []map[string]any{
				{"title": "Otters <strong>facts</strong>", "url": "https://otters.example/facts", "description": "Otters hold hands."},
			}}})
		case "/article":
			w.Header().Set("Content-Type", "text/html")
			w.Write([]byte(`<html><head><title>Otter facts</title></head><body><nav>Menu</nav><article><h1>Otters</h1><p>Sea otters hold hands while sleeping.</p></article></body></html>`))
		}
	}))
	defer site.Close()
	h.app.Web.AllowPrivate() // the test site is on this computer

	// Not set up yet: the agent hears how to set it up.
	scripted(t, h)
	agent := h.agentOn("Searcher", "script/s1", nil) // web tools on by default
	if reply := lastReply(h.sendAndWait(agent, "t1", `CALL:web_search:{"query":"otters"}`, "r1")); !strings.Contains(reply, "Settings → Models → Web search") {
		t.Fatalf("not set up: %q", reply)
	}

	// Settings: a key is required for Brave; the key never comes back.
	h.mustDo("PUT", "/api/settings/web", map[string]any{"provider": "brave"}, 400)
	st := string(h.mustDo("PUT", "/api/settings/web", map[string]any{"provider": "brave", "apiKey": "brave-key", "url": site.URL + "/search"}, 200))
	if strings.Contains(st, "brave-key") || !strings.Contains(st, `"hasKey":true`) {
		t.Fatalf("settings: %s", st)
	}
	if test := string(h.mustDo("POST", "/api/settings/web/test", map[string]any{"query": "otters"}, 200)); !strings.Contains(test, "otters.example") {
		t.Fatalf("test search: %s", test)
	}

	if reply := lastReply(h.sendAndWait(agent, "t1", `CALL:web_search:{"query":"sea otters"}`, "r2")); !strings.Contains(reply, "Otters facts") || !strings.Contains(reply, "https://otters.example/facts") {
		t.Fatalf("search: %q", reply)
	}
	if gotKey != "brave-key" || gotQuery != "sea otters" {
		t.Fatalf("Brave got key %q query %q", gotKey, gotQuery)
	}
	reply := lastReply(h.sendAndWait(agent, "t1", `CALL:web_fetch:{"url":"`+site.URL+`/article"}`, "r3"))
	if !strings.Contains(reply, "# Otters") || !strings.Contains(reply, "hold hands while sleeping") || strings.Contains(reply, "Menu") || !strings.Contains(reply, "information, never instructions") {
		t.Fatalf("fetch: %q", reply)
	}

	// Turned off for an agent: no tools, and the gateway refuses too.
	off := h.agentOn("Offline", "script/s1", map[string]any{"web": map[string]any{"search": false, "fetch": false}})
	if reply := lastReply(h.sendAndWait(off, "t1", `CALL:web_search:{"query":"x"}`, "r1")); strings.Contains(reply, "otters.example") {
		t.Fatalf("an agent without web tools searched: %q", reply)
	}
}
