// Package claudecode 解析 Claude Code 的 ~/.claude/projects/**/*.jsonl。
// 格式依据真实样例核对：每行一个 JSON；type=user/assistant 带 timestamp(RFC3339)、
// cwd、sessionId、gitBranch、isSidechain、isMeta；message.content 为字符串或块数组
// （text / image / tool_use{id,name,input} / tool_result{tool_use_id,content,is_error} / thinking）。
// tool_result.content 为字符串或块数组（text / image / tool_reference）。
// 同一条 AI 消息会拆成多行（每行一个内容块），这些行的 message.id 相同、usage 重复，
// 所以 token 按 message.id 去重。type=ai-title 带 aiTitle；其余类型（system、attachment 等）忽略。
// isMeta 为系统注入的消息，不算用户发言；子 agent（isSidechain）不参与主会话分轮。
package claudecode

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/crazyjums/timetrace/internal/model"
)

type Adapter struct{}

func (Adapter) ID() string { return "claude-code" }

func (Adapter) Discover(root string) ([]string, error) {
	var out []string
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() && strings.HasSuffix(p, ".jsonl") {
			out = append(out, p)
		}
		return nil
	})
	return out, err
}

type line struct {
	Type        string `json:"type"`
	Timestamp   string `json:"timestamp"`
	Cwd         string `json:"cwd"`
	SessionID   string `json:"sessionId"`
	IsSidechain bool   `json:"isSidechain"`
	IsMeta      bool   `json:"isMeta"`
	GitBranch   string `json:"gitBranch"`
	AITitle     string `json:"aiTitle"`
	Message     struct {
		ID    string `json:"id"`
		Model string `json:"model"`
		Usage struct {
			In  int `json:"input_tokens"`
			Out int `json:"output_tokens"`
		} `json:"usage"`
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

type block struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	Thinking  string          `json:"thinking"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Input     json.RawMessage `json:"input"`
	ToolUseID string          `json:"tool_use_id"`
	Content   json.RawMessage `json:"content"`
	IsError   bool            `json:"is_error"`
}

// scan 逐行读取文件，把每条 user/assistant 消息交给 fn。坏行计数但不中断。
type meta struct {
	id, title, cwd, branch string
	lines, bad             int
}

func scan(file string, fn func(l *line, m model.Message)) (meta, error) {
	var mt meta
	f, err := os.Open(file) // 只读
	if err != nil {
		return mt, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 64<<20)
	for sc.Scan() {
		raw := sc.Bytes()
		if len(strings.TrimSpace(string(raw))) == 0 {
			continue
		}
		mt.lines++
		var l line
		if err := json.Unmarshal(raw, &l); err != nil {
			mt.bad++
			continue
		}
		if l.AITitle != "" {
			mt.title = l.AITitle
		}
		if l.SessionID != "" && mt.id == "" {
			mt.id = l.SessionID
		}
		if (l.Type != "user" && l.Type != "assistant") || l.IsMeta {
			continue
		}
		t, err := time.Parse(time.RFC3339Nano, l.Timestamp)
		if err != nil {
			mt.bad++
			continue
		}
		if mt.cwd == "" {
			mt.cwd = l.Cwd
		}
		if mt.branch == "" {
			mt.branch = l.GitBranch
		}
		if m, ok := toMessage(&l, t); ok {
			fn(&l, m)
		}
	}
	if err := sc.Err(); err != nil {
		return mt, fmt.Errorf("读取失败: %w", err)
	}
	if mt.lines > 0 && mt.bad == mt.lines {
		return mt, fmt.Errorf("全部 %d 行都无法解析，疑似不是 Claude Code 日志", mt.lines)
	}
	if mt.id == "" {
		mt.id = strings.TrimSuffix(filepath.Base(file), ".jsonl")
	}
	return mt, nil
}

// toMessage 是唯一的逐行分类：Parse（计时用）和 Transcript（对话用）都走这里，保证分轮一致。
func toMessage(l *line, t time.Time) (model.Message, bool) {
	m := model.Message{T: t, Sidechain: l.IsSidechain}
	var str string
	if json.Unmarshal(l.Message.Content, &str) == nil {
		if l.Type == "assistant" {
			m.Role = "assistant"
		} else {
			m.Role = "user"
		}
		m.Blocks = []model.Block{{Kind: "text", Text: str}}
		return m, true
	}
	var bs []block
	if json.Unmarshal(l.Message.Content, &bs) != nil {
		return m, false
	}
	if l.Type == "assistant" {
		m.Role, m.Model = "assistant", l.Message.Model
		m.TokIn, m.TokOut = l.Message.Usage.In, l.Message.Usage.Out
		for _, b := range bs {
			switch b.Type {
			case "text":
				m.Blocks = append(m.Blocks, model.Block{Kind: "text", Text: b.Text})
			case "thinking":
				m.Blocks = append(m.Blocks, model.Block{Kind: "thinking", Text: b.Thinking})
			case "tool_use":
				m.Blocks = append(m.Blocks, model.Block{Kind: "tool_use", Name: b.Name, Input: string(b.Input), ToolID: b.ID})
			}
		}
		return m, true
	}
	// user 行：含 tool_result 的是工具回传，否则是用户发言（文字或图片）
	m.Role = "user"
	for _, b := range bs {
		switch b.Type {
		case "tool_result":
			m.Role = "tool_result"
			m.Blocks = append(m.Blocks, model.Block{Kind: "tool_result", ToolID: b.ToolUseID, Text: resultText(b.Content), IsError: b.IsError})
		case "text":
			m.Blocks = append(m.Blocks, model.Block{Kind: "text", Text: b.Text})
		case "image":
			m.Blocks = append(m.Blocks, model.Block{Kind: "image"})
		}
	}
	if len(m.Blocks) == 0 {
		return m, false
	}
	return m, true
}

func resultText(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var parts []block
	if json.Unmarshal(raw, &parts) != nil {
		return ""
	}
	var out []string
	for _, p := range parts {
		switch p.Type {
		case "text":
			out = append(out, p.Text)
		case "image":
			out = append(out, "[图片]")
		default:
			out = append(out, "["+p.Type+"]")
		}
	}
	return strings.Join(out, "\n")
}

func (Adapter) Parse(file string) (*model.Session, error) {
	s := &model.Session{Tool: "claude-code", File: file, Precision: model.Exact}
	seen := map[string]bool{} // message.id 去重 token
	mt, err := scan(file, func(l *line, m model.Message) {
		if m.Sidechain {
			return
		}
		ev := model.Event{T: m.T, Role: m.Role, Model: m.Model}
		if id := l.Message.ID; id == "" || !seen[id] {
			ev.TokIn, ev.TokOut = m.TokIn, m.TokOut
			if id != "" {
				seen[id] = true
			}
		}
		var texts []string
		for _, b := range m.Blocks {
			switch b.Kind {
			case "text":
				texts = append(texts, b.Text)
			case "image":
				texts = append(texts, "[图片]")
			case "thinking":
				ev.Thinking = true
			case "tool_use":
				ev.Tools = append(ev.Tools, b.Name)
				ev.ToolInput = append(ev.ToolInput, keyArg(json.RawMessage(b.Input)))
			}
		}
		if m.Role != "tool_result" {
			ev.Text = strings.Join(texts, "\n")
		}
		s.Events = append(s.Events, ev)
	})
	if err != nil {
		return nil, err
	}
	if len(s.Events) == 0 {
		return nil, fmt.Errorf("没有可用的 user/assistant 事件")
	}
	s.ID, s.Title, s.Cwd, s.Branch = mt.id, mt.title, mt.cwd, mt.branch
	s.StartedAt, s.EndedAt = s.Events[0].T, s.Events[len(s.Events)-1].T
	return s, nil
}

// Transcript 还原完整对话（含子 agent 消息，带 Sidechain 标记）。
func (Adapter) Transcript(file string) ([]model.Message, error) {
	var msgs []model.Message
	at := map[string]int{} // message.id -> 在 msgs 中的下标
	_, err := scan(file, func(l *line, m model.Message) {
		if id := l.Message.ID; id != "" && m.Role == "assistant" {
			if i, ok := at[id]; ok { // 同一条 AI 消息拆成多行：合并成一条
				msgs[i].Blocks = append(msgs[i].Blocks, m.Blocks...)
				return
			}
			at[id] = len(msgs)
		}
		msgs = append(msgs, m)
	})
	return msgs, err
}

func keyArg(in json.RawMessage) string {
	var m map[string]any
	if json.Unmarshal(in, &m) != nil {
		return ""
	}
	for _, k := range []string{"command", "file_path", "path", "pattern", "url", "query", "description"} {
		if v, ok := m[k].(string); ok && v != "" {
			return v
		}
	}
	return ""
}
