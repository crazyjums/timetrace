// timetrace CLI：脱离界面，扫描日志目录并输出需求、今日、洞察，管理人工修正与设置。
//
//	timetrace [list|today|insights|llm-preview|llm-send|rename|phase|merge|split] [flags] [args]
package main

import (
	"flag"
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/crazyjums/timetrace/internal/adapter"
	"github.com/crazyjums/timetrace/internal/adapter/claudecode"
	"github.com/crazyjums/timetrace/internal/core"
	"github.com/crazyjums/timetrace/internal/insights"
	"github.com/crazyjums/timetrace/internal/llm"
	"github.com/crazyjums/timetrace/internal/model"
	"github.com/crazyjums/timetrace/internal/store"
)

func main() {
	cmd := "list"
	args := os.Args[1:]
	if len(args) > 0 && args[0][0] != '-' {
		cmd, args = args[0], args[1:]
	}
	fs := flag.NewFlagSet(cmd, flag.ExitOnError)
	root := fs.String("claude-dir", os.ExpandEnv("$HOME/.claude/projects"), "Claude Code 日志目录（只读）")
	state := fs.String("state", store.DefaultPath(), "本机状态文件（人工修正与设置）")
	days := fs.Int("days", 7, "insights 统计天数；7（默认）按自然周（周一起），其他值按最近 N 天；上期为紧邻的同长度区间")
	fs.Parse(args)

	st, err := store.Load(*state)
	die(err)
	cfg := st.Settings.Config()
	cfg.Overrides = &st.Overrides
	save := func() { die(store.Save(*state, st)) }
	rest := fs.Args()

	switch cmd {
	case "rename": // rename <需求键> <名称>
		need(rest, 2)
		if st.Overrides.Rename == nil {
			st.Overrides.Rename = map[string]string{}
		}
		st.Overrides.Rename[rest[0]] = rest[1]
		save()
		return
	case "phase": // phase <会话ID> <轮序号> <P|R|C|F|T|O>
		need(rest, 3)
		if _, err := strconv.Atoi(rest[1]); err != nil || len(rest[2]) != 1 || !validPhase(rest[2]) {
			die(fmt.Errorf("用法: phase <会话ID> <轮序号> <P|R|C|F|T|O>"))
		}
		if st.Overrides.Phase == nil {
			st.Overrides.Phase = map[string]core.Phase{}
		}
		st.Overrides.Phase[rest[0]+"#"+rest[1]] = core.Phase(rest[2])
		save()
		return
	case "merge": // merge <会话ID>...（强制归为同一需求(可跨目录)）
		need(rest, 2)
		st.Overrides.Merge = append(st.Overrides.Merge, rest)
		save()
		return
	case "split": // split <会话ID>（从该会话起另起需求）
		need(rest, 1)
		st.Overrides.SplitAt = append(st.Overrides.SplitAt, rest...)
		save()
		return
	}

	sessions, errs, err := adapter.ScanAll(claudecode.Adapter{}, *root)
	die(err)
	now := time.Now()
	switch cmd {
	case "list":
		reqs := core.Aggregate(sessions, cfg)
		if len(reqs) == 0 {
			fmt.Println("未发现日志：", *root)
		}
		for _, r := range reqs {
			fmt.Printf("%s  键=%s  [%s]  活跃 %s  会话 %d  最近 %s\n", r.Name, r.Key(), r.Cwd, fmtD(r.Active), len(r.Sessions), r.End.Local().Format("2006-01-02 15:04"))
			for _, p := range []core.Phase{core.Plan, core.Research, core.Code, core.Fix, core.Test, core.Other, core.Wait} {
				if d := r.ByPhase[p]; d > 0 {
					fmt.Printf("    %s %s\n", p, fmtD(d))
				}
			}
			if r.CoarseSessions > 0 {
				fmt.Printf("    粗略档会话 %d 个：不显示耗时，不计入汇总\n", r.CoarseSessions)
			}
		}
	case "today":
		for _, it := range core.Today(core.Aggregate(sessions, cfg), now, cfg) {
			note := map[string]string{"running": "  （运行中，计到现在）", "waiting": "  （等我中）", "ended": ""}[it.Status]
			fmt.Printf("%s  %s%s\n", it.Name, fmtD(it.Stats.Active), note)
		}
	case "insights", "llm-preview", "llm-send":
		d := time.Duration(*days) * 24 * time.Hour
		curR := core.Aggregate(inRange(sessions, now.Add(-d), now), cfg)
		if cmd == "insights" {
			from, to, pf, pt := core.Period("week", now)
			if *days != 7 {
				to, from = now, now.Add(-d)
				pf, pt = from.Add(-d), from
			}
			named := func(f, t time.Time) []insights.Named {
				var o []insights.Named
				for _, q := range core.Aggregate(sessions, cfg) {
					o = append(o, insights.Named{Key: q.Key(), Name: q.Name, S: q.Stats(f, t)})
				}
				return o
			}
			printInsights(insights.Build(named(from, to), named(pf, pt)))
			break
		}
		p, err := llm.BuildPayload(st.Settings.LLM.Level, curR)
		die(err)
		pv, err := llm.Preview(p)
		die(err)
		fmt.Println(string(pv))
		if cmd == "llm-send" { // 先显示预览，再发送；未启用时拒绝
			out, err := llm.Send(st.Settings.LLM, pv, nil)
			die(err)
			fmt.Println("\n--- 大模型解读 ---\n" + out)
		}
	default:
		die(fmt.Errorf("未知命令 %q", cmd))
	}
	for _, e := range errs {
		fmt.Printf("解析失败 %s: %s\n", e.File, e.Reason)
	}
}

func printInsights(r insights.Report) {
	if r.Top == nil {
		fmt.Println("本期没有可统计的精确档数据")
		return
	}
	fmt.Printf("最耗时阶段: %s %s (占活跃 %.0f%%)\n", r.Top.Phase, fmtD(r.Top.D), r.Top.Pct)
	if r.HasPrev {
		fmt.Printf("活跃时间: 本期 %s，上期 %s\n", fmtD(r.Active), fmtD(r.PrevActive))
	} else {
		fmt.Printf("活跃时间: %s（上期无数据，不显示变化）\n", fmtD(r.Active))
	}
	for i, q := range r.TopReqs {
		fmt.Printf("Top%d %s %s\n", i+1, q.Name, fmtD(q.S.Active))
	}
	for _, s := range r.Suggestions {
		fmt.Printf("建议: %s %s 可以试：%s（依据：%s）\n", s.Title, s.Detail, s.Try, s.Basis)
	}
}

func inRange(ss []*model.Session, from, to time.Time) []*model.Session {
	var out []*model.Session
	for _, s := range ss {
		if !s.StartedAt.Before(from) && s.StartedAt.Before(to) {
			out = append(out, s)
		}
	}
	return out
}

func validPhase(s string) bool {
	switch core.Phase(s) {
	case core.Plan, core.Research, core.Code, core.Fix, core.Test, core.Other:
		return true
	}
	return false
}

func need(a []string, n int) {
	if len(a) < n {
		die(fmt.Errorf("参数不足，需要 %d 个", n))
	}
}

func die(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "错误:", err)
		os.Exit(1)
	}
}

func fmtD(d time.Duration) string { return d.Round(time.Second).String() }
