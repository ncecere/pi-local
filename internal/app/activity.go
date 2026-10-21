package app

import (
	"context"
	"fmt"

	"github.com/ncecere/pi-local/internal/activity"
	"github.com/ncecere/pi-local/internal/agents"
	"github.com/ncecere/pi-local/internal/approvals"
	"github.com/ncecere/pi-local/internal/asks"
	"github.com/ncecere/pi-local/internal/mcp"
	"github.com/ncecere/pi-local/internal/schedules"
	"github.com/ncecere/pi-local/internal/threads"
)

// What the app writes to the audit log itself (package activity): the runtimes report tool calls; everything else is
// seen here. Recording only queues the entry, so these are safe to call from anywhere, also with rows open.

// systemActor is who acts when nobody does: a time-out, a failed start.
const systemActor = "Pi Local"

// recordApproval: a request was decided (by the person, by time running out, or because the call went away).
func (a *App) recordApproval(ap *approvals.Approval) {
	title, outcome, actor := "", "", a.Approvals.Person
	switch ap.Status {
	case "approved":
		title, outcome = "Approved "+ap.Tool, "ok"
	case "denied":
		title, outcome = "Denied "+ap.Tool, "denied"
	case "timed_out":
		title, outcome, actor = "Approval for "+ap.Tool+" timed out", "declined", systemActor
	case "cancelled":
		title, outcome, actor = "Approval for "+ap.Tool+" cancelled", "cancelled", systemActor
	default:
		return
	}
	at := ap.RequestedAt
	if ap.DecidedAt != nil {
		at = *ap.DecidedAt
	}
	waited := max(at-ap.RequestedAt, 0)
	detail := map[string]any{"approvalId": ap.ID, "tool": ap.Tool}
	if ap.Summary != nil && *ap.Summary != "" {
		detail["summary"] = *ap.Summary
	}
	if ap.Reason != nil && *ap.Reason != "" {
		detail["reason"] = agents.RedactText(*ap.Reason)
	}
	thread := ""
	if ap.ThreadID != nil {
		thread = *ap.ThreadID
	}
	a.Activity.Record(activity.Entry{At: at, Kind: activity.KindApproval, AgentID: ap.AgentID, AgentName: ap.AgentName, ThreadID: thread, Actor: actor,
		Title: title, Outcome: outcome, DurationMs: &waited, Detail: activity.Detail(detail), Dedupe: "approval:" + ap.AgentID + ":" + ap.ID})
	// Stop need not settle a tool round, and expiry can happen while the runtime sleeps. The persisted
	// request has everything needed to audit the unexecuted call; a later result shares its dedupe key.
	if ap.Status == "cancelled" || ap.Status == "timed_out" {
		a.Activity.RecordTools(ap.AgentID, []activity.ToolItem{{
			CallID: ap.CallID, ThreadID: thread, Tool: ap.Tool, Arguments: ap.Arguments,
			Outcome: "declined", EndedAt: at,
			Approval: &activity.ToolApproval{ID: ap.ID, Status: ap.Status, WaitedMs: &waited},
		}})
	}
}

// recordReplyError: a reply ended in an error.
func (a *App) recordReplyError(agentID string, t *threads.Thread) {
	if t.LastError == nil || *t.LastError == "" {
		return
	}
	at := t.UpdatedAt
	if t.LastReplyAt != nil {
		at = *t.LastReplyAt
	}
	a.Activity.Record(activity.Entry{At: at, Kind: activity.KindError, AgentID: agentID, ThreadID: t.ThreadID, Actor: a.Agents.NameOf(agentID),
		Title: "A reply failed", Outcome: "error", Detail: activity.Detail(map[string]any{"error": clipText(agents.RedactText(*t.LastError), 500)}),
		Dedupe: fmt.Sprintf("error:reply:%s:%s:%d", agentID, t.ThreadID, at)})
}

// recordAgentFailed: an agent's runtime could not start (or stopped for good).
func (a *App) recordAgentFailed(agentID, message string) {
	a.Activity.Record(activity.Entry{Kind: activity.KindError, AgentID: agentID, Actor: systemActor, Title: "The agent could not run", Outcome: "error",
		Detail: activity.Detail(map[string]any{"error": clipText(agents.RedactText(message), 500)})})
}

// recordScheduleRun: a schedule's run ended.
func (a *App) recordScheduleRun(sc *schedules.Schedule, run *schedules.Run) {
	if run == nil {
		return
	}
	outcome, title := "ok", "Schedule ran: "+sc.Name
	detail := map[string]any{"scheduleId": sc.ID, "runId": run.ID}
	if run.Status != "done" {
		outcome, title = "error", "Schedule failed: "+sc.Name
		if run.Error != nil {
			detail["error"] = clipText(agents.RedactText(*run.Error), 500)
		}
	}
	var duration *int64
	if run.FinishedAt != nil {
		d := max(*run.FinishedAt-run.FiredAt, 0)
		duration = &d
	}
	a.Activity.Record(activity.Entry{At: run.FiredAt, Kind: activity.KindSchedule, AgentID: sc.AgentID, ThreadID: run.ThreadID, Actor: "Schedule: " + sc.Name,
		Title: title, Outcome: outcome, DurationMs: duration, Detail: activity.Detail(detail), Dedupe: "schedule:" + run.ID})
}

// recordAsk: an agent asked another, and the ask ended.
func (a *App) recordAsk(f asks.Finished) {
	outcome, target := "ok", a.Agents.NameOf(f.Target)
	detail := map[string]any{"askId": f.ID, "targetAgentId": f.Target, "targetAgent": target, "targetThread": f.TargetThread, "preview": activity.Preview(f.Message)}
	if f.Status != "done" {
		outcome = "error"
		detail["error"] = clipText(agents.RedactText(f.Error), 500)
	}
	d := max(f.Ended.Sub(f.Asked).Milliseconds(), 0)
	a.Activity.Record(activity.Entry{At: f.Ended.UnixMilli(), Kind: activity.KindAsk, AgentID: f.Caller, ThreadID: f.CallerThread, Actor: a.Agents.NameOf(f.Caller),
		Title: "Asked " + target, Outcome: outcome, DurationMs: &d, Detail: activity.Detail(detail), Dedupe: "ask:" + f.ID})
}

// recordSignIn: an MCP server's sign-in ended, or it was signed out.
func (a *App) recordSignIn(ev mcp.AuthEvent) {
	title := "Signed in to " + ev.Name
	switch {
	case ev.Action == "sign_out":
		title = "Signed out of " + ev.Name
	case ev.Outcome == "error":
		title = "Signing in to " + ev.Name + " failed"
	case ev.Outcome == "cancelled":
		title = "Signing in to " + ev.Name + " was cancelled"
	}
	detail := map[string]any{"server": ev.Slug, "action": ev.Action}
	if ev.Error != "" {
		detail["error"] = clipText(agents.RedactText(ev.Error), 500)
	}
	a.Activity.Record(activity.Entry{Kind: activity.KindSignIn, Actor: localPersonName(), Title: title, Outcome: ev.Outcome, Detail: activity.Detail(detail)})
}

// budgetCheck is the budget's check for asks and schedule runs, recording a refusal.
func (a *App) budgetCheck(via string) func(ctx context.Context, agentID string) error {
	return func(ctx context.Context, agentID string) error {
		err := a.Budget.Check(ctx, agentID)
		a.Activity.Refused(agentID, via, err)
		return err
	}
}

func clipText(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n-1]) + "…"
	}
	return s
}
