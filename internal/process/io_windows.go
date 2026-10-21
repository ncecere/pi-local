//go:build windows

package process

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"sync"
	"time"

	"golang.org/x/sys/windows"
)

type windowsCopy struct {
	dst   io.Writer
	src   io.Reader
	done  chan error
	stdin bool
}

type windowsStreams struct {
	child              [3]*os.File
	ownedChild, parent []*os.File
	input              *os.File
	copies             []windowsCopy
	outputMu           sync.Mutex
}
type serializedWriter struct {
	mu  *sync.Mutex
	dst io.Writer
}

func (w serializedWriter) Write(b []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.dst.Write(b)
}

func prepareWindowsStreams(cmd *exec.Cmd) (_ *windowsStreams, err error) {
	s := &windowsStreams{}
	defer func() {
		if err != nil {
			s.closeAll()
		}
	}()
	for i := range s.child {
		var direct *os.File
		var isFile, nilStream bool
		if i == 0 {
			direct, isFile = cmd.Stdin.(*os.File)
			nilStream = cmd.Stdin == nil
		} else if i == 1 {
			direct, isFile = cmd.Stdout.(*os.File)
			nilStream = cmd.Stdout == nil
		} else {
			direct, isFile = cmd.Stderr.(*os.File)
			nilStream = cmd.Stderr == nil
		}
		if isFile && direct == nil {
			return nil, errors.New("process: nil stdio file")
		}
		if nilStream {
			flag := os.O_WRONLY
			if i == 0 {
				flag = os.O_RDONLY
			}
			direct, err = os.OpenFile(os.DevNull, flag, 0)
			if err != nil {
				return nil, err
			}
			s.ownedChild = append(s.ownedChild, direct)
		}
		if direct != nil {
			s.child[i] = direct
			continue
		}
		r, w, e := os.Pipe()
		if e != nil {
			return nil, e
		}
		copy := windowsCopy{done: make(chan error, 1)}
		if i == 0 {
			copy.stdin = true
			s.child[i] = r
			s.ownedChild = append(s.ownedChild, r)
			s.parent = append(s.parent, w)
			s.input = w
			copy.src, copy.dst = cmd.Stdin, w
		} else {
			s.child[i] = w
			s.ownedChild = append(s.ownedChild, w)
			s.parent = append(s.parent, r)
			dst := cmd.Stdout
			if i == 2 {
				dst = cmd.Stderr
			}
			// Even if stdout/stderr are the same non-comparable writer, serialize their
			// callbacks. This matches exec's shared-consumer non-concurrent guarantee.
			copy.src, copy.dst = r, serializedWriter{&s.outputMu, dst}
		}
		s.copies = append(s.copies, copy)
	}
	return s, nil
}
func (s *windowsStreams) closeChild() {
	for _, f := range s.ownedChild {
		_ = f.Close()
	}
}
func (s *windowsStreams) closeAll() {
	s.closeChild()
	for _, f := range s.parent {
		_ = f.Close()
	}
}
func (s *windowsStreams) start() {
	// Release only owned child ends. In particular caller-owned OutputPipe.writer
	// remains owned by OutputPipe.Started, and its reader is never touched here.
	s.closeChild()
	for _, c := range s.copies {
		go func() {
			_, err := io.Copy(c.dst, c.src)
			if f, ok := c.dst.(*os.File); ok {
				_ = f.Close()
			} // stdin must deliver EOF
			c.done <- err
		}()
	}
}

// WaitDelay bounds total post-leader copier I/O (default two seconds). We never
// close caller-owned streams. As with exec, arbitrary user Reader/Writer
// callbacks must return: closing our pipe cannot interrupt a blocked callback.
// A non-cooperating callback can outlive Wait but cannot retain a job handle.
func (s *windowsStreams) finish(delay time.Duration) error {
	if s.input != nil {
		_ = s.input.Close()
	}
	defer s.closeAll()
	if delay <= 0 {
		delay = 2 * time.Second
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	var result error
	for _, c := range s.copies {
		select {
		case err := <-c.done:
			// Like Go exec_windows.go, a child that stops reading stdin is not
			// itself a copier failure. Its real process exit status still wins.
			if c.stdin && (errors.Is(err, windows.ERROR_BROKEN_PIPE) || errors.Is(err, windows.ERROR_NO_DATA)) {
				continue
			}
			if !errors.Is(err, os.ErrClosed) {
				result = errors.Join(result, err)
			}
		case <-timer.C:
			return errors.Join(result, exec.ErrWaitDelay)
		}
	}
	return result
}
