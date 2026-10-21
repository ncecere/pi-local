package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ncecere/pi-local/internal/judge"
	"github.com/ncecere/pi-local/internal/secrets"
	"github.com/ncecere/pi-local/internal/usage"
)

func TestKnowledgeJudgmentUsageAndBudgetFallback(t *testing.T) {
	for _, tc := range []struct {
		name, off, failure, budgetScope, budgetMode string
		noMatch, noTokens                           bool
		wantRequests, wantInput, wantOutput         int64
		wantReranked                                bool
	}{
		{name: "successful judgment", wantRequests: 1, wantInput: 120, wantOutput: 12, wantReranked: true},
		{name: "successful judgment without tokens", noTokens: true, wantRequests: 1, wantReranked: true},
		{name: "HTTP failure", failure: "http", wantRequests: 1},
		{name: "malformed response", failure: "malformed", wantRequests: 1},
		{name: "canceled request still accounted", failure: "cancel", wantRequests: 1},
		{name: "judgments disabled", off: "global"},
		{name: "knowledge judgments disabled", off: "knowledge"},
		{name: "no matching passages", noMatch: true},
		{name: "exhausted agent stop budget", budgetScope: "agent", budgetMode: "stop"},
		{name: "exhausted app stop budget", budgetScope: "app", budgetMode: "stop"},
		{name: "exhausted agent warn budget", budgetScope: "agent", budgetMode: "warn", wantRequests: 1, wantInput: 120, wantOutput: 12, wantReranked: true},
		{name: "exhausted app warn budget", budgetScope: "app", budgetMode: "warn", wantRequests: 1, wantInput: 120, wantOutput: 12, wantReranked: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := start(t, t.TempDir(), Config{Secrets: secrets.NewMemory(), KnowledgeInterval: time.Hour})
			scripted(t, h) // Only a synthetic provider; searches below never send a runtime/model request.
			dir := t.TempDir()
			for name, text := range map[string]string{
				"returns.txt": "Returns are accepted within thirty days.",
				"refunds.txt": "Returns require a receipt for a refund.",
			} {
				if err := os.WriteFile(filepath.Join(dir, name), []byte(text), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			agent := h.agentOn("Docs", "script/s1", map[string]any{"knowledge": map[string]any{"folders": []string{dir}}})
			h.knowledgeReady(agent, 2)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var calls atomic.Int64
			system := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.URL.Path != "/v1/systemone" || r.Header.Get("Authorization") != "Bearer synthetic-key" {
					t.Error("unexpected judgment request")
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				switch tc.failure {
				case "http":
					w.WriteHeader(http.StatusServiceUnavailable)
					return
				case "malformed":
					_, _ = w.Write([]byte(`{"answers":`))
					return
				case "cancel":
					cancel() // The attempt must be recorded even though the caller's context is now canceled.
					return
				}
				response := map[string]any{
					"model": "synthetic-response",
					"answers": map[string]any{
						"p0": map[string]any{"type": "noul", "noul": 0.1},
						"p1": map[string]any{"type": "noul", "noul": 0.95},
					},
				}
				if !tc.noTokens {
					response["usage"] = map[string]int{"input_tokens": 120, "output_tokens": 12}
				}
				_ = json.NewEncoder(w).Encode(response)
			}))
			t.Cleanup(system.Close)
			h.mustDo("PUT", "/api/settings/judgments", map[string]any{
				"enabled": tc.off != "global", "url": system.URL, "apiKey": "synthetic-key", "model": "synthetic-configured",
				"uses": map[string]bool{"knowledge": tc.off != "knowledge"},
			}, 200)

			if tc.budgetScope != "" {
				h.priceScripted(1, 1)
				b := map[string]any{"monthlyUsd": 1, "onExceed": tc.budgetMode}
				if tc.budgetScope == "agent" {
					h.mustDo("PATCH", "/api/agents/"+agent, map[string]any{"budget": b}, 200)
					h.spend(agent, 2)
				} else {
					h.mustDo("PUT", "/api/settings/budget", map[string]any{"budget": b}, 200)
					other := h.agentOn("Spender", "script/s1", nil)
					h.spend(other, 2) // Another agent can exhaust the app's budget for this search.
				}
			}

			query := "returns"
			if tc.noMatch {
				query = "zebra"
			}
			local, _, err := h.app.Knowledge.Search(ctx, []string{dir}, query, judge.MaxPassagesJudged)
			if err != nil {
				t.Fatal(err)
			}
			wantHits := 2
			if tc.noMatch {
				wantHits = 0
			}
			if len(local) != wantHits {
				t.Fatalf("fixture search: got %d hits, want %d", len(local), wantHits)
			}
			result, err := (knowledgeGateway{h.app}).Search(ctx, agent, query, 1)
			if err != nil {
				t.Fatalf("local search must not fail when judgment is unavailable: %v", err)
			}
			answer := result.(knowledgeAnswer)
			if answer.Reranked != tc.wantReranked || len(answer.Passages) != min(wantHits, 1) {
				t.Fatalf("search result: %+v", answer)
			}
			if wantHits > 0 {
				index := 0
				if tc.wantReranked {
					index = 1
				}
				if got := answer.Passages[0]; got.Path != local[index].Path || got.Text != local[index].Text {
					t.Fatalf("wrong passage/order: %+v; want %+v", got, local[index])
				}
			}
			if calls.Load() != tc.wantRequests {
				t.Fatalf("judgment requests: got %d, want %d", calls.Load(), tc.wantRequests)
			}
			model := "judgments/synthetic-response"
			if tc.failure != "" {
				model = "judgments/synthetic-configured"
			}
			report := decodeInto[usage.Report](t, h.mustDo("GET", "/api/me/usage?agent="+agent+"&model="+url.QueryEscape(model), nil, 200))
			want := usage.Totals{Requests: tc.wantRequests, InputTokens: tc.wantInput, OutputTokens: tc.wantOutput, UnpricedRequests: tc.wantRequests}
			if report.Total != want {
				t.Fatalf("judgment usage: got %+v, want %+v", report.Total, want)
			}
			var rows int
			if err := h.app.DB.QueryRow(`SELECT COUNT(*) FROM usage WHERE agent_id = ? AND model LIKE 'judgments/%'`, agent).Scan(&rows); err != nil {
				t.Fatal(err)
			}
			if rows != int(tc.wantRequests) {
				t.Fatalf("judgment usage rows: got %d, want %d", rows, tc.wantRequests)
			}
		})
	}
}
