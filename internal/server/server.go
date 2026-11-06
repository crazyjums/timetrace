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

// capabilities：适配器声明能提供的字段。缺失的字段界面一律显示「–」。
var capabilities = map[string][]string{
	"claude-code": {"逐事件时间戳", "用户消息", "AI 文字回复", "工具调用名与参数", "子 agent 标记"},
}
var missingFields = map[string][]string{"claude-code": {"token", "模型", "费用", "权限等待"}}

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

func (s *Server) requirements(w http.ResponseWriter, r *http.Request) {
	reqs, sn, _, _, err := s.aggregate(r.URL.Query().Get("refresh") == "1")
	if err != nil {
		fail(w, 500, err)
		return
	}
	type row struct {
		Key      string             `json:"key"`
		Name     string             `json:"name"`
		Cwd      string             `json:"cwd"`
		Active   float64            `json:"active"`
		ByPhase  map[string]float64 `json:"byPhase"`
		Tools    []string           `json:"tools"`
		Sessions int                `json:"sessions"`
		Coarse   int                `json:"coarse"`
		Turns    int                `json:"turns"`
		End      time.Time          `json:"end"`
		Start    time.Time          `json:"start"`
	}
	rows := []row{}
	for _, q := range reqs {
		n := 0
		for _, ss := range q.Sessions {
			n += len(ss.Turns)
		}
		rows = append(rows, row{q.Key(), q.Name, q.Cwd, secs(q.Active), phaseSecs(q.ByPhase), q.Tools, len(q.Sessions), q.CoarseSessions, n, q.End, q.Start})
	}
	writeJSON(w, map[string]any{"requirements": rows, "parseErrors": sn.errs, "sources": len(sn.perSrc)})
}

func (s *Server) requirement(w http.ResponseWriter, r *http.Request) {
	key := strings.TrimPrefix(r.URL.Path, "/api/requirements/")
	reqs, _, _, _, err := s.aggregate(false)
	if err != nil {
		fail(w, 500, err)
		return
	}
	for _, q := range reqs {
		if q.Key() != key {
			continue
		}
		type turn struct {
			I      int       `json:"i"`
			Start  time.Time `json:"start"`
			AI     float64   `json:"ai"`
			Wait   float64   `json:"wait"`
			Idle   float64   `json:"idle"`
			Phase  string    `json:"phase"`
			Prompt string    `json:"prompt"`
		}
		type sess struct {
			ID        string    `json:"id"`
			Tool      string    `json:"tool"`
			Title     string    `json:"title"`
			File      string    `json:"file"`
			Precision string    `json:"precision"`
			Start     time.Time `json:"start"`
			End       time.Time `json:"end"`
			Active    float64   `json:"active"`
			Turns     []turn    `json:"turns"`
		}
		out := []sess{}
		for _, ss := range q.Sessions {
			x := sess{ss.Session.ID, ss.Session.Tool, ss.Session.Title, ss.Session.File, string(ss.Session.Precision), ss.Session.StartedAt, ss.Session.EndedAt, 0, []turn{}}
			for i, t := range ss.Turns {
				x.Active += secs(t.AI + t.Wait)
				x.Turns = append(x.Turns, turn{i, t.Start, secs(t.AI), secs(t.Wait), secs(t.Idle), string(t.Phase), t.Prompt})
			}
			out = append(out, x)
		}
		writeJSON(w, map[string]any{"key": q.Key(), "name": q.Name, "cwd": q.Cwd, "active": secs(q.Active), "idle": secs(q.Idle),
			"byPhase": phaseSecs(q.ByPhase), "coarse": q.CoarseSessions, "sessions": out})
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
					Kind string    `json:"kind"`
					T    time.Time `json:"t"`
					Text string    `json:"text"`
					Arg  string    `json:"arg"`
				}
				items := []item{}
				for _, it := range t.Items {
					items = append(items, item{it.Kind, it.T, it.Text, it.Arg})
				}
				writeJSON(w, map[string]any{"phase": string(t.Phase), "ai": secs(t.AI), "items": items})
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
	type row struct {
		Name    string  `json:"name"`
		Active  float64 `json:"active"`
		Running bool    `json:"running"`
	}
	rows := []row{}
	var total float64
	for _, it := range core.Today(reqs, time.Now(), cfg) {
		rows = append(rows, row{it.Name, secs(it.Active), it.Running})
		total += secs(it.Active)
	}
	writeJSON(w, map[string]any{"items": rows, "total": total})
}

func (s *Server) insights(w http.ResponseWriter, r *http.Request) {
	days, _ := strconv.Atoi(r.URL.Query().Get("days"))
	if days <= 0 {
		days = 7
	}
	sn, st, err := s.load(false)
	if err != nil {
		fail(w, 500, err)
		return
	}
	cfg := st.Settings.Config()
	cfg.Overrides = &st.Overrides
	now, d := time.Now(), time.Duration(days)*24*time.Hour
	in := func(from, to time.Time) []*model.Session {
		var out []*model.Session
		for _, x := range sn.sessions {
			if !x.StartedAt.Before(from) && x.StartedAt.Before(to) {
				out = append(out, x)
			}
		}
		return out
	}
	cur := core.Aggregate(in(now.Add(-d), now), cfg)
	prev := core.Aggregate(in(now.Add(-2*d), now.Add(-d)), cfg)
	rep := insights.Build(cur, prev)
	out := map[string]any{"days": days, "suggestions": append([]string{}, rep.Suggestions...), "topReqs": rep.TopReqs}
	if rep.TopPhase != nil {
		out["topPhase"] = map[string]any{"phase": string(rep.TopPhase.Phase), "sec": secs(rep.TopPhase.D), "pct": rep.TopPhase.Pct}
	}
	if rep.Delta != nil {
		out["delta"] = map[string]float64{"cur": secs(rep.Delta.Cur), "prev": secs(rep.Delta.Prev)}
	}
	writeJSON(w, out)
}

func (s *Server) sources(w http.ResponseWriter, r *http.Request) {
	sn, _, err := s.load(r.URL.Query().Get("refresh") == "1")
	if err != nil {
		fail(w, 500, err)
		return
	}
	writeJSON(w, map[string]any{"sources": sn.perSrc, "capabilities": capabilities, "missing": missingFields})
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
		fail(w, 400, fmt.Errorf("未知适配器 %q", in.Adapter))
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
	writeJSON(w, map[string]any{"sessions": len(ss), "turns": turns, "failed": len(errs), "errors": errs, "capabilities": capabilities[in.Adapter], "missing": missingFields[in.Adapter]})
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
