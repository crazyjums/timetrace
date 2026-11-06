package core_test

import (
	"testing"
	"time"

	"github.com/crazyjums/timetrace/internal/core"
	"github.com/crazyjums/timetrace/internal/insights"
	"github.com/crazyjums/timetrace/internal/llm"
	"github.com/crazyjums/timetrace/internal/model"
	"github.com/crazyjums/timetrace/internal/store"
)

func TestOverrides(t *testing.T) {
	base := load(t)[0]
	cfg := core.DefaultConfig()
	b := *base
	b.ID, b.StartedAt, b.EndedAt = "s2", base.EndedAt.Add(time.Hour), base.EndedAt.Add(2*time.Hour)

	cfg.Overrides = &core.Overrides{SplitAt: []string{"s2"}}
	if n := len(core.Aggregate([]*model.Session{base, &b}, cfg)); n != 2 {
		t.Errorf("split: reqs=%d", n)
	}
	far := b
	far.StartedAt, far.EndedAt = base.EndedAt.Add(9*time.Hour), base.EndedAt.Add(10*time.Hour)
	cfg.Overrides = &core.Overrides{Merge: [][]string{{"s1", "s2"}}, Rename: map[string]string{"s1": "登录"}, Phase: map[string]core.Phase{"s1#0": core.Research}}
	far3 := far
	far3.ID, far3.StartedAt, far3.EndedAt = "s3", base.EndedAt.Add(20*time.Hour), base.EndedAt.Add(21*time.Hour)
	// far(s2) 虽在窗口外，但与 s1 被人工合并；s3 在窗口外且未合并，另起需求
	reqs := core.Aggregate([]*model.Session{base, &far, &far3}, cfg)
	if len(reqs) != 2 {
		t.Fatalf("reqs=%d", len(reqs))
	}
	var r *core.Requirement
	for _, x := range reqs {
		if x.Key() == "s1" {
			r = x
		}
	}
	if r.Name != "登录" || r.Sessions[0].Turns[0].Phase != core.Research {
		t.Errorf("rename/phase 覆盖未生效: %+v", r.Name)
	}
}

func TestTodayRunning(t *testing.T) {
	s := load(t)[0]
	cfg := core.DefaultConfig()
	reqs := core.Aggregate([]*model.Session{s}, cfg)
	now := s.EndedAt.Add(2 * time.Minute) // 最后一轮刚结束 2 分钟
	items := core.Today(reqs, now, cfg)
	if len(items) != 1 || items[0].Status != "running" {
		t.Fatalf("items=%+v", items)
	}
	// 最后一轮从 10:30:00 开始，算到 now=10:30:00(最后事件时间 10:30:00)+2m
	if items[0].Stats.Active < 2*time.Minute {
		t.Errorf("进行中的轮应算到现在: %v", items[0].Stats.Active)
	}
}

func TestInsightsNoPrevNoDelta(t *testing.T) {
	var cur []insights.Named
	for _, r := range core.Aggregate(load(t), core.DefaultConfig()) {
		cur = append(cur, insights.Named{Key: r.Key(), Name: r.Name, S: r.Stats(time.Time{}, time.Time{})})
	}
	rep := insights.Build(cur, nil)
	if rep.HasPrev || rep.Top == nil || len(rep.Suggestions) > 4 {
		t.Errorf("%+v", rep)
	}
}

func TestLLMGuardsAndPayload(t *testing.T) {
	reqs := core.Aggregate(load(t), core.DefaultConfig())
	if _, err := llm.Send(store.LLMCfg{}, []byte("{}"), nil); err != llm.ErrDisabled {
		t.Errorf("默认应拒绝发送: %v", err)
	}
	p, _ := llm.BuildPayload("counts", reqs)
	if len(p.Requirements) != 0 {
		t.Error("counts 档不应含需求")
	}
	p, _ = llm.BuildPayload("names", reqs)
	if len(p.Requirements) != 1 || p.Requirements[0].Phases != nil {
		t.Error("names 档只含名称与总时长")
	}
	if _, err := llm.BuildPayload("x", reqs); err == nil {
		t.Error("未知档位应报错")
	}
}

func TestStoreRoundtrip(t *testing.T) {
	p := t.TempDir() + "/s.json"
	f, _ := store.Load(p)
	if f.Settings.IdleMinutes != 10 || f.Settings.LLM.Enabled {
		t.Fatal("默认值错误")
	}
	f.Overrides.Rename = map[string]string{"a": "b"}
	if err := store.Save(p, f); err != nil {
		t.Fatal(err)
	}
	g, _ := store.Load(p)
	if g.Overrides.Rename["a"] != "b" {
		t.Error("未持久化")
	}
}

func TestStatsRangeAndLongTurn(t *testing.T) {
	r := core.Aggregate(load(t), core.DefaultConfig())[0]
	all := r.Stats(time.Time{}, time.Time{})
	if all.Turns != 3 || all.AI != 70*time.Second || all.Wait != 150*time.Second {
		t.Fatalf("%+v", all)
	}
	// 只含第一轮开始之后的 5 分钟：第二轮(10:03)在内，第三轮(10:30)不在
	from := all.First
	got := r.Stats(from, from.Add(5*time.Minute))
	if got.Turns != 2 || got.ByPhase[core.Wait] != 150*time.Second {
		t.Errorf("范围统计错误: %+v", got)
	}
	if all.LongTurns != 0 {
		t.Errorf("没有超过 10 分钟的轮: %d", all.LongTurns)
	}
}

func TestPeriodWeekStartsMonday(t *testing.T) {
	now := time.Date(2026, 11, 6, 14, 0, 0, 0, time.UTC) // 周五
	from, to, pf, pt := core.Period("week", now)
	if from.Weekday() != time.Monday || from.Day() != 2 || to.Day() != 9 || !pt.Equal(from) || pf.Day() != 26 {
		t.Errorf("week: %v %v %v %v", from, to, pf, pt)
	}
	if f, _, pf2, _ := core.Period("all", now); !f.IsZero() || !pf2.IsZero() {
		t.Error("all 没有范围与上期")
	}
}

func TestMergeAcrossCwdAndToolDurations(t *testing.T) {
	base := load(t)[0]
	other := *base
	other.ID, other.Cwd = "x2", "/w/other"
	other.StartedAt, other.EndedAt = base.EndedAt.Add(30*time.Hour), base.EndedAt.Add(31*time.Hour)
	cfg := core.DefaultConfig()
	if n := len(core.Aggregate([]*model.Session{base, &other}, cfg)); n != 2 {
		t.Fatalf("默认应 2 个需求: %d", n)
	}
	cfg.Overrides = &core.Overrides{Merge: [][]string{{"s1", "x2"}}}
	if n := len(core.Aggregate([]*model.Session{base, &other}, cfg)); n != 1 {
		t.Errorf("人工合并应允许跨目录: %d", n)
	}
	// 第二轮：Write(10:03:20) 的工具耗时 = 到下一个事件 tool_result(10:03:25) = 5s
	turn := core.BuildTurns(base, core.DefaultConfig())[1]
	var found bool
	for _, it := range turn.Items {
		if it.Kind == "tool" && it.Text == "Write" {
			found = true
			if it.Dur != 5*time.Second {
				t.Errorf("Write 耗时=%v", it.Dur)
			}
		}
	}
	if !found {
		t.Error("没有 Write 工具项")
	}
}
