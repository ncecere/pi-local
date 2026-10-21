package api

import (
	"bytes"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/ncecere/pi-local/internal/activity"
)

// The audit log (docs/api.md, "Activity").
func (a *API) activityRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/activity", a.listActivity)
	m.HandleFunc("GET /api/activity/export", a.exportActivity)
	m.HandleFunc("POST /api/activity/export", a.saveActivity)
}

// activityQuery reads the filters both routes share; a bad one is a 400 already answered.
func (a *API) activityQuery(w http.ResponseWriter, r *http.Request) (activity.Query, bool) {
	v := r.URL.Query()
	q := activity.Query{Agent: strings.TrimSpace(v.Get("agent")), Thread: strings.TrimSpace(v.Get("thread")), Text: v.Get("q"), Before: strings.TrimSpace(v.Get("before"))}
	if len(q.Agent) > 64 || len(q.Thread) > 64 || len(q.Text) > 200 {
		fail(w, http.StatusBadRequest, "invalid_filter", "A filter is too long.")
		return q, false
	}
	list := func(name string) []string {
		var out []string
		for _, part := range strings.Split(v.Get(name), ",") {
			if part = strings.TrimSpace(part); part != "" {
				out = append(out, part)
			}
		}
		return out
	}
	q.Kinds, q.Outcome = list("kind"), list("outcome")
	if !activity.ValidKinds(q.Kinds) {
		fail(w, http.StatusBadRequest, "invalid_kind", "kind is one or more of "+strings.Join(activity.Kinds, ", ")+", separated by commas.")
		return q, false
	}
	if q.Before != "" {
		if _, _, ok := activity.ParseCursor(q.Before); !ok {
			fail(w, http.StatusBadRequest, "invalid_before", "before is a cursor from a previous page, or a time in Unix milliseconds.")
			return q, false
		}
	}
	if s := v.Get("since"); s != "" {
		since, err := strconv.ParseInt(s, 10, 64)
		if err != nil || since < 0 {
			fail(w, http.StatusBadRequest, "invalid_since", "since is a time in Unix milliseconds.")
			return q, false
		}
		q.Since = since
	}
	if s := v.Get("limit"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n < 1 || n > activity.MaxLimit {
			fail(w, http.StatusBadRequest, "invalid_limit", fmt.Sprintf("limit is 1 to %d.", activity.MaxLimit))
			return q, false
		}
		q.Limit = n
	}
	return q, true
}

func (a *API) listActivity(w http.ResponseWriter, r *http.Request) {
	q, good := a.activityQuery(w, r)
	if !good {
		return
	}
	items, next, err := a.Activity.List(r.Context(), q)
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal", "could not read the activity")
		return
	}
	var nextBefore any
	if next != "" {
		nextBefore = next
	}
	ok(w, map[string]any{"items": items, "nextBefore": nextBefore})
}

// activityCSV is the export of what the request's filters match (built in memory first: an error part-way is then a
// clean 500 and not a half file). It answers false when the request was refused or failed, having already said so.
func (a *API) activityCSV(w http.ResponseWriter, r *http.Request) ([]byte, string, bool) {
	q, good := a.activityQuery(w, r)
	if !good {
		return nil, "", false
	}
	var buf bytes.Buffer
	if err := a.Activity.WriteCSV(r.Context(), &buf, q); err != nil {
		if r.Context().Err() == nil {
			fail(w, http.StatusInternalServerError, "internal", "could not export the activity")
		}
		return nil, "", false
	}
	return buf.Bytes(), "pi-local-activity-" + time.Now().Format("2006-01-02-150405") + ".csv", true
}

// exportActivity is the browser's way: the CSV as a download.
func (a *API) exportActivity(w http.ResponseWriter, r *http.Request) {
	data, name, good := a.activityCSV(w, r)
	if !good {
		return
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	w.Write(data)
}

// saveActivity is the desktop app's way: the system Save dialog, then the file.
func (a *API) saveActivity(w http.ResponseWriter, r *http.Request) {
	if a.SaveDialog == nil {
		fail(w, http.StatusNotImplemented, "not_supported", "Saving through a dialog needs the desktop app.")
		return
	}
	data, name, good := a.activityCSV(w, r)
	if !good {
		return
	}
	path, err := a.SaveDialog(name)
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal", "The save dialog failed: "+err.Error())
		return
	}
	if path == "" {
		ok(w, map[string]any{"cancelled": true})
		return
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		fail(w, http.StatusInternalServerError, "internal", "Could not write "+path+": "+err.Error())
		return
	}
	ok(w, map[string]any{"path": path})
}
