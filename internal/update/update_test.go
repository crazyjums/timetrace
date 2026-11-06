package update_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/crazyjums/timetrace/internal/update"
)

func TestNewer(t *testing.T) {
	cases := []struct {
		latest, current string
		want            bool
	}{
		{"v0.1.10", "0.1.9", true}, // 按数字比较，不是按字符串
		{"0.1.9", "0.1.10", false},
		{"v0.1.10", "0.1.10", false},
		{"v0.2.0", "0.1.99", true},
		{"v1.0", "0.9.9", true},
		{"v0.1.10", "dev", false}, // 开发版不提示
		{"v0.1.10-beta", "0.1.0", false},
		{"", "0.1.0", false},
	}
	for _, c := range cases {
		if got := update.Newer(c.latest, c.current); got != c.want {
			t.Errorf("Newer(%q, %q) = %v, want %v", c.latest, c.current, got, c.want)
		}
	}
}

func fake(t *testing.T, code int, body string) *httptest.Server {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/crazyjums/timetrace/releases/latest" || r.Header.Get("User-Agent") != "timetrace-update-check" {
			t.Errorf("请求不对: %s UA=%q", r.URL.Path, r.Header.Get("User-Agent"))
		}
		if r.Method != "GET" || r.ContentLength > 0 {
			t.Error("只应发 GET 且不带请求体")
		}
		w.WriteHeader(code)
		w.Write([]byte(body))
	}))
	t.Cleanup(ts.Close)
	return ts
}

const latest = `{"tag_name":"v0.1.11","name":"v0.1.11","html_url":"https://github.com/crazyjums/timetrace/releases/tag/v0.1.11","published_at":"2026-11-06T14:30:00Z","draft":false,"prerelease":false,"body":"## What's Changed"}`

func TestCheck(t *testing.T) {
	c := update.New("0.1.10")
	c.BaseURL = fake(t, 200, latest).URL
	st := c.Check(context.Background())
	if !st.Available || st.Latest == nil || st.Latest.Version != "0.1.11" || st.Error != "" || st.CheckedAt.IsZero() {
		t.Fatalf("%+v", st)
	}
	c.Current = "0.1.11"
	if c.Check(context.Background()).Available {
		t.Error("已是最新版本时不应提示")
	}
}

func TestCheckRejectsBadResponses(t *testing.T) {
	for name, tc := range map[string]struct {
		code int
		body string
		want string
	}{
		"非本仓库地址": {200, strings.Replace(latest, "github.com/crazyjums/timetrace", "evil.example.com/x", 1), "地址异常"},
		"预发布":    {200, strings.Replace(latest, `"prerelease":false`, `"prerelease":true`, 1), "不是正式版本"},
		"没有发布":   {404, `{}`, "还没有发布"},
		"限流":     {403, `{}`, "HTTP 403"},
	} {
		c := update.New("0.1.10")
		c.BaseURL = fake(t, tc.code, tc.body).URL
		st := c.Check(context.Background())
		if st.Available || !strings.Contains(st.Error, tc.want) {
			t.Errorf("%s: %+v", name, st)
		}
	}
}
