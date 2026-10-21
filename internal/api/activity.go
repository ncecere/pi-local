package api

import (
	"bytes"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/ncecere/pi-local/internal/activity"
)

// The audit log (docs/api.md, "Activity").
func (a *API) activityRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/activity", a.listActivity)
	m.HandleFunc("GET /api/activity/export", a.exportActivity)
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

func (a *API) exportActivity(w http.ResponseWriter, r *http.Request) {
	q, good := a.activityQuery(w, r)
	if !good {
		return
	}
	// Built in memory first: an error part-way is then a clean 500 and not a half file.
	var buf bytes.Buffer
	if err := a.Activity.WriteCSV(r.Context(), &buf, q); err != nil {
		if r.Context().Err() == nil {
			fail(w, http.StatusInternalServerError, "internal", "could not export the activity")
		}
		return
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Disposition", `attachment; filename="pi-local-activity-`+time.Now().Format("2006-01-02-150405")+`.csv"`)
	w.Write(buf.Bytes())
}
