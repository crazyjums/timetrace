// Package insights 用本地规则生成洞察。所有数字本地计算；不下「高于正常」之类的断言。
package insights

import (
	"fmt"
	"sort"
	"time"

	"github.com/crazyjums/timetrace/internal/core"
)

// WaitHint 是「等我」占比的提示线。它只是产品内固定的提示阈值，不是「正常水平」。
const WaitHint = 15.0

// LongTurnMin 是触发「长轮」建议所需的最少轮数。
const LongTurnMin = 3

type Named struct {
	Key, Name string
	S         core.Stats
}

type PhaseShare struct {
	Phase core.Phase
	D     time.Duration
	Pct   float64 // PctOf 指明分母：topPhase 占活跃时间，Ranking 占 AI 时间
}

type Suggestion struct {
	Title  string
	Detail string
	Try    string
	Basis  string
}

type Report struct {
	Active, AI, Wait time.Duration
	WaitPct          float64
	Top, Second      *PhaseShare
	HasPrev          bool // 仅当上期有数据才显示变化
	PrevActive       time.Duration
	Ranking          []PhaseShare
	TopReqs          []Named
	CoarseReqs       []string // 粗略档需求：不计入以上数字
	Suggestions      []Suggestion
}

func dur(d time.Duration) string {
	m := int(d.Round(time.Minute) / time.Minute)
	if m >= 60 {
		return fmt.Sprintf("%dh %dm", m/60, m%60)
	}
	return fmt.Sprintf("%dm", m)
}

var phaseName = map[core.Phase]string{core.Plan: "聊方案", core.Research: "调研", core.Code: "写代码", core.Fix: "改代码", core.Test: "测试", core.Other: "其他"}

var order = []core.Phase{core.Plan, core.Research, core.Code, core.Fix, core.Test, core.Other}

// Build：cur 为本期各需求的统计，prev 为上期（可为空）。
func Build(cur, prev []Named) Report {
	var rep Report
	phases := map[core.Phase]time.Duration{}
	var longTurns int
	longByPhase := map[core.Phase]time.Duration{}
	for _, n := range cur {
		if n.S.Turns == 0 {
			if n.S.Coarse > 0 {
				rep.CoarseReqs = append(rep.CoarseReqs, n.Name)
			}
			continue
		}
		rep.Active += n.S.Active
		rep.AI += n.S.AI
		rep.Wait += n.S.Wait
		for p, d := range n.S.ByPhase {
			phases[p] += d
		}
		longTurns += n.S.LongTurns
		for p, d := range n.S.LongByPhase {
			longByPhase[p] += d
		}
	}
	for _, n := range prev {
		rep.PrevActive += n.S.Active
	}
	rep.HasPrev = rep.PrevActive > 0
	if rep.Active == 0 {
		return rep
	}
	rep.WaitPct = float64(rep.Wait) / float64(rep.Active) * 100

	for _, p := range order {
		if phases[p] > 0 {
			rep.Ranking = append(rep.Ranking, PhaseShare{p, phases[p], float64(phases[p]) / float64(rep.AI) * 100})
		}
	}
	sort.SliceStable(rep.Ranking, func(i, j int) bool { return rep.Ranking[i].D > rep.Ranking[j].D })
	if len(rep.Ranking) > 0 {
		t := rep.Ranking[0]
		rep.Top = &PhaseShare{t.Phase, t.D, float64(t.D) / float64(rep.Active) * 100}
	}
	if len(rep.Ranking) > 1 {
		t := rep.Ranking[1]
		rep.Second = &PhaseShare{t.Phase, t.D, float64(t.D) / float64(rep.Active) * 100}
	}
	rep.TopReqs = append([]Named(nil), cur...)
	sort.Slice(rep.TopReqs, func(i, j int) bool { return rep.TopReqs[i].S.Active > rep.TopReqs[j].S.Active })
	var tr []Named
	for _, n := range rep.TopReqs {
		if n.S.Active > 0 && len(tr) < 5 {
			tr = append(tr, n)
		}
	}
	rep.TopReqs = tr

	add := func(s Suggestion) {
		if len(rep.Suggestions) < 4 {
			rep.Suggestions = append(rep.Suggestions, s)
		}
	}
	if rep.WaitPct > WaitHint {
		add(Suggestion{
			Title:  "AI 做完后你要隔很久才回",
			Detail: fmt.Sprintf("等我占活跃时间 %.0f%%，共 %s，超过 %.0f%% 的提示线。", rep.WaitPct, dur(rep.Wait), WaitHint),
			Try:    "长任务开始前，把验收条件一次说清，减少来回确认。",
			Basis:  fmt.Sprintf("等我 ÷ 活跃 = %.0fm ÷ %.0fm", rep.Wait.Minutes(), rep.Active.Minutes()),
		})
	}
	if longTurns >= LongTurnMin {
		var sum time.Duration
		for _, d := range longByPhase {
			sum += d
		}
		top := ""
		var best time.Duration
		var second time.Duration
		var secondP core.Phase
		var bestP core.Phase
		for _, p := range order {
			if d := longByPhase[p]; d > best {
				second, secondP, best, bestP = best, bestP, d, p
			} else if d > second {
				second, secondP = d, p
			}
		}
		if best > 0 {
			top = "集中在" + phaseName[bestP]
			if second > 0 {
				top += "和" + phaseName[secondP]
			}
		}
		add(Suggestion{
			Title:  fmt.Sprintf("有 %d 轮超过 10 分钟", longTurns),
			Detail: fmt.Sprintf("合计 %s，%s。", dur(sum), top),
			Try:    "点开这几轮看看卡在哪，是工具慢，还是反复重试。",
			Basis:  fmt.Sprintf("轮时长 > 10m 的轮数 ≥ %d", LongTurnMin),
		})
	}
	if phases[core.Code] > 0 && phases[core.Fix] >= phases[core.Code] {
		add(Suggestion{
			Title:  "改代码用时不少于写代码",
			Detail: fmt.Sprintf("改代码 %s，写代码 %s。", dur(phases[core.Fix]), dur(phases[core.Code])),
			Try:    "返工较多时，可以先在聊方案阶段把验收条件和边界写清再动手。",
			Basis:  "改代码 ≥ 写代码；相关，不等于因果",
		})
	}
	if phases[core.Test] == 0 {
		add(Suggestion{
			Title:  "本期没有识别到测试阶段",
			Detail: "测试按命令规则判定（go test / pytest / npm test 等），可能漏判。",
			Try:    "如果实际有测试，可在对话抽屉里把对应轮改成「测试」。",
			Basis:  "测试阶段时间 = 0",
		})
	}
	return rep
}
