// Package store 把人工修正与设置保存为本机 JSON 文件。不联网，不写原始日志。
package store

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/crazyjums/timetrace/internal/core"
)

type Settings struct {
	IdleMinutes int    `json:"idle_minutes"`
	WindowHours int    `json:"window_hours"`
	LLM         LLMCfg `json:"llm"`
}

// LLMCfg 默认关闭；Level: counts | names | segments。
type LLMCfg struct {
	Enabled  bool   `json:"enabled"`
	Endpoint string `json:"endpoint"` // 例如本地 Ollama http://127.0.0.1:11434
	Model    string `json:"model"`
	Level    string `json:"level"`
}

type File struct {
	Settings  Settings       `json:"settings"`
	Overrides core.Overrides `json:"overrides"`
}

func DefaultPath() string {
	d, err := os.UserConfigDir()
	if err != nil {
		d = os.Getenv("HOME")
	}
	return filepath.Join(d, "timetrace", "state.json")
}

func Default() File {
	return File{Settings: Settings{IdleMinutes: 10, WindowHours: 4, LLM: LLMCfg{Level: "counts"}}}
}

// Load：文件不存在返回默认值。
func Load(path string) (File, error) {
	f := Default()
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return f, nil
	}
	if err != nil {
		return f, err
	}
	err = json.Unmarshal(b, &f)
	return f, err
}

// Save 原子写入（临时文件 + rename）。
func Save(path string, f File) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (s Settings) Config() core.Config {
	return core.Config{
		IdleThreshold: time.Duration(s.IdleMinutes) * time.Minute,
		MergeWindow:   time.Duration(s.WindowHours) * time.Hour,
	}
}
