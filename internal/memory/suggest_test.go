package memory

import (
	"strings"
	"testing"
)

func TestCleanCandidates(t *testing.T) {
	got := CleanCandidates([]Candidate{
		{Text: "  Works   at Acme ", Category: "WORK"},
		{Text: "works at acme", Category: "work"}, // the same
		{Text: "Likes tea", Category: "nonsense"}, // unknown category: preferences
		{Text: "", Category: "work"},              // empty
		{Text: strings.Repeat("x", 301), Category: "work"},
		{Text: "Has a dog", Category: "family"},
		{Text: "Fourth", Category: "home"}, // more than three
	})
	want := []Candidate{{"Works at Acme", "work"}, {"Likes tea", "preferences"}, {"Has a dog", "family"}}
	if len(got) != len(want) {
		t.Fatalf("got %+v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("%d: got %+v, want %+v", i, got[i], want[i])
		}
	}
	if got := CleanCandidates(nil); got == nil || len(got) != 0 {
		t.Errorf("nil in: %#v", got)
	}
}
