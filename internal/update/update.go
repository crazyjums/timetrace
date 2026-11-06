// Package update 检查 GitHub 上是否有新版本。只发一个 GET 请求获取最新 Release 的版本号，
// 不发送任何本地数据；失败时静默，只记录错误供设置页显示。
package update

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

const Repo = "crazyjums/timetrace"

// Release 是最新版本的信息（字段已对照 GitHub API 的真实返回核对）。
type Release struct {
	Version     string    `json:"version"` // 去掉前缀 v，例如 0.1.10
	Name        string    `json:"name"`
	URL         string    `json:"url"` // Release 页面
	PublishedAt time.Time `json:"publishedAt"`
	Notes       string    `json:"notes"` // 更新说明（截断）
}

type Status struct {
	Current   string    `json:"current"`
	Latest    *Release  `json:"latest"`
	Available bool      `json:"available"`
	CheckedAt time.Time `json:"checkedAt"`
	Error     string    `json:"error,omitempty"`
}

type Checker struct {
	Current string // 当前版本；为空或无法解析（如开发版 "dev"）时不提示更新
	BaseURL string // 默认 https://api.github.com，测试时替换
	Client  *http.Client

	mu sync.Mutex
	st Status
}

func New(current string) *Checker {
	return &Checker{Current: current, BaseURL: "https://api.github.com", Client: &http.Client{Timeout: 15 * time.Second}}
}

func (c *Checker) Status() Status {
	c.mu.Lock()
	defer c.mu.Unlock()
	st := c.st
	st.Current = c.Current
	return st
}

// Check 立即检查一次并更新缓存的状态。
func (c *Checker) Check(ctx context.Context) Status {
	rel, err := c.fetch(ctx)
	c.mu.Lock()
	c.st.CheckedAt = time.Now()
	if err != nil {
		c.st.Error = err.Error()
	} else {
		c.st.Error, c.st.Latest = "", rel
		c.st.Available = Newer(rel.Version, c.Current)
	}
	c.mu.Unlock()
	return c.Status()
}

func (c *Checker) fetch(ctx context.Context) (*Release, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", strings.TrimRight(c.BaseURL, "/")+"/repos/"+Repo+"/releases/latest", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "timetrace-update-check") // 通用客户端名，不含任何用户信息
	resp, err := c.Client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("连接 GitHub 失败: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("还没有发布任何版本")
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub 返回 HTTP %d", resp.StatusCode)
	}
	var r struct {
		TagName     string    `json:"tag_name"`
		Name        string    `json:"name"`
		HTMLURL     string    `json:"html_url"`
		PublishedAt time.Time `json:"published_at"`
		Body        string    `json:"body"`
		Draft       bool      `json:"draft"`
		Prerelease  bool      `json:"prerelease"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
		return nil, fmt.Errorf("解析 GitHub 返回失败: %w", err)
	}
	if r.Draft || r.Prerelease || parse(r.TagName) == nil {
		return nil, fmt.Errorf("最新 Release 不是正式版本: %q", r.TagName)
	}
	// 只信任本仓库的 Release 页面地址，界面上的「下载」只会打开这里
	if !strings.HasPrefix(r.HTMLURL, "https://github.com/"+Repo+"/releases/") {
		return nil, fmt.Errorf("Release 地址异常: %q", r.HTMLURL)
	}
	notes := r.Body
	if len(notes) > 2000 {
		notes = notes[:2000] + "…"
	}
	return &Release{Version: strings.TrimPrefix(r.TagName, "v"), Name: r.Name, URL: r.HTMLURL, PublishedAt: r.PublishedAt, Notes: notes}, nil
}

// parse 解析 "v0.1.10" / "0.1.10" 为 [0 1 10]；不是纯数字的版本返回 nil。
func parse(v string) []int {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if v == "" {
		return nil
	}
	var out []int
	for _, p := range strings.Split(v, ".") {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return nil
		}
		out = append(out, n)
	}
	return out
}

// Newer：latest 是否比 current 新。任一方无法解析时返回 false（开发版不提示）。
func Newer(latest, current string) bool {
	a, b := parse(latest), parse(current)
	if a == nil || b == nil {
		return false
	}
	for i := 0; i < len(a) || i < len(b); i++ {
		var x, y int
		if i < len(a) {
			x = a[i]
		}
		if i < len(b) {
			y = b[i]
		}
		if x != y {
			return x > y
		}
	}
	return false
}
