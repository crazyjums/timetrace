// Package insights 用本地规则生成洞察。所有数字本地计算；不下「高于正常」之类的断言。
package insights

import (
	"fmt"
	"sort"
	"time"

	"github.com/crazyjums/timetrace/internal/core"
)

type Report struct {
	TopPhase    *PhaseShare
	Delta       *Delta // 仅当上期有数据
	TopReqs     []ReqShare
	Suggestions []string // 最多 4 条
}

type PhaseShare struct {
	Phase core.Phase
	D     time.Duration
	Pct   float64 // 占活跃时间（阶段 + 等我）
}
type Delta struct{ Cur, Prev time.Duration }
type ReqShare struct {
	Name string
	D    time.Duration
}

func total(m map[core.Phase]time.Duration) (t time.Duration) {
	for _, d := range m {
		t += d
	}
	return
}

func sum(reqs []*core.Requirement) (map[core.Phase]time.Duration, time.Duration) {
	m := map[core.Phase]time.Duration{}
	var a time.Duration
	for _, r := range reqs {
		for p, d := range r.ByPhase {
			m[p] += d
		}
		a += r.Active
	}
	return m, a
}

// Build：cur 为本期需求，prev 为上期需求（可为空）。
func Build(cur, prev []*core.Requirement) Report {
	var rep Report
	phases, active := sum(cur)
	if active == 0 {
		return rep
	}
	for p, d := range phases {
		if p == core.Wait {
			continue
		}
		if rep.TopPhase == nil || d > rep.TopPhase.D {
			rep.TopPhase = &PhaseShare{p, d, float64(d) / float64(active) * 100}
		}
	}
	if _, pa := sum(prev); pa > 0 {
		rep.Delta = &Delta{Cur: active, Prev: pa}
	}
	sorted := append([]*core.Requirement(nil), cur...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Active > sorted[j].Active })
	for i := 0; i < len(sorted) && i < 3; i++ {
		if sorted[i].Active > 0 {
			rep.TopReqs = append(rep.TopReqs, ReqShare{sorted[i].Name, sorted[i].Active})
		}
	}

	pct := func(p core.Phase) float64 { return float64(phases[p]) / float64(active) * 100 }
	add := func(s string) {
		if len(rep.Suggestions) < 4 {
			rep.Suggestions = append(rep.Suggestions, s)
		}
	}
	if pct(core.Wait) >= 30 {
		add(fmt.Sprintf("「等我」占活跃时间 %.0f%%：AI 完成后有较多时间在等你回应。可考虑一次给出更完整的指令，或并行处理其他需求。", pct(core.Wait)))
	}
	if phases[core.Code] > 0 && float64(phases[core.Fix]) >= float64(phases[core.Code])*1.0 {
		add(fmt.Sprintf("「改代码」(%s) 不少于「写代码」(%s)。返工多可能与需求描述不够明确有关（相关，不等于因果）。",
			round(phases[core.Fix]), round(phases[core.Code])))
	}
	if pct(core.Plan) < 5 && pct(core.Fix) >= 20 {
		add("聊方案占比很低而改代码较多；两者同时出现，相关，不等于因果。")
	}
	if pct(core.Test) == 0 {
		add("本期没有识别到测试阶段（按命令规则判定，可能漏判，可在设置里调整阶段规则）。")
	}
	return rep
}

func round(d time.Duration) string { return d.Round(time.Second).String() }
