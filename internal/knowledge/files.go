package knowledge

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// openLocalFile confines every actual read to the folder, not just the earlier directory walk. os.Root also
// protects against an ancestor being replaced by a symlink between the walk and the read. Never open devices,
// sockets, or final symlinks. The selected folder itself must not be a symlink either.
func openLocalFile(folder, rel string) (*os.File, error) {
	info, err := os.Lstat(folder)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, errors.New("not a document folder")
	}
	root, err := os.OpenRoot(folder)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	info, err = root.Lstat(rel)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("not a regular document file")
	}
	f, err := root.Open(rel)
	if err != nil {
		return nil, err
	}
	info, err = f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		f.Close()
		return nil, errors.New("not a regular document file")
	}
	return f, nil
}

func readLocalFile(folder, rel string) ([]byte, error) {
	f, err := openLocalFile(folder, filepath.FromSlash(rel))
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, MaxFileBytes+1))
	if len(data) > MaxFileBytes {
		return nil, errors.New("larger than 50 MB: not read")
	}
	return data, err
}

func relativeFile(folder, path string) (string, bool) {
	rel, err := filepath.Rel(folder, path)
	return rel, err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

// OpenIndexed opens a citation for streaming through the API, using the same confined reads as indexing. It is
// checked against this agent's current folder list and index, even between filesystem rescans.
func (s *Service) OpenIndexed(ctx context.Context, folders []string, path string) (*os.File, error) {
	folder, ok := s.Indexed(ctx, folders, path)
	if !ok {
		return nil, os.ErrNotExist
	}
	rel, _ := relativeFile(folder, path)
	return openLocalFile(folder, rel)
}
