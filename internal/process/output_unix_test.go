//go:build darwin || linux

package process

import (
	"io"
	"os"
	"os/exec"
	"syscall"
	"testing"
	"time"
)

// A dup retains precisely the same pipe write endpoint as an escaped descendant,
// without requiring timing assumptions about subprocess startup or PID cleanup.
func retainedWriter(t *testing.T, p *OutputPipe) *os.File {
	t.Helper()
	fd, err := syscall.Dup(int(p.writer.Fd()))
	if err != nil {
		t.Fatal(err)
	}
	syscall.CloseOnExec(fd)
	f := os.NewFile(uintptr(fd), "retained-stdout")
	t.Cleanup(func() { f.Close() })
	return f
}

func TestOutputCallbackDoesNotSpendDrainBudget(t *testing.T) {
	p, err := NewOutputPipe(exec.Command("unused"))
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	w := retainedWriter(t, p)
	done := make(chan struct{})
	p.Started(done, nil, 20*time.Millisecond)
	p.Consume(func() {
		close(done)
		time.Sleep(100 * time.Millisecond) // callback exceeds the entire I/O budget
		if _, err := io.WriteString(w, "final result\n"); err != nil {
			t.Fatal(err)
		}
		w.Close()
	})
	b, err := io.ReadAll(p)
	if err != nil || string(b) != "final result\n" {
		t.Fatalf("lost buffered output: %q %v", b, err)
	}
	p.Close()
	select {
	case <-p.watchDone:
	default:
		t.Fatal("watcher not joined")
	}
}

func TestOutputRetainedEndpointIsBounded(t *testing.T) {
	for _, continuous := range []bool{false, true} {
		t.Run(map[bool]string{false: "silent", true: "writing"}[continuous], func(t *testing.T) {
			p, err := NewOutputPipe(exec.Command("unused"))
			if err != nil {
				t.Fatal(err)
			}
			defer p.Close()
			w := retainedWriter(t, p)
			writerDone := make(chan struct{})
			if continuous {
				go func() {
					defer close(writerDone)
					b := make([]byte, 1024)
					for {
						if _, err := w.Write(b); err != nil {
							return
						}
					}
				}()
			} else {
				close(writerDone)
			}
			done := make(chan struct{})
			p.Started(done, nil, 30*time.Millisecond)
			if _, err := p.writer.Stat(); err == nil {
				t.Fatal("parent write endpoint remained open after Start")
			}
			close(done)
			readDone := make(chan struct{})
			go func() { io.Copy(io.Discard, p); close(readDone) }()
			select {
			case <-readDone:
			case <-time.After(time.Second):
				t.Fatal("retained stdout blocked drain")
			}
			select {
			case <-writerDone:
			case <-time.After(time.Second):
				t.Fatal("writer did not unblock")
			}
			p.Close()
			select {
			case <-p.watchDone:
			default:
				t.Fatal("watcher not joined")
			}
		})
	}
}
