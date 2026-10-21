package api

import (
	"net/http"

	"github.com/ncecere/pi-local/internal/models"
)

// Settings → Models → Per conversation: whether the person may choose a conversation's model and thinking level in
// the composer (on by default). Turned off, every conversation uses its agent's model.
func (a *API) chatSettingsRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/settings/chat", a.chatSettings)
	m.HandleFunc("PUT /api/settings/chat", a.saveChatSettings)
}

type chatSettingsJSON struct {
	ModelPerConversation bool     `json:"modelPerConversation"`
	ThinkingLevels       []string `json:"thinkingLevels"`
}

func (a *API) chatSettingsJSON() chatSettingsJSON {
	return chatSettingsJSON{ModelPerConversation: a.Catalog.PerConversation(), ThinkingLevels: models.ThinkingLevels}
}

func (a *API) chatSettings(w http.ResponseWriter, r *http.Request) {
	ok(w, a.chatSettingsJSON())
}

func (a *API) saveChatSettings(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ModelPerConversation *bool `json:"modelPerConversation"`
	}
	if !decodeBody(w, r, &in) {
		return
	}
	if in.ModelPerConversation != nil {
		if err := a.Catalog.SetPerConversation(*in.ModelPerConversation); err != nil {
			fail(w, http.StatusInternalServerError, "internal", err.Error())
			return
		}
	}
	ok(w, a.chatSettingsJSON())
}
