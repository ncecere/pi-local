package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/ncecere/pi-local/internal/agents"
	"github.com/ncecere/pi-local/internal/schedules"
	"github.com/ncecere/pi-local/internal/templates"
	"gopkg.in/yaml.v3"
)

// BuilderInput deliberately supports only available configuration. Unknown fields (including
// knowledge, skills, credentials and setup commands) are errors, not ignored promises.
type BuilderInput struct {
	Agent        string           `json:"agent,omitempty"`
	TemplateID   *string          `json:"templateId,omitempty"`
	Name         *string          `json:"name,omitempty"`
	Description  *string          `json:"description,omitempty"`
	Instructions *string          `json:"instructions,omitempty"`
	ModelID      *string          `json:"modelId,omitempty"`
	Workspace    *workspaceInput  `json:"workspace,omitempty"`
	Schedule     *schedules.Input `json:"schedule,omitempty"`
}

type builderProposal struct {
	Tool     string           `json:"tool"`
	AgentID  string           `json:"agentId"`
	YAML     string           `json:"yaml"`
	Schedule *schedules.Input `json:"schedule,omitempty"`
	Revision int              `json:"revision"`
}

type builderError struct{ message string }

func (e *builderError) Error() string   { return e.message }
func (e *builderError) HTTPStatus() int { return 400 }
func (e *builderError) Code() string    { return "builder_refused" }
func builderRefuse(format string, args ...any) error {
	return &builderError{fmt.Sprintf(format, args...)}
}

func strictBuilder(raw []byte, into any) error {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(into); err != nil {
		return builderRefuse("Unsupported or invalid builder setting: %s", err)
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return builderRefuse("Send exactly one configuration.")
	}
	return nil
}

func (a *API) builderOwns(ctx context.Context, caller, target string) bool {
	if caller == target {
		return false
	}
	var owner string
	return a.DB.QueryRowContext(ctx, `SELECT creator_id FROM agent_creators WHERE agent_id = ?`, target).Scan(&owner) == nil && owner == caller
}

// BuilderCall is reachable only on the authenticated runtime gateway, never the UI's public
// management routes. The caller comes from its runtime key, not a model-supplied agent ID.
func (a *API) BuilderCall(ctx context.Context, caller, action string, raw json.RawMessage) (any, error) {
	a.builderMu.Lock()
	defer a.builderMu.Unlock()
	ag, err := a.Agents.Get(caller)
	if err != nil || !ag.Config.Builder {
		return nil, builderRefuse("Agent builder is not enabled for this agent.")
	}
	var in struct {
		Key           string          `json:"key"`
		ApprovalID    string          `json:"approvalId,omitempty"`
		Tool          string          `json:"tool,omitempty"`
		Configuration json.RawMessage `json:"configuration,omitempty"`
	}
	if err := strictBuilder(raw, &in); err != nil {
		return nil, err
	}
	if len(in.Key) == 0 || len(in.Key) > 200 {
		return nil, builderRefuse("A durable request key is required.")
	}
	var proposalText, inputText, target, approvalID, state string
	err = a.DB.QueryRowContext(ctx, `SELECT input, proposal, target, approval_id, state FROM builder_requests WHERE caller = ? AND request_key = ?`, caller, in.Key).Scan(&inputText, &proposalText, &target, &approvalID, &state)
	found := err == nil
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if action == "prepare" {
		if in.Tool != "create_agent" && in.Tool != "update_agent" {
			return nil, builderRefuse("Choose create_agent or update_agent.")
		}
		if !strings.HasPrefix(in.ApprovalID, "ap_") || len(in.ApprovalID) > 70 {
			return nil, builderRefuse("Name the approval request.")
		}
		var config BuilderInput
		if err := strictBuilder(in.Configuration, &config); err != nil {
			return nil, err
		}
		canonical, _ := json.Marshal(struct {
			Tool   string
			Config BuilderInput
		}{in.Tool, config})
		if found {
			if inputText != string(canonical) || approvalID != in.ApprovalID {
				return nil, builderRefuse("This request key already belongs to a different proposal. Start a new tool call.")
			}
			if in.Tool == "update_agent" && !a.builderOwns(ctx, caller, target) {
				return nil, builderRefuse("This agent is not yours to update.")
			}
			return json.RawMessage(proposalText), nil
		}
		patch := agentInput{Name: config.Name, Description: config.Description, Instructions: config.Instructions, ModelID: config.ModelID, TemplateID: config.TemplateID, Workspace: config.Workspace}
		var cfg agents.Config
		var tmpl *templates.Template
		revision := 0
		if in.Tool == "create_agent" {
			if config.Agent != "" {
				return nil, builderRefuse("A new agent cannot choose an existing agent ID.")
			}
			cfg, tmpl, err = a.prepareAgent(ctx, patch)
			target = agents.NewID()
		} else {
			target = config.Agent
			if !a.builderOwns(ctx, caller, target) {
				return nil, builderRefuse("You may update only agents you created, never yourself or unrelated agents.")
			}
			current, e := a.Agents.Get(target)
			if e != nil {
				return nil, e
			}
			cfg, revision = current.Config, current.Revision
			if config.TemplateID != nil {
				tmpl, err = a.Templates.Get(*config.TemplateID)
				if err != nil {
					return nil, builderRefuse("Unknown template %q.", *config.TemplateID)
				}
				if !a.templateAvailable(tmpl) {
					return nil, builderRefuse("Connect and test the template's required connection before using it.")
				}
				tmpl.Apply(&cfg)
				patch.TemplateID = nil
			}
			err = patch.apply(&cfg)
			if err == nil {
				cfg.Normalize()
				err = cfg.Validate()
			}
		}
		if err != nil {
			return nil, builderRefuse("%s", err)
		}
		if a.Agents.ModelAvailable != nil && cfg.Model != agents.DemoModel && !a.Agents.ModelAvailable(cfg.Model) {
			return nil, builderRefuse("Choose an available model.")
		}
		schedule := config.Schedule
		if schedule == nil && tmpl != nil && tmpl.Schedule != nil {
			sc := tmpl.Schedule
			tz, mode := templates.LocalTimezone(), sc.ThreadMode
			if mode == "" {
				mode = "new"
			}
			schedule = &schedules.Input{Name: &sc.Name, Cron: &sc.Cron, Timezone: &tz, Message: &sc.Message, ThreadMode: &mode}
		}
		if schedule != nil {
			if a.Schedules == nil {
				return nil, builderRefuse("Schedules are unavailable.")
			}
			if schedule.AgentID != nil || schedule.ThreadID != nil {
				return nil, builderRefuse("A first schedule cannot move agents or choose another conversation.")
			}
			if schedule.Name == nil {
				name := cfg.Name
				schedule.Name = &name
			}
			if schedule.ThreadMode != nil && *schedule.ThreadMode == "this" {
				h := sha256.Sum256([]byte(caller + "\x00" + in.Key))
				thread := "builder-" + hex.EncodeToString(h[:8])
				schedule.ThreadID = &thread
			}
			prepared, err := a.Schedules.Prepare(*schedule)
			if err != nil {
				return nil, builderRefuse("%s", err)
			}
			schedule = &prepared
		}
		yamlBytes, err := yaml.Marshal(cfg)
		if err != nil {
			return nil, err
		}
		proposal := builderProposal{Tool: in.Tool, AgentID: target, YAML: string(yamlBytes), Schedule: schedule, Revision: revision}
		encoded, err := json.Marshal(proposal)
		if err != nil {
			return nil, err
		}
		if len(encoded) > 128<<10 {
			return nil, builderRefuse("The full proposal must fit in 128 KiB to be reviewed.")
		}
		_, err = a.DB.ExecContext(ctx, `INSERT INTO builder_requests (caller,request_key,input,proposal,target,approval_id) VALUES (?,?,?,?,?,?)`, caller, in.Key, string(canonical), string(encoded), target, in.ApprovalID)
		return proposal, err
	}
	if action != "apply" || !found {
		return nil, builderRefuse("No prepared proposal for this request.")
	}
	var proposal builderProposal
	if err := json.Unmarshal([]byte(proposalText), &proposal); err != nil {
		return nil, err
	}
	if proposal.Tool == "update_agent" && !a.builderOwns(ctx, caller, target) {
		return nil, builderRefuse("This agent is not yours to update.")
	}
	if state == "done" {
		if err := a.Agents.RecoverPending(ctx); err != nil {
			return nil, builderRefuse("%s", err)
		}
		return map[string]any{"agentId": target, "status": "done"}, nil
	}
	var status, tool, args string
	err = a.DB.QueryRowContext(ctx, `SELECT status,tool,arguments FROM approvals WHERE agent_id = ? AND id = ?`, caller, approvalID).Scan(&status, &tool, &args)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, builderRefuse("Human approval is required.")
	}
	if err != nil {
		return nil, err
	}
	var recorded builderProposal
	if json.Unmarshal([]byte(args), &recorded) != nil {
		return nil, builderRefuse("The approval does not show the complete proposal.")
	}
	normalized, _ := json.Marshal(recorded)
	if tool != proposal.Tool || string(normalized) != proposalText {
		return nil, builderRefuse("The approval does not match this complete proposal.")
	}
	if status != "approved" {
		return nil, builderRefuse("Human approval is required (request is %s).", status)
	}
	cfg, err := agents.ParseConfig([]byte(proposal.YAML))
	if err != nil {
		return nil, err
	}
	commit := func(tx *sql.Tx) error {
		if proposal.Tool == "create_agent" {
			if _, err := tx.ExecContext(ctx, `INSERT INTO agent_creators (agent_id,creator_id,request_key) VALUES (?,?,?)`, target, caller, in.Key); err != nil {
				return err
			}
		}
		if proposal.Schedule != nil {
			if err := a.Schedules.InsertApproved(ctx, tx, target, *proposal.Schedule); err != nil {
				return err
			}
		}
		_, err := tx.ExecContext(ctx, `UPDATE builder_requests SET state = 'done' WHERE caller = ? AND request_key = ?`, caller, in.Key)
		return err
	}
	if proposal.Tool == "create_agent" {
		_, err = a.Agents.CreatePrepared(ctx, target, cfg, commit)
	} else {
		_, err = a.Agents.UpdatePrepared(ctx, target, proposal.Revision, func(c *agents.Config) { *c = cfg }, commit)
	}
	if err != nil {
		var outcome *agents.SaveOutcomeError
		if errors.As(err, &outcome) {
			return nil, builderRefuse("%s", err)
		}
		return nil, builderRefuse("Nothing was saved: %s", err)
	}
	if proposal.Schedule != nil {
		list, _ := a.Schedules.List(ctx, target)
		for _, sc := range list {
			a.Schedules.OnChange(sc.ID, sc)
		}
	}
	return map[string]any{"agentId": target, "status": "done"}, nil
}
