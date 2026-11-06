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
)

func setup(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	dir := t.TempDir()
	data, _ := os.ReadFile("../adapter/claudecode/testdata/s1.jsonl")
	os.WriteFile(filepath.Join(dir, "s1.jsonl"), data, 0o600)
	os.WriteFile(filepath.Join(dir, "bad.jsonl"), []byte("garbage\n"), 0o600)
	state := filepath.Join(t.TempDir(), "state.json")
	f := store.Default()
	f.Settings.Sources = []store.Source{{Adapter: "claude-code", Dir: dir, Enabled: true}}
	if err := store.Save(state, f); err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(server.New(state).Handler())
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
	code, body := do(t, "GET", ts.URL+"/api/requirements", "", nil)
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
