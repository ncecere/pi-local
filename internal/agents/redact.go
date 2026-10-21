package agents

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

// Redaction: what must not leave the app in a view of a tool call, a log or a settings dump. This is the Go side of
// runtime/src/lib/redact.ts, and the two must agree (the runtime is not trusted to redact, so the app applies the
// rules again; diagnostics apply them to logs and settings).
//
//   - A value is redacted when its key clearly names a credential (IsSecretKey) or when it looks like one
//     (IsSecretValue); it then reads `[redacted, N characters]`.
//   - Strings are cut at 2,000 characters, arrays at 100 items, objects at 100 keys, nesting at 6 levels.

const (
	maxRedactString = 2000
	maxRedactItems  = 100
	maxRedactDepth  = 6
)

// Key names (lower case, letters and digits only) that name a credential, whole or as their end.
var secretExact = map[string]bool{"authorization": true, "proxyauthorization": true, "cookie": true, "setcookie": true,
	"credentials": true, "credential": true, "bearer": true, "sessionid": true, "xapikey": true}

var secretSuffix = []string{"password", "passwd", "passphrase", "secret", "apikey", "secretkey", "privatekey", "secretaccesskey", "token"}

// Names ending in "token" that are not credentials (pagination).
var notSecret = map[string]bool{"pagetoken": true, "nextpagetoken": true, "prevpagetoken": true, "previouspagetoken": true,
	"continuationtoken": true, "synctoken": true, "nexttoken": true, "cursortoken": true}

var (
	secretPrefix = regexp.MustCompile(`^(?:pdp[a-z]{0,3}[_.]|sk-|sk_(?:live|test)_|rk_(?:live|test)_|gh[pousr]_|github_pat_|glpat-|xox[abeprs]-|AKIA|ASIA|AIza|hf_|npm_)[A-Za-z0-9_.-]{16,}$`)
	authValue    = regexp.MustCompile(`(?i)^(?:bearer|basic|token)\s+\S{8,}$`)
	jwtValue     = regexp.MustCompile(`^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*$`)
	randomValue  = regexp.MustCompile(`^[A-Za-z0-9+/=_-]{32,512}$`)
	redactedMark = regexp.MustCompile(`^\[redacted(?:, [0-9]{1,9} characters?)?\]$`)
	nonAlnum     = regexp.MustCompile(`[^a-z0-9]`)
)

// IsSecretKey reports whether a key names a credential: Authorization, api_key, clientSecret, refresh-token, password.
func IsSecretKey(key string) bool {
	k := nonAlnum.ReplaceAllString(strings.ToLower(key), "")
	if secretExact[k] {
		return true
	}
	if notSecret[k] {
		return false
	}
	for _, s := range secretSuffix {
		if strings.HasSuffix(k, s) {
			return true
		}
	}
	return false
}

// IsSecretValue reports whether a string looks like a credential: known token prefixes, an Authorization header's
// value, a JWT, a PEM private key, or a long random-looking string (32-512 characters of base64 or base64url with
// upper and lower case letters and digits, and at least 4 bits of entropy per character). Conservative: identifiers,
// paths, one-case hashes, UUIDs and prose are not.
func IsSecretValue(value string) bool {
	v := strings.TrimSpace(value)
	if secretPrefix.MatchString(v) || authValue.MatchString(v) || jwtValue.MatchString(v) {
		return true
	}
	if strings.Contains(v, "-----BEGIN") && strings.Contains(v, "PRIVATE KEY") {
		return true
	}
	return looksRandom(v)
}

func looksRandom(v string) bool {
	if !randomValue.MatchString(v) {
		return false
	}
	var upper, lower, digit bool
	for _, c := range v {
		switch {
		case c >= 'A' && c <= 'Z':
			upper = true
		case c >= 'a' && c <= 'z':
			lower = true
		case c >= '0' && c <= '9':
			digit = true
		}
	}
	return upper && lower && digit && entropy(v) >= 4
}

// entropy is a string's Shannon entropy in bits per character.
func entropy(s string) float64 {
	counts := map[rune]int{}
	n := 0
	for _, c := range s {
		counts[c]++
		n++
	}
	h := 0.0
	for _, c := range counts {
		p := float64(c) / float64(n)
		h -= p * math.Log2(p)
	}
	return h
}

// RedactedMark is what a redacted value reads: its length in characters (a string's, or its JSON's), never any of it.
func RedactedMark(value any) string {
	if s, ok := value.(string); ok && redactedMark.MatchString(s) {
		return s
	}
	var n int
	if s, ok := value.(string); ok {
		n = utf8.RuneCountInString(s)
	} else {
		raw, _ := json.Marshal(value)
		n = utf8.RuneCount(raw)
	}
	if n == 1 {
		return "[redacted, 1 character]"
	}
	return fmt.Sprintf("[redacted, %d characters]", n)
}

// RedactValue is a bounded, redacted copy of a decoded JSON value (maps, slices, strings, numbers, booleans, nil).
func RedactValue(value any) any { return redactValue(value, 0) }

func redactValue(value any, depth int) any {
	switch v := value.(type) {
	case nil, bool:
		return v
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return nil
		}
		return v
	case int, int64, uint64, float32:
		return v
	case string:
		if IsSecretValue(v) {
			return RedactedMark(v)
		}
		if r := []rune(v); len(r) > maxRedactString {
			return string(r[:maxRedactString]) + "…"
		}
		return v
	}
	if depth >= maxRedactDepth {
		return "[…]"
	}
	switch v := value.(type) {
	case []any:
		out := make([]any, 0, min(len(v), maxRedactItems)+1)
		for _, item := range v[:min(len(v), maxRedactItems)] {
			out = append(out, redactValue(item, depth+1))
		}
		if len(v) > maxRedactItems {
			out = append(out, fmt.Sprintf("[… %d more]", len(v)-maxRedactItems))
		}
		return out
	case map[string]any:
		keys := sortedKeys(v)
		out := map[string]any{}
		for _, key := range keys[:min(len(keys), maxRedactItems)] {
			name := key
			if r := []rune(key); len(r) > 200 {
				name = string(r[:200]) + "…"
			}
			if IsSecretKey(key) {
				out[name] = RedactedMark(v[key])
			} else {
				out[name] = redactValue(v[key], depth+1)
			}
		}
		if len(keys) > maxRedactItems {
			out["[…]"] = fmt.Sprintf("%d more keys", len(keys)-maxRedactItems)
		}
		return out
	}
	// Anything else (a typed struct): through its JSON.
	raw, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	var decoded any
	if json.Unmarshal(raw, &decoded) != nil {
		return nil
	}
	return redactValue(decoded, depth)
}

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// Free text (a log, an agent.yaml): the same rules, applied to what is found in it.
var (
	pemBlock     = regexp.MustCompile(`(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)`)
	headerLine   = regexp.MustCompile(`(?im)\b(authorization|proxy-authorization|cookie|set-cookie)(["']?[ \t]*[:=][ \t]*["']?)([^\r\n"']+)`)
	bearerText   = regexp.MustCompile(`(?i)\b(bearer|basic)[ \t]+[^\s"',;]{8,}`)
	assignment   = regexp.MustCompile(`([A-Za-z0-9_.-]+)(["']?[ \t]*[:=][ \t]*)("[^"\r\n]*"|'[^'\r\n]*'|\[redacted[^\]\r\n]*\]|[^\s,;&"'\]})]+)`)
	urlUserinfo  = regexp.MustCompile(`(://[^/\s:@]+:)([^@\s/]+)(@)`)
	textToken    = regexp.MustCompile(`[^\s"'` + "`" + `<>()\[\]{},;|]+`)
	pathLikeText = regexp.MustCompile(`/.*/`)
)

// RedactText redacts the credentials in free text: PEM private keys, Authorization and Cookie header lines, bearer
// tokens, `name: value` and `name=value` where the name is a credential's (including in URLs and JSON), passwords
// in URLs, and any word that looks like a credential (IsSecretValue). A long path is never mistaken for a random
// string.
func RedactText(text string) string {
	text = pemBlock.ReplaceAllString(text, "[redacted private key]")
	text = headerLine.ReplaceAllStringFunc(text, func(m string) string {
		parts := headerLine.FindStringSubmatch(m)
		return parts[1] + parts[2] + RedactedMark(strings.TrimRight(parts[3], " \t"))
	})
	text = bearerText.ReplaceAllStringFunc(text, func(m string) string {
		return m[:strings.IndexAny(m, " \t")] + " [redacted]"
	})
	text = redactAssignments(text)
	text = urlUserinfo.ReplaceAllString(text, "${1}[redacted]${3}")
	return textToken.ReplaceAllStringFunc(text, func(word string) string {
		if redactedMark.MatchString(word) {
			return word
		}
		if pathLikeText.MatchString(word) && !secretPrefix.MatchString(word) && !authValue.MatchString(word) && !jwtValue.MatchString(word) {
			return word
		}
		if IsSecretValue(word) {
			return RedactedMark(word)
		}
		return word
	})
}

// redactAssignments redacts the value of every `name: value` and `name=value` whose name is a credential's. A value
// that isn't one is searched too (a URL's query string is one).
func redactAssignments(text string) string {
	var out strings.Builder
	pos := 0
	for pos < len(text) {
		loc := assignment.FindStringSubmatchIndex(text[pos:])
		if loc == nil {
			break
		}
		end := pos + loc[1]
		key, valueStart := text[pos+loc[2]:pos+loc[3]], pos+loc[6]
		value := text[valueStart:end]
		if !IsSecretKey(key) || redactedMark.MatchString(strings.Trim(value, `"'`)) {
			out.WriteString(text[pos:valueStart])
			pos = max(valueStart, pos+1)
			continue
		}
		out.WriteString(text[pos:valueStart])
		if len(value) >= 2 && (value[0] == '"' || value[0] == '\'') && value[len(value)-1] == value[0] {
			out.WriteString(string(value[0]) + RedactedMark(value[1:len(value)-1]) + string(value[0]))
		} else {
			out.WriteString(RedactedMark(value))
		}
		pos = end
	}
	out.WriteString(text[pos:])
	return out.String()
}
