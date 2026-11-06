package index_test

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/crazyjums/timetrace/internal/adapter"
	"github.com/crazyjums/timetrace/internal/adapter/claudecode"
	"github.com/crazyjums/timetrace/internal/index"
)

func lookup(id string) adapter.Adapter {
	if id == "claude-code" {
		return claudecode.Adapter{}
	}
	return nil
}

func copyFile(t *testing.T, src, dst string) {
	b, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dst, b, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestIncrementalAndCache(t *testing.T) {
	dir := t.TempDir()
	copyFile(t, "../adapter/claudecode/testdata/scan/s1.jsonl", filepath.Join(dir, "s1.jsonl"))
	copyFile(t, "../adapter/claudecode/testdata/transcript/split.jsonl", filepath.Join(dir, "sp.jsonl"))
	os.WriteFile(filepath.Join(dir, "bad.jsonl"), []byte("garbage\n"), 0o600)
	cache := filepath.Join(t.TempDir(), "idx.gob")
	srcs := []index.Source{{Adapter: "claude-code", Dir: dir}}

	ix := index.New(cache, lookup)
	if changed, err := ix.Scan(srcs); err != nil || !changed {
		t.Fatal(changed, err)
	}
	sn := ix.Snapshot()
	if len(sn.Sessions) != 2 || len(sn.Errors) != 1 || ix.Parsed.Load() != 3 {
		t.Fatalf("首次扫描: sessions=%d errs=%d parsed=%d", len(sn.Sessions), len(sn.Errors), ix.Parsed.Load())
	}
	// 没有变化：不重新解析
	if changed, _ := ix.Scan(srcs); changed || ix.Parsed.Load() != 3 {
		t.Errorf("无变化时不应重新解析: parsed=%d", ix.Parsed.Load())
	}
	// 修改一个文件：只解析它
	future := time.Now().Add(time.Minute)
	os.Chtimes(filepath.Join(dir, "s1.jsonl"), future, future)
	if changed, _ := ix.Scan(srcs); !changed || ix.Parsed.Load() != 4 {
		t.Errorf("应只重新解析变化的文件: parsed=%d", ix.Parsed.Load())
	}
	// 删除一个文件：从索引移除
	os.Remove(filepath.Join(dir, "sp.jsonl"))
	ix.Scan(srcs)
	if n := len(ix.Snapshot().Sessions); n != 1 {
		t.Errorf("删除后会话数=%d", n)
	}
	// 从缓存恢复：立即可用，且再次扫描不重新解析
	ix2 := index.New(cache, lookup)
	if err := ix2.LoadCache(); err != nil {
		t.Fatal(err)
	}
	if st := ix2.Status(); !st.Ready || st.Sessions != 1 {
		t.Fatalf("缓存恢复失败: %+v", st)
	}
	if ix2.Scan(srcs); ix2.Parsed.Load() != 0 {
		t.Errorf("缓存命中时不应重新解析: parsed=%d", ix2.Parsed.Load())
	}
	if p, a, ok := ix2.File("s1"); !ok || a != "claude-code" || filepath.Base(p) != "s1.jsonl" {
		t.Errorf("File 查找失败: %s %s %v", p, a, ok)
	}
}

func TestMissingDirAndCorruptCache(t *testing.T) {
	cache := filepath.Join(t.TempDir(), "idx.gob")
	os.WriteFile(cache, []byte("not gob"), 0o600)
	ix := index.New(cache, lookup)
	if err := ix.LoadCache(); err != nil || ix.Status().Ready {
		t.Fatalf("损坏的缓存应被忽略: %v %+v", err, ix.Status())
	}
	ix.Scan([]index.Source{{Adapter: "claude-code", Dir: filepath.Join(t.TempDir(), "none")}})
	sn := ix.Snapshot()
	if len(sn.Sources) != 1 || !sn.Sources[0].Missing {
		t.Errorf("目录不存在应标记 Missing: %+v", sn.Sources)
	}
}
