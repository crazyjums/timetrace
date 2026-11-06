// Package claudecode 解析 Claude Code 的 ~/.claude/projects/**/*.jsonl。
// 格式依据真实样例核对：每行一个 JSON；type=user/assistant 带 timestamp(RFC3339)、
// cwd、sessionId、isSidechain、isMeta；message.content 为字符串或块数组
// （text / tool_use{name,input} / tool_result / thinking）。type=ai-title 带 aiTitle。
// 其余未知类型一律忽略；子 agent（isSidechain）事件不计入主会话轮次。
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
	AITitle     string `json:"aiTitle"`
	Message     struct {
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

type block struct {
	Type  string          `json:"type"`
	Text  string          `json:"text"`
	Name  string          `json:"name"`
	Input json.RawMessage `json:"input"`
}

func (Adapter) Parse(file string) (*model.Session, error) {
	f, err := os.Open(file) // 只读
	if err != nil {
		return nil, err
	}
	defer f.Close()

	s := &model.Session{Tool: "claude-code", File: file, Precision: model.Exact}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 64<<20)
	n, bad := 0, 0
	for sc.Scan() {
		raw := strings.TrimSpace(sc.Text())
		if raw == "" {
			continue
		}
		n++
		var l line
		if err := json.Unmarshal([]byte(raw), &l); err != nil {
			bad++
			continue
		}
		if l.AITitle != "" {
			s.Title = l.AITitle
		}
		if l.SessionID != "" && s.ID == "" {
			s.ID = l.SessionID
		}
		if (l.Type != "user" && l.Type != "assistant") || l.IsSidechain || l.IsMeta {
			continue
		}
		t, err := time.Parse(time.RFC3339Nano, l.Timestamp)
		if err != nil {
			bad++
			continue
		}
		if s.Cwd == "" {
			s.Cwd = l.Cwd
		}
		if ev, ok := toEvent(l, t); ok {
			s.Events = append(s.Events, ev)
		}
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("读取失败: %w", err)
	}
	if n > 0 && bad == n {
		return nil, fmt.Errorf("全部 %d 行都无法解析，疑似不是 Claude Code 日志", n)
	}
	if len(s.Events) == 0 {
		return nil, fmt.Errorf("没有可用的 user/assistant 事件")
	}
	if s.ID == "" {
		s.ID = strings.TrimSuffix(filepath.Base(file), ".jsonl")
	}
	s.StartedAt, s.EndedAt = s.Events[0].T, s.Events[len(s.Events)-1].T
	return s, nil
}

func toEvent(l line, t time.Time) (model.Event, bool) {
	ev := model.Event{T: t}
	var str string
	if json.Unmarshal(l.Message.Content, &str) == nil { // 纯字符串 = 用户输入
		if l.Type != "user" {
			ev.Role = "assistant"
			return ev, true
		}
		ev.Role, ev.Text = "user", str
		return ev, true
	}
	var bs []block
	if json.Unmarshal(l.Message.Content, &bs) != nil {
		return ev, false
	}
	if l.Type == "assistant" {
		ev.Role = "assistant"
		var texts []string
		for _, b := range bs {
			if b.Type == "text" && b.Text != "" {
				texts = append(texts, b.Text)
			}
			if b.Type == "tool_use" {
				ev.Tools = append(ev.Tools, b.Name)
				ev.ToolInput = append(ev.ToolInput, keyArg(b.Input))
			}
		}
		ev.Text = strings.Join(texts, "\n")
		return ev, true
	}
	// user 事件：含 tool_result 的是工具回传，不是用户发言
	var text []string
	for _, b := range bs {
		if b.Type == "tool_result" {
			ev.Role = "tool_result"
			return ev, true
		}
		if b.Type == "text" {
			text = append(text, b.Text)
		}
	}
	if len(text) == 0 {
		return ev, false
	}
	ev.Role, ev.Text = "user", strings.Join(text, "\n")
	return ev, true
}

func keyArg(in json.RawMessage) string {
	var m map[string]any
	if json.Unmarshal(in, &m) != nil {
		return ""
	}
	for _, k := range []string{"command", "file_path", "path", "pattern", "url", "query"} {
		if v, ok := m[k].(string); ok {
			return v
		}
	}
	return ""
}
