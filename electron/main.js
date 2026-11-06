// Electron 外壳：只负责启动本机 Go 服务并加载界面，不含业务逻辑。
// 安全：不开 nodeIntegration、开 contextIsolation、沙箱；只允许加载 127.0.0.1，外链交给系统浏览器。
const { app, BrowserWindow, shell, dialog } = require("electron");
const { spawn } = require("child_process");
const path = require("path");

let server;

function startServer() {
  return new Promise((resolve, reject) => {
    const bin = app.isPackaged
      ? path.join(process.resourcesPath, "timetrace-server")
      : path.join(__dirname, "bin", "timetrace-server");
    server = spawn(bin, ["--port", "0"], { stdio: ["ignore", "pipe", "inherit"] });
    server.on("error", reject);
    server.on("exit", code => { if (!app.isQuitting) reject(new Error("服务异常退出，code=" + code)); });
    let buf = "";
    server.stdout.on("data", d => {
      buf += d;
      const m = buf.match(/LISTENING (http:\/\/127\.0\.0\.1:\d+)/);
      if (m) resolve(m[1]);
    });
    setTimeout(() => reject(new Error("服务启动超时")), 10000);
  });
}

async function createWindow() {
  let url;
  try { url = await startServer(); }
  catch (e) { dialog.showErrorBox("时迹启动失败", String(e.message)); app.quit(); return; }
  const win = new BrowserWindow({
    width: 1200, height: 860, title: "时迹 Timetrace",
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  const origin = new URL(url).origin;
  win.webContents.setWindowOpenHandler(({ url: u }) => { shell.openExternal(u); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, u) => { if (new URL(u).origin !== origin) { e.preventDefault(); shell.openExternal(u); } });
  win.loadURL(url);
}

app.whenReady().then(createWindow);
app.on("before-quit", () => { app.isQuitting = true; if (server) server.kill(); });
app.on("window-all-closed", () => app.quit());
