// Package server 提供只绑定本机的 JSON API 与内嵌的静态界面。
// 界面可被浏览器或 Electron 外壳加载；两者看到的是同一份页面。
package server

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/crazyjums/timetrace/internal/adapter"
	"github.com/crazyjums/timetrace/internal/adapter/claudecode"
	"github.com/crazyjums/timetrace/internal/core"
	"github.com/crazyjums/timetrace/internal/insights"
	"github.com/crazyjums/timetrace/internal/llm"
	"github.com/crazyjums/timetrace/internal/model"
	"github.com/crazyjums/timetrace/internal/store"
)

//go:embed web
var webFS embed.FS

type Server struct {
	StatePath string
	mu        sync.Mutex
	cache     *snapshot
}

type snapshot struct {
	at       time.Time
	sessions []*model.Session
	errs     []model.ParseError
	perSrc   []srcInfo
}

type srcInfo struct {
	store.Source
	Files    int                `json:"files"`
	Sessions int                `json:"sessions"`
	Errors   []model.ParseError `json:"errors"`
	Missing  bool               `json:"missing"`
}

func New(statePath string) *Server { return &Server{StatePath: statePath} }

// adapters 是内置适配器注册表；新增工具只在这里加一行。
func adapterFor(id string) adapter.Adapter {
	if id == "claude-code" {
		return claudecode.Adapter{}
	}
	return nil
}

func (s *Server) load(force bool) (*snapshot, store.File, error) {
	st, err := store.Load(s.StatePath)
	if err != nil {
		return nil, st, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !force && s.cache != nil && time.Since(s.cache.at) < 5*time.Second {
		return s.cache, st, nil
	}
	sn := &snapshot{at: time.Now()}
	for _, src := range st.Settings.Sources {
		if !src.Enabled {
			continue
		}
		info := srcInfo{Source: src, Errors: []model.ParseError{}}
		a := adapterFor(src.Adapter)
		if a == nil {
			info.Errors = append(info.Errors, model.ParseError{File: src.Dir, Reason: "未知适配器 " + src.Adapter})
		} else if ss, errs, err := adapter.ScanAll(a, src.Dir); err != nil {
			info.Missing = true
			info.Errors = append(info.Errors, model.ParseError{File: src.Dir, Reason: err.Error()})
		} else {
			info.Sessions, info.Files = len(ss), len(ss)+len(errs)
			info.Errors = append(info.Errors, errs...)
			sn.sessions = append(sn.sessions, ss...)
			sn.errs = append(sn.errs, errs...)
		}
		sn.perSrc = append(sn.perSrc, info)
	}
	s.cache = sn
	return sn, st, nil
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	sub, _ := fs.Sub(webFS, "web")
	mux.Handle("/", http.FileServer(http.FS(sub)))
	api := func(path string, h func(http.ResponseWriter, *http.Request)) {
		mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
			if !localHost(r.Host) {
				http.Error(w, "仅允许本机访问", http.StatusForbidden)
				return
			}
			// 修改类请求必须带自定义头：浏览器跨站表单无法设置它，防 CSRF
			if r.Method != http.MethodGet && r.Header.Get("X-Timetrace") != "1" {
				http.Error(w, "缺少 X-Timetrace 头", http.StatusForbidden)
				return
			}
			h(w, r)
		})
	}
	api("/api/requirements", s.requirements)
	api("/api/requirements/", s.requirement)
	api("/api/turn", s.turn)
	api("/api/today", s.today)
	api("/api/insights", s.insights)
	api("/api/sources", s.sources)
	api("/api/sources/test", s.sourceTest)
	api("/api/settings", s.settings)
	api("/api/overrides", s.overrides)
	api("/api/llm/preview", s.llmPreview)
	api("/api/llm/send", s.llmSend)
	return mux
}

func localHost(h string) bool {
	host, _, err := net.SplitHostPort(h)
	if err != nil {
		host = h
	}
	return host == "127.0.0.1" || host == "localhost" || host == "[::1]" || host == "::1"
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, code int, err error) {
	http.Error(w, err.Error(), code)
}

func secs(d time.Duration) float64 { return d.Seconds() }

func phaseSecs(m map[core.Phase]time.Duration) map[string]float64 {
	out := map[string]float64{}
	for p, d := range m {
		out[string(p)] = secs(d)
	}
	return out
}

func (s *Server) aggregate(force bool) ([]*core.Requirement, *snapshot, store.File, core.Config, error) {
	sn, st, err := s.load(force)
	if err != nil {
		return nil, nil, st, core.Config{}, err
	}
	cfg := st.Settings.Config()
	cfg.Overrides = &st.Overrides
	return core.Aggregate(sn.sessions, cfg), sn, st, cfg, nil
}

func validRange(r string) string {
	switch r {
	case "today", "week", "month", "all":
		return r
	}
	return "week"
}

func statsJSON(st core.Stats) map[string]any {
	return map[string]any{"active": secs(st.Active), "ai": secs(st.AI), "wait": secs(st.Wait), "idle": secs(st.Idle),
		"byPhase": phaseSecs(st.ByPhase), "turns": st.Turns, "longTurns": st.LongTurns, "sessions": st.Sessions, "coarse": st.Coarse}
}

// live：该需求是否有「运行中」的会话（最后事件距现在小于空闲阈值，且 AI 还在干活）。
func live(r *core.Requirement, now time.Time, cfg core.Config) bool {
	for _, ss := range r.Sessions {
		if ss.Tail == core.TailWorking && !now.Before(ss.Session.EndedAt) && now.Sub(ss.Session.EndedAt) < cfg.IdleThreshold {
			return true
		}
	}
	return false
}

func (s *Server) requirements(w http.ResponseWriter, r *http.Request) {
	reqs, sn, _, cfg, err := s.aggregate(r.URL.Query().Get("refresh") == "1")
	if err != nil {
		fail(w, 500, err)
		return
	}
	rng := validRange(r.URL.Query().Get("range"))
	now := time.Now()
	from, to, _, _ := core.Period(rng, now)
	home, _ := os.UserHomeDir()
	rows := []map[string]any{}
	for _, q := range reqs {
		st := q.Stats(from, to)
		if st.Turns == 0 && st.Coarse == 0 {
			continue
		}
		row := statsJSON(st)
		row["key"], row["name"], row["cwd"], row["tools"] = q.Key(), q.Name, q.Cwd, q.Tools
		row["end"], row["running"] = q.End, live(q, now, cfg)
		rows = append(rows, row)
	}
	writeJSON(w, map[string]any{"range": rng, "home": home, "requirements": rows, "parseErrors": sn.errs, "sources": len(sn.perSrc)})
}

func (s *Server) requirement(w http.ResponseWriter, r *http.Request) {
	key := strings.TrimPrefix(r.URL.Path, "/api/requirements/")
	reqs, _, _, cfg, err := s.aggregate(false)
	if err != nil {
		fail(w, 500, err)
		return
	}
	home, _ := os.UserHomeDir()
	now := time.Now()
	for _, q := range reqs {
		if q.Key() != key {
			continue
		}
		type turn struct {
			I     int       `json:"i"`
			Start time.Time `json:"start"`
			AI    float64   `json:"ai"`
			Wait  float64   `json:"wait"`
			Idle  float64   `json:"idle"`
			Phase string    `json:"phase"`
			Long  bool      `json:"long"`
		}
		type sess struct {
			ID        string    `json:"id"`
			Tool      string    `json:"tool"`
			Title     string    `json:"title"`
			Precision string    `json:"precision"`
			Start     time.Time `json:"start"`
			End       time.Time `json:"end"`
			Active    float64   `json:"active"`
			Turns     []turn    `json:"turns"`
		}
		out := []sess{}
		toolCount := map[string]int{}
		for _, ss := range q.Sessions {
			toolCount[ss.Session.Tool]++
			x := sess{ss.Session.ID, ss.Session.Tool, ss.Session.Title, string(ss.Session.Precision), ss.Session.StartedAt, ss.Session.EndedAt, 0, []turn{}}
			for i, t := range ss.Turns {
				x.Active += secs(t.AI + t.Wait)
				x.Turns = append(x.Turns, turn{i, t.Start, secs(t.AI), secs(t.Wait), secs(t.Idle), string(t.Phase), t.AI > core.LongTurn})
			}
			out = append(out, x)
		}
		sib := []map[string]string{}
		for _, o := range reqs {
			if o.Key() != key {
				sib = append(sib, map[string]string{"key": o.Key(), "name": o.Name, "cwd": o.Cwd})
			}
		}
		d := statsJSON(q.Stats(time.Time{}, time.Time{}))
		d["key"], d["name"], d["cwd"], d["home"] = q.Key(), q.Name, q.Cwd, home
		d["start"], d["end"], d["running"] = q.Start, q.End, live(q, now, cfg)
		d["toolCount"], d["sessionList"], d["siblings"] = toolCount, out, sib
		writeJSON(w, d)
		return
	}
	http.NotFound(w, r)
}

func (s *Server) turn(w http.ResponseWriter, r *http.Request) {
	sid, i := r.URL.Query().Get("sid"), r.URL.Query().Get("i")
	idx, err := strconv.Atoi(i)
	reqs, _, _, _, aerr := s.aggregate(false)
	if err != nil || aerr != nil {
		fail(w, 400, fmt.Errorf("参数错误"))
		return
	}
	for _, q := range reqs {
		for _, ss := range q.Sessions {
			if ss.Session.ID == sid && idx >= 0 && idx < len(ss.Turns) {
				t := ss.Turns[idx]
				type item struct {
					Kind   string    `json:"kind"`
					T      time.Time `json:"t"`
					Text   string    `json:"text"`
					Arg    string    `json:"arg"`
					Dur    float64   `json:"dur"`
					Model  string    `json:"model"`
					TokIn  int       `json:"tokIn"`
					TokOut int       `json:"tokOut"`
				}
				items := []item{}
				for _, it := range t.Items {
					items = append(items, item{it.Kind, it.T, it.Text, it.Arg, secs(it.Dur), it.Model, it.TokIn, it.TokOut})
				}
				writeJSON(w, map[string]any{"i": idx, "sid": sid, "tool": ss.Session.Tool, "precision": string(ss.Session.Precision),
					"start": t.Start, "phase": string(t.Phase), "ai": secs(t.AI), "branch": ss.Session.Branch, "items": items})
				return
			}
		}
	}
	http.NotFound(w, r)
}

func (s *Server) today(w http.ResponseWriter, r *http.Request) {
	reqs, _, _, cfg, err := s.aggregate(true)
	if err != nil {
		fail(w, 500, err)
		return
	}
	now := time.Now()
	type block struct {
		Start time.Time `json:"start"`
		AI    float64   `json:"ai"`
		Wait  float64   `json:"wait"`
		Phase string    `json:"phase"`
	}
	var tot core.Stats
	tot.ByPhase = map[core.Phase]time.Duration{}
	rows := []map[string]any{}
	for _, t := range core.Today(reqs, now, cfg) {
		tot.Active += t.Stats.Active
		tot.AI += t.Stats.AI
		tot.Wait += t.Stats.Wait
		tot.Idle += t.Stats.Idle
		bl := []block{}
		for _, b := range t.Blocks {
			bl = append(bl, block{b.Start, secs(b.AI), secs(b.Wait), string(b.Phase)})
		}
		row := statsJSON(t.Stats)
		row["key"], row["name"], row["tools"], row["status"] = t.Key, t.Name, t.Tools, t.Status
		row["waitingFor"], row["endedAt"], row["blocks"] = secs(t.WaitingFor), t.EndedAt, bl
		rows = append(rows, row)
	}
	writeJSON(w, map[string]any{"now": now, "idleMinutes": int(cfg.IdleThreshold.Minutes()), "items": rows, "total": statsJSON(tot)})
}

func (s *Server) insights(w http.ResponseWriter, r *http.Request) {
	reqs, _, _, _, err := s.aggregate(false)
	if err != nil {
		fail(w, 500, err)
		return
	}
	rng := r.URL.Query().Get("range")
	if rng != "today" && rng != "month" {
		rng = "week"
	}
	from, to, pf, pt := core.Period(rng, time.Now())
	named := func(f, t time.Time) []insights.Named {
		var o []insights.Named
		for _, q := range reqs {
			o = append(o, insights.Named{Key: q.Key(), Name: q.Name, S: q.Stats(f, t)})
		}
		return o
	}
	rep := insights.Build(named(from, to), named(pf, pt))
	ph := func(p *insights.PhaseShare) any {
		if p == nil {
			return nil
		}
		return map[string]any{"phase": string(p.Phase), "sec": secs(p.D), "pct": p.Pct}
	}
	rank := []map[string]any{}
	for _, p := range rep.Ranking {
		rank = append(rank, map[string]any{"phase": string(p.Phase), "sec": secs(p.D), "pct": p.Pct})
	}
	top := []map[string]any{}
	for _, n := range rep.TopReqs {
		top = append(top, map[string]any{"key": n.Key, "name": n.Name, "active": secs(n.S.Active), "byPhase": phaseSecs(n.S.ByPhase)})
	}
	sug := []map[string]string{}
	for _, x := range rep.Suggestions {
		sug = append(sug, map[string]string{"title": x.Title, "detail": x.Detail, "try": x.Try, "basis": x.Basis})
	}
	out := map[string]any{"range": rng, "active": secs(rep.Active), "ai": secs(rep.AI), "wait": secs(rep.Wait), "waitPct": rep.WaitPct,
		"top": ph(rep.Top), "second": ph(rep.Second), "ranking": rank, "topReqs": top, "coarse": append([]string{}, rep.CoarseReqs...), "suggestions": sug, "reqCount": len(rep.TopReqs)}
	if rep.HasPrev {
		out["prevActive"] = secs(rep.PrevActive)
	}
	writeJSON(w, out)
}

// 适配器目录：界面展示所有已知工具；只有已实现的才能启用。
type toolInfo struct {
	ID, Name, DefaultPath string
	Precision             string // exact | coarse
	Implemented           bool
}

var toolCatalog = []toolInfo{
	{"claude-code", "Claude Code", "~/.claude/projects", "exact", true},
	{"codex", "Codex CLI", "~/.codex/sessions", "exact", false},
	{"pi", "pi", "~/.pi/agent/sessions", "exact", false},
	{"omp", "omp", "~/.omp/agent/sessions", "exact", false},
	{"cursor", "Cursor 转录", "~/.cursor/projects/*/agent-transcripts", "coarse", false},
}

// capCols 是能力矩阵的列；每个适配器声明自己提供哪些。没有的显示「–」，不估算。
var capCols = []string{"逐事件时间戳", "token", "模型", "费用", "子 agent", "权限等待", "分支"}
var capHas = map[string][]bool{"claude-code": {true, true, true, false, true, false, true}}

func (s *Server) sources(w http.ResponseWriter, r *http.Request) {
	sn, st, err := s.load(r.URL.Query().Get("refresh") == "1")
	if err != nil {
		fail(w, 500, err)
		return
	}
	tools := []map[string]any{}
	for _, t := range toolCatalog {
		row := map[string]any{"id": t.ID, "name": t.Name, "defaultPath": t.DefaultPath, "precision": t.Precision, "implemented": t.Implemented,
			"files": 0, "sessions": 0, "failed": 0, "configured": false, "enabled": false, "missing": false}
		for i, src := range st.Settings.Sources {
			if src.Adapter != t.ID {
				continue
			}
			row["configured"], row["enabled"], row["dir"], row["index"] = true, src.Enabled, src.Dir, i
			for _, info := range sn.perSrc {
				if info.Dir == src.Dir && info.Adapter == src.Adapter {
					row["files"], row["sessions"], row["failed"], row["missing"] = info.Files, info.Sessions, len(info.Errors), info.Missing
				}
			}
		}
		tools = append(tools, row)
	}
	caps := map[string][]bool{}
	for _, t := range toolCatalog {
		if h, ok := capHas[t.ID]; ok {
			caps[t.ID] = h
		} else {
			caps[t.ID] = make([]bool, len(capCols))
		}
	}
	writeJSON(w, map[string]any{"tools": tools, "capCols": capCols, "caps": caps, "parseErrors": sn.errs, "sources": sn.perSrc})
}

// sourceTest：添加数据源前的「测试扫描」，不保存任何东西。
func (s *Server) sourceTest(w http.ResponseWriter, r *http.Request) {
	var in store.Source
	if json.NewDecoder(r.Body).Decode(&in) != nil {
		fail(w, 400, fmt.Errorf("请求体不是合法 JSON"))
		return
	}
	a := adapterFor(in.Adapter)
	if a == nil {
		fail(w, 400, fmt.Errorf("适配器 %q 尚未实现", in.Adapter))
		return
	}
	ss, errs, err := adapter.ScanAll(a, in.Dir)
	if err != nil {
		fail(w, 400, err)
		return
	}
	turns := 0
	cfg := core.DefaultConfig()
	for _, x := range ss {
		turns += len(core.BuildTurns(x, cfg))
	}
	writeJSON(w, map[string]any{"sessions": len(ss), "turns": turns, "failed": len(errs), "errors": errs})
}

func (s *Server) settings(w http.ResponseWriter, r *http.Request) {
	st, err := store.Load(s.StatePath)
	if err != nil {
		fail(w, 500, err)
		return
	}
	if r.Method == http.MethodPut {
		var in store.Settings
		if json.NewDecoder(r.Body).Decode(&in) != nil || in.IdleMinutes < 1 || in.WindowHours < 1 {
			fail(w, 400, fmt.Errorf("设置不合法：空闲阈值与聚合窗口必须 ≥ 1"))
			return
		}
		for _, src := range in.Sources {
			if adapterFor(src.Adapter) == nil {
				fail(w, 400, fmt.Errorf("未知适配器 %q", src.Adapter))
				return
			}
		}
		st.Settings = in
		if err := store.Save(s.StatePath, st); err != nil {
			fail(w, 500, err)
			return
		}
		s.mu.Lock()
		s.cache = nil
		s.mu.Unlock()
	}
	writeJSON(w, st.Settings)
}

func (s *Server) overrides(w http.ResponseWriter, r *http.Request) {
	st, err := store.Load(s.StatePath)
	if err != nil {
		fail(w, 500, err)
		return
	}
	if r.Method == http.MethodGet {
		writeJSON(w, st.Overrides)
		return
	}
	var in struct {
		Op   string   `json:"op"` // rename | phase | merge | split | unsplit | unmerge
		Key  string   `json:"key"`
		Name string   `json:"name"`
		Sid  string   `json:"sid"`
		Turn int      `json:"turn"`
		P    string   `json:"phase"`
		Sids []string `json:"sids"`
	}
	if json.NewDecoder(r.Body).Decode(&in) != nil {
		fail(w, 400, fmt.Errorf("请求体不是合法 JSON"))
		return
	}
	o := &st.Overrides
	switch in.Op {
	case "rename":
		if o.Rename == nil {
			o.Rename = map[string]string{}
		}
		if strings.TrimSpace(in.Name) == "" {
			delete(o.Rename, in.Key)
		} else {
			o.Rename[in.Key] = in.Name
		}
	case "phase":
		if o.Phase == nil {
			o.Phase = map[string]core.Phase{}
		}
		k := fmt.Sprintf("%s#%d", in.Sid, in.Turn)
		if in.P == "" {
			delete(o.Phase, k)
		} else if len(in.P) == 1 && strings.Contains("PRCFTO", in.P) {
			o.Phase[k] = core.Phase(in.P)
		} else {
			fail(w, 400, fmt.Errorf("阶段必须是 P R C F T O"))
			return
		}
	case "merge":
		if len(in.Sids) < 2 {
			fail(w, 400, fmt.Errorf("合并至少需要两个会话"))
			return
		}
		o.Merge = append(o.Merge, in.Sids)
	case "split":
		o.SplitAt = append(o.SplitAt, in.Sid)
	case "reset": // 撤销该会话相关的合并 / 拆分
		var sp []string
		for _, x := range o.SplitAt {
			if x != in.Sid {
				sp = append(sp, x)
			}
		}
		o.SplitAt = sp
		var mg [][]string
		for _, g := range o.Merge {
			keep := true
			for _, x := range g {
				if x == in.Sid {
					keep = false
				}
			}
			if keep {
				mg = append(mg, g)
			}
		}
		o.Merge = mg
	default:
		fail(w, 400, fmt.Errorf("未知操作 %q", in.Op))
		return
	}
	if err := store.Save(s.StatePath, st); err != nil {
		fail(w, 500, err)
		return
	}
	writeJSON(w, st.Overrides)
}

func (s *Server) payload() (llm.Payload, []byte, store.File, error) {
	reqs, _, st, _, err := s.aggregate(false)
	if err != nil {
		return llm.Payload{}, nil, st, err
	}
	p, err := llm.BuildPayload(st.Settings.LLM.Level, reqs)
	if err != nil {
		return p, nil, st, err
	}
	b, err := llm.Preview(p)
	return p, b, st, err
}

func (s *Server) llmPreview(w http.ResponseWriter, r *http.Request) {
	_, b, st, err := s.payload()
	if err != nil {
		fail(w, 500, err)
		return
	}
	writeJSON(w, map[string]any{"enabled": st.Settings.LLM.Enabled, "level": st.Settings.LLM.Level, "payload": json.RawMessage(b)})
}

func (s *Server) llmSend(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		fail(w, 405, fmt.Errorf("仅支持 POST"))
		return
	}
	_, b, st, err := s.payload()
	if err != nil {
		fail(w, 500, err)
		return
	}
	// 界面必须带回用户已预览的内容；与当前将发送的内容不一致则拒绝，避免「预览后内容变了」
	var in struct {
		Confirmed json.RawMessage `json:"confirmed"`
	}
	json.NewDecoder(r.Body).Decode(&in)
	if !sameJSON(in.Confirmed, b) {
		fail(w, 409, fmt.Errorf("发送内容与已预览内容不一致，请重新预览"))
		return
	}
	out, err := llm.Send(st.Settings.LLM, b, nil)
	if err == llm.ErrDisabled {
		fail(w, 403, err)
		return
	}
	if err != nil {
		fail(w, 502, err)
		return
	}
	writeJSON(w, map[string]string{"text": out})
}

func sameJSON(a, b []byte) bool {
	var x, y any
	if json.Unmarshal(a, &x) != nil || json.Unmarshal(b, &y) != nil {
		return false
	}
	xa, _ := json.Marshal(x)
	ya, _ := json.Marshal(y)
	return string(xa) == string(ya)
}
