// Package core 实现计时、阶段判定、需求聚合。计时规则只在这里实现一次。
package core

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/crazyjums/timetrace/internal/model"
)

type Phase string

const (
	Plan     Phase = "P" // 聊方案
	Research Phase = "R" // 调研
	Code     Phase = "C" // 写代码
	Fix      Phase = "F" // 改代码
	Test     Phase = "T" // 测试
	Other    Phase = "O" // 其他
	Wait     Phase = "W" // 等我（非阶段）
)

type Config struct {
	IdleThreshold time.Duration // 间隔 >= 阈值视为空闲，不计入。默认 10 分钟
	MergeWindow   time.Duration // 同 cwd 相邻会话间隔 <= 窗口则同一需求。默认 4 小时
	Overrides     *Overrides    // 人工修正，可为 nil
}

// Overrides 是人工修正，持久化由 store 包负责。需求用其首个会话 ID 作为稳定键。
type Overrides struct {
	Rename  map[string]string `json:"rename"`   // 需求键 -> 名称
	Phase   map[string]Phase  `json:"phase"`    // "会话ID#轮序号" -> 阶段
	Merge   [][]string        `json:"merge"`    // 每组会话 ID 强制归为同一需求
	SplitAt []string          `json:"split_at"` // 这些会话强制另起一个需求
}

func DefaultConfig() Config {
	return Config{IdleThreshold: 10 * time.Minute, MergeWindow: 4 * time.Hour}
}

// Turn：从用户一条消息到 AI/工具的最后一个事件。
type Turn struct {
	Start  time.Time
	AI     time.Duration // AI 工作时间
	Gap    time.Duration // 到下一轮的间隔；最后一轮为 0
	HasGap bool
	Wait   time.Duration // 计入「等我」的部分（Gap < 阈值）
	Idle   time.Duration // 空闲（Gap >= 阈值），不计入
	Phase  Phase
	Prompt string
	Tools  []string
	Items  []Item // 对话抽屉：该轮的消息与工具调用，按时间顺序
}

// Item 是抽屉里的一行。Kind: user | llm（AI 文字回复）| tool | agent（子 agent）。
type Item struct {
	Kind string
	T    time.Time
	Text string // user/llm 为正文；tool/agent 为工具名
	Arg  string // tool/agent 的关键参数
}

type SessionStats struct {
	Session *model.Session
	Turns   []Turn // 粗略档为空
}

var (
	reTest = regexp.MustCompile(`(?i)\b(go test|pytest|npm (run )?test|yarn test|jest|cargo test|mvn test|make test)\b`)
	reFix  = regexp.MustCompile(`(?i)(fix|bug|修复|修改|改一下|重构|refactor)`)
	editT  = map[string]bool{"Edit": true, "MultiEdit": true, "NotebookEdit": true}
	writeT = map[string]bool{"Write": true}
	readT  = map[string]bool{"Read": true, "Grep": true, "Glob": true, "WebFetch": true, "WebSearch": true}
)

// ClassifyPhase 纯规则判定（人工覆盖由上层保存，不在此处）。
// 优先级：测试命令 > 有 Edit 或 prompt 含修改类词(且有写入) = 改代码 > 仅 Write = 写代码
// > 只用读/搜索类工具 = 调研 > 没有任何工具 = 聊方案 > 其他。
func ClassifyPhase(t Turn, toolInputs []string) Phase {
	for i, n := range t.Tools {
		if n == "Bash" && i < len(toolInputs) && reTest.MatchString(toolInputs[i]) {
			return Test
		}
	}
	var edit, write, read, otherTool bool
	for _, n := range t.Tools {
		switch {
		case editT[n]:
			edit = true
		case writeT[n]:
			write = true
		case readT[n]:
			read = true
		default:
			otherTool = true
		}
	}
	switch {
	case edit, write && reFix.MatchString(t.Prompt):
		return Fix
	case write:
		return Code
	case len(t.Tools) == 0:
		return Plan
	case read && !otherTool:
		return Research
	}
	return Other
}

// BuildTurns 是唯一的计时实现。
func BuildTurns(s *model.Session, cfg Config) []Turn {
	if s.Precision != model.Exact {
		return nil
	}
	type acc struct {
		Turn
		last   time.Time
		inputs []string
	}
	var accs []*acc
	for _, e := range s.Events {
		if e.Role == "user" {
			accs = append(accs, &acc{Turn: Turn{Start: e.T, Prompt: e.Text, Items: []Item{{Kind: "user", T: e.T, Text: e.Text}}}, last: e.T})
			continue
		}
		if len(accs) == 0 {
			continue // 第一条 user 之前的事件不属于任何轮
		}
		a := accs[len(accs)-1]
		if e.T.After(a.last) {
			a.last = e.T
		}
		if e.Text != "" {
			a.Items = append(a.Items, Item{Kind: "llm", T: e.T, Text: e.Text})
		}
		for i, n := range e.Tools {
			k := "tool"
			if n == "Task" || n == "Agent" {
				k = "agent"
			}
			arg := ""
			if i < len(e.ToolInput) {
				arg = e.ToolInput[i]
			}
			a.Items = append(a.Items, Item{Kind: k, T: e.T, Text: n, Arg: arg})
		}
		a.Tools = append(a.Tools, e.Tools...)
		a.inputs = append(a.inputs, e.ToolInput...)
	}
	out := make([]Turn, len(accs))
	for i, a := range accs {
		t := a.Turn
		t.AI = a.last.Sub(t.Start)
		if i+1 < len(accs) {
			t.Gap, t.HasGap = accs[i+1].Start.Sub(a.last), true
			if t.Gap < 0 { // 轮重叠（乱序日志）：不产生等我/空闲
				t.Gap = 0
			}
			if t.Gap >= cfg.IdleThreshold {
				t.Idle = t.Gap
			} else {
				t.Wait = t.Gap
			}
		}
		t.Phase = ClassifyPhase(t, a.inputs)
		out[i] = t
	}
	return out
}

type Requirement struct {
	Cwd            string
	Name           string
	Sessions       []*SessionStats
	Start, End     time.Time
	Active         time.Duration           // AI + 等我；仅精确档
	ByPhase        map[Phase]time.Duration // P R C F T O W（W = 等我）
	Idle           time.Duration
	Tools          []string
	CoarseSessions int // 粗略档会话数：只给次数与跨度，不计入 Active
}

// Aggregate：同一 cwd，相邻会话间隔 <= MergeWindow 归为一个需求；同需求会话允许重叠。
func Aggregate(sessions []*model.Session, cfg Config) []*Requirement {
	byCwd := map[string][]*model.Session{}
	for _, s := range sessions {
		byCwd[s.Cwd] = append(byCwd[s.Cwd], s)
	}
	var reqs []*Requirement
	for cwd, ss := range byCwd {
		sort.Slice(ss, func(i, j int) bool { return ss[i].StartedAt.Before(ss[j].StartedAt) })
		var cur *Requirement
		for _, s := range ss {
			if cur == nil || cfg.Overrides.newReq(cur, s, cfg.MergeWindow) {
				cur = &Requirement{Cwd: cwd, ByPhase: map[Phase]time.Duration{}, Start: s.StartedAt, End: s.EndedAt}
				reqs = append(reqs, cur)
			}
			st := &SessionStats{Session: s, Turns: BuildTurns(s, cfg)}
			cfg.Overrides.applyPhases(s.ID, st.Turns)
			cur.Sessions = append(cur.Sessions, st)
			if s.EndedAt.After(cur.End) {
				cur.End = s.EndedAt
			}
			cur.addTool(s.Tool)
			if s.Precision != model.Exact {
				cur.CoarseSessions++
				continue
			}
			for _, t := range st.Turns {
				cur.ByPhase[t.Phase] += t.AI
				cur.ByPhase[Wait] += t.Wait
				cur.Active += t.AI + t.Wait
				cur.Idle += t.Idle
			}
		}
	}
	for _, r := range reqs {
		r.Name = nameOf(r)
		if n, ok := cfg.Overrides.rename(r.Key()); ok {
			r.Name = n
		}
	}
	sort.Slice(reqs, func(i, j int) bool { return reqs[i].End.After(reqs[j].End) })
	return reqs
}

func (r *Requirement) addTool(t string) {
	for _, x := range r.Tools {
		if x == t {
			return
		}
	}
	r.Tools = append(r.Tools, t)
}

func nameOf(r *Requirement) string {
	for _, s := range r.Sessions {
		if s.Session.Title != "" {
			return s.Session.Title
		}
	}
	if i := strings.LastIndex(r.Cwd, "/"); i >= 0 && i+1 < len(r.Cwd) {
		return r.Cwd[i+1:]
	}
	return r.Cwd
}

// Key 是需求的稳定键（首个会话 ID），人工修正按它保存。
func (r *Requirement) Key() string { return r.Sessions[0].Session.ID }

func (o *Overrides) rename(key string) (string, bool) {
	if o == nil {
		return "", false
	}
	n, ok := o.Rename[key]
	return n, ok
}

func (o *Overrides) applyPhases(sid string, turns []Turn) {
	if o == nil {
		return
	}
	for i := range turns {
		if p, ok := o.Phase[fmt.Sprintf("%s#%d", sid, i)]; ok {
			turns[i].Phase = p
		}
	}
}

// newReq 判断会话 s 是否另起需求：人工拆分 > 人工合并 > 窗口规则。
func (o *Overrides) newReq(cur *Requirement, s *model.Session, win time.Duration) bool {
	if o != nil {
		for _, id := range o.SplitAt {
			if id == s.ID {
				return true
			}
		}
		for _, g := range o.Merge {
			if contains(g, s.ID) {
				for _, st := range cur.Sessions {
					if contains(g, st.Session.ID) {
						return false
					}
				}
			}
		}
	}
	return s.StartedAt.Sub(cur.End) > win
}

func contains(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}
