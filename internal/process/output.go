package process

import (
	"io"
	"os"
	"os/exec"
	"sync"
	"time"
)

// OutputDrainGrace bounds post-exit stdout I/O, not time spent in consumer
// callbacks. Local pipe reads get five seconds; slow callbacks do not discard
// already-written results. Consumers must return from their callbacks.
const OutputDrainGrace = 5 * time.Second

// OutputPipe owns BOTH os.Pipe endpoints. Unlike Cmd.StdoutPipe, its reader is
// not closed by cmd.Wait: the consumer can finish draining after Tree reaps.
// Use Started immediately after successful Start, and Close on every path.
// There must be one reader/consumer; Consume may not be nested.
type OutputPipe struct {
	reader, writer         *os.File
	mu                     sync.Mutex
	paused, exited, closed bool
	remaining              time.Duration
	armed                  time.Time
	timer                  *time.Timer
	generation             uint64
	stop                   chan struct{}
	watchDone              chan struct{}
	once                   sync.Once
}

func NewOutputPipe(cmd *exec.Cmd) (*OutputPipe, error) {
	r, w, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	cmd.Stdout = w // an externally owned file: os/exec must not close our reader
	return &OutputPipe{reader: r, writer: w, stop: make(chan struct{})}, nil
}

func (p *OutputPipe) Read(b []byte) (int, error) { return p.reader.Read(b) }

// Started releases the parent's write endpoint immediately, so child exit can
// produce EOF. Cancellation closes the read side even if a descendant escaped
// containment and retained stdout. nil cancel is a startup-only caller's policy.
func (p *OutputPipe) Started(done, cancel <-chan struct{}, grace time.Duration) {
	p.writer.Close()
	p.mu.Lock()
	if p.closed || p.watchDone != nil {
		p.mu.Unlock()
		return
	}
	p.watchDone = make(chan struct{})
	watchDone := p.watchDone
	p.mu.Unlock()
	go func() {
		defer close(watchDone)
		select {
		case <-p.stop:
			return
		case <-cancel:
			p.reader.Close()
			return
		case <-done:
			p.mu.Lock()
			p.exited, p.remaining = true, max(grace, 0)
			p.armLocked()
			p.mu.Unlock()
		}
		select {
		case <-p.stop:
		case <-cancel:
			p.reader.Close()
		}
	}()
}

func (p *OutputPipe) armLocked() {
	if p.closed || p.paused || !p.exited {
		return
	}
	p.armed = time.Now()
	p.generation++
	gen := p.generation
	p.timer = time.AfterFunc(max(p.remaining, 0), func() {
		p.mu.Lock()
		defer p.mu.Unlock()
		if !p.closed && !p.paused && gen == p.generation {
			p.reader.Close()
		}
	})
}

// Consume excludes a callback's duration from the post-exit I/O budget. Timer
// generations prevent an already-dispatched old timer from closing the pipe
// after a pause. Parsing and reading still share a finite budget; even an
// escaped descendant continuously writing cannot extend it by making progress.
func (p *OutputPipe) Consume(fn func()) {
	p.mu.Lock()
	p.paused = true
	if p.timer != nil {
		p.timer.Stop()
		p.timer = nil
		p.generation++
		p.remaining -= time.Since(p.armed)
	}
	p.mu.Unlock()
	defer func() {
		p.mu.Lock()
		p.paused = false
		p.armLocked()
		p.mu.Unlock()
	}()
	fn()
}

func (p *OutputPipe) Close() error {
	p.once.Do(func() {
		p.mu.Lock()
		p.closed = true
		if p.timer != nil {
			p.timer.Stop()
		}
		close(p.stop)
		p.reader.Close()
		p.writer.Close()
		watchDone := p.watchDone
		p.mu.Unlock()
		if watchDone != nil {
			<-watchDone
		}
	})
	return nil
}

var _ io.ReadCloser = (*OutputPipe)(nil)
