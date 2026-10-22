package main

import (
	"strings"
	"testing"
)

func TestAppleStrings(t *testing.T) {
	cases := map[string]string{
		`plain`:            `"plain"`,
		`say "hi" \ there`: `"say \"hi\" \\ there"`,
		"two\nlines":       `"two lines"`,
	}
	for in, want := range cases {
		if got := appleString(in); got != want {
			t.Errorf("appleString(%q) = %s, want %s", in, got, want)
		}
	}
	if got := appleString(strings.Repeat("x", 500)); len([]rune(got)) > 245 {
		t.Errorf("a long string isn't shortened: %d", len(got))
	}
}

func TestPlural(t *testing.T) {
	if plural(0, "agent working", "agents working", "Nothing working") != "Nothing working" ||
		plural(1, "agent working", "agents working", "") != "1 agent working" ||
		plural(3, "agent working", "agents working", "") != "3 agents working" {
		t.Fatal("plural")
	}
}
