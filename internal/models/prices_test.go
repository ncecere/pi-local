package models

import "testing"

func TestListPricesMatchModelIDsFlexibly(t *testing.T) {
	cases := []struct {
		id      string
		in, out float64
	}{
		// Exactly as the table has it.
		{"claude-sonnet-4-5", 3, 15},
		{"gpt-4o", 2.50, 10},
		{"gemini-2.5-pro", 1.25, 10},
		{"mistral-large-latest", 0.50, 1.50},
		{"deepseek-v4-pro", 1.32, 3.96},
		// Dated suffixes, compact and dashed.
		{"claude-sonnet-4-5-20250929", 3, 15},
		{"claude-opus-4-1-20250805", 15, 75},
		{"claude-opus-4-20250514", 15, 75},
		{"claude-3-5-haiku-20241022", 0.80, 4},
		{"gpt-4.1-2025-04-14", 2, 8},
		{"o3-2025-04-16", 2, 8},
		{"gpt-5-2025-08-07", 1.25, 10},
		{"gpt-4-turbo-2024-04-09", 10, 30},
		// A dated model with a price of its own keeps it.
		{"gpt-4o-2024-05-13", 5, 15},
		{"gpt-4o-2024-08-06", 2.50, 10},
		// Provider prefixes, from gateways and routers.
		{"anthropic/claude-sonnet-4.5", 3, 15},
		{"openai/gpt-5.4-mini", 0.75, 4.50},
		{"openrouter/openai/gpt-4o-mini", 0.15, 0.60},
		{"google/gemini-2.5-flash", 0.30, 2.50},
		{"models/gemini-2.5-flash-lite", 0.10, 0.40},
		{"mistralai/mistral-small-latest", 0.15, 0.60},
		// Dots or dashes in the version, any case.
		{"gpt-5-4", 2.50, 15},
		{"GPT-5.4", 2.50, 15},
		{"Claude-Opus-4.5", 5, 25},
		{"claude-haiku-4.5", 1, 5},
		// Bedrock.
		{"anthropic.claude-sonnet-4-5-20250929-v1:0", 3, 15},
		{"us.anthropic.claude-haiku-4-5-20251001-v1:0", 1, 5},
		{"global.anthropic.claude-opus-4-5-20251101-v1:0", 5, 25},
		// Vertex.
		{"claude-sonnet-4-5@20250929", 3, 15},
	}
	for _, c := range cases {
		p, ok := LookupListPrice(c.id)
		if !ok || p.Input != c.in || p.Output != c.out {
			t.Errorf("%s: got %+v ok=%v, want %v/%v", c.id, p, ok, c.in, c.out)
		}
	}
}

func TestListPricesLeaveOutWhatTheyDoNotKnow(t *testing.T) {
	for _, id := range []string{
		"", "llama3", "llama3.2:3b", "qwen2.5-coder", "gpt-oss-20b", "my-fine-tune",
		// Close to a known model is not that model.
		"gpt-5.4-turbo", "gpt-5.3", "claude-sonnet-4-5-thinking", "claude-opus-9", "gemini-2.5-ultra",
		// Prices that are promotional, scheduled to change or by the hour are not in the table.
		"gpt-5.6-sol", "gemini-4-argon", "gemini-3.8-flash", "claude-haiku-5-5",
		// A tag (Ollama's, OpenRouter's :free) is not part of what is priced.
		"gpt-4o:free", "gpt-4o mini",
	} {
		if p, ok := LookupListPrice(id); ok {
			t.Errorf("%q should have no list price, got %+v", id, p)
		}
	}
}

func TestListPriceCacheFields(t *testing.T) {
	p, _ := LookupListPrice("claude-sonnet-4-5")
	if p.CacheRead == nil || *p.CacheRead != 0.30 || p.CacheWrite == nil || *p.CacheWrite != 3.75 {
		t.Fatalf("anthropic cache prices: %+v", p)
	}
	p, _ = LookupListPrice("gpt-5")
	if p.CacheRead == nil || *p.CacheRead != 0.125 || p.CacheWrite != nil {
		t.Fatalf("openai cache prices: %+v", p)
	}
	p, _ = LookupListPrice("mistral-large-2512")
	if p.CacheRead != nil || p.CacheWrite != nil {
		t.Fatalf("a model with no published cache prices: %+v", p)
	}
}

// The table is hand-written, so its shape is checked: keys are in the normalized form lookups produce, and no price
// is nonsense.
func TestTheListPriceTableIsWellFormed(t *testing.T) {
	for key, p := range priceList {
		if normalizeModelID(key) != key {
			t.Errorf("%q is not in normalized form (%q)", key, normalizeModelID(key))
		}
		if p.Input <= 0 || p.Output < p.Input {
			t.Errorf("%s: odd prices %+v", key, p)
		}
		if p.CacheRead != nil && (*p.CacheRead <= 0 || *p.CacheRead >= p.Input) {
			t.Errorf("%s: a cache read costs less than input, got %v against %v", key, *p.CacheRead, p.Input)
		}
		if p.CacheWrite != nil && *p.CacheWrite < p.Input {
			t.Errorf("%s: a cache write costs at least the input price, got %v against %v", key, *p.CacheWrite, p.Input)
		}
		if _, ok := LookupListPrice(key); !ok {
			t.Errorf("%s can't be found by its own name", key)
		}
	}
}
