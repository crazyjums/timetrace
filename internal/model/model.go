// Package model 是适配器输出的统一模型。核心层只认这里的类型。
package model

import "time"

type Precision string

const (
	Exact  Precision = "exact"  // 每个事件都有时间戳
	Coarse Precision = "coarse" // 只有会话起止，不显示耗时，不计入汇总
)

// Event 是适配器给出的原始事件，不含任何计时/阶段判断。
type Event struct {
	T         time.Time
	Role      string   // "user" | "assistant" | "tool_result"
	Text      string   // user 的真实 prompt 文本；assistant 的文字回复（可为空）
	Tools     []string // assistant 事件中调用的工具名
	ToolInput []string // 与 Tools 对应的关键参数（命令/文件路径），可为空
}

// Session 对应某个工具的一份日志文件。缺失字段用零值，界面显示「–」。
type Session struct {
	ID        string
	Tool      string
	File      string
	Cwd       string
	Title     string
	Precision Precision
	StartedAt time.Time
	EndedAt   time.Time
	Events    []Event // Precision==Coarse 时可为空
}

// ParseError 记录单个文件的解析失败，不影响其他文件。
type ParseError struct {
	File   string
	Reason string
}
