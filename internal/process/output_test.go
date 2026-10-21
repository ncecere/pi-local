package process

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestOutputPrestartCleanup(t *testing.T) {
	for _, mode := range []string{"refused", "missing", "cancelled"} {
		t.Run(mode, func(t *testing.T) {
			cmd := exec.Command(filepath.Join(t.TempDir(), "missing"))
			p, err := NewOutputPipe(cmd)
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			o := &failingOwner{}
			if mode == "refused" {
				o.prepareErr = ErrUnsupported
			}
			if mode == "cancelled" {
				cancel()
			}
			if _, err := start(ctx, cmd, o); err == nil {
				t.Fatal("expected failed start")
			}
			if cmd.Process != nil {
				t.Fatal("refused command launched")
			}
			// No os/exec ownership of either external endpoint is assumed.
			var wg sync.WaitGroup
			for i := 0; i < 8; i++ {
				wg.Add(1)
				go func() { defer wg.Done(); p.Close() }()
			}
			wg.Wait()
			for _, f := range []*os.File{p.reader, p.writer} {
				if _, err := f.Stat(); !errors.Is(err, os.ErrClosed) {
					t.Fatalf("endpoint left open: %v", err)
				}
			}
		})
	}
}

func TestOutputStartCloseRace(t *testing.T) {
	for i := 0; i < 20; i++ {
		p, err := NewOutputPipe(exec.Command("unused"))
		if err != nil {
			t.Fatal(err)
		}
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); p.Started(make(chan struct{}), nil, time.Hour) }()
		go func() { defer wg.Done(); p.Close() }()
		wg.Wait()
		p.Close()
		if p.watchDone != nil {
			select {
			case <-p.watchDone:
			default:
				t.Fatal("watcher survived Close")
			}
		}
	}
}

func TestOutputCancellationJoinsWatcher(t *testing.T) {
	p, err := NewOutputPipe(exec.Command("unused"))
	if err != nil {
		t.Fatal(err)
	}
	cancel := make(chan struct{})
	p.Started(make(chan struct{}), cancel, time.Hour)
	close(cancel)
	select {
	case <-p.watchDone:
	case <-time.After(time.Second):
		t.Fatal("cancellation watcher hung")
	}
	p.Close()
}
