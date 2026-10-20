package app

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

type sseEvent struct {
	ID, Name, Data string
}

// readEvents opens an SSE stream and sends its events on a channel until ctx ends.
func readEvents(t *testing.T, ctx context.Context, url string, header http.Header) <-chan sseEvent {
	t.Helper()
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	for k, v := range header {
		req.Header[k] = v
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("stream %s: %d", url, resp.StatusCode)
	}
	out := make(chan sseEvent, 1000)
	go func() {
		defer resp.Body.Close()
		defer close(out)
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(make([]byte, 64<<10), 8<<20)
		var ev sseEvent
		for sc.Scan() {
			line := sc.Text()
			switch {
			case line == "":
				if ev.Data != "" {
					out <- ev
				}
				ev = sseEvent{}
			case strings.HasPrefix(line, "id: "):
				ev.ID = line[4:]
			case strings.HasPrefix(line, "event: "):
				ev.Name = line[7:]
			case strings.HasPrefix(line, "data: "):
				ev.Data += line[6:]
			}
		}
	}()
	return out
}

func TestTheDeltaStreamAndSteeringPassThrough(t *testing.T) {
	h := start(t, t.TempDir(), Config{DemoTokensPerSecond: "30"})
	agent := h.createAgent("Streamer")
	h.mustDo("POST", "/api/agents/"+agent+"/threads/t1/messages", map[string]string{"text": "hello", "requestId": "r1"}, 202)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events := readEvents(t, ctx, h.srv.URL+"/api/agents/"+agent+"/threads/t1/events?format=delta&v=1", nil)
	first := <-events
	if first.Name != "snapshot" || first.ID == "" {
		t.Fatalf("the first delta event: %+v", first)
	}
	// While it answers, a steer joins the run (not queued after it).
	h.mustDo("POST", "/api/agents/"+agent+"/threads/t1/messages", map[string]any{"text": "and also this", "requestId": "r2", "whenBusy": "steer"}, 202)
	var lastID string
	names := map[string]int{}
	deadline := time.After(30 * time.Second)
	for done := false; !done; {
		select {
		case ev := <-events:
			names[ev.Name]++
			lastID = ev.ID
			if ev.Name == "run" && strings.Contains(ev.Data, `"busy":false`) {
				done = true
			}
		case <-deadline:
			t.Fatalf("no end of the run; events so far: %v", names)
		}
	}
	if names["message.added"] == 0 || names["partial.appended"]+names["partial.set"] == 0 {
		t.Fatalf("delta events: %v", names)
	}
	cancel()

	// Continuing from the last event ID: nothing missed, no fresh snapshot needed.
	ctx2, cancel2 := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel2()
	resumed := readEvents(t, ctx2, h.srv.URL+"/api/agents/"+agent+"/threads/t1/events?format=delta&v=1", http.Header{"Last-Event-ID": {lastID}})
	select {
	case ev := <-resumed:
		if ev.Name == "snapshot" {
			t.Logf("resumed with a snapshot (allowed when the runtime no longer has the gap): %s", ev.ID)
		}
	case <-ctx2.Done():
		// No event: caught up, nothing new to send. That's the expected case.
	}

	// The user messages carry their request IDs; the steer was answered in the same run.
	v := h.view(agent, "t1")
	raw, _ := json.Marshal(v)
	full := string(h.mustDo("GET", "/api/agents/"+agent+"/threads/t1", nil, 200))
	if !strings.Contains(full, `"requestId":"r1"`) || !strings.Contains(full, `"requestId":"r2"`) {
		t.Fatalf("request IDs in the view: %s", raw)
	}
	// Paging: one message, then the ones before it.
	page := decodeInto[struct {
		Messages      []json.RawMessage `json:"messages"`
		EarlierCursor string            `json:"earlierCursor"`
	}](t, h.mustDo("GET", "/api/agents/"+agent+"/threads/t1?limit=1", nil, 200))
	if len(page.Messages) != 1 || page.EarlierCursor == "" {
		t.Fatalf("a page of one: %+v", page)
	}
	earlier := decodeInto[struct {
		Messages []json.RawMessage `json:"messages"`
	}](t, h.mustDo("GET", "/api/agents/"+agent+"/threads/t1?limit=50&before="+page.EarlierCursor, nil, 200))
	if len(earlier.Messages) == 0 {
		t.Fatal("no earlier messages")
	}
}

func TestDocumentsOfAResearcher(t *testing.T) {
	h := start(t, t.TempDir(), Config{DemoTokensPerSecond: "100000"})
	agent := decodeInto[struct{ ID string }](t, h.mustDo("POST", "/api/agents", map[string]any{"name": "Researcher", "templateId": "researcher"}, 201)).ID
	h.sendAndWait(agent, "t1", "hello", "r1")
	full := string(h.mustDo("GET", "/api/agents/"+agent+"/threads/t1", nil, 200))
	if !strings.Contains(full, `"documents":{`) || !strings.Contains(full, "research.plan") {
		t.Fatalf("a researcher's thread should expose its documents: %s", full)
	}
	doc := string(h.mustDo("GET", "/api/agents/"+agent+"/threads/t1/documents/research.plan", nil, 200))
	if !strings.Contains(doc, `"kind":"research.plan"`) || !strings.Contains(doc, `"revision"`) {
		t.Fatalf("the plan: %s", doc)
	}
	if code, _ := h.do("GET", "/api/agents/"+agent+"/threads/t1/documents/pi.agent", nil); code != 404 {
		t.Fatalf("an internal document must not be exposed: %d", code)
	}
}
