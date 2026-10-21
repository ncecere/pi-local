package mcp

import (
	"context"
	"encoding/json"
	"sort"
)

// Reviewed against Softeria/ms-365-mcp-server, main at
// 9176369b760190f7c51451fb4ea05fe5f0aeb2ac: src/endpoints.json defines
// list-mail-messages as GET /me/messages and get-mail-message as
// GET /me/messages/{message-id}, both Mail.Read. src/graph-tools.ts registers
// GET tools with readOnlyHint:true. No batch, generic execute, attachment or write tools.
var mailReadTools = []string{"list-mail-messages", "get-mail-message"}

// MailReadTools resolves one tested custom connection using known tool names AND
// explicit read-only metadata, never a server's label, slug or description. This
// is capability matching, not proof of the identity or trustworthiness of a server.
// It only inspects the catalog: no login, probe or mail calls.
func (c *Catalog) MailReadTools(ctx context.Context) (string, []string, error) {
	servers, err := c.List(ctx)
	if err != nil {
		return "", nil, err
	}
	return mailReadCandidate(servers)
}

func mailReadCandidate(servers []*Server) (string, []string, error) {
	// List order must not choose a different mailbox after a catalog reorder.
	servers = append([]*Server(nil), servers...)
	sort.Slice(servers, func(i, j int) bool { return servers[i].Slug < servers[j].Slug })
	for _, s := range servers {
		if !s.Enabled || s.TestedAt == nil || s.LastError != nil || s.OAuth && !s.SignedIn {
			continue
		}
		valid := true
		for _, name := range mailReadTools {
			count := 0
			for _, tool := range s.Tools {
				if tool.Name != name {
					continue
				}
				var hints struct {
					ReadOnly    bool `json:"readOnlyHint"`
					Destructive bool `json:"destructiveHint"`
				}
				if !tool.ModelVisible || json.Unmarshal(tool.Annotations, &hints) != nil || !hints.ReadOnly || hints.Destructive {
					valid = false
				}
				count++
			}
			if count != 1 {
				valid = false
			}
		}
		if valid {
			return s.Slug, append([]string(nil), mailReadTools...), nil
		}
	}
	return "", nil, nil
}
