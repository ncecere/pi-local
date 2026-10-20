package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// streamInfo is what the Go side observed for one /api/stream request.
type streamInfo struct {
	ID                string `json:"id"`
	Client            string `json:"client"`
	RWType            string `json:"responseWriterType"`
	ImplementsFlusher bool   `json:"implementsFlusher"`
	RCFlushErr        string `json:"responseControllerFlushErr"`
	Flush             bool   `json:"flushEnabled"`
	Sent              int    `json:"eventsSent"`
	CtxCancelled      bool   `json:"ctxCancelled"`
	CancelledAfterMs  int64  `json:"cancelledAfterMs,omitempty"`
	CompletedNormally bool   `json:"completedNormally"`
	WriteErr          string `json:"writeErr,omitempty"`
}

type apiServer struct {
	mu      sync.Mutex
	streams map[string]*streamInfo
	onEvent func(id string, durMs int) // Wails-events fallback trigger
	loop    *loopbackServer
	onReport func(body []byte)
}

func newAPIServer() *apiServer {
	return &apiServer{streams: map[string]*streamInfo{}}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// Handler returns a plain http.Handler serving /api/*. It is mounted into the
// Wails asset server via Middleware, so the frontend uses same-origin URLs.
func (s *apiServer) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/ping", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"ok": true, "t": time.Now().UnixMilli(), "mode": buildMode, "host": r.Host, "origin": r.Header.Get("Origin")})
	})

	mux.HandleFunc("POST /api/echo", func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		log.Printf("[echo] content-type=%q content-length-hdr=%q bytes=%d", r.Header.Get("Content-Type"), r.Header.Get("Content-Length"), len(body))
		if r.URL.Query().Get("raw") == "1" {
			writeJSON(w, map[string]any{"bytes": len(body), "contentType": r.Header.Get("Content-Type")})
			return
		}
		var v any
		if err := json.Unmarshal(body, &v); err != nil {
			http.Error(w, "bad json: "+err.Error(), 400)
			return
		}
		writeJSON(w, map[string]any{"bytes": len(body), "echo": v})
	})

	mux.HandleFunc("GET /api/stream", s.handleStream)

	mux.HandleFunc("GET /api/stream-info", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		info := s.streams[r.URL.Query().Get("id")]
		if info == nil {
			writeJSON(w, map[string]any{"found": false})
			return
		}
		writeJSON(w, info)
	})

	mux.HandleFunc("POST /api/events/start", func(w http.ResponseWriter, r *http.Request) {
		id := r.URL.Query().Get("id")
		dur, _ := strconv.Atoi(r.URL.Query().Get("dur"))
		if dur == 0 {
			dur = 10000
		}
		go s.onEvent(id, dur)
		writeJSON(w, map[string]any{"started": id})
	})

	mux.HandleFunc("GET /api/loopback", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"base": s.loop.base, "seen": s.loop.Seen()})
	})

	mux.HandleFunc("POST /api/report", func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		s.onReport(body)
		writeJSON(w, map[string]any{"ok": true, "bytes": len(body)})
	})

	return mux
}

func (s *apiServer) snapshotStreams() map[string]*streamInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]*streamInfo, len(s.streams))
	for k, v := range s.streams {
		c := *v
		out[k] = &c
	}
	return out
}

// handleStream: SSE, one tick every interval ms for dur ms.
// Query: id, client, dur (ms, default 10000), interval (ms, default 250), flush (default 1).
func (s *apiServer) handleStream(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	id := q.Get("id")
	dur, _ := strconv.Atoi(q.Get("dur"))
	if dur <= 0 {
		dur = 10000
	}
	interval, _ := strconv.Atoi(q.Get("interval"))
	if interval <= 0 {
		interval = 250
	}
	doFlush := q.Get("flush") != "0"

	_, isFlusher := w.(http.Flusher)
	info := &streamInfo{ID: id, Client: q.Get("client"), RWType: fmt.Sprintf("%T", w), ImplementsFlusher: isFlusher, Flush: doFlush}
	s.mu.Lock()
	s.streams[id] = info
	s.mu.Unlock()

	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	rc := http.NewResponseController(w)
	flush := func() {
		if !doFlush {
			return
		}
		if err := rc.Flush(); err != nil {
			s.mu.Lock()
			info.RCFlushErr = err.Error()
			s.mu.Unlock()
		}
	}

	// retry hint + initial comment so the client sees the stream open right away
	_, _ = io.WriteString(w, "retry: 600000\n: open\n\n")
	flush()

	start := time.Now()
	log.Printf("[stream %s] start client=%s rw=%T flusher=%v flush=%v dur=%dms", id, info.Client, w, isFlusher, doFlush, dur)
	ticker := time.NewTicker(time.Duration(interval) * time.Millisecond)
	defer ticker.Stop()
	deadline := time.NewTimer(time.Duration(dur) * time.Millisecond)
	defer deadline.Stop()

	n := 0
	for {
		select {
		case <-r.Context().Done():
			el := time.Since(start).Milliseconds()
			s.mu.Lock()
			info.CtxCancelled = true
			info.CancelledAfterMs = el
			s.mu.Unlock()
			log.Printf("[stream %s] REQUEST CONTEXT CANCELLED after %dms, %d events sent (err=%v)", id, el, n, r.Context().Err())
			return
		case <-deadline.C:
			_, _ = io.WriteString(w, "event: done\ndata: {}\n\n")
			flush()
			s.mu.Lock()
			info.CompletedNormally = true
			s.mu.Unlock()
			log.Printf("[stream %s] completed normally, %d events", id, n)
			return
		case <-ticker.C:
			n++
			msg := fmt.Sprintf("event: tick\ndata: {\"n\":%d,\"t\":%d}\n\n", n, time.Now().UnixMilli())
			if n%4 == 0 {
				msg = ": keepalive\n\n" + msg
			}
			if _, err := io.WriteString(w, msg); err != nil {
				s.mu.Lock()
				info.WriteErr = err.Error()
				s.mu.Unlock()
				log.Printf("[stream %s] write error after %d events: %v", id, n, err)
				return
			}
			flush()
			s.mu.Lock()
			info.Sent = n
			s.mu.Unlock()
		}
	}
}
