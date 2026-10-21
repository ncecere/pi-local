package supervisor

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A runtime's log never holds its secrets: stderr lines (even when they arrive in pieces), stdout lines and the tail.
func TestALogIsCleanedOfSecrets(t *testing.T) {
	dir := t.TempDir()
	l, err := openLog(dir)
	if err != nil {
		t.Fatal(err)
	}
	l.redact = func(line string) string { return strings.ReplaceAll(line, "model-key-0123456789", "[redacted secret]") }
	l.Write([]byte("[agent x] failed with model-key-01"))
	l.Write([]byte("23456789 in the header\n[agent x] second\n"))
	l.Line("stdout says model-key-0123456789 too")
	l.Note("starting")
	l.Close()
	raw, _ := os.ReadFile(filepath.Join(dir, "runtime.log"))
	if strings.Contains(string(raw), "model-key") || strings.Count(string(raw), "[redacted secret]") != 2 || !strings.Contains(string(raw), "second") {
		t.Fatalf("the log: %q", raw)
	}
	if strings.Contains(l.Tail(), "model-key") {
		t.Fatalf("the tail: %q", l.Tail())
	}
}
