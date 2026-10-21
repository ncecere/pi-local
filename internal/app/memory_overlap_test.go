package app

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ncecere/pi-local/internal/gateway"
)

func TestIdleExcludesCompactionUntilFailedRequestReleasesClaim(t *testing.T) {
	h, fake := startSuggesting(t)
	h.app.cfg.MemoryIdle = time.Hour
	started, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		if strings.Contains(string(raw), "at most 3 durable facts") {
			close(started)
			<-release
			// A malformed successful answer is still an extraction failure, never a checkpoint.
			fake.setExtract(`{"facts":"invalid"}`)
		}
		r.Body = io.NopCloser(bytes.NewReader(raw))
		fake.serve(w, r)
	}))
	t.Cleanup(provider.Close)
	t.Cleanup(unblock)
	h.mustDo("PATCH", "/api/providers/script", map[string]any{"baseUrl": provider.URL + "/v1"}, 200)
	agent := h.agentOn("Helper", "script/s1", nil)
	h.sendAndWait(agent, "t1", "I prefer metric units", "r1")
	h.mustDo("PUT", "/api/you/settings", map[string]any{"suggestions": true}, 200)
	ctx := context.Background()
	thread, _ := h.app.Threads.Get(ctx, agent, "t1")
	done := make(chan struct{})
	go func() { h.app.suggestFromIdle(agent, "t1", *thread.LastReplyAt); close(done) }()
	select {
	case <-started:
	case <-time.After(10 * time.Second):
		t.Fatal("extractor not reached")
	}
	g := memoryGateway{h.app}
	begin, err := g.Suggest(ctx, agent, gateway.SuggestInput{ThreadID: "t1", Trigger: "begin"})
	if err != nil || begin["enabled"] != false {
		t.Fatalf("compaction overlapped idle: %v %v", begin, err)
	}
	unblock()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("idle stuck")
	}
	if cursor := h.app.Memory.Extracted(ctx, agent, "t1").Cursor; cursor != "" {
		t.Fatalf("failed idle advanced cursor: %s", cursor)
	}
	begin, err = g.Suggest(ctx, agent, gateway.SuggestInput{ThreadID: "t1", Trigger: "begin"})
	if err != nil || begin["enabled"] != true || begin["since"] != "" {
		t.Fatalf("retry lost source: %v %v", begin, err)
	}
	// Releasing an old claim must not release a newer claimant.
	g.Suggest(ctx, agent, gateway.SuggestInput{ThreadID: "t1", Trigger: "release", Claim: "stale"})
	if !h.app.ownsExtraction(agent, "t1", begin["claim"].(string)) {
		t.Fatal("stale release removed a newer claim")
	}
	g.Suggest(ctx, agent, gateway.SuggestInput{ThreadID: "t1", Trigger: "release", Claim: begin["claim"].(string)})
}
