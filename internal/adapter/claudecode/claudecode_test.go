package claudecode_test

import (
	"testing"

	"github.com/crazyjums/timetrace/internal/adapter/claudecode"
	"github.com/crazyjums/timetrace/internal/core"
)

func TestTokenDedupByMessageID(t *testing.T) {
	s, err := claudecode.Adapter{}.Parse("testdata/transcript/split.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	var in, out int
	for _, e := range s.Events {
		in, out = in+e.TokIn, out+e.TokOut
	}
	// m1 拆成两行、usage 重复，只计一次：100+200 / 40+10
	if in != 300 || out != 50 {
		t.Errorf("token 未按 message.id 去重: in=%d out=%d", in, out)
	}
	if n := len(core.BuildTurns(s, core.DefaultConfig())); n != 2 {
		t.Errorf("isMeta 不应开新轮、子 agent 不计入: turns=%d", n)
	}
}

func TestTranscriptMergesAndAligns(t *testing.T) {
	a := claudecode.Adapter{}
	msgs, err := a.Transcript("testdata/transcript/split.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	// user, assistant(m1 合并), tool_result, assistant(子 agent), assistant(m2), user(图+字), assistant(m3)
	if len(msgs) != 7 {
		t.Fatalf("消息数=%d", len(msgs))
	}
	if b := msgs[1].Blocks; len(b) != 2 || b[0].Kind != "thinking" || b[1].Kind != "tool_use" || b[1].Name != "Read" {
		t.Errorf("同一 message.id 的多行应合并: %+v", b)
	}
	if r := msgs[2].Blocks[0]; r.Kind != "tool_result" || r.ToolID != "t1" || r.Text != "package a\n[图片]" {
		t.Errorf("tool_result 块数组未还原: %+v", r)
	}
	if !msgs[3].Sidechain {
		t.Error("子 agent 消息应标记 Sidechain")
	}
	// 对话分轮必须与计时分轮一致
	s, _ := a.Parse("testdata/transcript/split.jsonl")
	turns := core.TurnOf(msgs)
	if max := turns[len(turns)-1]; max+1 != len(core.BuildTurns(s, core.DefaultConfig())) {
		t.Errorf("对话分轮(%d)与计时分轮不一致", max+1)
	}
	if turns[3] != 0 || turns[5] != 1 {
		t.Errorf("轮归属错误: %v", turns)
	}
}
