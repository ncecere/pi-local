package app

import (
	"context"
	"os"
	"slices"
	"strings"

	"github.com/ncecere/pi-local/internal/gateway"
	"github.com/ncecere/pi-local/internal/memory"
	"github.com/ncecere/pi-local/internal/templates"
)

// basicsDefaults are the About me card's values before the person saves it: from this computer.
func basicsDefaults() memory.Basics {
	lang := "English"
	if l := os.Getenv("LANG"); l != "" && !strings.HasPrefix(l, "en") && !strings.HasPrefix(l, "C") {
		lang = strings.SplitN(l, ".", 2)[0]
	}
	return memory.Basics{Name: localPersonName(), Timezone: templates.LocalTimezone(), Language: lang}
}

// memoryGateway is the agents' memory tools, with the rules about who may save what:
//   - About the person, said by the person in a conversation they started: saved as known.
//   - Concluded by the agent, or from outside text, or in a run the person didn't start (a schedule, another agent):
//     a suggestion they review. Outside text is never shown in the always-on profile, even once accepted.
//   - About itself: always saved (its own notes), visibly.
type memoryGateway struct{ a *App }

func (g memoryGateway) agent(agentID string) (dir string, share []string, err error) {
	ag, err := g.a.Agents.Get(agentID)
	if err != nil {
		return "", nil, err
	}
	if ag.Config.Memory.Off {
		return "", nil, &memory.Error{Status: 403, Code: "memory_off", Message: "Memory is turned off for this agent."}
	}
	return ag.Dir, ag.Config.Memory.Share, nil
}

func (g memoryGateway) Context(ctx context.Context, agentID string) (string, string, error) {
	dir, share, err := g.agent(agentID)
	if err != nil {
		return "", "", err
	}
	about, notes := g.a.Memory.Context(ctx, g.a.Memory.GetBasics(basicsDefaults()), share, dir)
	return about, notes, nil
}

func (g memoryGateway) Remember(ctx context.Context, agentID string, in gateway.RememberInput) (map[string]any, error) {
	dir, _, err := g.agent(agentID)
	if err != nil {
		return nil, err
	}
	if in.About == "myself" {
		n, err := g.a.Memory.AddNote(agentID, dir, in.Text, in.ThreadID)
		if err != nil {
			return nil, err
		}
		return map[string]any{"saved": "known", "id": n.ID, "about": "myself"}, nil
	}
	category := in.Category
	if category == "" {
		category = "preferences"
	}
	trust, active := "inferred", false
	switch {
	case in.Source == "outside":
		trust = "external"
	case in.Source == "person" && in.Present:
		trust, active = "said", true
	}
	f, err := g.a.Memory.AddFact(ctx, memory.FactInput{Category: category, Text: in.Text, Trust: trust, Active: active, SourceAgent: agentID, SourceThread: in.ThreadID})
	if err != nil {
		return nil, err
	}
	saved := "known"
	if f.Status != "active" {
		saved = "suggested"
	}
	return map[string]any{"saved": saved, "id": f.ID, "about": "you", "category": f.Category}, nil
}

func (g memoryGateway) Recall(ctx context.Context, agentID, query string, limit int) (map[string]any, error) {
	dir, share, err := g.agent(agentID)
	if err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 10
	}
	facts, err := g.a.Memory.SearchFacts(ctx, query, share, limit)
	if err != nil {
		return nil, err
	}
	notes, err := g.a.Memory.SearchNotes(dir, query, limit)
	if err != nil {
		return nil, err
	}
	about := []map[string]any{}
	for _, f := range facts {
		about = append(about, map[string]any{"id": f.ID, "category": f.Category, "text": f.Text, "fromOutside": f.Trust == "external"})
	}
	own := []map[string]any{}
	for _, n := range notes {
		own = append(own, map[string]any{"id": n.ID, "text": n.Text})
	}
	return map[string]any{"aboutYou": about, "notes": own}, nil
}

func (g memoryGateway) Forget(ctx context.Context, agentID, id string, present bool) error {
	dir, share, err := g.agent(agentID)
	if err != nil {
		return err
	}
	if strings.HasPrefix(id, "an_") {
		return g.a.Memory.DeleteNote(agentID, dir, id)
	}
	// Something about the person: only while they're there, and only what this agent can see.
	if !present {
		return &memory.Error{Status: 403, Code: "not_present", Message: "Only the person can have something about them forgotten, in a conversation they started."}
	}
	f, err := g.a.Memory.Fact(ctx, id)
	if err != nil {
		return err
	}
	if f.Category != "preferences" && !slices.Contains(share, f.Category) {
		return memory.ErrNotFound
	}
	return g.a.Memory.DeleteFact(ctx, id)
}
