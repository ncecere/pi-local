package main

import (
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// loopbackServer is the fallback option (c): a plain HTTP server on
// 127.0.0.1:<random>, reached cross-origin from the wails:// page.
type loopbackServer struct {
	base string
	mu   sync.Mutex
	seen []string
}

func (l *loopbackServer) Seen() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.seen...)
}

func startLoopback() *loopbackServer {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatal(err)
	}
	l := &loopbackServer{base: "http://" + ln.Addr().String()}
	mux := http.NewServeMux()
	cors := func(w http.ResponseWriter) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "*")
	}
	record := func(r *http.Request) {
		l.mu.Lock()
		l.seen = append(l.seen, fmt.Sprintf("%s %s origin=%q", r.Method, r.URL.Path, r.Header.Get("Origin")))
		l.mu.Unlock()
	}
	mux.HandleFunc("/ping", func(w http.ResponseWriter, r *http.Request) { // NO CORS headers
		record(r)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"ok":true,"cors":false}`)
	})
	mux.HandleFunc("/ping-cors", func(w http.ResponseWriter, r *http.Request) {
		record(r)
		cors(w)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"ok":true,"cors":true}`)
	})
	mux.HandleFunc("/stream-cors", func(w http.ResponseWriter, r *http.Request) {
		record(r)
		cors(w)
		dur, _ := strconv.Atoi(r.URL.Query().Get("dur"))
		if dur <= 0 {
			dur = 3000
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(200)
		f := w.(http.Flusher)
		_, _ = io.WriteString(w, ": open\n\n")
		f.Flush()
		t := time.NewTicker(250 * time.Millisecond)
		defer t.Stop()
		end := time.After(time.Duration(dur) * time.Millisecond)
		n := 0
		for {
			select {
			case <-r.Context().Done():
				log.Printf("[loopback stream] ctx cancelled after %d events", n)
				return
			case <-end:
				_, _ = io.WriteString(w, "event: done\ndata: {}\n\n")
				f.Flush()
				return
			case <-t.C:
				n++
				fmt.Fprintf(w, "event: tick\ndata: {\"n\":%d,\"t\":%d}\n\n", n, time.Now().UnixMilli())
				f.Flush()
			}
		}
	})
	go func() { _ = http.Serve(ln, mux) }()
	log.Printf("[loopback] listening on %s", l.base)
	return l
}
