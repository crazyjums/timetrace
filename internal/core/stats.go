package core

import (
	"sort"
	"time"

	"github.com/crazyjums/timetrace/internal/model"
)

// Stats 是某个时间范围内、某个需求的汇总。轮按开始时间归属范围。
// ByPhase：P R C F T O 为 AI 时间，W 为等我。粗略档不计入任何耗时。
type Stats struct {
	Active, AI, Wait, Idle time.Duration
	ByPhase                map[Phase]time.Duration
	LongByPhase            map[Phase]time.Duration // 长轮的 AI 时间按阶段拆分
	Turns, LongTurns       int
	Sessions, Coarse       int
	First, Last            time.Time
}

// Stats 统计 [from, to) 内的数据；零值的 from / to 表示不限。
func (r *Requirement) Stats(from, to time.Time) Stats {
	st := Stats{ByPhase: map[Phase]time.Duration{}, LongByPhase: map[Phase]time.Duration{}}
	in := func(t time.Time) bool {
		return (from.IsZero() || !t.Before(from)) && (to.IsZero() || t.Before(to))
	}
	for _, ss := range r.Sessions {
		counted := false
		if ss.Session.Precision != model.Exact {
			if in(ss.Session.StartedAt) {
				st.Coarse++
				counted = true
			}
		}
		for _, t := range ss.Turns {
			if !in(t.Start) {
				continue
			}
			counted = true
			st.Turns++
			st.AI += t.AI
			st.Wait += t.Wait
			st.Idle += t.Idle
			st.ByPhase[t.Phase] += t.AI
			st.ByPhase[Wait] += t.Wait
			if t.AI > LongTurn {
				st.LongTurns++
				st.LongByPhase[t.Phase] += t.AI
			}
			if st.First.IsZero() || t.Start.Before(st.First) {
				st.First = t.Start
			}
			if e := t.Start.Add(t.AI); e.After(st.Last) {
				st.Last = e
			}
		}
		if counted {
			st.Sessions++
		}
	}
	st.Active = st.AI + st.Wait
	return st
}

// Period 返回区间与紧邻的上一个同类区间（kind: today | week | month | all）。
// 周从周一开始。all 没有上期（prevFrom、prevTo 为零值）。
func Period(kind string, now time.Time) (from, to, prevFrom, prevTo time.Time) {
	day := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	switch kind {
	case "today":
		return day, day.AddDate(0, 0, 1), day.AddDate(0, 0, -1), day
	case "month":
		m := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, now.Location())
		return m, m.AddDate(0, 1, 0), m.AddDate(0, -1, 0), m
	case "week":
		off := (int(day.Weekday()) + 6) % 7
		w := day.AddDate(0, 0, -off)
		return w, w.AddDate(0, 0, 7), w.AddDate(0, 0, -7), w
	}
	return
}

// TodayReq 是今日面板里的一个需求。
type TodayReq struct {
	Key, Name  string
	Tools      []string
	Stats      Stats
	Status     string        // running | waiting | ended
	WaitingFor time.Duration // Status==waiting 时已等了多久
	EndedAt    time.Time
	Blocks     []TodayBlock
}

type TodayBlock struct {
	Start    time.Time
	AI, Wait time.Duration
	Phase    Phase
}

// Today 统计当天（now 所在日）。进行中的轮算到 now：
//   - 最后事件距 now 小于空闲阈值，且 AI 还在干活（最后是工具调用/回传）→ 运行中，AI 时间算到 now；
//   - 最后事件距 now 小于空闲阈值，且最后是 AI 的最终回复 → 等我中，等我时间算到 now；
//   - 否则 → 已结束。
func Today(reqs []*Requirement, now time.Time, cfg Config) []TodayReq {
	ds, de, _, _ := Period("today", now)
	var out []TodayReq
	for _, r := range reqs {
		tr := TodayReq{Key: r.Key(), Name: r.Name, Tools: r.Tools, Stats: Stats{ByPhase: map[Phase]time.Duration{}}}
		for _, ss := range r.Sessions {
			for i, t := range ss.Turns {
				if t.Start.Before(ds) || !t.Start.Before(de) {
					continue
				}
				ai, wait := t.AI, t.Wait
				if i == len(ss.Turns)-1 {
					last := t.Start.Add(t.AI)
					if now.Sub(last) < cfg.IdleThreshold && !now.Before(last) {
						if ss.Tail == TailFinal {
							wait = now.Sub(last)
							tr.Status, tr.WaitingFor = "waiting", wait
						} else {
							ai = now.Sub(t.Start)
							tr.Status = "running"
						}
					}
				}
				s := &tr.Stats
				s.Turns++
				s.AI += ai
				s.Wait += wait
				s.Idle += t.Idle
				s.ByPhase[t.Phase] += ai
				s.ByPhase[Wait] += wait
				if e := t.Start.Add(ai); e.After(tr.EndedAt) {
					tr.EndedAt = e
				}
				tr.Blocks = append(tr.Blocks, TodayBlock{Start: t.Start, AI: ai, Wait: wait, Phase: t.Phase})
			}
		}
		tr.Stats.Active = tr.Stats.AI + tr.Stats.Wait
		if tr.Stats.Turns == 0 {
			continue
		}
		if tr.Status == "" {
			tr.Status = "ended"
		}
		out = append(out, tr)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Stats.Active > out[j].Stats.Active })
	return out
}
