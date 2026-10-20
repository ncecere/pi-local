package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Found is a server another app's config describes.
type Found struct {
	Name      string   `json:"name"`
	Transport string   `json:"transport"`
	Command   string   `json:"command,omitempty"`
	Args      []string `json:"args,omitempty"`
	URL       string   `json:"url,omitempty"`
	EnvNames  []string `json:"envNames"`
	Exists    bool     `json:"exists"`
	// Unsupported says why it can't be imported (legacy HTTP+SSE).
	Unsupported string `json:"unsupported,omitempty"`

	env, headers map[string]string
}

// Source is one app's config.
type Source struct {
	ID      string  `json:"id"`
	Path    string  `json:"path"`
	Servers []Found `json:"servers"`
}

// SourcePaths are where other apps keep their MCP servers, by source (a variable so tests can point elsewhere).
var SourcePaths = func() map[string][]string {
	home, _ := os.UserHomeDir()
	config, _ := os.UserConfigDir()
	return map[string][]string{
		"claude": {filepath.Join(config, "Claude", "claude_desktop_config.json")},
		"cursor": {filepath.Join(home, ".cursor", "mcp.json")},
		"vscode": {filepath.Join(config, "Code", "User", "mcp.json"), filepath.Join(config, "Code", "User", "settings.json")},
	}
}

// stripJSONC removes // and /* */ comments and trailing commas (VS Code's settings are JSON with comments).
func stripJSONC(in []byte) []byte {
	var out bytes.Buffer
	inString, escaped := false, false
	for i := 0; i < len(in); i++ {
		ch := in[i]
		if inString {
			out.WriteByte(ch)
			switch {
			case escaped:
				escaped = false
			case ch == '\\':
				escaped = true
			case ch == '"':
				inString = false
			}
			continue
		}
		if ch == '"' {
			inString = true
			out.WriteByte(ch)
			continue
		}
		if ch == '/' && i+1 < len(in) && in[i+1] == '/' {
			for i < len(in) && in[i] != '\n' {
				i++
			}
			out.WriteByte('\n')
			continue
		}
		if ch == '/' && i+1 < len(in) && in[i+1] == '*' {
			i += 2
			for i+1 < len(in) && !(in[i] == '*' && in[i+1] == '/') {
				i++
			}
			i++
			continue
		}
		out.WriteByte(ch)
	}
	// Trailing commas before } or ].
	b := out.Bytes()
	var clean bytes.Buffer
	for i := 0; i < len(b); i++ {
		if b[i] == ',' {
			j := i + 1
			for j < len(b) && (b[j] == ' ' || b[j] == '\n' || b[j] == '\r' || b[j] == '\t') {
				j++
			}
			if j < len(b) && (b[j] == '}' || b[j] == ']') {
				continue
			}
		}
		clean.WriteByte(b[i])
	}
	return clean.Bytes()
}

type rawServer struct {
	Type    string            `json:"type"`
	Command string            `json:"command"`
	Args    []string          `json:"args"`
	Env     map[string]string `json:"env"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers"`
}

func parseServers(path string) map[string]rawServer {
	raw, err := os.ReadFile(path)
	if err != nil || len(raw) > 4<<20 {
		return nil
	}
	var doc struct {
		MCPServers map[string]rawServer `json:"mcpServers"`
		Servers    map[string]rawServer `json:"servers"`
		MCP        *struct {
			Servers map[string]rawServer `json:"servers"`
		} `json:"mcp"`
	}
	if json.Unmarshal(stripJSONC(raw), &doc) != nil {
		return nil
	}
	out := map[string]rawServer{}
	for _, m := range []map[string]rawServer{doc.MCPServers, doc.Servers} {
		for k, v := range m {
			out[k] = v
		}
	}
	if doc.MCP != nil {
		for k, v := range doc.MCP.Servers {
			out[k] = v
		}
	}
	return out
}

func (c *Catalog) found(name string, r rawServer) Found {
	f := Found{Name: name, EnvNames: names(r.Env), env: r.Env, headers: r.Headers}
	switch {
	case r.Command != "":
		f.Transport, f.Command, f.Args = "stdio", r.Command, r.Args
	case r.URL != "":
		f.Transport, f.URL = "http", r.URL
		if r.Type == "sse" || strings.HasSuffix(strings.TrimRight(r.URL, "/"), "/sse") {
			f.Unsupported = "it uses the old HTTP+SSE transport, which Pi Local doesn't support"
		}
		f.EnvNames = names(r.Headers)
	default:
		f.Unsupported = "it has neither a command nor a URL"
	}
	f.Exists = c.Exists(Slug(name))
	return f
}

// Sources lists the servers other apps' configs describe (sources with none are left out).
func (c *Catalog) Sources() []Source {
	var out []Source
	paths := SourcePaths()
	for _, id := range []string{"claude", "cursor", "vscode"} {
		for _, path := range paths[id] {
			servers := parseServers(path)
			if len(servers) == 0 {
				continue
			}
			src := Source{ID: id, Path: path}
			for _, name := range names(servers) {
				src.Servers = append(src.Servers, c.found(name, servers[name]))
			}
			out = append(out, src)
		}
	}
	if out == nil {
		out = []Source{}
	}
	return out
}

// Skipped is a server not imported, and why.
type Skipped struct {
	Name   string `json:"name"`
	Reason string `json:"reason"`
}

// Import adds the named servers of a source (each tested).
func (c *Catalog) Import(ctx context.Context, sourceID string, wanted []string) ([]*Server, []Skipped, error) {
	var src *Source
	for _, s := range c.Sources() {
		if s.ID == sourceID {
			s := s
			if src == nil {
				src = &s
			} else {
				src.Servers = append(src.Servers, s.Servers...)
			}
		}
	}
	if src == nil {
		return nil, nil, bad("invalid_source", "No MCP servers were found for %s.", sourceID)
	}
	want := map[string]bool{}
	for _, n := range wanted {
		want[n] = true
	}
	added := []*Server{}
	skipped := []Skipped{}
	for _, f := range src.Servers {
		if !want[f.Name] {
			continue
		}
		if f.Unsupported != "" {
			skipped = append(skipped, Skipped{f.Name, f.Unsupported})
			continue
		}
		if f.Exists {
			skipped = append(skipped, Skipped{f.Name, "a server with that name is already here"})
			continue
		}
		name := f.Name
		in := Input{Name: &name, Transport: &f.Transport}
		if f.Transport == "stdio" {
			in.Command, in.Args = &f.Command, &f.Args
			if len(f.env) > 0 {
				env := f.env
				in.Env = &env
			}
		} else {
			in.URL = &f.URL
			if len(f.headers) > 0 {
				h := f.headers
				in.Headers = &h
			}
		}
		s, err := c.Create(ctx, in, sourceID)
		if err != nil {
			skipped = append(skipped, Skipped{f.Name, err.Error()})
			continue
		}
		added = append(added, s)
	}
	sort.Slice(added, func(i, j int) bool { return added[i].Name < added[j].Name })
	return added, skipped, nil
}
