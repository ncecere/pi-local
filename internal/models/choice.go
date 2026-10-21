package models

import (
	"context"
	"fmt"
	"slices"
)

// The person may choose the model and thinking level of a conversation, in the composer (on unless turned off in
// Settings → Models). It is their choice, made by hand: nothing picks a model for them.
const perConversationKey = "chat:model_per_conversation"

// ThinkingLevels a conversation may ask for, on a model that reasons ("" is the model's default).
var ThinkingLevels = []string{"off", "low", "medium", "high"}

// PerConversation reports whether the person may choose a conversation's model (on by default).
func (c *Catalog) PerConversation() bool {
	var v string
	c.db.QueryRow(`SELECT value FROM settings WHERE key = ?`, perConversationKey).Scan(&v)
	return v != "off"
}

// SetPerConversation turns the choice on or off.
func (c *Catalog) SetPerConversation(on bool) error {
	v := "on"
	if !on {
		v = "off"
	}
	_, err := c.db.Exec(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, perConversationKey, v)
	return err
}

// ChoiceError is a choice that can't be used (400).
type ChoiceError struct{ Code, Message string }

func (e *ChoiceError) Error() string { return e.Message }

// CheckChoice validates a conversation's choice against the catalog. It answers the model to record ("" when it is
// the agent's own, or none was chosen) and the thinking level ("" for the model's default; a model that doesn't
// reason has none).
func (c *Catalog) CheckChoice(ctx context.Context, agentModel, modelID, thinking string) (string, string, error) {
	if modelID == agentModel {
		modelID = ""
	}
	if thinking != "" && !slices.Contains(ThinkingLevels, thinking) {
		return "", "", &ChoiceError{"invalid_thinking", "Thinking is off, low, medium or high."}
	}
	effective := agentModel
	if modelID != "" {
		if modelID == DemoModelID {
			return "", "", &ChoiceError{"invalid_model", "The demo model can't be chosen for a conversation."}
		}
		if _, err := c.RuntimeEnv(ctx, modelID); err != nil {
			msg := fmt.Sprintf("The model %s can't be used.", modelID)
			if u, ok := err.(*UnavailableError); ok {
				msg = u.Message
			}
			return "", "", &ChoiceError{"invalid_model", msg}
		}
		effective = modelID
	}
	if thinking != "" && effective != DemoModelID {
		if m, err := c.Model(ctx, effective); err == nil && !m.Reasoning {
			thinking = ""
		}
	}
	return modelID, thinking, nil
}
