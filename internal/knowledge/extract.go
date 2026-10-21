package knowledge

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/ncecere/pi-local/internal/supervisor"
)

// Result is what reading a document gave: its Markdown, or why not.
type Result struct {
	Markdown string
	// Error is for people ("report.pdf is protected by a password"); empty when Markdown is the document.
	Error string
}

// Extractor turns documents (PDF, Word, Excel, PowerPoint) into Markdown. The app's is the agent runtime run as
// `runtime.mjs --extract --batch` (the converters `read` uses); tests give their own.
type Extractor interface {
	// Extract reads the files at paths (absolute); every path gets a Result.
	Extract(ctx context.Context, paths []string) map[string]Result
}

// NodeExtractor runs the runtime's extract mode: paths on stdin, one JSON line per file on stdout. Files go in
// batches (a process starts, and loads the PDF library, once per batch); a batch that dies or hangs is retried file
// by file, so one bad file costs only itself.
type NodeExtractor struct {
	Runtime supervisor.Runtime
	// BatchSize is how many files one process reads (default 12).
	BatchSize int
	// PerFile is how long one file may take (default 60 s).
	PerFile time.Duration
}

const maxMarkdownBytes = 256 << 20

func (e NodeExtractor) Extract(ctx context.Context, paths []string) map[string]Result {
	out := make(map[string]Result, len(paths))
	size := e.BatchSize
	if size <= 0 {
		size = 12
	}
	per := e.PerFile
	if per <= 0 {
		per = 60 * time.Second
	}
	for start := 0; start < len(paths); start += size {
		if ctx.Err() != nil {
			break
		}
		batch := paths[start:min(start+size, len(paths))]
		got, err := e.run(ctx, batch, time.Duration(len(batch))*per+30*time.Second)
		for _, p := range batch {
			if r, ok := got[p]; ok {
				out[p] = r
				continue
			}
			// What the batch didn't answer (its process died on a file, or took too long): that file alone.
			if len(batch) > 1 {
				if ctx.Err() != nil {
					break
				}
				got1, err1 := e.run(ctx, []string{p}, per+30*time.Second)
				if r, ok := got1[p]; ok {
					out[p] = r
					continue
				}
				err = err1
			}
			if errors.Is(err, context.DeadlineExceeded) {
				out[p] = Result{Error: "Took too long to read"}
			} else {
				out[p] = Result{Error: "Could not be read (the reader stopped on it)"}
			}
		}
	}
	return out
}

// extractDocuments gives the converter private, bounded snapshots, never paths it could follow out of the folder.
// The directory walk alone is not a read guard: a directory could have been replaced by a symlink since it ran.
func (s *Service) extractDocuments(ctx context.Context, folder string, files []found) map[string]Result {
	out := map[string]Result{}
	tmp, err := os.MkdirTemp("", "pi-local-knowledge-")
	if err != nil {
		for _, f := range files {
			out[filepath.Join(folder, filepath.FromSlash(f.rel))] = Result{Error: "Could not prepare the document reader"}
		}
		return out
	}
	defer os.RemoveAll(tmp)
	var paths []string
	originals := map[string]string{}
	for i, f := range files {
		if ctx.Err() != nil {
			break
		}
		original := filepath.Join(folder, filepath.FromSlash(f.rel))
		raw, err := readLocalFile(folder, f.rel)
		if err != nil {
			out[original] = Result{Error: "Could not be read: " + firstLine(err.Error())}
			continue
		}
		dir := filepath.Join(tmp, fmt.Sprint(i))
		path := filepath.Join(dir, filepath.Base(f.rel))
		if err = os.Mkdir(dir, 0o700); err == nil {
			err = os.WriteFile(path, raw, 0o600)
		}
		if err != nil {
			out[original] = Result{Error: "Could not prepare the document reader"}
			continue
		}
		paths = append(paths, path)
		originals[path] = original
	}
	if len(paths) > 0 {
		results := s.extractor.Extract(ctx, paths)
		for _, path := range paths {
			out[originals[path]] = results[path]
		}
	}
	return out
}

// run starts one extract process for paths and collects the answers it gave before it ended.
func (e NodeExtractor) run(ctx context.Context, paths []string, timeout time.Duration) (map[string]Result, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	args := append(append([]string{}, e.Runtime.Args...), e.Runtime.Script, "--extract", "--batch")
	cmd := exec.CommandContext(ctx, e.Runtime.Node, args...)
	cmd.Dir = e.Runtime.Dir
	cmd.Stdin = strings.NewReader(strings.Join(paths, "\n") + "\n")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	var stderr bytes.Buffer
	cmd.Stderr = &limitedWriter{w: &stderr, left: 8 << 10}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	got := map[string]Result{}
	reader := bufio.NewReaderSize(stdout, 1<<20)
	for {
		line, readErr := readLine(reader)
		if len(line) > 0 {
			var l struct {
				Path     string `json:"path"`
				Markdown string `json:"markdown"`
				Error    string `json:"error"`
			}
			if json.Unmarshal(line, &l) == nil && l.Path != "" {
				got[l.Path] = Result{Markdown: l.Markdown, Error: l.Error}
			}
		}
		if readErr != nil {
			break
		}
	}
	waitErr := cmd.Wait()
	if ctx.Err() != nil {
		return got, ctx.Err()
	}
	return got, waitErr
}

// readLine reads one line of any length up to maxMarkdownBytes (a long document is one line of JSON).
func readLine(r *bufio.Reader) ([]byte, error) {
	var line []byte
	for {
		chunk, isPrefix, err := r.ReadLine()
		if len(line)+len(chunk) > maxMarkdownBytes {
			io.Copy(io.Discard, r)
			return nil, io.EOF
		}
		line = append(line, chunk...)
		if err != nil || !isPrefix {
			return line, err
		}
	}
}

type limitedWriter struct {
	w    io.Writer
	left int
}

func (l *limitedWriter) Write(p []byte) (int, error) {
	n := len(p)
	if l.left <= 0 {
		return n, nil
	}
	if len(p) > l.left {
		p = p[:l.left]
	}
	l.left -= len(p)
	l.w.Write(p)
	return n, nil
}
