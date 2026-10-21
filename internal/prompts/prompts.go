// Package prompts keeps the prompt library: saved prompts (a title, an optional description, and text with
// {{placeholders}}) as Markdown files in <data>/prompts/, so they can be edited, shared and backed up as plain files.
// The composer's slash menu offers them (/ at the start of a message).
//
//	---
//	title: Summarize a document
//	description: A short summary with the decisions
//	---
//	Summarize {{document}} for {{audience}}. List the decisions at the end.
package prompts

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/ncecere/pi-local/internal/frontmatter"
)

// Limits.
const (
	MaxTitleChars       = 100
	MaxDescriptionChars = 300
	MaxBodyChars        = 20_000
	MaxPrompts          = 500
	// MaxImportBytes is the most an import may be (a file or a zip).
	MaxImportBytes = 8 << 20
)

// Prompt is a saved prompt.
type Prompt struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Body        string `json:"body"`
	// Placeholders are the {{names}} in the body, once each, in order.
	Placeholders []string `json:"placeholders"`
	UpdatedAt    string   `json:"updatedAt"`
}

// Input is what a person writes.
type Input struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	Body        string `json:"body"`
}

// Error is a refusal for people.
type Error struct {
	Status  int
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Message }

func bad(code, format string, args ...any) error {
	return &Error{Status: http.StatusBadRequest, Code: code, Message: fmt.Sprintf(format, args...)}
}

// ErrNotFound: no such prompt.
var ErrNotFound = &Error{Status: http.StatusNotFound, Code: "not_found", Message: "Prompt not found"}

var (
	idPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)
	// placeholder is a {{name}}: letters, digits, spaces, dashes and underscores. The UI reads them the same way.
	placeholder = regexp.MustCompile(`\{\{\s*([A-Za-z0-9_][A-Za-z0-9_ -]{0,39}?)\s*\}\}`)
)

// PlaceholdersIn lists the {{names}} in text, once each, in order.
func PlaceholdersIn(text string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, m := range placeholder.FindAllStringSubmatch(text, -1) {
		if !seen[m[1]] {
			seen[m[1]] = true
			out = append(out, m[1])
		}
	}
	return out
}

// Fill replaces each {{name}} with its value (a name without a value stays as written).
func Fill(body string, values map[string]string) string {
	return placeholder.ReplaceAllStringFunc(body, func(m string) string {
		name := placeholder.FindStringSubmatch(m)[1]
		if v, ok := values[name]; ok {
			return v
		}
		return m
	})
}

// Store is the folder of prompts.
type Store struct {
	dir string
	mu  sync.Mutex
}

// New opens (and makes) the prompts folder.
func New(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return &Store{dir: dir}, nil
}

// Dir is the folder.
func (s *Store) Dir() string { return s.dir }

func oneLine(s string) string {
	var b strings.Builder
	space := false
	for _, r := range strings.TrimSpace(s) {
		if unicode.IsControl(r) || unicode.IsSpace(r) {
			if !space {
				b.WriteByte(' ')
			}
			space = true
			continue
		}
		space = false
		b.WriteRune(r)
	}
	return b.String()
}

// clean trims and checks what a person wrote.
func (in Input) clean() (Input, error) {
	in.Title = oneLine(in.Title)
	in.Description = oneLine(in.Description)
	in.Body = strings.TrimSpace(strings.ReplaceAll(in.Body, "\r\n", "\n"))
	switch {
	case in.Title == "":
		return in, bad("invalid_prompt", "Give the prompt a title.")
	case utf8.RuneCountInString(in.Title) > MaxTitleChars:
		return in, bad("invalid_prompt", "A title is at most %d characters.", MaxTitleChars)
	case utf8.RuneCountInString(in.Description) > MaxDescriptionChars:
		return in, bad("invalid_prompt", "A description is at most %d characters.", MaxDescriptionChars)
	case in.Body == "":
		return in, bad("invalid_prompt", "A prompt needs some text.")
	case utf8.RuneCountInString(in.Body) > MaxBodyChars:
		return in, bad("invalid_prompt", "A prompt's text is at most %d characters.", MaxBodyChars)
	}
	return in, nil
}

func quote(s string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s) + `"`
}

// Marshal is a prompt's file.
func Marshal(p Prompt) []byte {
	var b bytes.Buffer
	b.WriteString("---\ntitle: " + quote(p.Title) + "\n")
	if p.Description != "" {
		b.WriteString("description: " + quote(p.Description) + "\n")
	}
	b.WriteString("---\n\n" + p.Body + "\n")
	return b.Bytes()
}

// Parse reads a prompt's file. A file without front matter is a prompt titled by `fallbackTitle` (or its first
// heading).
func Parse(raw []byte, fallbackTitle string) (Input, error) {
	if len(raw) > 4*MaxBodyChars+8192 {
		return Input{}, bad("invalid_prompt", "A prompt file is too large.")
	}
	if !utf8.Valid(raw) {
		return Input{}, bad("invalid_prompt", "That file isn't text.")
	}
	data, body := frontmatter.Parse(string(raw))
	in := Input{Title: data["title"], Description: data["description"], Body: body}
	if strings.TrimSpace(in.Title) == "" {
		in.Title = fallbackTitle
		if len(data) == 0 {
			if first, rest, ok := strings.Cut(strings.TrimLeft(body, "\n"), "\n"); ok && strings.HasPrefix(first, "# ") {
				in.Title, in.Body = strings.TrimPrefix(first, "# "), rest
			}
		}
	}
	return in, nil
}

func (s *Store) read(id string) (*Prompt, error) {
	file := filepath.Join(s.dir, id+".md")
	raw, err := os.ReadFile(file)
	if err != nil {
		return nil, ErrNotFound
	}
	in, err := Parse(raw, id)
	if err != nil {
		return nil, err
	}
	p := &Prompt{ID: id, Title: oneLine(in.Title), Description: oneLine(in.Description), Body: strings.TrimSpace(in.Body), Placeholders: PlaceholdersIn(in.Body)}
	if info, err := os.Stat(file); err == nil {
		p.UpdatedAt = info.ModTime().UTC().Format(time.RFC3339)
	}
	return p, nil
}

// List is every prompt by title. A file that can't be read is left out.
func (s *Store) List() []Prompt {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.list()
}

func (s *Store) list() []Prompt {
	out := []Prompt{}
	entries, _ := os.ReadDir(s.dir)
	for _, e := range entries {
		id, ok := strings.CutSuffix(e.Name(), ".md")
		if !ok || e.IsDir() || !idPattern.MatchString(id) {
			continue
		}
		if p, err := s.read(id); err == nil && p.Title != "" && p.Body != "" {
			out = append(out, *p)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := strings.ToLower(out[i].Title), strings.ToLower(out[j].Title)
		if a != b {
			return a < b
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// Get is one prompt.
func (s *Store) Get(id string) (*Prompt, error) {
	if !idPattern.MatchString(id) {
		return nil, ErrNotFound
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.read(id)
}

// Slug makes an ID from a title.
func Slug(title string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(title) {
		switch {
		case r >= 'a' && r <= 'z' || r >= '0' && r <= '9':
			b.WriteRune(r)
			dash = false
		case !dash && b.Len() > 0:
			b.WriteByte('-')
			dash = true
		}
	}
	id := strings.Trim(b.String(), "-")
	if len(id) > 48 {
		id = strings.Trim(id[:48], "-")
	}
	if id == "" {
		id = "prompt"
	}
	return id
}

func (s *Store) write(id string, in Input) error {
	p := Prompt{ID: id, Title: in.Title, Description: in.Description, Body: in.Body}
	file := filepath.Join(s.dir, id+".md")
	tmp := file + ".tmp"
	if err := os.WriteFile(tmp, Marshal(p), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, file)
}

func (s *Store) freeID(title string) string {
	base := Slug(title)
	id := base
	for n := 2; ; n++ {
		// "export" is a route (GET /api/prompts/export), never a prompt's ID.
		if _, err := os.Stat(filepath.Join(s.dir, id+".md")); os.IsNotExist(err) && id != "export" {
			return id
		}
		id = fmt.Sprintf("%s-%d", base, n)
	}
}

// Create saves a new prompt.
func (s *Store) Create(in Input) (*Prompt, error) {
	in, err := in.clean()
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.create(in)
}

func (s *Store) create(in Input) (*Prompt, error) {
	if len(s.list()) >= MaxPrompts {
		return nil, &Error{Status: http.StatusConflict, Code: "too_many", Message: fmt.Sprintf("The library holds at most %d prompts.", MaxPrompts)}
	}
	id := s.freeID(in.Title)
	if err := s.write(id, in); err != nil {
		return nil, err
	}
	return s.read(id)
}

// Update replaces a prompt's title, description and text (its ID stays).
func (s *Store) Update(id string, in Input) (*Prompt, error) {
	if !idPattern.MatchString(id) {
		return nil, ErrNotFound
	}
	in, err := in.clean()
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := os.Stat(filepath.Join(s.dir, id+".md")); err != nil {
		return nil, ErrNotFound
	}
	if err := s.write(id, in); err != nil {
		return nil, err
	}
	return s.read(id)
}

// Delete removes a prompt.
func (s *Store) Delete(id string) error {
	if !idPattern.MatchString(id) {
		return ErrNotFound
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.Remove(filepath.Join(s.dir, id+".md")); err != nil {
		if os.IsNotExist(err) {
			return ErrNotFound
		}
		return err
	}
	return nil
}

// Import keeps prompts from a shared file: one Markdown file, or a zip of them (an export). `name` is the file's name,
// the title of one without front matter. Each becomes a new prompt (nothing is replaced); files that aren't prompts
// are skipped, and what was skipped is counted.
func (s *Store) Import(raw []byte, name string) (imported []Prompt, skipped int, err error) {
	if len(raw) == 0 {
		return nil, 0, bad("empty_file", "The file is empty. (Send its bytes, not a Blob.)")
	}
	if len(raw) > MaxImportBytes {
		return nil, 0, bad("too_large", "An import is at most %d MB.", MaxImportBytes>>20)
	}
	type item struct {
		name string
		raw  []byte
	}
	var items []item
	if bytes.HasPrefix(raw, []byte("PK\x03\x04")) {
		zr, zerr := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
		if zerr != nil {
			return nil, 0, bad("invalid_archive", "That isn't a zip file.")
		}
		for _, f := range zr.File {
			base := path.Base(f.Name)
			if f.FileInfo().IsDir() || strings.HasPrefix(base, ".") || strings.Contains(f.Name, "__MACOSX/") || !strings.HasSuffix(strings.ToLower(base), ".md") {
				continue
			}
			if f.UncompressedSize64 > uint64(4*MaxBodyChars+8192) {
				skipped++
				continue
			}
			rc, oerr := f.Open()
			if oerr != nil {
				skipped++
				continue
			}
			b, rerr := io.ReadAll(io.LimitReader(rc, int64(4*MaxBodyChars+8192)+1))
			rc.Close()
			if rerr != nil {
				skipped++
				continue
			}
			items = append(items, item{base, b})
		}
	} else {
		items = append(items, item{path.Base(name), raw})
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, it := range items {
		title := strings.TrimSuffix(it.name, filepath.Ext(it.name))
		title = strings.TrimSpace(strings.NewReplacer("-", " ", "_", " ").Replace(title))
		in, perr := Parse(it.raw, title)
		if perr == nil {
			in, perr = in.clean()
		}
		if perr != nil {
			if len(items) == 1 {
				return nil, 0, perr
			}
			skipped++
			continue
		}
		p, cerr := s.create(in)
		if cerr != nil {
			if len(items) == 1 {
				return nil, 0, cerr
			}
			skipped++
			continue
		}
		imported = append(imported, *p)
	}
	if len(imported) == 0 {
		return nil, skipped, bad("invalid_prompt", "Nothing in that file is a prompt: it needs some text and a title.")
	}
	return imported, skipped, nil
}

// ExportZip is every prompt as a zip of Markdown files.
func (s *Store) ExportZip() ([]byte, error) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, p := range s.List() {
		w, err := zw.CreateHeader(&zip.FileHeader{Name: p.ID + ".md", Method: zip.Deflate, Modified: time.Now()})
		if err != nil {
			return nil, err
		}
		if _, err := w.Write(Marshal(p)); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
