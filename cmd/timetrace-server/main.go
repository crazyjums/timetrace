// timetrace-server：本机 HTTP 服务 + 内嵌界面。只监听 127.0.0.1。
// 启动后在 stdout 输出一行 "LISTENING http://127.0.0.1:<port>"，供 Electron 外壳读取。
package main

import (
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"

	"github.com/crazyjums/timetrace/internal/server"
	"github.com/crazyjums/timetrace/internal/store"
)

func main() {
	port := flag.Int("port", 0, "端口，0 表示随机")
	state := flag.String("state", store.DefaultPath(), "本机状态文件")
	flag.Parse()
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *port))
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("LISTENING http://%s\n", ln.Addr())
	log.Fatal(http.Serve(ln, server.New(*state).Handler()))
}
