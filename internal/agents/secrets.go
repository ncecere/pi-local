package agents

import (
	"encoding/json"
	"net/url"
	"regexp"
	"sort"
	"strings"
)

// The secret values a runtime holds: its keys and its MCP servers' env and header values (runtime/src/lib/scrub.ts is
// the other side: it hides them from what tools return; the app hides them from the runtime's logs).

// SecretMark is what a hidden secret reads, in tool output and in logs.
const SecretMark = "[redacted secret]"

const minSecretValue = 6

// secretEnv are the runtime's variables that hold a secret by name, besides any whose name says so (IsSecretKey).
var secretEnv = map[string]bool{"MODEL_API_KEY": true, "PLATFORM_KEY": true, "MODEL_USAGE_KEY": true, "MCP_KEY": true}

var (
	authScheme   = regexp.MustCompile(`(?i)^(?:bearer|basic|token)\s+(\S+)$`)
	urlWithAuth  = regexp.MustCompile(`(?i)^[a-z][a-z0-9+.-]*://[^/\s:@]+:([^@\s/]+)@`)
	urlScheme    = regexp.MustCompile(`(?i)^[a-z][a-z0-9+.-]*://`)
	flagOrNumber = regexp.MustCompile(`(?i)^(?:true|false|null|undefined|[0-9.:,_-]+)$`)
	pathStart    = regexp.MustCompile(`^(?:[/~]|\.{1,2}/|[A-Za-z]:[\\/])`)
	mediaType    = regexp.MustCompile(`(?i)^[a-z-]+/[a-z0-9.+-]+$`)
)

// secretValues are the values to hide from one setting: all of it from 6 characters, except what is plainly no
// credential (a flag, a number, a path, a URL without a password, a media type).
func secretValues(value string) []string {
	v := strings.TrimSpace(value)
	if len(v) < minSecretValue || v == "no-key" { // "no-key" stands for a keyless local server
		return nil
	}
	var out []string
	if m := authScheme.FindStringSubmatch(v); m != nil {
		out = append(out, m[1])
	}
	m := urlWithAuth.FindStringSubmatch(v)
	if m != nil {
		out = append(out, m[1])
		if dec, err := url.PathUnescape(m[1]); err == nil {
			out = append(out, dec)
		}
	}
	if m != nil || !(flagOrNumber.MatchString(v) || pathStart.MatchString(v) || urlScheme.MatchString(v) || mediaType.MatchString(v)) {
		out = append(out, v)
	}
	return out
}

// RuntimeSecrets are the secret values in a runtime's environment (its model key, its gateway key, anything named like a
// credential, and every env and header value of its MCP servers), longest first. Never log the list.
func RuntimeSecrets(env map[string]string) []string {
	seen := map[string]bool{}
	var out []string
	add := func(values []string) {
		for _, v := range values {
			if len(v) >= minSecretValue && !seen[v] {
				seen[v] = true
				out = append(out, v)
			}
		}
	}
	for name, value := range env {
		if name != "MCP_SERVERS" && name != "MODEL_HEADERS" && (secretEnv[name] || IsSecretKey(name)) {
			add(secretValues(value))
		}
	}
	// The provider's extra request headers (a JSON object) are credentials too.
	var headers map[string]string
	if json.Unmarshal([]byte(env["MODEL_HEADERS"]), &headers) == nil {
		for _, v := range headers {
			add(secretValues(v))
		}
	}
	var servers []struct {
		Env     map[string]string `json:"env"`
		Headers map[string]string `json:"headers"`
		URL     string            `json:"url"`
	}
	if json.Unmarshal([]byte(env["MCP_SERVERS"]), &servers) == nil {
		for _, s := range servers {
			for _, v := range s.Env {
				add(secretValues(v))
			}
			for _, v := range s.Headers {
				add(secretValues(v))
			}
			if u, err := url.Parse(s.URL); err == nil && u.User != nil {
				if pw, ok := u.User.Password(); ok {
					add(secretValues(pw))
				}
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return len(out[i]) > len(out[j]) })
	return out
}

// LogRedactor makes the function that cleans a runtime's log lines: its own secret values by value, then anything that
// looks like a credential (RedactText).
func LogRedactor(env map[string]string) func(string) string {
	exact := RuntimeSecrets(env)
	return func(line string) string {
		for _, v := range exact {
			if strings.Contains(line, v) {
				line = strings.ReplaceAll(line, v, SecretMark)
			}
		}
		return RedactText(line)
	}
}
