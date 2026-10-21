package app

import (
	"strings"
	"testing"
)

type detectedJSON struct {
	Preset   string  `json:"preset"`
	BaseURL  string  `json:"baseUrl"`
	Provider *string `json:"provider"`
	Models   []struct {
		ModelID string `json:"modelId"`
	} `json:"models"`
}

func TestFirstRunFindsALocalModelServerAndSetsItUp(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	defer h.close()
	// A fake Ollama, listing two chat models and an embedding model.
	ollama := newFakeProvider(t, "openai", "hello from ollama")
	ollama.models = []map[string]any{{"id": "llama3.2:3b"}, {"id": "qwen3:8b"}, {"id": "nomic-embed-text"}}
	h.app.Catalog.SetPresetURL("ollama", ollama.URL+"/v1")
	h.app.Catalog.SetPresetURL("lm-studio", "http://127.0.0.1:1/v1") // not running

	found := decodeInto[[]detectedJSON](t, h.mustDo("GET", "/api/providers/detect", nil, 200))
	if len(found) != 1 || found[0].Preset != "ollama" || found[0].Provider != nil || len(found[0].Models) != 2 {
		t.Fatalf("detected: %+v", found)
	}

	// One step: the provider, its chat models, and the default model (it was the demo).
	res := decodeInto[struct {
		Provider struct {
			ID     string
			Models []struct{ ModelID string }
		}
		DefaultModelID string `json:"defaultModelId"`
	}](t, h.mustDo("POST", "/api/providers/setup", map[string]any{"preset": "ollama"}, 200))
	if res.Provider.ID != "ollama" || len(res.Provider.Models) != 2 || res.DefaultModelID != "ollama/llama3.2:3b" {
		t.Fatalf("setup: %+v", res)
	}
	// Found again, it says it's already set up; setting up twice reuses the provider.
	again := decodeInto[[]detectedJSON](t, h.mustDo("GET", "/api/providers/detect", nil, 200))
	if again[0].Provider == nil || *again[0].Provider != "ollama" {
		t.Fatalf("detected after setup: %+v", again)
	}
	h.mustDo("POST", "/api/providers/setup", map[string]any{"preset": "ollama"}, 200)

	// A new agent gets the new default, and it answers through the local server.
	agent := h.createAgent("Local")
	if reply := lastReply(h.sendAndWait(agent, "t1", "hi", "r1")); !strings.Contains(reply, "hello from ollama") {
		t.Fatalf("reply: %q", reply)
	}
}

func TestFirstRunWithAKeyedProvider(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	defer h.close()
	remote := newFakeProvider(t, "openai", "hi")
	remote.models = []map[string]any{{"id": "big-1"}, {"id": "small-1"}}
	h.app.Catalog.SetPresetURL("openrouter", remote.URL+"/v1")

	// A key is needed; with it, nothing is added until the person picks.
	h.mustDo("POST", "/api/providers/setup", map[string]any{"preset": "openrouter"}, 400)
	res := decodeInto[struct {
		Provider  struct{ Models []struct{ ModelID string } }
		Available []struct {
			ModelID string `json:"modelId"`
		}
		DefaultModelID string `json:"defaultModelId"`
	}](t, h.mustDo("POST", "/api/providers/setup", map[string]any{"preset": "openrouter", "apiKey": "sk-or-test"}, 200))
	if len(res.Provider.Models) != 0 || len(res.Available) != 2 || res.DefaultModelID != "demo/demo-1" {
		t.Fatalf("keyed setup: %+v", res)
	}
	res2 := decodeInto[struct {
		DefaultModelID string `json:"defaultModelId"`
	}](t, h.mustDo("POST", "/api/providers/setup", map[string]any{"preset": "openrouter", "models": []string{"small-1"}}, 200))
	if res2.DefaultModelID != "openrouter/small-1" {
		t.Fatalf("after picking: %+v", res2)
	}
	if !strings.Contains(remote.seen()[0].Auth, "sk-or-test") {
		t.Fatal("the key wasn't used")
	}
	h.mustDo("POST", "/api/providers/setup", map[string]any{"preset": "openrouter", "models": []string{"nope"}}, 400)
	h.mustDo("POST", "/api/providers/setup", map[string]any{"preset": "nonsense"}, 400)
}
