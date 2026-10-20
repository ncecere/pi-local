package app

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// fakeProvider is a model service for tests, speaking OpenAI's chat completions or Anthropic's messages API (both
// streamed, as the runtime uses them) and listing its models. It records what it was sent.
type fakeProvider struct {
	*httptest.Server
	kind  string // "openai" or "anthropic"
	reply string

	mu       sync.Mutex
	requests []fakeRequest
	models   []map[string]any
	status   int // when set, every request gets this status
	calls    int
}

type fakeRequest struct {
	Path    string
	Auth    string // Authorization or x-api-key
	Header  http.Header
	Model   string
	Stream  bool
	Message string // the last user message's text
}

func newFakeProvider(t *testing.T, kind, reply string) *fakeProvider {
	t.Helper()
	f := &fakeProvider{kind: kind, reply: reply}
	f.Server = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.Close)
	return f
}

func (f *fakeProvider) seen() []fakeRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]fakeRequest{}, f.requests...)
}

func (f *fakeProvider) chats() []fakeRequest {
	var out []fakeRequest
	for _, r := range f.seen() {
		if strings.HasSuffix(r.Path, "/chat/completions") || strings.HasSuffix(r.Path, "/messages") {
			out = append(out, r)
		}
	}
	return out
}

func lastUserText(messages []json.RawMessage) string {
	for i := len(messages) - 1; i >= 0; i-- {
		var m struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		}
		json.Unmarshal(messages[i], &m)
		if m.Role != "user" {
			continue
		}
		var text string
		if json.Unmarshal(m.Content, &text) == nil {
			return text
		}
		var parts []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		json.Unmarshal(m.Content, &parts)
		var b strings.Builder
		for _, p := range parts {
			b.WriteString(p.Text)
		}
		return b.String()
	}
	return ""
}

func (f *fakeProvider) serve(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	var body struct {
		Model    string            `json:"model"`
		Stream   bool              `json:"stream"`
		Messages []json.RawMessage `json:"messages"`
	}
	json.Unmarshal(raw, &body)
	auth := r.Header.Get("Authorization")
	if f.kind == "anthropic" {
		auth = r.Header.Get("x-api-key")
	}
	f.mu.Lock()
	f.requests = append(f.requests, fakeRequest{Path: r.URL.Path, Auth: auth, Header: r.Header.Clone(), Model: body.Model, Stream: body.Stream, Message: lastUserText(body.Messages)})
	status, listed := f.status, f.models
	f.mu.Unlock()
	if status != 0 {
		http.Error(w, `{"error":{"message":"nope"}}`, status)
		return
	}
	switch {
	case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/models"):
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": listed})
	case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/chat/completions"):
		// A little script: after a tool result, answer with it; a user message with ASK:<agent>:<question> calls
		// ask_agent; anything else gets the canned reply.
		if result, ok := lastToolResult(body.Messages); ok {
			f.openAIText(w, body.Model, "Got: "+result)
			return
		}
		user := lastUserText(body.Messages)
		for prefix, tool := range map[string]string{"RUN:": "bash", "READ:": "read", "WRITE:": "write"} {
			i := strings.Index(user, prefix)
			if i < 0 {
				continue
			}
			arg := strings.TrimSpace(user[i+len(prefix):])
			var args []byte
			switch tool {
			case "bash":
				args, _ = json.Marshal(map[string]string{"command": arg})
			case "read":
				args, _ = json.Marshal(map[string]string{"path": arg})
			case "write":
				path, content, _ := strings.Cut(arg, ":")
				args, _ = json.Marshal(map[string]string{"path": path, "content": content})
			}
			f.openAIToolCall(w, body.Model, tool, string(args))
			return
		}
		if i := strings.Index(lastUserText(body.Messages), "ASK:"); i >= 0 {
			parts := strings.SplitN(lastUserText(body.Messages)[i+4:], ":", 2)
			if len(parts) == 2 {
				args, _ := json.Marshal(map[string]string{"agent": parts[0], "message": strings.TrimSpace(parts[1])})
				f.openAIToolCall(w, body.Model, "ask_agent", string(args))
				return
			}
		}
		f.openAIStream(w, body.Model)
	case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/v1/messages"):
		f.anthropicStream(w, body.Model)
	default:
		http.NotFound(w, r)
	}
}

func sse(w http.ResponseWriter, event string, data any) {
	raw, _ := json.Marshal(data)
	if event != "" {
		fmt.Fprintf(w, "event: %s\n", event)
	}
	fmt.Fprintf(w, "data: %s\n\n", raw)
	w.(http.Flusher).Flush()
}

// lastToolResult is the text of the last message when it is a tool result.
func lastToolResult(messages []json.RawMessage) (string, bool) {
	if len(messages) == 0 {
		return "", false
	}
	var m struct {
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	}
	json.Unmarshal(messages[len(messages)-1], &m)
	if m.Role != "tool" {
		return "", false
	}
	var text string
	if json.Unmarshal(m.Content, &text) == nil {
		return text, true
	}
	var parts []struct {
		Text string `json:"text"`
	}
	json.Unmarshal(m.Content, &parts)
	var b strings.Builder
	for _, p := range parts {
		b.WriteString(p.Text)
	}
	return b.String(), true
}

func (f *fakeProvider) openAIToolCall(w http.ResponseWriter, model, name, args string) {
	w.Header().Set("Content-Type", "text/event-stream")
	f.mu.Lock()
	f.calls++
	id := fmt.Sprintf("call_%d", f.calls)
	f.mu.Unlock()
	sse(w, "", map[string]any{"id": "c1", "object": "chat.completion.chunk", "model": model, "choices": []any{map[string]any{"index": 0,
		"delta": map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{"index": 0, "id": id, "type": "function",
			"function": map[string]any{"name": name, "arguments": args}}}}, "finish_reason": nil}}})
	sse(w, "", map[string]any{"id": "c1", "object": "chat.completion.chunk", "model": model,
		"choices": []any{map[string]any{"index": 0, "delta": map[string]any{}, "finish_reason": "tool_calls"}}})
	sse(w, "", map[string]any{"id": "c1", "object": "chat.completion.chunk", "model": model, "choices": []any{},
		"usage": map[string]any{"prompt_tokens": 100, "completion_tokens": 20}})
	fmt.Fprint(w, "data: [DONE]\n\n")
}

func (f *fakeProvider) openAIStream(w http.ResponseWriter, model string) {
	f.openAIText(w, model, f.reply)
}

func (f *fakeProvider) openAIText(w http.ResponseWriter, model, text string) {
	w.Header().Set("Content-Type", "text/event-stream")
	words := strings.SplitAfter(text, " ")
	for i, word := range words {
		delta := map[string]any{"content": word}
		if i == 0 {
			delta["role"] = "assistant"
		}
		sse(w, "", map[string]any{"id": "c1", "object": "chat.completion.chunk", "model": model,
			"choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": nil}}})
	}
	sse(w, "", map[string]any{"id": "c1", "object": "chat.completion.chunk", "model": model,
		"choices": []any{map[string]any{"index": 0, "delta": map[string]any{}, "finish_reason": "stop"}}})
	sse(w, "", map[string]any{"id": "c1", "object": "chat.completion.chunk", "model": model, "choices": []any{},
		"usage": map[string]any{"prompt_tokens": 1200, "completion_tokens": 300, "total_tokens": 1500}})
	fmt.Fprint(w, "data: [DONE]\n\n")
}

func (f *fakeProvider) anthropicStream(w http.ResponseWriter, model string) {
	w.Header().Set("Content-Type", "text/event-stream")
	sse(w, "message_start", map[string]any{"type": "message_start", "message": map[string]any{
		"id": "msg_1", "type": "message", "role": "assistant", "model": model, "content": []any{},
		"stop_reason": nil, "usage": map[string]any{"input_tokens": 900, "output_tokens": 1}}})
	sse(w, "content_block_start", map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "text", "text": ""}})
	for _, word := range strings.SplitAfter(f.reply, " ") {
		sse(w, "content_block_delta", map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "text_delta", "text": word}})
	}
	sse(w, "content_block_stop", map[string]any{"type": "content_block_stop", "index": 0})
	sse(w, "message_delta", map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": "end_turn"}, "usage": map[string]any{"output_tokens": 250}})
	sse(w, "message_stop", map[string]any{"type": "message_stop"})
}
