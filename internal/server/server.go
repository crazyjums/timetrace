// Package server 提供只绑定本机的 JSON API 与内嵌的静态界面。
// 界面可被浏览器或 Electron 外壳加载；两者看到的是同一份页面。
package server

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/crazyjums/timetrace/internal/adapter"
	"github.com/crazyjums/timetrace/internal/adapter/claudecode"
	"github.com/crazyjums/timetrace/internal/core"
	"github.com/crazyjums/timetrace/internal/index"
	"github.com/crazyjums/timetrace/internal/insights"
	"github.com/crazyjums/timetrace/internal/llm"
	"github.com/crazyjums/timetrace/internal/model"
	"github.com/crazyjums/timetrace/internal/store"
	"github.com/crazyjums/timetrace/internal/update"
)

//go:embed web
var webFS embed.FS

type Server struct {
	StatePath string
	Index     *index.Index
	Update    *update.Checker // 检查 GitHub 上的新版本；只请求版本号，不发送本地数据

	mu   sync.Mutex
	memo struct {
		ok        bool
		gen       uint64
		stateHash uint64
		reqs      []*core.Requirement
		cfg       core.Config
	}
	wake chan struct{}
}

// snapshot 是处理请求时用到的索引视图（来自内存索引，不读磁盘上的日志）。
type snapshot struct {
	gen      uint64
	sessions []*model.Session
	errs     []model.ParseError
	perSrc   []srcInfo
	byID     map[string]*model.Session
}

type srcInfo struct {
	store.Source
	Files    int                `json:"files"`
	Sessions int                `json:"sessions"`
	Errors   []model.ParseError `json:"errors"`
	Missing  bool               `json:"missing"`
}

// New：cachePath 为空则不持久化索引（测试用）。
func New(statePath, cachePath string) *Server {
	return &Server{StatePath: statePath, Index: index.New(cachePath, adapterFor), Update: update.New(""), wake: make(chan struct{}, 1)}
}

// adapters 是内置适配器注册表；新增工具只在这里加一行。
func adapterFor(id string) adapter.Adapter {
	if id == "claude-code" {
		return claudecode.Adapter{}
	}
	return nil
}

func enabledSources(st store.File) []index.Source {
	var out []index.Source
	for _, src := range st.Settings.Sources {
		if src.Enabled {
			out = append(out, index.Source{Adapter: src.Adapter, Dir: src.Dir})
		}
	}
	return out
}

func (s *Server) rescan() error {
	st, err := store.Load(s.StatePath)
	if err != nil {
		return err
	}
	before, t0 := s.Index.Parsed.Load(), time.Now()
	changed, err := s.Index.Scan(enabledSources(st))
	if n := s.Index.Parsed.Load() - before; changed || n > 0 {
		log.Printf("索引更新：解析 %d 个文件，共 %d 个会话，用时 %v", n, s.Index.Status().Sessions, time.Since(t0).Round(time.Millisecond))
	}
	return err
}

// Start 读取上次的索引缓存，然后在后台扫描，并每隔 interval 增量刷新一次。
// 只有新增或变化的文件会被重新解析。
func (s *Server) Start(ctx context.Context, interval time.Duration) {
	if err := s.Index.LoadCache(); err != nil {
		log.Printf("读取索引缓存失败（将重新扫描）: %v", err)
	} else if st := s.Index.Status(); st.Ready {
		log.Printf("已载入索引缓存：%d 个会话", st.Sessions)
	}
	s.startUpdateCheck(ctx)
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			if err := s.rescan(); err != nil {
				log.Printf("扫描失败: %v", err)
			}
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			case <-s.wake:
			}
		}
	}()
}

// updateEvery 是自动检查更新的间隔；启动后先等一小会儿再查，不影响启动速度。
const updateEvery = 6 * time.Hour

func (s *Server) startUpdateCheck(ctx context.Context) {
	go func() {
		wait := 5 * time.Second
		for {
			select {
			case <-ctx.Done():
				return
			case <-time.After(wait):
			}
			wait = updateEvery
			if st, err := store.Load(s.StatePath); err == nil && !st.Settings.NoUpdateCheck {
				if r := s.Update.Check(ctx); r.Available {
					log.Printf("发现新版本 v%s（当前 %s）", r.Latest.Version, r.Current)
				}
			}
		}
	}()
}

// kick 请求后台尽快重扫（不阻塞）。
func (s *Server) kick() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// load 返回内存中的索引视图。force=true（界面上的「重新扫描」）会同步扫描一次；
// 索引从未建立时也会同步建立（只发生在没有后台扫描的场景，例如测试）。
func (s *Server) load(force bool) (*snapshot, store.File, error) {
	st, err := store.Load(s.StatePath)
	if err != nil {
		return nil, st, err
	}
	if force || !s.Index.Status().Ready {
		if _, err := s.Index.Scan(enabledSources(st)); err != nil {
			return nil, st, err
		}
	}
	isn := s.Index.Snapshot()
	// 切片一律非 nil：界面会直接遍历，JSON 里不能出现 null
	sn := &snapshot{gen: isn.Gen, sessions: isn.Sessions, errs: append([]model.ParseError{}, isn.Errors...), byID: isn.ByID, perSrc: []srcInfo{}}
	for _, info := range isn.Sources {
		sn.perSrc = append(sn.perSrc, srcInfo{Source: store.Source{Adapter: info.Adapter, Dir: info.Dir, Enabled: true},
			Files: info.Files, Sessions: info.Sessions, Errors: info.Errors, Missing: info.Missing})
	}
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
	api("/api/status", s.status)
	api("/api/update", s.updateStatus)
	api("/api/session/", s.session)
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

// aggregate 返回聚合后的需求。结果按「索引代数 + 状态文件内容」缓存，
// 只有日志变化或设置 / 人工修正变化时才重新计算。
func (s *Server) aggregate(force bool) ([]*core.Requirement, *snapshot, store.File, core.Config, error) {
	sn, st, err := s.load(force)
	if err != nil {
		return nil, nil, st, core.Config{}, err
	}
	h := st.Hash()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.memo.ok && s.memo.gen == sn.gen && s.memo.stateHash == h {
		return s.memo.reqs, sn, st, s.memo.cfg, nil
	}
	cfg := st.Settings.Config()
	cfg.Overrides = &st.Overrides
	reqs := core.Aggregate(sn.sessions, cfg)
	s.memo.ok, s.memo.gen, s.memo.stateHash, s.memo.reqs, s.memo.cfg = true, sn.gen, h, reqs, cfg
	return reqs, sn, st, cfg, nil
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
	reqs, _, _, cfg, err := s.aggregate(false)
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
		s.kick() // 数据源可能变了：后台增量重扫
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

func (s *Server) status(w http.ResponseWriter, r *http.Request) {
	st, _ := store.Load(s.StatePath)
	dirs := []string{}
	for _, src := range enabledSources(st) {
		dirs = append(dirs, src.Dir)
	}
	writeJSON(w, map[string]any{"index": s.Index.Status(), "dirs": dirs})
}

// 对话里单个块的最大长度；超出部分截断并标注原长度（原文件不受影响）。
const (
	maxResult = 20000
	maxBlock  = 200000
)

func clip(t string, n int) (string, int, bool) {
	if len(t) <= n {
		return t, len(t), false
	}
	cut := n
	for cut > 0 && !utf8.RuneStart(t[cut]) {
		cut--
	}
	return t[:cut], len(t), true
}

func prettyJSON(raw string) string {
	var v any
	if json.Unmarshal([]byte(raw), &v) != nil {
		return raw
	}
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return raw
	}
	return string(b)
}

// session: GET /api/session/<id> 返回会话元信息与逐轮计时；
// GET /api/session/<id>/transcript 按需读取原文件，还原完整对话。
func (s *Server) session(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/session/")
	sid, sub, _ := strings.Cut(rest, "/")
	if sub == "transcript" {
		s.transcript(w, sid)
		return
	}
	reqs, _, _, _, err := s.aggregate(false)
	if err != nil {
		fail(w, 500, err)
		return
	}
	home, _ := os.UserHomeDir()
	for _, q := range reqs {
		for _, ss := range q.Sessions {
			if ss.Session.ID != sid {
				continue
			}
			x := ss.Session
			type turn struct {
				I      int       `json:"i"`
				Start  time.Time `json:"start"`
				AI     float64   `json:"ai"`
				Wait   float64   `json:"wait"`
				Idle   float64   `json:"idle"`
				Phase  string    `json:"phase"`
				Long   bool      `json:"long"`
				Prompt string    `json:"prompt"`
			}
			turns := []turn{}
			var ai, wait, idle time.Duration
			for i, t := range ss.Turns {
				p, _, _ := clip(t.Prompt, 120)
				turns = append(turns, turn{i, t.Start, secs(t.AI), secs(t.Wait), secs(t.Idle), string(t.Phase), t.AI > core.LongTurn, p})
				ai, wait, idle = ai+t.AI, wait+t.Wait, idle+t.Idle
			}
			var tin, tout int
			models := []string{}
			seenModel := map[string]bool{}
			for _, e := range x.Events {
				tin, tout = tin+e.TokIn, tout+e.TokOut
				if e.Model != "" && !seenModel[e.Model] {
					seenModel[e.Model] = true
					models = append(models, e.Model)
				}
			}
			writeJSON(w, map[string]any{"id": x.ID, "tool": x.Tool, "title": x.Title, "cwd": x.Cwd, "home": home, "branch": x.Branch, "file": x.File,
				"precision": string(x.Precision), "start": x.StartedAt, "end": x.EndedAt, "req": map[string]string{"key": q.Key(), "name": q.Name},
				"active": secs(ai + wait), "ai": secs(ai), "wait": secs(wait), "idle": secs(idle), "tokIn": tin, "tokOut": tout, "models": models, "turns": turns})
			return
		}
	}
	http.NotFound(w, r)
}

func (s *Server) transcript(w http.ResponseWriter, sid string) {
	path, aid, ok := s.Index.File(sid)
	if !ok {
		fail(w, 404, fmt.Errorf("没有找到会话 %s", sid))
		return
	}
	tr, ok := adapterFor(aid).(adapter.Transcriber)
	if !ok {
		fail(w, 501, fmt.Errorf("适配器 %s 暂不支持还原对话", aid))
		return
	}
	msgs, err := tr.Transcript(path)
	if err != nil {
		fail(w, 500, fmt.Errorf("读取 %s 失败: %v", path, err))
		return
	}
	type block struct {
		Kind      string `json:"kind"`
		Text      string `json:"text,omitempty"`
		Name      string `json:"name,omitempty"`
		Input     string `json:"input,omitempty"`
		ToolID    string `json:"toolId,omitempty"`
		IsError   bool   `json:"isError,omitempty"`
		Truncated bool   `json:"truncated,omitempty"`
		Len       int    `json:"len,omitempty"`
	}
	type msg struct {
		T         time.Time `json:"t"`
		Role      string    `json:"role"`
		Sidechain bool      `json:"side,omitempty"`
		Turn      int       `json:"turn"`
		Model     string    `json:"model,omitempty"`
		Blocks    []block   `json:"blocks"`
	}
	turns := core.TurnOf(msgs)
	out := make([]msg, 0, len(msgs))
	for i, m := range msgs {
		x := msg{T: m.T, Role: m.Role, Sidechain: m.Sidechain, Turn: turns[i], Model: m.Model, Blocks: []block{}}
		for _, b := range m.Blocks {
			limit := maxBlock
			if b.Kind == "tool_result" {
				limit = maxResult
			}
			text, n, cut := clip(b.Text, limit)
			in, _, _ := clip(prettyJSON(b.Input), maxResult)
			bb := block{Kind: b.Kind, Text: text, Name: b.Name, Input: in, ToolID: b.ToolID, IsError: b.IsError, Truncated: cut}
			if cut {
				bb.Len = n
			}
			x.Blocks = append(x.Blocks, bb)
		}
		out = append(out, x)
	}
	writeJSON(w, map[string]any{"id": sid, "file": path, "messages": out})
}

// updateStatus：GET 返回缓存的检查结果（不联网）；POST 立即检查一次（用户点「立即检查」）。
func (s *Server) updateStatus(w http.ResponseWriter, r *http.Request) {
	st, _ := store.Load(s.StatePath)
	res := s.Update.Status()
	if r.Method == http.MethodPost {
		res = s.Update.Check(r.Context())
	}
	writeJSON(w, map[string]any{"enabled": !st.Settings.NoUpdateCheck, "status": res})
}
