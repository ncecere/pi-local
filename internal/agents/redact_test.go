package agents

import (
	"strings"
	"testing"
)

func TestSecretKeysAndValues(t *testing.T) {
	// The rules agree with runtime/src/lib/redact.ts.
	for _, k := range []string{"Authorization", "api_key", "clientSecret", "refresh-token", "password", "X-Api-Key", "OPENAI_API_KEY", "Set-Cookie"} {
		if !IsSecretKey(k) {
			t.Errorf("%q should be a secret key", k)
		}
	}
	for _, k := range []string{"key", "pageToken", "nextPageToken", "path", "tools", "hasKey", "headerNames"} {
		if IsSecretKey(k) {
			t.Errorf("%q should not be a secret key", k)
		}
	}
	for _, v := range []string{
		"sk-proj-abcdefghijklmnopqrstuvwx", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "Bearer abcdefgh12345678",
		"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk", "AKIAABCDEFGHIJKLMNOP",
		"aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fG3hJ5kL7",
	} {
		if !IsSecretValue(v) {
			t.Errorf("%q should look like a secret", v)
		}
	}
	for _, v := range []string{"hello world", "/Users/ann/projects/pi-local/runtime/dist", "123e4567-e89b-12d3-a456-426614174000", "abcdefghijklmnopqrstuvwxyzabcdefgh", "ag_abcdefghijklmnop"} {
		if IsSecretValue(v) {
			t.Errorf("%q should not look like a secret", v)
		}
	}
	if got := RedactedMark("abc"); got != "[redacted, 3 characters]" {
		t.Error(got)
	}
	if got := RedactedMark("x"); got != "[redacted, 1 character]" {
		t.Error(got)
	}
	if got := RedactedMark("[redacted, 9 characters]"); got != "[redacted, 9 characters]" {
		t.Error("an already redacted value is kept:", got)
	}
}

func TestRedactValue(t *testing.T) {
	in := map[string]any{
		"name": "GitHub", "apiKey": "hunter2hunter2", "args": []any{"--token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"},
		"nested": map[string]any{"password": "p", "path": "/tmp/x"}, "count": float64(3), "ok": true,
	}
	out := RedactValue(in).(map[string]any)
	if out["name"] != "GitHub" || out["apiKey"] != "[redacted, 14 characters]" || out["count"] != float64(3) || out["ok"] != true {
		t.Fatalf("%v", out)
	}
	if args := out["args"].([]any); args[0] != "--token" || !strings.HasPrefix(args[1].(string), "[redacted") {
		t.Fatalf("args: %v", args)
	}
	if n := out["nested"].(map[string]any); n["password"] != "[redacted, 1 character]" || n["path"] != "/tmp/x" {
		t.Fatalf("nested: %v", n)
	}
	// Bounded: long strings are cut, long lists too.
	long := RedactValue(strings.Repeat("a b ", 1500)).(string)
	if len([]rune(long)) != 2001 {
		t.Fatalf("a long string: %d", len([]rune(long)))
	}
	items := make([]any, 150)
	if got := RedactValue(items).([]any); len(got) != 101 || got[100] != "[… 50 more]" {
		t.Fatalf("a long list: %d", len(got))
	}
}

func TestRedactText(t *testing.T) {
	cases := []struct{ in, gone, kept string }{
		{`Authorization: Bearer abcdefghij12345`, "abcdefghij12345", "Authorization:"},
		{`curl -H "Authorization: Basic dXNlcjpwYXNz" https://x`, "dXNlcjpwYXNz", "https://x"},
		{`OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz stuff`, "sk-abcdefghijklmnopqrstuvwxyz", "OPENAI_API_KEY="},
		{`{"apiKey":"hunter2","name":"x"}`, "hunter2", `"name":"x"`},
		{`password: s3cret!`, "s3cret!", "password:"},
		{`GET https://user:pa55w0rd@host.example/path?api_key=abc123&x=1 200`, "pa55w0rd", "host.example/path"},
		{`GET https://host.example/p?api_key=abc123&x=1`, "abc123", "x=1"},
		{`token ghp_abcdefghijklmnopqrstuvwxyz0123456789 end`, "ghp_abcdefghijklmnopqrstuvwxyz0123456789", " end"},
		{"-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\nafter", "MIIEvQ", "after"},
		{`random aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fG3hJ5kL7 here`, "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fG3hJ5kL7", "here"},
	}
	for _, c := range cases {
		got := RedactText(c.in)
		if strings.Contains(got, c.gone) || !strings.Contains(got, c.kept) || !strings.Contains(got, "redacted") {
			t.Errorf("RedactText(%q) = %q", c.in, got)
		}
	}
	// What isn't a secret is left alone: prose, paths (even long ones with digits), ids, the mark itself.
	for _, in := range []string{
		"the agent woke up and answered in 2.4s",
		"/Users/Ann1/Library/Application Support/Pi Local/agents/ag_abcdefghijklmnop/workspace/Notes2024",
		"agent ag_abcdefghijklmnop revision 4 started",
		"apiKey: [redacted, 12 characters]",
		"pageToken=abc123",
	} {
		if got := RedactText(in); got != in {
			t.Errorf("RedactText(%q) = %q", in, got)
		}
	}
}
