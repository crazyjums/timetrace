package server_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/crazyjums/timetrace/internal/server"
	"github.com/crazyjums/timetrace/internal/store"
	"github.com/crazyjums/timetrace/internal/update"
)

func setup(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	dir := t.TempDir()
	data, _ := os.ReadFile("../adapter/claudecode/testdata/scan/s1.jsonl")
	os.WriteFile(filepath.Join(dir, "s1.jsonl"), data, 0o600)
	os.WriteFile(filepath.Join(dir, "bad.jsonl"), []byte("garbage\n"), 0o600)
	state := filepath.Join(t.TempDir(), "state.json")
	f := store.Default()
	f.Settings.Sources = []store.Source{{Adapter: "claude-code", Dir: dir, Enabled: true}}
	if err := store.Save(state, f); err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(server.New(state, "").Handler())
	t.Cleanup(ts.Close)
	return ts, state
}

func do(t *testing.T, method, url, body string, hdr map[string]string) (int, string) {
	req, _ := http.NewRequest(method, url, strings.NewReader(body))
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var sb strings.Builder
	buf := make([]byte, 4096)
	for {
		n, e := resp.Body.Read(buf)
		sb.Write(buf[:n])
		if e != nil {
			break
		}
	}
	return resp.StatusCode, sb.String()
}

var csrf = map[string]string{"X-Timetrace": "1"}

func TestRequirementsAndBadFile(t *testing.T) {
	ts, _ := setup(t)
	code, body := do(t, "GET", ts.URL+"/api/requirements?range=all", "", nil)
	if code != 200 {
		t.Fatal(code, body)
	}
	var d struct {
		Requirements []struct {
			Key, Name string
			Turns     int
		}
		ParseErrors []struct{ File, Reason string }
	}
	json.Unmarshal([]byte(body), &d)
	if len(d.Requirements) != 1 || d.Requirements[0].Turns != 3 || len(d.ParseErrors) != 1 {
		t.Fatalf("%s", body)
	}
	code, body = do(t, "GET", ts.URL+"/api/turn?sid=s1&i=1", "", nil)
	if code != 200 || !strings.Contains(body, `"kind":"tool"`) {
		t.Fatal(code, body)
	}
}

func TestMutationsNeedHeaderAndLocalHost(t *testing.T) {
	ts, _ := setup(t)
	if c, _ := do(t, "POST", ts.URL+"/api/overrides", `{"op":"rename","key":"s1","name":"x"}`, nil); c != 403 {
		t.Errorf("无自定义头应 403, got %d", c)
	}
	if c, _ := do(t, "POST", ts.URL+"/api/overrides", `{"op":"rename","key":"s1","name":"x"}`, csrf); c != 200 {
		t.Errorf("rename code=%d", c)
	}
	req, _ := http.NewRequest("GET", ts.URL+"/api/today", nil)
	req.Host = "evil.example.com" // DNS rebinding
	resp, _ := http.DefaultClient.Do(req)
	if resp.StatusCode != 403 {
		t.Errorf("非本机 Host 应 403, got %d", resp.StatusCode)
	}
	if c, _ := do(t, "POST", ts.URL+"/api/overrides", `{"op":"phase","sid":"s1","turn":0,"phase":"Z"}`, csrf); c != 400 {
		t.Errorf("非法阶段应 400, got %d", c)
	}
}

func TestLLMGates(t *testing.T) {
	ts, state := setup(t)
	_, pv := do(t, "GET", ts.URL+"/api/llm/preview", "", nil)
	var p struct {
		Enabled bool
		Payload json.RawMessage
	}
	json.Unmarshal([]byte(pv), &p)
	if p.Enabled {
		t.Fatal("默认应关闭")
	}
	body := `{"confirmed":` + string(p.Payload) + `}`
	if c, _ := do(t, "POST", ts.URL+"/api/llm/send", body, csrf); c != 403 {
		t.Errorf("未启用应 403, got %d", c)
	}
	f, _ := store.Load(state)
	f.Settings.LLM.Enabled = true
	store.Save(state, f)
	if c, _ := do(t, "POST", ts.URL+"/api/llm/send", `{"confirmed":{"level":"counts"}}`, csrf); c != 409 {
		t.Errorf("与预览不一致应 409, got %d", c)
	}
}

func TestSettingsValidationAndSourceTest(t *testing.T) {
	ts, _ := setup(t)
	if c, _ := do(t, "PUT", ts.URL+"/api/settings", `{"idle_minutes":0,"window_hours":4}`, csrf); c != 400 {
		t.Errorf("非法设置应 400, got %d", c)
	}
	dir := filepath.Join(t.TempDir(), "none")
	if c, _ := do(t, "POST", ts.URL+"/api/sources/test", `{"adapter":"claude-code","dir":"`+dir+`"}`, csrf); c != 400 {
		t.Errorf("目录不存在应 400, got %d", c)
	}
	if c, _ := do(t, "POST", ts.URL+"/api/sources/test", `{"adapter":"nope","dir":"/"}`, csrf); c != 400 {
		t.Errorf("未知适配器应 400, got %d", c)
	}
}

func TestStaticIndex(t *testing.T) {
	ts, _ := setup(t)
	c, b := do(t, "GET", ts.URL+"/", "", nil)
	if c != 200 || !strings.Contains(b, "时迹") {
		t.Fatal(c)
	}
}

func TestNewEndpointsShape(t *testing.T) {
	ts, _ := setup(t)
	for _, path := range []string{"/api/today", "/api/insights?range=week", "/api/insights?range=month", "/api/sources", "/api/requirements?range=today"} {
		c, b := do(t, "GET", ts.URL+path, "", nil)
		if c != 200 || !json.Valid([]byte(b)) {
			t.Fatalf("%s: %d %s", path, c, b)
		}
		// 前端遍历这些字段，不能是 null
		for _, bad := range []string{`"suggestions":null`, `"ranking":null`, `"topReqs":null`, `"coarse":null`, `"items":null`, `"requirements":null`} {
			if strings.Contains(b, bad) {
				t.Errorf("%s 含 %s", path, bad)
			}
		}
	}
	_, b := do(t, "GET", ts.URL+"/api/sources", "", nil)
	if !strings.Contains(b, `"implemented":false`) || !strings.Contains(b, `"capCols"`) {
		t.Errorf("sources 应列出未实现的工具与能力矩阵: %s", b)
	}
	_, b = do(t, "GET", ts.URL+"/api/requirements/s1", "", nil)
	if !strings.Contains(b, `"siblings"`) || !strings.Contains(b, `"sessionList"`) {
		t.Errorf("明细缺字段: %s", b)
	}
	_, b = do(t, "GET", ts.URL+"/api/turn?sid=s1&i=1", "", nil)
	if !strings.Contains(b, `"dur":5`) { // Write 工具耗时 5s
		t.Errorf("工具耗时缺失: %s", b)
	}
}

func TestSessionAndTranscript(t *testing.T) {
	ts, _ := setup(t)
	c, b := do(t, "GET", ts.URL+"/api/status", "", nil)
	if c != 200 || !strings.Contains(b, `"dirs"`) {
		t.Fatalf("status: %d %s", c, b)
	}
	c, b = do(t, "GET", ts.URL+"/api/session/s1", "", nil)
	if c != 200 || !strings.Contains(b, `"turns":[`) || !strings.Contains(b, `"req":{`) {
		t.Fatalf("session: %d %s", c, b)
	}
	c, b = do(t, "GET", ts.URL+"/api/session/s1/transcript", "", nil)
	if c != 200 {
		t.Fatalf("transcript: %d %s", c, b)
	}
	var tr struct {
		Messages []struct {
			Role   string
			Turn   int
			Blocks []struct{ Kind, Name string }
		}
	}
	json.Unmarshal([]byte(b), &tr)
	// s1：3 轮；子 agent 那行带标记保留；坏行跳过
	last := tr.Messages[len(tr.Messages)-1]
	if len(tr.Messages) < 6 || tr.Messages[0].Role != "user" || last.Turn != 2 {
		t.Errorf("对话还原错误: %s", b)
	}
	if c, _ := do(t, "GET", ts.URL+"/api/session/nope/transcript", "", nil); c != 404 {
		t.Errorf("不存在的会话应 404, got %d", c)
	}
}

func TestNoParseErrorsIsEmptyArray(t *testing.T) {
	dir := t.TempDir()
	data, _ := os.ReadFile("../adapter/claudecode/testdata/scan/s1.jsonl")
	os.WriteFile(filepath.Join(dir, "s1.jsonl"), data, 0o600)
	state := filepath.Join(t.TempDir(), "state.json")
	f := store.Default()
	f.Settings.Sources = []store.Source{{Adapter: "claude-code", Dir: dir, Enabled: true}}
	store.Save(state, f)
	ts := httptest.NewServer(server.New(state, "").Handler())
	defer ts.Close()
	for _, path := range []string{"/api/requirements?range=all", "/api/sources"} {
		_, b := do(t, "GET", ts.URL+path, "", nil)
		if strings.Contains(b, `"parseErrors":null`) || strings.Contains(b, `"sources":null`) {
			t.Errorf("%s 没有解析错误时应返回空数组: %s", path, b)
		}
	}
}

func TestUpdateEndpoint(t *testing.T) {
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"tag_name":"v0.1.11","name":"v0.1.11","html_url":"https://github.com/crazyjums/timetrace/releases/tag/v0.1.11","published_at":"2026-11-06T14:30:00Z"}`))
	}))
	defer gh.Close()
	dir := t.TempDir()
	state := filepath.Join(dir, "state.json")
	// 旧版本的状态文件没有 no_update_check 字段：默认应为开启检查
	os.WriteFile(state, []byte(`{"settings":{"idle_minutes":10,"window_hours":4,"sources":[]}}`), 0o600)
	srv := server.New(state, "")
	srv.Update = update.New("0.1.10")
	srv.Update.BaseURL = gh.URL
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	_, b := do(t, "GET", ts.URL+"/api/update", "", nil)
	if !strings.Contains(b, `"enabled":true`) || !strings.Contains(b, `"latest":null`) {
		t.Fatalf("GET 只返回缓存、不联网，且默认开启: %s", b)
	}
	if c, _ := do(t, "POST", ts.URL+"/api/update", "{}", nil); c != 403 {
		t.Errorf("POST 需要 X-Timetrace 头, got %d", c)
	}
	_, b = do(t, "POST", ts.URL+"/api/update", "{}", csrf)
	if !strings.Contains(b, `"available":true`) || !strings.Contains(b, `"version":"0.1.11"`) {
		t.Errorf("立即检查应发现新版本: %s", b)
	}
	// 关闭自动检查后设置能保存
	do(t, "PUT", ts.URL+"/api/settings", `{"idle_minutes":10,"window_hours":4,"no_update_check":true,"sources":[]}`, csrf)
	if _, b = do(t, "GET", ts.URL+"/api/update", "", nil); !strings.Contains(b, `"enabled":false`) {
		t.Errorf("关闭后应为 enabled=false: %s", b)
	}
}
