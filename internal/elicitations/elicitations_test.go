package elicitations

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestFormsAreCheckedAgainstTheServersSchema(t *testing.T) {
	s := New(time.Minute)
	e, err := s.Create("ag_1", Request{Server: "m365", Message: "Pick", Schema: json.RawMessage(`{"type":"object","properties":{
		"choice":{"type":"string","enum":["a","b"],"title":"Choice"},
		"count":{"type":"integer","minimum":1,"maximum":5},
		"email":{"type":"string","format":"email"},
		"ok":{"type":"boolean"}},"required":["choice"]}`)})
	if err != nil {
		t.Fatal(err)
	}
	for _, bad := range []map[string]any{
		{"choice": "c"}, {"choice": "a", "count": 2.5}, {"choice": "a", "count": float64(9)}, {"choice": "a", "email": "nope"},
		{"count": float64(1)}, {"choice": "a", "ok": "true"}, {"choice": "a", "extra": 1},
	} {
		if _, err := s.Answer(e.ID, "accept", bad); err == nil || !strings.Contains(err.Error(), "") || err.(*Error).Code != "invalid_content" {
			t.Errorf("%v was accepted (%v)", bad, err)
		}
	}
	got, err := s.Answer(e.ID, "accept", map[string]any{"choice": "b", "count": float64(3), "email": "a@b.example", "ok": true})
	if err != nil || got.State != "accepted" {
		t.Fatalf("%+v %v", got, err)
	}
	a, done, _ := s.Wait(context.Background(), "ag_1", e.ID, time.Second)
	if !done || a.Action != "accept" || a.Content["choice"] != "b" {
		t.Fatalf("%+v", a)
	}
	// Another agent can't wait on it or withdraw it.
	if _, _, err := s.Wait(context.Background(), "ag_2", e.ID, 0); err != ErrNotFound {
		t.Fatal(err)
	}
}

func TestUnsupportedFormsAndExpiry(t *testing.T) {
	s := New(50 * time.Millisecond)
	if _, err := s.Create("ag_1", Request{Server: "x", Schema: json.RawMessage(`{"type":"object","properties":{"nested":{"type":"object"}}}`)}); err == nil {
		t.Fatal("a nested form was accepted")
	}
	e, _ := s.Create("ag_1", Request{Server: "x", Message: "?"})
	a, done, _ := s.Wait(context.Background(), "ag_1", e.ID, time.Second)
	if !done || a.Action != "cancel" {
		t.Fatalf("expiry: %+v %v", a, done)
	}
	if len(s.Pending()) != 0 {
		t.Fatal("still pending")
	}
}
