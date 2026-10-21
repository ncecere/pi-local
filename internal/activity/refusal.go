package activity

import (
	"errors"

	"github.com/ncecere/pi-local/internal/budget"
)

// Refused records work an agent was refused because a budget is used up (err is what budget.Service.Check answered; any
// other error, or none, records nothing). via says what was refused: message, ask or schedule.
func (s *Store) Refused(agentID, via string, err error) {
	var over *budget.OverBudgetError
	if s == nil || err == nil || !errors.As(err, &over) {
		return
	}
	s.Record(Entry{Kind: KindBudget, AgentID: agentID, Actor: "Pi Local", Title: over.Message, Outcome: "refused",
		Detail: Detail(map[string]any{"via": via, "scope": over.Status.Scope, "monthlyUsd": over.Status.MonthlyUSD, "spentUsd": over.Status.SpentUSD})})
}
