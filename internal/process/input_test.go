package process

import (
	"os/exec"
	"sync"
	"testing"
)

func TestOwnedInputPrestartAndStartedCleanup(t *testing.T) {
	for _, started := range []bool{false, true} {
		cmd := exec.Command("unused")
		p, err := NewInputPipe(cmd)
		if err != nil {
			t.Fatal(err)
		}
		if cmd.Stdin != p.reader {
			t.Fatal("child input is not caller-owned")
		}
		if started {
			p.Started()
		}
		var wg sync.WaitGroup
		for i := 0; i < 10; i++ {
			wg.Add(1)
			go func() { defer wg.Done(); _ = p.Close() }()
		}
		wg.Wait()
		if p.reader.Fd() != ^uintptr(0) || p.writer.Fd() != ^uintptr(0) {
			t.Fatal("owned input endpoint leaked")
		}
	}
}
