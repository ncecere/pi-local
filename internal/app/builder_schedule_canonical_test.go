package app

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/ncecere/pi-local/internal/schedules"
)

func TestBuilderCanonicalScheduleApprovalMatchesStoredAndRetries(t *testing.T) {
	for _, timing := range []string{"once", "cron"} {
		t.Run(timing, func(t *testing.T) {
			h := start(t, t.TempDir(), Config{}) // harness uses secrets.NewMemory
			builder := h.agentOn("Builder", "demo/demo-1", map[string]any{"templateId": "agent-builder"})
			when := map[string]any{"name": "  ", "timezone": "", "message": "  Hello  ", "paused": true, "threadMode": "this"}
			if timing == "once" {
				when["at"] = "  " + time.Now().Add(24*time.Hour).In(time.FixedZone("offset", 2*60*60)).Format(time.RFC3339Nano) + "  "
			} else {
				when["cron"] = "  0 9 * * *  "
			}
			raw, _ := json.Marshal(map[string]any{"key": "canonical", "approvalId": "ap_canonical", "tool": "create_agent", "configuration": map[string]any{"name": "Child", "schedule": when}})
			result, err := h.app.API.BuilderCall(t.Context(), builder, "prepare", raw)
			if err != nil {
				t.Fatal(err)
			}
			encoded, _ := json.Marshal(result)
			var proposal struct {
				AgentID  string          `json:"agentId"`
				Schedule schedules.Input `json:"schedule"`
			}
			if err := json.Unmarshal(encoded, &proposal); err != nil {
				t.Fatal(err)
			}
			approved := proposal.Schedule
			if approved.Timezone == nil || *approved.Timezone != "UTC" || approved.Name == nil || *approved.Name != "Hello" || approved.Message == nil || *approved.Message != "Hello" || approved.MissedPolicy == nil || *approved.MissedPolicy != "run_once" || approved.Paused == nil || !*approved.Paused || approved.ThreadID == nil {
				t.Fatalf("noncanonical approval: %s", encoded)
			}
			if timing == "once" && (approved.Cron != nil || approved.At == nil || !strings.HasSuffix(*approved.At, "Z")) {
				t.Fatalf("noncanonical at representation: %+v", approved)
			}
			if timing == "cron" && (approved.At != nil || approved.Cron == nil || *approved.Cron != "0 9 * * *") {
				t.Fatalf("noncanonical cron representation: %+v", approved)
			}
			// Test fixture represents an explicit human decision on the entire exact
			// proposal. Existing runtime tests exercise the actual approval UI path.
			_, err = h.app.DB.Exec(`INSERT INTO approvals (agent_id,id,tool,arguments,status,requested_at,expires_at) VALUES (?,?,'create_agent',?,'approved',0,0)`, builder, "ap_canonical", string(encoded))
			if err != nil {
				t.Fatal(err)
			}
			apply := json.RawMessage(`{"key":"canonical"}`)
			// A transaction failure cannot leave a partial schedule or consume approval.
			if _, err := h.app.DB.Exec(`CREATE TRIGGER reject_schedule BEFORE INSERT ON schedules BEGIN SELECT RAISE(ABORT, 'retry'); END`); err != nil {
				t.Fatal(err)
			}
			if _, err := h.app.API.BuilderCall(t.Context(), builder, "apply", apply); err == nil {
				t.Fatal("injected transaction failure was ignored")
			}
			if _, err := h.app.DB.Exec(`DROP TRIGGER reject_schedule`); err != nil {
				t.Fatal(err)
			}
			for range 3 {
				if _, err := h.app.API.BuilderCall(t.Context(), builder, "apply", apply); err != nil {
					t.Fatal(err)
				}
			}
			list, err := h.app.Schedules.List(t.Context(), proposal.AgentID)
			if err != nil || len(list) != 1 {
				t.Fatalf("schedule replay: %+v %v", list, err)
			}
			sc := list[0]
			stored := schedules.Input{Name: &sc.Name, Timezone: &sc.Timezone, Message: &sc.Message, Cron: sc.Cron, ThreadMode: &sc.ThreadMode, ThreadID: sc.ThreadID, MissedPolicy: &sc.MissedPolicy, Paused: &sc.Paused}
			if sc.At != nil {
				at := time.UnixMilli(*sc.At).UTC().Format(time.RFC3339Nano)
				stored.At = &at
			}
			if !reflect.DeepEqual(approved, stored) {
				want, _ := json.Marshal(approved)
				got, _ := json.Marshal(stored)
				t.Fatalf("approval != stored:\n%s\n%s", want, got)
			}
		})
	}
}

func TestBuilderRejectsConflictingScheduleBeforeApproval(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	builder := h.agentOn("Builder", "demo/demo-1", map[string]any{"templateId": "agent-builder"})
	at := time.Now().Add(24 * time.Hour).Format(time.RFC3339)
	raw, _ := json.Marshal(map[string]any{"key": "both", "approvalId": "ap_both", "tool": "create_agent", "configuration": map[string]any{"name": "Child", "schedule": map[string]any{"at": at, "cron": "@daily", "message": "Hello"}}})
	if _, err := h.app.API.BuilderCall(t.Context(), builder, "prepare", raw); err == nil || !strings.Contains(err.Error(), "not both") {
		t.Fatalf("conflicting timing accepted: %v", err)
	}
	var count int
	if err := h.app.DB.QueryRow(`SELECT COUNT(*) FROM builder_requests`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("conflicting proposal persisted: %d %v", count, err)
	}
}

func TestApprovedScheduleRefusesSemanticRenormalization(t *testing.T) {
	h := start(t, t.TempDir(), Config{})
	id := h.createAgent("Child")
	cron, message := "@daily", "  Hello  "
	tx, err := h.app.DB.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if err := h.app.Schedules.InsertApproved(t.Context(), tx, id, schedules.Input{Cron: &cron, Message: &message}); err == nil || !strings.Contains(err.Error(), "not canonical") {
		t.Fatalf("raw approval silently normalized at insert: %v", err)
	}
}
