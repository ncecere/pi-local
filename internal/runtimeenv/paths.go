package runtimeenv

import (
	"path"
	"strings"
)

func pathSeparator(goos string) string {
	if goos == "windows" {
		return ";"
	}
	return ":"
}

// splitPath mirrors Windows PATH quoting without consulting PATHEXT or the cwd.
func splitPath(goos, value string) []string {
	if goos != "windows" {
		return strings.Split(value, ":")
	}
	var entries []string
	var entry strings.Builder
	quoted := false
	for _, r := range value {
		switch {
		case r == '"':
			quoted = !quoted
		case r == ';' && !quoted:
			entries = append(entries, entry.String())
			entry.Reset()
		default:
			entry.WriteRune(r)
		}
	}
	return append(entries, entry.String())
}

// Windows rooted (\tools) and drive-relative (C:tools) paths depend on a cwd,
// so only drive-absolute paths and ordinary UNC shares qualify. Device namespace
// paths are deliberately unsupported rather than inferred as package layouts.
func absolutePath(goos, value string) bool {
	if goos != "windows" {
		return strings.HasPrefix(value, "/")
	}
	p := strings.ReplaceAll(value, "/", `\`)
	if len(p) >= 3 && ((p[0] >= 'A' && p[0] <= 'Z') || (p[0] >= 'a' && p[0] <= 'z')) && p[1] == ':' && p[2] == '\\' {
		return true
	}
	if strings.HasPrefix(p, `\\`) {
		parts := strings.Split(p[2:], `\`)
		return len(parts) >= 2 && parts[0] != "" && parts[0] != "." && parts[0] != "?" && parts[1] != ""
	}
	return false
}

func pathKey(goos, value string) string {
	if goos == "windows" {
		return strings.ToLower(path.Clean(strings.ReplaceAll(value, `\`, "/")))
	}
	// Keep Unix spelling semantics: cleaning through symlink/.. can conflate
	// different directories, and existing macOS PATH precedence is exact.
	return value
}

// mergePathsForOS preserves the first spelling/order, excluding empty/relative
// entries: a GUI workspace must never become an implicit executable search dir.
func mergePathsForOS(goos, a, b string) string {
	seen := map[string]bool{}
	var out []string
	for _, p := range append(splitPath(goos, a), splitPath(goos, b)...) {
		key := pathKey(goos, p)
		if absolutePath(goos, p) && !seen[key] {
			seen[key] = true
			// Re-quote Windows entries containing semicolons for round-tripping.
			if goos == "windows" && strings.Contains(p, ";") {
				p = `"` + p + `"`
			}
			out = append(out, p)
		}
	}
	return strings.Join(out, pathSeparator(goos))
}

func nodeExecutableName(goos, file string) bool {
	return goos != "windows" || strings.EqualFold(path.Ext(strings.ReplaceAll(file, `\`, "/")), ".exe")
}

func nodeCandidates(goos, explicit, bundled, searchPath string) []string {
	var out []string
	if explicit != "" {
		out = append(out, explicit)
	}
	if bundled != "" {
		out = append(out, bundled)
	}
	for _, dir := range splitPath(goos, mergePathsForOS(goos, searchPath, "")) {
		if !absolutePath(goos, dir) {
			continue
		}
		if goos == "windows" {
			out = append(out, strings.TrimRight(dir, `/\`)+`\node.exe`)
		} else {
			out = append(out, path.Join(dir, "node"))
		}
	}
	return out
}
