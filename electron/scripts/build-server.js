// 编译内嵌的 Go 本机服务到 electron/bin/。可用环境变量 GOOS / GOARCH 指定目标平台。
const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const goos = process.env.GOOS || { win32: "windows", darwin: "darwin", linux: "linux" }[process.platform];
const ext = goos === "windows" ? ".exe" : "";
const out = path.join(__dirname, "..", "bin", "timetrace-server" + ext);
fs.mkdirSync(path.dirname(out), { recursive: true });
execFileSync("go", ["build", "-trimpath", "-ldflags", "-s -w", "-o", out, "./cmd/timetrace-server"], {
  cwd: path.join(__dirname, "..", ".."),
  stdio: "inherit",
  env: { ...process.env, CGO_ENABLED: "0" },
});
console.log("built", out);
