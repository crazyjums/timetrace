// timetrace CLI：脱离界面，扫描日志目录并输出每个需求的时间分布。
package main

import (
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/crazyjums/timetrace/internal/adapter"
	"github.com/crazyjums/timetrace/internal/adapter/claudecode"
	"github.com/crazyjums/timetrace/internal/core"
)

func main() {
	root := flag.String("claude-dir", os.ExpandEnv("$HOME/.claude/projects"), "Claude Code 日志目录（只读）")
	idle := flag.Duration("idle", 10*time.Minute, "空闲阈值")
	win := flag.Duration("window", 4*time.Hour, "需求聚合窗口")
	flag.Parse()

	sessions, errs, err := adapter.ScanAll(claudecode.Adapter{}, *root)
	if err != nil {
		fmt.Fprintln(os.Stderr, "扫描失败:", err)
		os.Exit(1)
	}
	reqs := core.Aggregate(sessions, core.Config{IdleThreshold: *idle, MergeWindow: *win})
	if len(reqs) == 0 {
		fmt.Println("未发现日志：", *root)
	}
	for _, r := range reqs {
		fmt.Printf("%s  [%s]  活跃 %s  会话 %d  最近 %s\n", r.Name, r.Cwd, fmtD(r.Active), len(r.Sessions), r.End.Local().Format("2006-01-02 15:04"))
		for _, p := range []core.Phase{core.Plan, core.Research, core.Code, core.Fix, core.Test, core.Other, core.Wait} {
			if d := r.ByPhase[p]; d > 0 {
				fmt.Printf("    %s %s\n", p, fmtD(d))
			}
		}
	}
	for _, e := range errs {
		fmt.Printf("解析失败 %s: %s\n", e.File, e.Reason)
	}
}

func fmtD(d time.Duration) string { return d.Round(time.Second).String() }
