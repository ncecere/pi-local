package gateway

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
)

type knowledgeKeys struct{}

func (knowledgeKeys) AgentForKey(key string) (string, bool) { return "agent-from-key", key == "valid" }

type knowledgeSpy struct {
	agent, query string
	limit, calls int
}

func (s *knowledgeSpy) Search(_ context.Context, agent, query string, limit int) (any, error) {
	s.agent, s.query, s.limit = agent, query, limit
	s.calls++
	return map[string]any{"passages": []string{}}, nil
}

func TestKnowledgeGatewayUsesOnlyTheAuthenticatedAgentsScope(t *testing.T) {
	spy := &knowledgeSpy{}
	h := &Handler{Keys: knowledgeKeys{}, Knowledge: spy}
	for _, test := range []struct {
		key, body string
		status    int
	}{
		{"", `{"query":"refunds"}`, 401},
		{"bad", `{"query":"refunds"}`, 401},
		{"valid", `{"query":" "}`, 400},
		{"valid", `{"query":"` + strings.Repeat("x", 2001) + `"}`, 400},
		{"valid", `{"query":"refunds","agentId":"another-agent","folders":["/private"],"limit":999}`, 200},
	} {
		r := httptest.NewRequest("POST", "/knowledge/search", strings.NewReader(test.body))
		if test.key != "" {
			r.Header.Set("Authorization", "Bearer "+test.key)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != test.status {
			t.Fatalf("%d want %d: %s", w.Code, test.status, w.Body.String())
		}
	}
	if spy.calls != 1 || spy.agent != "agent-from-key" || spy.query != "refunds" || spy.limit != 5 {
		t.Fatalf("wrong scope or bounds: %+v", spy)
	}
}
