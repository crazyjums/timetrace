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
	if len(items) != 1 || !items[0].Running {
		t.Fatalf("items=%+v", items)
	}
	// 最后一轮从 10:30:00 开始，算到 now=10:30:00(最后事件时间 10:30:00)+2m
	if items[0].Active < 2*time.Minute {
		t.Errorf("进行中的轮应算到现在: %v", items[0].Active)
	}
}

func TestInsightsNoPrevNoDelta(t *testing.T) {
	reqs := core.Aggregate(load(t), core.DefaultConfig())
	rep := insights.Build(reqs, nil)
	if rep.Delta != nil || rep.TopPhase == nil || len(rep.Suggestions) > 4 {
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
