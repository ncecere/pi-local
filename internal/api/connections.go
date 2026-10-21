package api

import "net/http"

func (a *API) listConnections(w http.ResponseWriter, r *http.Request) {
	list, err := a.MCP.Connections(r.Context())
	if err != nil {
		mcpFailure(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	ok(w, list)
}
func (a *API) connect(w http.ResponseWriter, r *http.Request) {
	result, err := a.MCP.Connect(r.Context(), r.PathValue("id"))
	if err != nil {
		mcpFailure(w, err)
		return
	}
	ok(w, result)
}
func (a *API) disconnect(w http.ResponseWriter, r *http.Request) {
	if err := a.MCP.Disconnect(r.Context(), r.PathValue("id")); err != nil {
		mcpFailure(w, err)
		return
	}
	ok(w, map[string]bool{"ok": true})
}
