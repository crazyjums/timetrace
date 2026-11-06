package core_test

import (
	"testing"
	"time"

	"github.com/crazyjums/timetrace/internal/adapter"
	"github.com/crazyjums/timetrace/internal/adapter/claudecode"
	"github.com/crazyjums/timetrace/internal/core"
	"github.com/crazyjums/timetrace/internal/model"
)

const dir = "../adapter/claudecode/testdata/scan"

func load(t *testing.T) []*model.Session {
	ss, errs, err := adapter.ScanAll(claudecode.Adapter{}, dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(errs) != 1 {
		t.Fatalf("坏文件应给出原因且不影响其他文件, got %v", errs)
	}
	if len(ss) != 1 {
		t.Fatalf("sessions=%d", len(ss))
	}
	return ss
}

func TestTurnsAndPhases(t *testing.T) {
	turns := core.BuildTurns(load(t)[0], core.DefaultConfig())
	if len(turns) != 3 {
		t.Fatalf("turns=%d (sidechain/tool_result 不应开新轮)", len(turns))
	}
	want := []struct {
		ai, wait, idle time.Duration
		p              core.Phase
	}{
		{30 * time.Second, 150 * time.Second, 0, core.Plan},
		{40 * time.Second, 0, 26*time.Minute + 20*time.Second, core.Test},
		{0, 0, 0, core.Plan},
	}
	for i, w := range want {
		g := turns[i]
		if g.AI != w.ai || g.Wait != w.wait || g.Idle != w.idle || g.Phase != w.p {
			t.Errorf("turn %d = %+v, want %+v", i, g, w)
		}
	}
}

func TestAggregateWindowAndCoarse(t *testing.T) {
	base := load(t)[0]
	cfg := core.DefaultConfig()
	far := *base
	far.ID, far.StartedAt, far.EndedAt = "s2", base.EndedAt.Add(7*time.Hour), base.EndedAt.Add(7*time.Hour+time.Minute)
	coarse := *base
	coarse.ID, coarse.Precision = "s3", model.Coarse
	coarse.StartedAt, coarse.EndedAt = base.EndedAt.Add(time.Hour), base.EndedAt.Add(2*time.Hour)
	coarse.Events = nil

	reqs := core.Aggregate([]*model.Session{base, &far, &coarse}, cfg)
	if len(reqs) != 2 {
		t.Fatalf("reqs=%d, 超过 4h 应拆成两个需求", len(reqs))
	}
	var first *core.Requirement
	for _, r := range reqs {
		if len(r.Sessions) == 2 {
			first = r
		}
	}
	if first == nil || first.CoarseSessions != 1 {
		t.Fatalf("粗略档会话应并入同需求并计数: %+v", reqs)
	}
	if first.Active != 70*time.Second+150*time.Second {
		t.Errorf("粗略档不应计入汇总, Active=%v", first.Active)
	}
	if first.Name != "加登录" {
		t.Errorf("name=%q", first.Name)
	}
}
