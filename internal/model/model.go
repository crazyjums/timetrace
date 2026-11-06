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
	Thinking  bool     // assistant 事件含 thinking 块
	Model     string   // 日志里没有则为空，界面显示「–」
	TokIn     int      // 日志里没有则为 0（界面显示「–」）
	TokOut    int
}

// Session 对应某个工具的一份日志文件。缺失字段用零值，界面显示「–」。
type Session struct {
	ID        string
	Tool      string
	File      string
	Cwd       string
	Branch    string // 日志里没有则为空
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

// Message 是对话还原用的一条消息（按需读取单个文件生成，不进索引）。
// Role 与 Event 一致：user 为真实用户发言，tool_result 为工具回传，assistant 为 AI。
type Message struct {
	T         time.Time
	Role      string
	Sidechain bool // 子 agent 的消息，不参与分轮
	Model     string
	TokIn     int
	TokOut    int
	Blocks    []Block
}

// Block 是消息里的一个内容块。
type Block struct {
	Kind    string // text | thinking | tool_use | tool_result | image
	Text    string // text / thinking 的正文；tool_result 的输出
	Name    string // tool_use 的工具名
	Input   string // tool_use 的参数（JSON）
	ToolID  string // tool_use 的 id，或 tool_result 对应的 tool_use_id
	IsError bool   // tool_result 是否报错
}
