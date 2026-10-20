// Package events fans out what changes in the app (threads, agents) to every open UI stream (/api/events).
package events

import (
	"encoding/json"
	"sync"
)

// Event is one server-sent event: its name and JSON data.
type Event struct {
	Name string
	Data json.RawMessage
}

// Hub delivers events to subscribers without ever blocking a publisher: a subscriber that falls behind loses events
// and is sent `resync` instead, so it reads its lists again.
type Hub struct {
	mu   sync.Mutex
	subs map[*sub]struct{}
}

type sub struct {
	ch     chan Event
	behind bool
}

// NewHub makes an empty hub.
func NewHub() *Hub { return &Hub{subs: map[*sub]struct{}{}} }

// Subscribe returns a channel of events and a function that ends the subscription.
func (h *Hub) Subscribe() (<-chan Event, func()) {
	s := &sub{ch: make(chan Event, 256)}
	h.mu.Lock()
	h.subs[s] = struct{}{}
	h.mu.Unlock()
	return s.ch, func() {
		h.mu.Lock()
		if _, ok := h.subs[s]; ok {
			delete(h.subs, s)
			close(s.ch)
		}
		h.mu.Unlock()
	}
}

// Publish sends an event, with data marshalled to JSON, to every subscriber.
func (h *Hub) Publish(name string, data any) {
	raw, err := json.Marshal(data)
	if err != nil {
		return
	}
	ev := Event{Name: name, Data: raw}
	h.mu.Lock()
	defer h.mu.Unlock()
	for s := range h.subs {
		if s.behind {
			select {
			case s.ch <- Event{Name: "resync", Data: json.RawMessage(`{}`)}:
				s.behind = false
			default:
				continue
			}
		}
		select {
		case s.ch <- ev:
		default:
			s.behind = true
		}
	}
}

// Subscribers is how many streams are open.
func (h *Hub) Subscribers() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.subs)
}
