package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/ncecere/pi-local/internal/agents"
	"github.com/ncecere/pi-local/internal/secrets"
)

// All fixtures are synthetic: temporary document directories and shared skills, no real data or keychain.
func builderInputFixture(t *testing.T) (*harness, string) {
	t.Helper()
	h := start(t, t.TempDir(), Config{Secrets: secrets.NewMemory()})
	builder := h.agentOn("Builder", "demo/demo-1", map[string]any{"templateId": "agent-builder"})
	for _, name := range []string{"release-notes", "pdf-tools"} {
		dir := filepath.Join(h.app.Skills.Root, name)
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte("---\nname: "+name+"\ndescription: Synthetic test skill\n---\nTest instructions.\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return h, builder
}

func TestBuilderKnowledgeAndSkillsApprovedSnapshots(t *testing.T) {
	h, builder := builderInputFixture(t)
	folder, replacement := t.TempDir(), t.TempDir()
	var target string
	for _, step := range []struct {
		key, tool string
		config    map[string]any
		folders   []string
		skills    []string
	}{
		{"create", "create_agent", map[string]any{"name": "Child", "modelId": "demo/demo-1", "knowledge": map[string]any{"folders": []string{" " + folder + "/. ", folder}}, "skills": []string{"release-notes", "release-notes"}}, []string{folder}, []string{"release-notes"}},
		{"omit", "update_agent", map[string]any{"name": "Renamed"}, []string{folder}, []string{"release-notes"}},
		{"replace", "update_agent", map[string]any{"knowledge": map[string]any{"folders": []string{replacement}}, "skills": []string{"pdf-tools"}}, []string{replacement}, []string{"pdf-tools"}},
		{"clear", "update_agent", map[string]any{"knowledge": map[string]any{"folders": []string{}}, "skills": []string{}}, nil, nil},
	} {
		if !t.Run(step.key, func(t *testing.T) {
			if target != "" {
				step.config["agent"] = target
			}
			raw, _ := json.Marshal(map[string]any{"key": step.key, "approvalId": "ap_" + step.key, "tool": step.tool, "configuration": step.config})
			result, err := h.app.API.BuilderCall(t.Context(), builder, "prepare", raw)
			if err != nil {
				t.Fatal(err)
			}
			encoded, _ := json.Marshal(result)
			replayed, err := h.app.API.BuilderCall(t.Context(), builder, "prepare", raw)
			if err != nil {
				t.Fatal(err)
			}
			replayedJSON, _ := json.Marshal(replayed)
			if string(encoded) != string(replayedJSON) {
				t.Fatal("prepare replay changed the approved snapshot")
			}
			var proposal struct {
				AgentID string `json:"agentId"`
				YAML    string `json:"yaml"`
			}
			if err := json.Unmarshal(encoded, &proposal); err != nil {
				t.Fatal(err)
			}
			approved, err := agents.ParseConfig([]byte(proposal.YAML))
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(approved.Knowledge.Folders, step.folders) || !reflect.DeepEqual(approved.Skills, step.skills) {
				t.Fatalf("not normalized in full approval: %s", proposal.YAML)
			}
			if len(approved.Workspace.Tools) != 0 || !approved.Workspace.NetworkOn() || !approved.Security.Scrub() || approved.Builder || approved.Approvals.Profile != agents.ProfileBalanced {
				t.Fatal("builder changed security defaults")
			}
			var previous *agents.Agent
			if target != "" {
				previous, err = h.app.Agents.Get(target)
				if err != nil {
					t.Fatal(err)
				}
			}
			apply, _ := json.Marshal(map[string]string{"key": step.key})
			if _, err := h.app.API.BuilderCall(t.Context(), builder, "apply", apply); err == nil || !strings.Contains(err.Error(), "Human approval") {
				t.Fatalf("applied without human approval: %v", err)
			}
			if target == "" {
				if _, err := h.app.Agents.Get(proposal.AgentID); err == nil {
					t.Fatal("materialized before approval")
				}
			} else if current, err := h.app.Agents.Get(target); err != nil || !reflect.DeepEqual(current, previous) {
				t.Fatalf("update changed agent before approval: %v", err)
			}
			// An explicit fixture decision authorizes only this complete normalized snapshot.
			if _, err := h.app.DB.Exec(`INSERT INTO approvals (agent_id,id,tool,arguments,status,requested_at,expires_at) VALUES (?,?,?,?,'approved',0,0)`, builder, "ap_"+step.key, step.tool, string(encoded)); err != nil {
				t.Fatal(err)
			}
			for range 2 {
				if _, err := h.app.API.BuilderCall(t.Context(), builder, "apply", apply); err != nil {
					t.Fatal(err)
				}
			}
			target = proposal.AgentID
			ag, err := h.app.Agents.Get(target)
			if err != nil || !reflect.DeepEqual(ag.Config, approved) {
				t.Fatalf("saved config differs from approval: %+v %v", ag, err)
			}
			text, err := h.app.Agents.ConfigText(target)
			if err != nil {
				t.Fatal(err)
			}
			stored, err := agents.ParseConfig(text)
			if err != nil || !reflect.DeepEqual(stored, approved) {
				t.Fatalf("materialized YAML differs from approval: %s %v", text, err)
			}
		}) {
			return
		}
	}
}

func TestBuilderKnowledgeAndSkillsBoundaries(t *testing.T) {
	h, builder := builderInputFixture(t)
	folder := t.TempDir()
	link := filepath.Join(t.TempDir(), "linked")
	if err := os.Symlink(folder, link); err != nil {
		t.Fatal(err)
	}
	own, err := h.app.Agents.Get(builder)
	if err != nil {
		t.Fatal(err)
	}
	ownSkill := filepath.Join(own.SkillsDir(), "private-skill")
	if err := os.MkdirAll(ownSkill, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ownSkill, "SKILL.md"), []byte("---\nname: private-skill\ndescription: Not shared\n---\nTest\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	linkedSkill := t.TempDir()
	if err := os.WriteFile(filepath.Join(linkedSkill, "SKILL.md"), []byte("---\nname: linked-skill\ndescription: Linked outside the shared store\n---\nTest\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(linkedSkill, filepath.Join(h.app.Skills.Root, "linked-skill")); err != nil {
		t.Fatal(err)
	}
	unrelated := h.createAgent("Foreign")
	child := h.createAgent("Owned")
	if _, err := h.app.DB.Exec(`INSERT INTO agent_creators (agent_id,creator_id,request_key) VALUES (?,?,'fixture')`, child, builder); err != nil {
		t.Fatal(err)
	}
	cases := map[string]map[string]any{
		"broad":                   {"knowledge": map[string]any{"folders": []string{"/"}}},
		"missing-folder":          {"knowledge": map[string]any{"folders": []string{filepath.Join(folder, "missing")}}},
		"relative":                {"knowledge": map[string]any{"folders": []string{"documents"}}},
		"symlink":                 {"knowledge": map[string]any{"folders": []string{link}}},
		"unknown-knowledge-field": {"knowledge": map[string]any{"folders": []string{folder}, "files": []string{"notes.md"}}},
		"missing-skill":           {"skills": []string{"not-installed"}},
		"private-skill":           {"skills": []string{"private-skill"}},
		"linked-skill":            {"skills": []string{"linked-skill"}},
		"skill-path":              {"skills": []string{"../release-notes"}},
		"skill-import":            {"skills": []map[string]string{{"name": "release-notes", "url": "https://invalid.test/skill"}}},
		"skill-files":             {"skills": []string{"release-notes/SKILL.md"}},
	}
	for key, config := range cases {
		for _, tool := range []string{"create_agent", "update_agent"} {
			t.Run(key+"/"+tool, func(t *testing.T) {
				config["name"], config["modelId"] = "No", "demo/demo-1"
				if tool == "update_agent" {
					config["agent"] = child
				}
				raw, _ := json.Marshal(map[string]any{"key": key + tool, "approvalId": "ap_bad", "tool": tool, "configuration": config})
				_, err := h.app.API.BuilderCall(t.Context(), builder, "prepare", raw)
				if err == nil {
					t.Fatal("unsafe selection accepted")
				}
				if key == "missing-skill" && !strings.Contains(err.Error(), "not-installed") {
					t.Fatalf("missing shared skill was not explained: %v", err)
				}
			})
		}
	}
	// Even valid selections cannot authorize edits to a foreign agent.
	raw, _ := json.Marshal(map[string]any{"key": "foreign", "approvalId": "ap_foreign", "tool": "update_agent", "configuration": map[string]any{"agent": unrelated, "knowledge": map[string]any{"folders": []string{folder}}, "skills": []string{"release-notes"}}})
	if _, err := h.app.API.BuilderCall(t.Context(), builder, "prepare", raw); err == nil || !strings.Contains(err.Error(), "only agents you created") {
		t.Fatalf("foreign agent accepted: %v", err)
	}
	var count int
	if err := h.app.DB.QueryRow(`SELECT COUNT(*) FROM builder_requests`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("refused proposal persisted: %d %v", count, err)
	}
	// A missing shared store cannot silently accept a selected name.
	h.app.API.Skills = nil
	raw = json.RawMessage(`{"key":"no-store","approvalId":"ap_no_store","tool":"create_agent","configuration":{"name":"No","modelId":"demo/demo-1","skills":["release-notes"]}}`)
	if _, err := h.app.API.BuilderCall(t.Context(), builder, "prepare", raw); err == nil || !strings.Contains(err.Error(), "release-notes") {
		t.Fatalf("missing shared store: %v", err)
	}
}

func TestBuilderKnowledgeValidateChangeAndApplyRevalidation(t *testing.T) {
	h, builder := builderInputFixture(t)
	folder := t.TempDir()
	child := h.agentOn("Child", "demo/demo-1", map[string]any{"knowledge": map[string]any{"folders": []string{folder}}, "skills": []string{"release-notes"}})
	if _, err := h.app.DB.Exec(`INSERT INTO agent_creators (agent_id,creator_id,request_key) VALUES (?,?,'fixture')`, child, builder); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(folder); err != nil {
		t.Fatal(err)
	}
	// Like a dialog edit, renaming an agent tolerates its existing unplugged knowledge folder.
	raw, _ := json.Marshal(map[string]any{"key": "rename", "approvalId": "ap_rename", "tool": "update_agent", "configuration": map[string]any{"agent": child, "name": "Renamed"}})
	result, err := h.app.API.BuilderCall(t.Context(), builder, "prepare", raw)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(result)
	if _, err := h.app.DB.Exec(`INSERT INTO approvals (agent_id,id,tool,arguments,status,requested_at,expires_at) VALUES (?,?,'update_agent',?,'approved',0,0)`, builder, "ap_rename", string(encoded)); err != nil {
		t.Fatal(err)
	}
	if err := h.app.Skills.Delete("release-notes"); err != nil {
		t.Fatal(err)
	}
	apply := json.RawMessage(`{"key":"rename"}`)
	if _, err := h.app.API.BuilderCall(t.Context(), builder, "apply", apply); err == nil || !strings.Contains(err.Error(), "release-notes") {
		t.Fatalf("skill removed since approval was accepted: %v", err)
	}
	// Restore the fake skill; the exact approved snapshot still applies without dropping the missing folder.
	if err := os.MkdirAll(filepath.Join(h.app.Skills.Root, "release-notes"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(h.app.Skills.Root, "release-notes", "SKILL.md"), []byte("---\nname: release-notes\ndescription: Synthetic\n---\nTest\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := h.app.API.BuilderCall(t.Context(), builder, "apply", apply); err != nil {
		t.Fatal(err)
	}
	changed, err := h.app.Agents.Get(child)
	if err != nil || changed.Config.Name != "Renamed" || !reflect.DeepEqual(changed.Config.Knowledge.Folders, []string{folder}) {
		t.Fatalf("ValidateChange diverged: %+v %v", changed, err)
	}
}
