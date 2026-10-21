package process

import (
	"os"
	"os/exec"
	"sync"
)

// InputPipe owns both endpoints, unlike Cmd.StdinPipe's private exec bookkeeping.
// Call Started after successful Start and Close on every path. Closing it sends
// EOF to runtime watchdogs without teaching MCP's JSON/null stdin that policy.
type InputPipe struct {
	reader, writer *os.File
	once           sync.Once
}

func NewInputPipe(cmd *exec.Cmd) (*InputPipe, error) {
	r, w, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	cmd.Stdin = r
	return &InputPipe{reader: r, writer: w}, nil
}
func (p *InputPipe) Started()                    { _ = p.reader.Close() }
func (p *InputPipe) Write(b []byte) (int, error) { return p.writer.Write(b) }
func (p *InputPipe) Close() error {
	p.once.Do(func() { _ = p.reader.Close(); _ = p.writer.Close() })
	return nil
}
