// Package applog keeps the app's own recent log lines in memory, for diagnostics: the desktop app has no terminal, so
// nothing else would show what it said. Everything slog prints still goes where it went; a copy is kept here.
package applog

import (
	"context"
	"log/slog"
	"os"
	"strings"
	"sync"
)

// MaxLines is how many lines are kept.
const MaxLines = 2000

// Ring is the last MaxLines log lines.
type Ring struct {
	mu    sync.Mutex
	lines []string
	part  string
}

// Write takes log output, which may arrive in pieces; whole lines are kept.
func (r *Ring) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	text := r.part + string(p)
	parts := strings.Split(text, "\n")
	r.part = parts[len(parts)-1]
	for _, line := range parts[:len(parts)-1] {
		r.lines = append(r.lines, line)
	}
	if extra := len(r.lines) - MaxLines; extra > 0 {
		r.lines = append([]string(nil), r.lines[extra:]...)
	}
	return len(p), nil
}

// Lines is a copy of the kept lines, oldest first.
func (r *Ring) Lines() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.lines...)
}

type tee struct{ a, b slog.Handler }

func (t tee) Enabled(ctx context.Context, l slog.Level) bool {
	return t.a.Enabled(ctx, l) || t.b.Enabled(ctx, l)
}

func (t tee) Handle(ctx context.Context, r slog.Record) error {
	var err error
	if t.a.Enabled(ctx, r.Level) {
		err = t.a.Handle(ctx, r.Clone())
	}
	if t.b.Enabled(ctx, r.Level) {
		if e := t.b.Handle(ctx, r.Clone()); err == nil {
			err = e
		}
	}
	return err
}

func (t tee) WithAttrs(attrs []slog.Attr) slog.Handler {
	return tee{t.a.WithAttrs(attrs), t.b.WithAttrs(attrs)}
}

func (t tee) WithGroup(name string) slog.Handler {
	return tee{t.a.WithGroup(name), t.b.WithGroup(name)}
}

var (
	once    sync.Once
	current = &Ring{}
)

// Install makes the default logger keep a copy of what it logs, once, and answers the ring that holds it. The
// logger keeps writing to stderr, as text (the default handler can't be wrapped: it feeds the log package, which
// would feed it back).
func Install() *Ring {
	once.Do(func() {
		slog.SetDefault(slog.New(tee{slog.NewTextHandler(os.Stderr, nil), slog.NewTextHandler(current, &slog.HandlerOptions{Level: slog.LevelInfo})}))
	})
	return current
}
