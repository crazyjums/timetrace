// Package index 维护日志的解析索引：首次全量扫描，之后按文件修改时间与大小增量更新，
// 并持久化到本机缓存文件，下次启动直接可用。只读原始日志。
package index

import (
	"encoding/gob"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/crazyjums/timetrace/internal/adapter"
	"github.com/crazyjums/timetrace/internal/model"
)

// cacheVersion 在统一模型或解析逻辑变化时加 1，旧缓存会被丢弃并重建。
const cacheVersion = 2

// maxText 限制索引里每条事件正文的长度；完整内容由会话详情页按需读取原文件。
const maxText = 2000

type Source struct {
	Adapter string
	Dir     string
}

type entry struct {
	Adapter string
	Dir     string
	ModTime int64
	Size    int64
	Session *model.Session
	Err     string
}

// SourceInfo 是某个数据源的扫描结果。
type SourceInfo struct {
	Source
	Files    int
	Sessions int
	Errors   []model.ParseError
	Missing  bool
}

// Snapshot 是某一代索引的只读视图。
type Snapshot struct {
	Gen      uint64
	Sessions []*model.Session
	Errors   []model.ParseError
	Sources  []SourceInfo
	ByID     map[string]*model.Session
	ScanAt   time.Time
}

type Index struct {
	cachePath string
	lookup    func(id string) adapter.Adapter

	scanMu sync.Mutex // 同一时间只跑一次扫描
	mu     sync.RWMutex
	files  map[string]*entry
	snap   *Snapshot
	gen    uint64
	ready  bool

	scanning    atomic.Bool
	done, total atomic.Int64
	Parsed      atomic.Int64 // 累计实际解析的文件数（测试与诊断用）
}

func New(cachePath string, lookup func(id string) adapter.Adapter) *Index {
	return &Index{cachePath: cachePath, lookup: lookup, files: map[string]*entry{}, snap: &Snapshot{ByID: map[string]*model.Session{}}}
}

type cacheFile struct {
	Version int
	Files   map[string]*entry
	ScanAt  time.Time
}

// LoadCache 读取上次的索引。成功则立即可用（Ready），之后的扫描只处理变化的文件。
func (ix *Index) LoadCache() error {
	if ix.cachePath == "" {
		return nil
	}
	f, err := os.Open(ix.cachePath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	var c cacheFile
	if err := gob.NewDecoder(f).Decode(&c); err != nil || c.Version != cacheVersion {
		return nil // 缓存损坏或版本不同：当作没有缓存，重新扫描
	}
	ix.mu.Lock()
	ix.files = c.Files
	ix.rebuildLocked(nil, c.ScanAt)
	ix.ready = true
	ix.mu.Unlock()
	return nil
}

func (ix *Index) saveCache(scanAt time.Time) error {
	if ix.cachePath == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(ix.cachePath), 0o700); err != nil {
		return err
	}
	tmp := ix.cachePath + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	ix.mu.RLock()
	err = gob.NewEncoder(f).Encode(cacheFile{Version: cacheVersion, Files: ix.files, ScanAt: scanAt})
	ix.mu.RUnlock()
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, ix.cachePath)
}

// Scan 扫描所有数据源：未变化的文件直接复用，新增或变化的并行解析，已删除的移除。
// 返回本次是否有变化。
func (ix *Index) Scan(sources []Source) (bool, error) {
	ix.scanMu.Lock()
	defer ix.scanMu.Unlock()
	ix.scanning.Store(true)
	defer ix.scanning.Store(false)

	type job struct {
		path string
		src  Source
		mod  int64
		size int64
	}
	var jobs []job
	seen := map[string]bool{}
	var srcErr = map[Source]error{}
	ix.mu.RLock()
	old := ix.files
	ix.mu.RUnlock()
	next := map[string]*entry{}
	for _, src := range sources {
		a := ix.lookup(src.Adapter)
		if a == nil {
			srcErr[src] = errors.New("未知适配器 " + src.Adapter)
			continue
		}
		paths, err := a.Discover(src.Dir)
		if err != nil {
			srcErr[src] = err
			continue
		}
		for _, p := range paths {
			if seen[p] {
				continue
			}
			seen[p] = true
			fi, err := os.Stat(p)
			if err != nil {
				continue
			}
			e := old[p]
			if e != nil && e.ModTime == fi.ModTime().UnixNano() && e.Size == fi.Size() && e.Adapter == src.Adapter {
				e.Dir = src.Dir
				next[p] = e
				continue
			}
			jobs = append(jobs, job{p, src, fi.ModTime().UnixNano(), fi.Size()})
		}
	}
	changed := len(jobs) > 0 || len(next) != len(old)

	ix.total.Store(int64(len(jobs)))
	ix.done.Store(0)
	results := make([]*entry, len(jobs))
	var wg sync.WaitGroup
	ch := make(chan int)
	for w := 0; w < runtime.NumCPU(); w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range ch {
				j := jobs[i]
				e := &entry{Adapter: j.src.Adapter, Dir: j.src.Dir, ModTime: j.mod, Size: j.size}
				s, err := ix.lookup(j.src.Adapter).Parse(j.path)
				if err != nil {
					e.Err = err.Error()
				} else {
					trim(s)
					e.Session = s
				}
				results[i] = e
				ix.Parsed.Add(1)
				ix.done.Add(1)
			}
		}()
	}
	for i := range jobs {
		ch <- i
	}
	close(ch)
	wg.Wait()
	for i, j := range jobs {
		next[j.path] = results[i]
	}

	scanAt := time.Now()
	ix.mu.Lock()
	ix.files = next
	ix.rebuildLocked(sources, scanAt)
	ix.snap.Sources = sourceInfos(sources, next, srcErr)
	if changed {
		ix.gen++
		ix.snap.Gen = ix.gen
	}
	ix.ready = true
	ix.mu.Unlock()
	if changed {
		if err := ix.saveCache(scanAt); err != nil {
			return changed, err
		}
	}
	return changed, nil
}

// rebuildLocked 由 files 重建快照（调用方持有写锁）。
func (ix *Index) rebuildLocked(sources []Source, scanAt time.Time) {
	sn := &Snapshot{Gen: ix.gen, ByID: map[string]*model.Session{}, ScanAt: scanAt}
	paths := make([]string, 0, len(ix.files))
	for p := range ix.files {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	for _, p := range paths {
		e := ix.files[p]
		if e.Err != "" {
			sn.Errors = append(sn.Errors, model.ParseError{File: p, Reason: e.Err})
			continue
		}
		sn.Sessions = append(sn.Sessions, e.Session)
		sn.ByID[e.Session.ID] = e.Session
	}
	if sources == nil && ix.snap != nil {
		sn.Sources = ix.snap.Sources
	}
	ix.snap = sn
}

func sourceInfos(sources []Source, files map[string]*entry, srcErr map[Source]error) []SourceInfo {
	var out []SourceInfo
	for _, src := range sources {
		info := SourceInfo{Source: src, Errors: []model.ParseError{}}
		if err := srcErr[src]; err != nil {
			info.Missing = true
			info.Errors = append(info.Errors, model.ParseError{File: src.Dir, Reason: err.Error()})
		}
		for p, e := range files {
			if e.Dir != src.Dir || e.Adapter != src.Adapter {
				continue
			}
			info.Files++
			if e.Err != "" {
				info.Errors = append(info.Errors, model.ParseError{File: p, Reason: e.Err})
			} else {
				info.Sessions++
			}
		}
		out = append(out, info)
	}
	return out
}

// trim 截断事件正文，控制索引的内存与缓存大小。
func trim(s *model.Session) {
	for i := range s.Events {
		if t := s.Events[i].Text; len(t) > maxText {
			cut := maxText
			for cut > 0 && !utf8.RuneStart(t[cut]) {
				cut--
			}
			s.Events[i].Text = t[:cut] + "…"
		}
	}
}

func (ix *Index) Snapshot() *Snapshot {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	return ix.snap
}

// Status 供界面显示首次索引进度。
type Status struct {
	Ready    bool      `json:"ready"`
	Scanning bool      `json:"scanning"`
	Done     int64     `json:"done"`
	Total    int64     `json:"total"`
	Sessions int       `json:"sessions"`
	ScanAt   time.Time `json:"scanAt"`
}

func (ix *Index) Status() Status {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	return Status{Ready: ix.ready, Scanning: ix.scanning.Load(), Done: ix.done.Load(), Total: ix.total.Load(), Sessions: len(ix.snap.Sessions), ScanAt: ix.snap.ScanAt}
}

// File 返回会话的原始日志路径与适配器，用于按需还原对话。
func (ix *Index) File(sid string) (path, adapterID string, ok bool) {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	s := ix.snap.ByID[sid]
	if s == nil {
		return "", "", false
	}
	if e := ix.files[s.File]; e != nil {
		return s.File, e.Adapter, true
	}
	return "", "", false
}
