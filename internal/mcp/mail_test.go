package mcp

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestMailReadCandidate(t *testing.T) {
	fresh := func() *Server {
		now := int64(1)
		return &Server{Slug: "custom_mail", Enabled: true, TestedAt: &now, Tools: []Tool{
			{Name: "list-mail-messages", ModelVisible: true, Annotations: json.RawMessage(`{"readOnlyHint":true,"destructiveHint":false}`)},
			{Name: "get-mail-message", ModelVisible: true, Annotations: json.RawMessage(`{"readOnlyHint":true}`)},
			{Name: "send-mail", ModelVisible: true},
		}}
	}
	for _, tc := range []struct {
		name   string
		change func(*Server)
	}{
		{"disabled", func(s *Server) { s.Enabled = false }},
		{"untested", func(s *Server) { s.TestedAt = nil }},
		{"disconnected", func(s *Server) { e := "connection refused"; s.LastError = &e }},
		{"empty error", func(s *Server) { e := ""; s.LastError = &e }},
		{"signed out", func(s *Server) { s.OAuth = true }},
		{"rejected token", func(s *Server) { s.OAuth = true; s.SignedIn = true; e := "needs_sign_in"; s.LastError = &e }},
		{"write only", func(s *Server) { s.Tools = s.Tools[2:] }},
		{"name impostor", func(s *Server) {
			s.Slug = "microsoft365"
			s.Name = "Outlook mail"
			s.Description = "Read emails"
			s.Tools = nil
		}},
		{"unknown names", func(s *Server) { s.Tools[0].Name = "search_mail" }},
		{"missing read", func(s *Server) { s.Tools = s.Tools[:1] }},
		{"hidden", func(s *Server) { s.Tools[0].ModelVisible = false }},
		{"no metadata", func(s *Server) { s.Tools[0].Annotations = nil }},
		{"false readonly", func(s *Server) { s.Tools[0].Annotations = json.RawMessage(`{"readOnlyHint":false}`) }},
		{"destructive", func(s *Server) {
			s.Tools[0].Annotations = json.RawMessage(`{"readOnlyHint":true,"destructiveHint":true}`)
		}},
		{"malformed", func(s *Server) { s.Tools[0].Annotations = json.RawMessage(`{"readOnlyHint":"true"}`) }},
		{"duplicate", func(s *Server) { s.Tools = append(s.Tools, s.Tools[0]) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := fresh()
			tc.change(s)
			if server, tools, err := mailReadCandidate([]*Server{s}); err != nil || server != "" || len(tools) != 0 {
				t.Fatalf("unsafe match: %s %v %v", server, tools, err)
			}
		})
	}
	for _, oauth := range []bool{false, true} {
		a, z := fresh(), fresh()
		a.Slug, z.Slug = "a_mail", "z_mail"
		a.OAuth, a.SignedIn = oauth, oauth
		for _, list := range [][]*Server{{z, a}, {a, z}} {
			server, tools, err := mailReadCandidate(list)
			if err != nil || server != "a_mail" || !reflect.DeepEqual(tools, []string{"list-mail-messages", "get-mail-message"}) {
				t.Fatalf("selection: %s %v %v", server, tools, err)
			}
			tools[0] = "changed"
		}
		if a.Tools[0].Name != "list-mail-messages" {
			t.Fatal("catalog metadata mutated")
		}
	}
}
