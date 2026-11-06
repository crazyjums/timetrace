// timetrace-server：本机 HTTP 服务 + 内嵌界面。只监听 127.0.0.1。
// 启动后在 stdout 输出一行 "LISTENING http://127.0.0.1:<port>"，供 Electron 外壳读取。
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/crazyjums/timetrace/internal/server"
	"github.com/crazyjums/timetrace/internal/store"
	"github.com/crazyjums/timetrace/internal/update"
)

func main() {
	port := flag.Int("port", 0, "端口，0 表示随机")
	state := flag.String("state", store.DefaultPath(), "本机状态文件")
	cache := flag.String("cache", defaultCache(), "索引缓存文件（可删除，删除后会重新扫描）")
	interval := flag.Duration("interval", 10*time.Second, "增量刷新间隔")
	appVersion := flag.String("app-version", version, "当前版本号，用于检查更新（Electron 外壳会传入自己的版本）")
	flag.Parse()
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *port))
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("LISTENING http://%s\n", ln.Addr())
	srv := server.New(*state, *cache)
	srv.Update = update.New(*appVersion)
	srv.Start(context.Background(), *interval)
	log.Fatal(http.Serve(ln, srv.Handler()))
}

// version 可在构建时用 -ldflags "-X main.version=0.1.11" 写入；开发版为 dev，不提示更新。
var version = "dev"

func defaultCache() string {
	d, err := os.UserCacheDir()
	if err != nil {
		d = os.TempDir()
	}
	return filepath.Join(d, "timetrace", "index.gob")
}
