package knowledge

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"testing"
	"time"

	"github.com/ncecere/pi-local/internal/knowledge/knowledgetest"
	"github.com/ncecere/pi-local/internal/supervisor"
)

// sourceRuntime runs the runtime from source (node --import tsx src/main.ts), as the app's tests do.
func sourceRuntime(t *testing.T) supervisor.Runtime {
	t.Helper()
	_, file, _, _ := goruntime.Caller(0)
	dir := filepath.Join(filepath.Dir(file), "..", "..", "runtime")
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	return supervisor.Runtime{Node: node, Args: []string{"--disable-warning=ExperimentalWarning", "--import", "tsx"}, Script: "src/main.ts", Dir: dir}
}

func TestTheRuntimeReadsDocumentsInBatchesAndAFailureCostsOnlyItsFile(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "paper.pdf"), string(knowledgetest.PDF("The warranty lasts two years", "Refunds are on page two")))
	write(t, filepath.Join(dir, "report.docx"), string(knowledgetest.DOCX("Quarterly report", "Summary", "Sales grew 12%.")))
	write(t, filepath.Join(dir, "broken.pdf"), "this is not a pdf")
	missing := filepath.Join(dir, "missing.docx")
	paths := []string{filepath.Join(dir, "paper.pdf"), filepath.Join(dir, "broken.pdf"), filepath.Join(dir, "report.docx"), missing}

	got := NodeExtractor{Runtime: sourceRuntime(t)}.Extract(context.Background(), paths)
	if len(got) != 4 {
		t.Fatalf("%d results: %+v", len(got), got)
	}
	if md := got[paths[0]].Markdown; !strings.Contains(md, "## Page 2\n\nRefunds are on page two") {
		t.Errorf("pdf: %+v", got[paths[0]])
	}
	if r := got[paths[1]]; r.Markdown != "" || !strings.Contains(r.Error, "could not be read as a PDF") {
		t.Errorf("broken pdf: %+v", r)
	}
	if md := got[paths[2]].Markdown; !strings.Contains(md, "Sales grew 12%.") {
		t.Errorf("docx: %+v", got[paths[2]])
	}
	if r := got[paths[3]]; !strings.Contains(r.Error, "could not be found") {
		t.Errorf("missing: %+v", r)
	}
	// And what Split makes of them.
	if p := Split(got[paths[0]].Markdown, "pdf"); len(p) != 2 || p[1].Locator != "page 2" {
		t.Errorf("passages: %+v", p)
	}
}

func TestBundledRuntimeExtractModeDoesNotStartAnAgent(t *testing.T) {
	rt := sourceRuntime(t)
	rt.Args = []string{"--disable-warning=ExperimentalWarning"}
	rt.Script = filepath.Join(rt.Dir, "dist", "runtime.mjs")
	if _, err := os.Stat(rt.Script); err != nil {
		t.Skip("run make runtime to test the bundled extract CLI")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "paper.pdf")
	write(t, path, string(knowledgetest.PDF("Bundled extraction", "Located on page two")))
	got := (NodeExtractor{Runtime: rt}).Extract(context.Background(), []string{path})[path]
	if got.Error != "" || !strings.Contains(got.Markdown, "## Page 2\n\nLocated on page two") {
		t.Fatalf("bundled extraction: %+v", got)
	}
}

func TestAReaderThatDiesGivesEveryFileAnError(t *testing.T) {
	dir := t.TempDir()
	var paths []string
	for _, n := range []string{"a.pdf", "b.pdf", "c.pdf"} {
		write(t, filepath.Join(dir, n), "x")
		paths = append(paths, filepath.Join(dir, n))
	}
	// A "runtime" that exits at once: each file is tried alone, and each says it couldn't be read.
	script := filepath.Join(dir, "die.sh")
	os.WriteFile(script, []byte("#!/bin/sh\nexit 3\n"), 0o755)
	started := time.Now()
	got := NodeExtractor{Runtime: supervisor.Runtime{Node: "/bin/sh", Script: script}}.Extract(context.Background(), paths)
	if len(got) != 3 || time.Since(started) > 10*time.Second {
		t.Fatalf("%+v after %s", got, time.Since(started))
	}
	for _, p := range paths {
		if !strings.Contains(got[p].Error, "Could not be read") {
			t.Errorf("%s: %+v", p, got[p])
		}
	}
}
