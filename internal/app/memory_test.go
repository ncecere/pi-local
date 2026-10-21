package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type factJSON struct {
	ID       string `json:"id"`
	Category string `json:"category"`
	Text     string `json:"text"`
	Trust    string `json:"trust"`
	Status   string `json:"status"`
}

func TestMemoryAboutThePersonAndTheAgent(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	defer h.close()
	fake := newFakeProvider(t, "openai", "ok")
	h.mustDo("POST", "/api/providers", map[string]any{"id": "script", "name": "Script", "kind": "openai-compatible", "baseUrl": fake.URL + "/v1"}, 201)
	h.mustDo("PUT", "/api/providers/script/models/s1", map[string]any{"name": "Scripted"}, 200)
	lastPrompt := func() string {
		chats := fake.chats()
		return string(chats[len(chats)-1].Body)
	}

	// The About me card (defaults from the computer until saved).
	you := decodeInto[struct {
		Basics struct{ Name, Timezone string }
		Saved  bool
	}](t, h.mustDo("GET", "/api/you", nil, 200))
	if you.Saved || you.Basics.Name == "" || you.Basics.Timezone == "" {
		t.Fatalf("defaults: %+v", you)
	}
	h.mustDo("PUT", "/api/you/basics", map[string]any{"name": "Nicholas Cecere", "addressAs": "Nick", "role": "AI engineer", "timezone": "America/New_York", "answerStyle": "short and direct", "signOff": "Nick"}, 200)

	agent := h.agentOn("Helper", "script/s1", map[string]any{"memory": map[string]any{"share": []string{"people"}}})
	// A fact the person said: known, and in the next turn's "about you".
	reply := lastReply(h.sendAndWait(agent, "t1", `CALL:remember:{"about":"you","text":"Mehdi Ramdane is his manager","category":"people","source":"person"}`, "r1"))
	if !strings.Contains(reply, "Saved (um_") {
		t.Fatalf("remember: %q", reply)
	}
	// A conclusion: a suggestion, not known.
	if reply := lastReply(h.sendAndWait(agent, "t1", `CALL:remember:{"about":"you","text":"Probably likes coffee","category":"preferences","source":"inferred"}`, "r2")); !strings.Contains(reply, "suggestion") {
		t.Fatalf("inferred: %q", reply)
	}
	// A category this agent doesn't share: saved, but it won't see it.
	h.mustDo("POST", "/api/you/memories", map[string]any{"category": "health", "text": "Allergic to penicillin"}, 201)
	// Its own note, in its folder.
	h.sendAndWait(agent, "t1", `CALL:remember:{"about":"myself","text":"TDX search needs status names, not IDs"}`, "r3")
	h.sendAndWait(agent, "t1", "hello again", "r4")
	prompt := lastPrompt()
	for _, want := range []string{"Name: Nicholas Cecere", "Call them: Nick", "Sign messages you write for them as: Nick", "Mehdi Ramdane is his manager", "TDX search needs status names"} {
		if !strings.Contains(prompt, want) {
			t.Errorf("the prompt lacks %q", want)
		}
	}
	// (The conversation itself mentions coffee: look only at the profile section.)
	section := prompt
	if i := strings.Index(prompt, "<about_you>"); i >= 0 {
		section = prompt[i:]
		if j := strings.Index(section, "</about_you>"); j >= 0 {
			section = section[:j]
		}
	} else {
		t.Fatal("no about_you section")
	}
	for _, unwanted := range []string{"likes coffee", "penicillin"} {
		if strings.Contains(section, unwanted) {
			t.Errorf("the prompt has %q", unwanted)
		}
	}
	ag, _ := h.app.Agents.Get(agent)
	raw, err := os.ReadFile(filepath.Join(ag.Dir, "memory.json"))
	if err != nil || !strings.Contains(string(raw), "TDX search needs status names") {
		t.Fatalf("memory.json: %s %v", raw, err)
	}

	// The You page: one known, one suggested; accepting makes it known.
	suggested := decodeInto[[]factJSON](t, h.mustDo("GET", "/api/you/memories?status=suggested", nil, 200))
	if len(suggested) != 1 || suggested[0].Trust != "inferred" {
		t.Fatalf("suggested: %+v", suggested)
	}
	h.mustDo("PATCH", "/api/you/memories/"+suggested[0].ID, map[string]any{"accept": true}, 200)

	// recall finds what it may see (not health).
	if reply := lastReply(h.sendAndWait(agent, "t1", `CALL:recall:{"query":"manager allergic"}`, "r5")); !strings.Contains(reply, "Mehdi") || strings.Contains(reply, "penicillin") {
		t.Fatalf("recall: %q", reply)
	}

	// A schedule's run (no person): a "person" fact is only a suggestion, and nothing about them can be forgotten.
	manager := decodeInto[[]factJSON](t, h.mustDo("GET", "/api/you/memories?status=active", nil, 200))
	var managerID string
	for _, f := range manager {
		if strings.Contains(f.Text, "Mehdi") {
			managerID = f.ID
		}
	}
	at := time.Now().Add(1500 * time.Millisecond).UTC().Format(time.RFC3339)
	h.mustDo("POST", "/api/agents/"+agent+"/schedules", map[string]any{"name": "Nightly", "at": at, "message": `CALL:remember:{"about":"you","text":"Lives in Gainesville","category":"home","source":"person"}`}, 201)
	eventually(t, 30*time.Second, "the scheduled remember", func() bool {
		for _, f := range decodeInto[[]factJSON](t, h.mustDo("GET", "/api/you/memories", nil, 200)) {
			if strings.Contains(f.Text, "Gainesville") {
				return f.Status == "suggested"
			}
		}
		return false
	})
	at = time.Now().Add(1500 * time.Millisecond).UTC().Format(time.RFC3339)
	h.mustDo("POST", "/api/agents/"+agent+"/schedules", map[string]any{"name": "Forget", "at": at, "message": `CALL:forget:{"id":"` + managerID + `"}`}, 201)
	time.Sleep(4 * time.Second)
	if _, err := h.app.Memory.Fact(t.Context(), managerID); err != nil {
		t.Fatal("a scheduled run forgot something about the person")
	}

	// Memory off: no tools, no sections.
	off := h.agentOn("Forgetful", "script/s1", map[string]any{"memory": map[string]any{"off": true}})
	h.sendAndWait(off, "t1", "hi", "r1")
	if strings.Contains(lastPrompt(), "Nicholas Cecere") {
		t.Fatal("an agent with memory off saw the profile")
	}

	// Notes on the agent's page; reset; erase everything about the person.
	notes := decodeInto[[]json.RawMessage](t, h.mustDo("GET", "/api/agents/"+agent+"/memory", nil, 200))
	if len(notes) != 1 {
		t.Fatalf("notes: %d", len(notes))
	}
	h.mustDo("DELETE", "/api/agents/"+agent+"/memory", nil, 200)
	h.mustDo("POST", "/api/you/erase", map[string]any{"confirm": "nope"}, 400)
	h.mustDo("POST", "/api/you/erase", map[string]any{"confirm": "erase"}, 200)
	if left := decodeInto[[]factJSON](t, h.mustDo("GET", "/api/you/memories", nil, 200)); len(left) != 0 {
		t.Fatalf("after erase: %+v", left)
	}
}
