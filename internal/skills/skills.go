// Package skills keeps agent skills: folders with a SKILL.md (pi's format: front matter with a name and a description,
// then instructions) and whatever files it points to. A skill is shared (<data>/skills/<name>/, an agent picks the ones
// it uses in agent.yaml) or an agent's own (<agent folder>/skills/<name>/, always on). The runtime lists the enabled
// ones in the agent's prompt and reads one when asked (runtime/src/lib/skills.ts); this package is the app's side:
// listing, checking, adding from a zip, viewing and removing them. A Store is one folder of skills.
package skills

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/ncecere/pi-local/internal/frontmatter"
)

// Limits on what a skill may hold.
const (
	MaxNameChars        = 64
	MaxDescriptionChars = 1024
	MaxFiles            = 300
	MaxFileBytes        = 5 << 20
	MaxTotalBytes       = 20 << 20
	// MaxViewBytes is the most of a file the app shows.
	MaxViewBytes = 256 << 10
	// MaxZipBytes is the most a zip upload may be.
	MaxZipBytes = 25 << 20
	// File is the skill's instructions.
	File = "SKILL.md"
)

var namePattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

// ValidName says whether name is a skill name: lowercase letters, digits and single dashes, at most 64 characters.
func ValidName(name string) bool {
	return len(name) <= MaxNameChars && namePattern.MatchString(name)
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

// ErrNotFound: no such skill.
var ErrNotFound = &Error{Status: http.StatusNotFound, Code: "not_found", Message: "Skill not found"}

// ErrExists: a skill of that name is already there.
var ErrExists = &Error{Status: http.StatusConflict, Code: "exists", Message: "A skill with that name is already there."}

// FileInfo is one file in a skill's folder.
type FileInfo struct {
	Path string `json:"path"`
	Size int64  `json:"size"`
}

// Skill is a skill as lists show it.
type Skill struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	// Problem says why the runtime won't use it (a folder someone made by hand without a description); empty when fine.
	Problem string `json:"problem,omitempty"`
	Files   int    `json:"fileCount"`
	Bytes   int64  `json:"bytes"`
}

// Detail is a skill with its instructions and files, for viewing.
type Detail struct {
	Skill
	// Body is SKILL.md without its front matter.
	Body string `json:"body"`
	// Folder is where the skill is on this computer.
	Folder string     `json:"folder"`
	Items  []FileInfo `json:"files"`
}

// Store is one folder of skills (the shared ones, or an agent's own).
type Store struct {
	Root string
}

// New is the store of the skill folders in root (made when the first skill is added).
func New(root string) *Store { return &Store{Root: root} }

// check reads SKILL.md's text and says what is wrong with it for use, or returns its name and description.
func check(raw string) (name, description, body string, err error) {
	data, body := frontmatter.Parse(raw)
	name, description = strings.TrimSpace(data["name"]), strings.TrimSpace(data["description"])
	switch {
	case len(data) == 0:
		return "", "", body, bad("invalid_skill", "SKILL.md needs front matter: a --- block with a name and a description at the top.")
	case name == "":
		return "", "", body, bad("invalid_skill", "SKILL.md's front matter needs a name.")
	case !ValidName(name):
		return "", "", body, bad("invalid_skill", "A skill's name is lowercase letters, digits and dashes (up to %d characters), like release-notes.", MaxNameChars)
	case description == "":
		return "", "", body, bad("invalid_skill", "SKILL.md's front matter needs a description: it tells the agent when to use the skill.")
	case utf8.RuneCountInString(description) > MaxDescriptionChars:
		return "", "", body, bad("invalid_skill", "A skill's description is at most %d characters.", MaxDescriptionChars)
	}
	return name, description, body, nil
}

// List is the skills in the folder, by name. A folder without a usable SKILL.md is listed with its problem.
func (s *Store) List() []Skill {
	entries, err := os.ReadDir(s.Root)
	out := []Skill{}
	if err != nil {
		return out
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".") || !ValidName(e.Name()) {
			continue
		}
		if info, err := os.Lstat(filepath.Join(s.Root, e.Name())); err != nil || !info.IsDir() {
			continue
		}
		out = append(out, s.summary(e.Name()))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// Names is the names of the skills the runtime can use.
func (s *Store) Names() []string {
	var out []string
	for _, sk := range s.List() {
		if sk.Problem == "" {
			out = append(out, sk.Name)
		}
	}
	return out
}

// Has says whether the folder holds a skill the runtime can use.
func (s *Store) Has(name string) bool {
	if !ValidName(name) {
		return false
	}
	sk := s.summary(name)
	return sk.Problem == ""
}

func (s *Store) summary(name string) Skill {
	dir := filepath.Join(s.Root, name)
	sk := Skill{Name: name}
	raw, truncated, err := s.ReadFile(name, File)
	if err != nil || truncated {
		sk.Problem = "It needs a readable SKILL.md inside its folder (at most 256 KB)."
	} else if declared, description, _, err := check(raw); err != nil || declared != name {
		if err != nil {
			sk.Problem = err.Error()
		} else {
			sk.Problem = "SKILL.md's name must match its folder."
		}
		data, _ := frontmatter.Parse(raw)
		sk.Description = strings.TrimSpace(data["description"])
	} else {
		sk.Description = description
	}
	files, bytes := walk(dir)
	sk.Files, sk.Bytes = len(files), bytes
	return sk
}

// walk lists the regular files of a skill's folder (relative, slash-separated, hidden ones left out).
func walk(dir string) ([]FileInfo, int64) {
	var files []FileInfo
	var total int64
	filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(dir, p)
		if rel == "." {
			return nil
		}
		if strings.HasPrefix(d.Name(), ".") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Type().IsRegular() {
			if info, err := d.Info(); err == nil {
				files = append(files, FileInfo{Path: filepath.ToSlash(rel), Size: info.Size()})
				total += info.Size()
			}
		}
		return nil
	})
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	return files, total
}

// Get is one skill with its instructions and its files.
func (s *Store) Get(name string) (*Detail, error) {
	if !ValidName(name) {
		return nil, ErrNotFound
	}
	dir := filepath.Join(s.Root, name)
	if info, err := os.Lstat(dir); err != nil || !info.IsDir() {
		return nil, ErrNotFound
	}
	d := &Detail{Skill: s.summary(name), Folder: dir}
	if raw, _, err := s.ReadFile(name, File); err == nil {
		_, d.Body = frontmatter.Parse(raw)
	}
	d.Items, _ = walk(dir)
	if d.Items == nil {
		d.Items = []FileInfo{}
	}
	return d, nil
}

// ReadFile is a text file of a skill, by its path in the folder: at most MaxViewBytes of it, and whether it was cut.
// Only files inside the skill's folder are read, symbolic links followed.
func (s *Store) ReadFile(name, rel string) (content string, truncated bool, err error) {
	if !ValidName(name) {
		return "", false, ErrNotFound
	}
	if rel == "" || strings.ContainsRune(rel, 0) || path.IsAbs(rel) || strings.HasPrefix(rel, "/") {
		return "", false, bad("invalid_path", "Give a file's path inside the skill.")
	}
	if strings.Contains(rel, "\\") || slicesContainParent(rel) {
		return "", false, bad("invalid_path", "That file is outside the skill.")
	}
	dir := filepath.Join(s.Root, name)
	if info, err := os.Lstat(dir); err != nil || !info.IsDir() {
		return "", false, ErrNotFound
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return "", false, ErrNotFound
	}
	defer root.Close()
	f, err := root.Open(filepath.FromSlash(rel))
	if errors.Is(err, os.ErrInvalid) || (err != nil && strings.Contains(err.Error(), "escapes")) {
		return "", false, bad("invalid_path", "That file is outside the skill.")
	}
	if err != nil {
		return "", false, &Error{Status: http.StatusNotFound, Code: "not_found", Message: "File not found"}
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return "", false, &Error{Status: http.StatusNotFound, Code: "not_found", Message: "File not found"}
	}
	data, err := io.ReadAll(io.LimitReader(f, MaxViewBytes+1))
	if err != nil {
		return "", false, err
	}
	if truncated = len(data) > MaxViewBytes; truncated {
		data = data[:MaxViewBytes]
	}
	if bytes.IndexByte(data[:min(len(data), 8192)], 0) >= 0 {
		return "", false, bad("binary_file", "That file isn't text.")
	}
	return strings.ToValidUTF8(string(data), "\uFFFD"), truncated, nil
}

// Delete removes a skill's folder.
func (s *Store) Delete(name string) error {
	if !ValidName(name) {
		return ErrNotFound
	}
	dir := filepath.Join(s.Root, name)
	if info, err := os.Lstat(dir); err != nil || !info.IsDir() {
		return ErrNotFound
	}
	return os.RemoveAll(dir)
}

// entry is a file of an archive about to be written.
type entry struct {
	rel  string
	file *zip.File
}

// AddZip adds the skill in a zip: SKILL.md at its top, or inside the one folder that holds everything. The skill is
// named by its front matter. A name already taken is refused unless replace is set. Nothing is written until the whole
// archive has been checked, and only regular files and folders are ever made (a link or a path that climbs out of the
// folder refuses the archive).
func (s *Store) AddZip(data []byte, replace bool) (*Skill, error) {
	if len(data) > MaxZipBytes {
		return nil, bad("too_large", "A skill's zip is at most 25 MB.")
	}
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, bad("invalid_archive", "That isn't a zip file.")
	}
	if len(zr.File) > 1000 {
		return nil, bad("too_large", "A skill's zip has at most 1000 entries, including folders.")
	}
	var entries []entry
	seen := map[string]bool{}
	for _, f := range zr.File {
		name := f.Name
		if strings.ContainsAny(name, "\\\x00:") || strings.HasPrefix(name, "/") || slicesContainParent(name) {
			return nil, bad("invalid_archive", "The zip has a file name that isn't allowed (%q).", name)
		}
		clean := path.Clean(strings.TrimSuffix(name, "/"))
		if clean == "." {
			continue
		}
		if clean == ".." || strings.HasPrefix(clean, "../") {
			return nil, bad("invalid_archive", "The zip has a file outside its folder (%q).", name)
		}
		if !f.Mode().IsRegular() && !f.Mode().IsDir() {
			return nil, bad("invalid_archive", "The zip has a link (%s); skills can only hold plain files.", clean)
		}
		if hidden(clean) {
			continue // __MACOSX, .DS_Store, .git and other hidden files aren't part of a skill
		}
		if f.FileInfo().IsDir() {
			continue
		}
		key := strings.ToLower(clean)
		if seen[key] {
			return nil, bad("invalid_archive", "The zip repeats a file name (%s).", clean)
		}
		seen[key] = true
		entries = append(entries, entry{rel: clean, file: f})
	}
	// Where SKILL.md is: the top, or the single folder everything is in.
	prefix, found := "", false
	for _, e := range entries {
		if e.rel == File {
			found = true
		}
	}
	if !found {
		tops := map[string]bool{}
		for _, e := range entries {
			if top, _, nested := strings.Cut(e.rel, "/"); nested {
				tops[top] = true
			} else {
				tops[""] = true
			}
		}
		var withSkill []string
		for _, e := range entries {
			if top, rest, nested := strings.Cut(e.rel, "/"); nested && rest == File {
				withSkill = append(withSkill, top)
			}
		}
		switch {
		case len(withSkill) > 1:
			return nil, bad("invalid_archive", "The zip holds %d skills. Add them one at a time.", len(withSkill))
		case len(withSkill) == 1 && len(tops) == 1:
			prefix, found = withSkill[0]+"/", true
		case len(withSkill) == 1:
			return nil, bad("invalid_archive", "Put the skill's files in one folder with SKILL.md at its top, with nothing beside that folder.")
		}
	}
	if !found {
		return nil, bad("invalid_archive", "The zip has no SKILL.md at its top (or in the one folder that holds it).")
	}
	var files []entry
	var total uint64
	for _, e := range entries {
		rel, inside := strings.CutPrefix(e.rel, prefix)
		if !inside {
			continue
		}
		if e.file.UncompressedSize64 > MaxFileBytes {
			return nil, bad("too_large", "%s is larger than %d MB.", rel, MaxFileBytes>>20)
		}
		total += e.file.UncompressedSize64
		files = append(files, entry{rel: rel, file: e.file})
	}
	if len(files) > MaxFiles {
		return nil, bad("too_large", "A skill has at most %d files.", MaxFiles)
	}
	if total > MaxTotalBytes {
		return nil, bad("too_large", "A skill is at most %d MB in all.", MaxTotalBytes>>20)
	}
	var skillMD []byte
	var actual int
	contents := make(map[string][]byte, len(files))
	for _, e := range files {
		rc, err := e.file.Open()
		if err != nil {
			return nil, bad("invalid_archive", "The zip is damaged.")
		}
		b, err := io.ReadAll(io.LimitReader(rc, MaxFileBytes+1))
		rc.Close()
		if err != nil || len(b) > MaxFileBytes {
			return nil, bad("invalid_archive", "The zip is damaged, or %s is too large.", e.rel)
		}
		actual += len(b)
		if actual > MaxTotalBytes {
			return nil, bad("too_large", "A skill is at most 20 MB in all.")
		}
		contents[e.rel] = b
		if e.rel == File {
			skillMD = b
		}
	}
	if len(skillMD) > MaxViewBytes {
		return nil, bad("too_large", "SKILL.md is at most 256 KB.")
	}
	name, description, _, err := check(string(skillMD))
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(s.Root, 0o700); err != nil {
		return nil, err
	}
	final := filepath.Join(s.Root, name)
	if _, err := os.Lstat(final); err == nil && !replace {
		return nil, &Error{Status: http.StatusConflict, Code: "exists", Message: fmt.Sprintf("There is already a skill called %s.", name)}
	}
	stage, err := os.MkdirTemp(s.Root, ".incoming-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(stage)
	for _, e := range files {
		dest := filepath.Join(stage, filepath.FromSlash(e.rel))
		if err := os.MkdirAll(filepath.Dir(dest), 0o700); err != nil {
			return nil, err
		}
		mode := os.FileMode(0o600)
		if e.file.Mode()&0o111 != 0 {
			mode = 0o700
		}
		if err := os.WriteFile(dest, contents[e.rel], mode); err != nil {
			return nil, err
		}
	}
	if _, err := os.Lstat(final); err == nil {
		old := stage + ".old"
		if err := os.Rename(final, old); err != nil {
			return nil, err
		}
		defer os.RemoveAll(old)
	}
	if err := os.Rename(stage, final); err != nil {
		return nil, err
	}
	n, size := walk(final)
	return &Skill{Name: name, Description: description, Files: len(n), Bytes: size}, nil
}

func slicesContainParent(p string) bool {
	for _, segment := range strings.Split(p, "/") {
		if segment == ".." {
			return true
		}
	}
	return false
}

// hidden says whether a path has a hidden or macOS-metadata segment.
func hidden(clean string) bool {
	for _, seg := range strings.Split(clean, "/") {
		if strings.HasPrefix(seg, ".") || seg == "__MACOSX" {
			return true
		}
	}
	return false
}

// IsNotFound says whether err is ErrNotFound.
func IsNotFound(err error) bool {
	var e *Error
	return errors.As(err, &e) && e.Code == "not_found"
}
