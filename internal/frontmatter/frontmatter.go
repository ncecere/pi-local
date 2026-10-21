// Package frontmatter reads the YAML-ish header of a Markdown file (skills' SKILL.md, library prompts) without a YAML
// library: the same reading as the runtime's parseFrontMatter (runtime/src/lib/skills.ts), so the app and the agent
// agree on what a skill says.
package frontmatter

import (
	"regexp"
	"strings"
)

// Parse returns the front matter of a Markdown file as a map, and the rest of the file. It reads `key: value` lines,
// plain or quoted or as a `>` or `|` block, a value continuing on indented lines; anything else (nested settings) is
// ignored. Without front matter there is no data.
func Parse(raw string) (data map[string]string, body string) {
	src := strings.TrimPrefix(raw, "\uFEFF")
	src = strings.ReplaceAll(strings.ReplaceAll(src, "\r\n", "\n"), "\r", "\n")
	data = map[string]string{}
	if !strings.HasPrefix(src, "---\n") {
		return data, src
	}
	end := delimiter.FindStringIndex(src[4:])
	if end == nil {
		return data, src
	}
	head := src[4 : 4+end[0]]
	body = src[4+end[1]:]
	var key, style string
	var parts []string
	finish := func() {
		if key == "" {
			return
		}
		sep := " "
		if strings.HasPrefix(style, "|") {
			sep = "\n"
		}
		value := strings.TrimSpace(strings.Join(parts, sep))
		if len(value) >= 2 {
			switch {
			case value[0] == '"' && value[len(value)-1] == '"':
				value = strings.NewReplacer(`\"`, `"`, `\\`, `\`).Replace(value[1 : len(value)-1])
			case value[0] == '\'' && value[len(value)-1] == '\'':
				value = strings.ReplaceAll(value[1:len(value)-1], "''", "'")
			}
		}
		data[key] = value
		key = ""
	}
	for _, line := range strings.Split(head, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "#") {
			continue
		}
		if m := keyLine.FindStringSubmatch(line); m != nil {
			finish()
			key = m[1]
			rest := strings.TrimSpace(m[2])
			if blockStyle.MatchString(rest) {
				style, parts = rest, nil
			} else {
				style, parts = "", nil
				if m[2] != "" {
					parts = []string{m[2]}
				}
			}
		} else if key != "" && strings.TrimSpace(line) != "" && (strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t")) {
			parts = append(parts, strings.TrimSpace(line))
		}
	}
	finish()
	return data, body
}

var (
	delimiter  = regexp.MustCompile(`(?m)^---[ \t]*(?:\n|$)`)
	keyLine    = regexp.MustCompile(`^([A-Za-z0-9_-]+):[ \t]*(.*)$`)
	blockStyle = regexp.MustCompile(`^[>|][+-]?$`)
)
