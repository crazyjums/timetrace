// Package adapter 定义数据源适配器接口。新增工具 = 新增一个实现，不改核心。
package adapter

import "github.com/crazyjums/timetrace/internal/model"

type Adapter interface {
	ID() string
	// Discover 只读扫描目录，返回所有候选日志文件。
	Discover(root string) ([]string, error)
	// Parse 只读解析单个文件；失败时返回带原因的 error。
	Parse(file string) (*model.Session, error)
}

// Transcriber 是可选能力：把单个会话还原成完整对话（用于会话详情页）。
type Transcriber interface {
	Transcript(file string) ([]model.Message, error)
}

// ScanAll 解析 root 下所有文件；单个文件失败只记入 errs。
func ScanAll(a Adapter, root string) (sessions []*model.Session, errs []model.ParseError, err error) {
	files, err := a.Discover(root)
	if err != nil {
		return nil, nil, err
	}
	for _, f := range files {
		s, perr := a.Parse(f)
		if perr != nil {
			errs = append(errs, model.ParseError{File: f, Reason: perr.Error()})
			continue
		}
		sessions = append(sessions, s)
	}
	return
}
