package app

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/url"
	"os/exec"
	goruntime "runtime"
	"slices"
	"strings"
	"time"

	"github.com/ncecere/pi-local/internal/judge"
	"github.com/ncecere/pi-local/internal/knowledge"
	"github.com/ncecere/pi-local/internal/usage"
)

// knowledgeFolders are every agent's knowledge folders, together: what the index keeps and watches.
func (a *App) knowledgeFolders() []string {
	var out []string
	for _, ag := range a.Agents.List() {
		for _, f := range ag.Config.Knowledge.Folders {
			if !slices.Contains(out, f) {
				out = append(out, f)
			}
		}
	}
	return out
}

// syncKnowledge tells the index which folders are wanted now (an agent was made, changed or deleted).
func (a *App) syncKnowledge() {
	if a.Knowledge != nil {
		a.Knowledge.SetFolders(a.knowledgeFolders())
	}
}

// knowledgeEnv is a runtime's knowledge settings: the search tool, and the folders its file tools may read.
func knowledgeEnv(folders []string, env map[string]string) {
	if len(folders) == 0 {
		return
	}
	env["KNOWLEDGE"] = "on"
	raw, _ := json.Marshal(folders)
	env["KNOWLEDGE_FOLDERS"] = string(raw)
	// The agent can open whole files from its folders (read-only): `read` is there even for an agent that has no other
	// workspace tool.
	tools := strings.Split(env["WORKSPACE_TOOLS"], ",")
	if !slices.Contains(tools, "read") {
		if env["WORKSPACE_TOOLS"] == "" {
			env["WORKSPACE_TOOLS"] = "read"
		} else {
			env["WORKSPACE_TOOLS"] += ",read"
		}
	}
}

// KnowledgeLink is what a citation links to: this agent's own endpoint for the file (the conversation's link opens it).
func KnowledgeLink(agentID, path string) string {
	return "/api/agents/" + agentID + "/knowledge/file?path=" + strings.ReplaceAll(url.QueryEscape(path), "+", "%20")
}

// knowledgeGateway is search_knowledge: the agent's folders searched, and the best passages judged when fast
// judgments are on for knowledge.
type knowledgeGateway struct{ a *App }

type knowledgePassage struct {
	File    string `json:"file"`
	Path    string `json:"path"`
	Locator string `json:"locator,omitempty"`
	Text    string `json:"text"`
	Link    string `json:"link"`
}

type knowledgeAnswer struct {
	Passages []knowledgePassage `json:"passages"`
	Searched struct {
		Folders  int `json:"folders"`
		Files    int `json:"files"`
		Passages int `json:"passages"`
	} `json:"searched"`
	Indexing *knowledge.Progress `json:"indexing,omitempty"`
	// Reranked: the passages were judged for relevance (fast judgments).
	Reranked bool   `json:"reranked"`
	Notice   string `json:"notice,omitempty"`
}

func (g knowledgeGateway) Search(ctx context.Context, agentID, query string, limit int) (any, error) {
	ag, err := g.a.Agents.Get(agentID)
	if err != nil {
		return nil, err
	}
	folders := ag.Config.Knowledge.Folders
	if len(folders) == 0 {
		return nil, knowledge.ErrNoFolders
	}
	if limit <= 0 {
		limit = 5
	}
	// The index's ranking finds the best 20; fast judgments, when on, pick the best of those.
	hits, info, err := g.a.Knowledge.Search(ctx, folders, query, judge.MaxPassagesJudged)
	if err != nil {
		return nil, err
	}
	reranked := false
	if len(hits) > 0 && g.a.Judge != nil && g.a.Judge.On("knowledge") && g.a.budgetCheck("knowledge judgment")(ctx, agentID) == nil {
		texts := make([]string, len(hits))
		for i, h := range hits {
			texts[i] = h.File + "\n" + h.Text
		}
		jctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		// Judgments have no configured prices: count attempts and available tokens as unpriced usage.
		// A stopped budget skips only the judgment above, never the local search.
		order, jerr := g.a.Judge.RankPassages(jctx, query, texts, limit, func(model string, input, output int64) {
			if recordErr := g.a.RecordUsage(context.WithoutCancel(ctx), agentID, "judgments/"+model, usage.Counts{Requests: 1, Input: input, Output: output}); recordErr != nil {
				slog.Warn("recording knowledge judgment usage", "err", recordErr)
			}
		})
		cancel()
		if jerr == nil {
			picked := make([]knowledge.Hit, 0, len(order))
			for _, i := range order {
				picked = append(picked, hits[i])
			}
			hits, reranked = picked, true
		} else if !errors.Is(jerr, judge.ErrOff) {
			// A failed judgment is no judgment: the index's own order stands.
			slog.Info("judging knowledge passages failed", "agent", agentID, "err", jerr)
		}
	}
	if len(hits) > limit {
		hits = hits[:limit]
	}
	out := knowledgeAnswer{Passages: []knowledgePassage{}, Reranked: reranked, Indexing: info.Indexing}
	out.Searched.Folders, out.Searched.Files, out.Searched.Passages = info.Folders, info.Files, info.Passages
	for _, h := range hits {
		out.Passages = append(out.Passages, knowledgePassage{File: h.File, Path: h.Path, Locator: h.Locator, Text: h.Text, Link: KnowledgeLink(agentID, h.Path)})
	}
	switch {
	case info.Folders == 0:
		out.Notice = "The agent's knowledge folders aren't on this computer right now (a drive unplugged?), so nothing could be searched."
	case info.Files == 0 && info.Indexing == nil:
		out.Notice = "Nothing in the knowledge folders could be read: they hold no text, Markdown, PDF, Word, Excel or PowerPoint files."
	}
	return out, nil
}

// OpenFile opens a file with the application the system chooses for it, or shows it in the Finder (reveal).
func (a *App) OpenFile(path string, reveal bool) error {
	if a.cfg.OpenFile != nil {
		return a.cfg.OpenFile(path, reveal)
	}
	if reveal {
		return a.RevealFile(path)
	}
	opener := "open"
	if goruntime.GOOS == "linux" {
		opener = "xdg-open"
	}
	cmd := exec.Command(opener, path)
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}
