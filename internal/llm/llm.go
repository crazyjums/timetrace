// Package llm：可选的大模型解读。默认关闭、只能手动触发、发送前必须预览。
// 发送内容只来自本地聚合数字；大模型不得编造数字。
package llm

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/crazyjums/timetrace/internal/core"
	"github.com/crazyjums/timetrace/internal/store"
)

type Payload struct {
	Level        string             `json:"level"`
	Total        float64            `json:"active_seconds"`
	Phases       map[string]float64 `json:"phase_seconds"`
	Requirements []ReqPayload       `json:"requirements,omitempty"`
}

type ReqPayload struct {
	Name   string             `json:"name,omitempty"`
	Active float64            `json:"active_seconds"`
	Phases map[string]float64 `json:"phase_seconds,omitempty"` // 仅 segments 档
}

// BuildPayload：counts 仅聚合数；names 加需求名；segments 加每个需求的分段摘要。
func BuildPayload(level string, reqs []*core.Requirement) (Payload, error) {
	p := Payload{Level: level, Phases: map[string]float64{}}
	if level != "counts" && level != "names" && level != "segments" {
		return p, fmt.Errorf("未知发送档位 %q", level)
	}
	for _, r := range reqs {
		p.Total += r.Active.Seconds()
		for ph, d := range r.ByPhase {
			p.Phases[string(ph)] += d.Seconds()
		}
		if level == "counts" {
			continue
		}
		rp := ReqPayload{Name: r.Name, Active: r.Active.Seconds()}
		if level == "segments" {
			rp.Phases = map[string]float64{}
			for ph, d := range r.ByPhase {
				rp.Phases[string(ph)] = d.Seconds()
			}
		}
		p.Requirements = append(p.Requirements, rp)
	}
	return p, nil
}

// Preview 返回将要发送的 JSON，供用户确认。
func Preview(p Payload) ([]byte, error) { return json.MarshalIndent(p, "", "  ") }

var ErrDisabled = errors.New("大模型建议未启用（设置中默认关闭）")

// Send 手动触发。cfg.Enabled 为 false 时拒绝。
// Ollama 的 /api/chat 请求/响应格式来自记忆，**不确定**，首次接入请对照官方文档核对。
func Send(cfg store.LLMCfg, preview []byte, client *http.Client) (string, error) {
	if !cfg.Enabled {
		return "", ErrDisabled
	}
	if client == nil {
		client = &http.Client{Timeout: 60 * time.Second}
	}
	body, _ := json.Marshal(map[string]any{
		"model":  cfg.Model,
		"stream": false,
		"messages": []map[string]string{
			{"role": "system", "content": "你是时间统计的解读助手。只能引用提供的数字，不得编造任何数字；相关性结论要注明「相关，不等于因果」。"},
			{"role": "user", "content": string(preview)},
		},
	})
	resp, err := client.Post(cfg.Endpoint+"/api/chat", "application/json", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("HTTP %d: %s", resp.StatusCode, b)
	}
	var out struct {
		Message struct{ Content string } `json:"message"`
	}
	if err := json.Unmarshal(b, &out); err != nil {
		return "", err
	}
	return out.Message.Content, nil
}
