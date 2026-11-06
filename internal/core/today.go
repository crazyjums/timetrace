package core

import (
	"sort"
	"time"
)

type TodayItem struct {
	Name    string
	Active  time.Duration
	Running bool
}

// Today 统计 [dayStart, dayStart+24h) 内各需求的活跃时间。
// 轮仍在进行（最后事件距 now 小于空闲阈值，且是会话最后一轮）时算到 now。
// 只统计精确档；一轮按其开始时间归属当天。
func Today(reqs []*Requirement, now time.Time, cfg Config) []TodayItem {
	ds := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	de := ds.AddDate(0, 0, 1)
	var out []TodayItem
	for _, r := range reqs {
		it := TodayItem{Name: r.Name}
		for _, ss := range r.Sessions {
			for i, t := range ss.Turns {
				if t.Start.Before(ds) || !t.Start.Before(de) {
					continue
				}
				d := t.AI + t.Wait
				if i == len(ss.Turns)-1 && ss.Session.EndedAt.After(now.Add(-cfg.IdleThreshold)) && !ss.Session.EndedAt.After(now) {
					d = now.Sub(t.Start) // 进行中，算到现在
					it.Running = true
				}
				it.Active += d
			}
		}
		if it.Active > 0 {
			out = append(out, it)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Active > out[j].Active })
	return out
}
