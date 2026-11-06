# 生成 README 截图用的演示日志（Claude Code 格式）。用法：python3 gen-demo.py <输出目录>
# 数据是虚构的；项目路径固定为 /home/u/work/...，时间相对「现在」生成，所以今日页总有数据。
import json, datetime as dt, random, os, sys
D = sys.argv[1]; random.seed(11)
now = dt.datetime.now(dt.timezone.utc)
def ts(t): return t.strftime('%Y-%m-%dT%H:%M:%S.000Z')
REPLY = {"plan": "我建议分三步：\n\n1. 先给 `refresh` 加一把**单飞锁**，同一时刻只发一次刷新请求；\n2. 刷新失败时区分网络错误和 token 失效，只有后者才踢出登录；\n3. 补并发测试覆盖这两种情况。\n\n```go\nvar mu sync.Mutex\nfunc refresh(ctx context.Context) error {\n\tmu.Lock()\n\tdefer mu.Unlock()\n\t// ...\n}\n```",
         "end": "改好了：刷新现在走单飞锁，网络错误会重试 3 次，只有 401 才会踢出登录。`go test ./internal/auth/...` 全部通过。"}
def gen(sid, cwd, start, turns, title, final=True, branch="feat/refresh-token"):
    t = start; L = [json.dumps({"type": "ai-title", "aiTitle": title, "sessionId": sid}, ensure_ascii=False)]; n = [0]
    def ev(typ, t, content, mid=None):
        m = {"role": typ, "content": content}
        if typ == "assistant": m.update(id=mid, model="claude-sonnet-5-5", usage={"input_tokens": random.randint(800, 4000), "output_tokens": random.randint(60, 900)})
        L.append(json.dumps({"type": typ, "timestamp": ts(t), "cwd": cwd, "sessionId": sid, "gitBranch": branch, "message": m}, ensure_ascii=False))
    for i, (kind, prompt, k, gap) in enumerate(turns):
        ev("user", t, prompt); t += dt.timedelta(seconds=random.randint(6, 15))
        tools = {"plan": [], "res": ["Read", "Grep"], "code": ["Write"], "fix": ["Edit"], "test": ["Bash"]}[kind]
        for tn in tools * max(1, k):
            n[0] += 1; tid = f"tu{n[0]}"
            inp = {"command": "go test ./internal/auth/..."} if tn == "Bash" else ({"pattern": "refresh"} if tn == "Grep" else {"file_path": "internal/auth/refresh.go"})
            ev("assistant", t, [{"type": "text", "text": "先读一下现有的刷新逻辑。"}, {"type": "tool_use", "id": tid, "name": tn, "input": inp}], mid=f"m{n[0]}")
            t += dt.timedelta(seconds=random.randint(20, 150))
            out = "ok  \tgithub.com/acme/auth/internal/auth\t1.204s" if tn == "Bash" else "package auth\n\nfunc refresh(ctx context.Context) error {\n\t// ...\n}"
            ev("user", t, [{"type": "tool_result", "tool_use_id": tid, "content": out}]); t += dt.timedelta(seconds=2)
        last = i == len(turns) - 1
        if not tools or (last and final):
            n[0] += 1; ev("assistant", t, [{"type": "text", "text": REPLY["plan" if not tools else "end"]}], mid=f"m{n[0]}"); t += dt.timedelta(seconds=random.randint(25, 120))
        if not last: t += dt.timedelta(seconds=gap)
    return "\n".join(L) + "\n"
A = [("plan", "聊聊刷新 token 的方案：现在并发刷新时偶尔会把用户踢出登录", 1, 240), ("res", "看下现有的刷新逻辑", 3, 90), ("code", "按方案实现并发安全的刷新", 4, 150), ("test", "跑一下测试", 2, 500), ("fix", "把刷新失败时踢出登录的问题修掉", 6, 60), ("plan", "确认下边界：网络错误要不要重试？", 1, 1500), ("code", "补接口", 3, 110), ("test", "再跑测试", 2, 360), ("fix", "重构 refresh.go", 3, 80)]
def w(proj, n, body):
    d = os.path.join(D, proj.replace('/', '-')); os.makedirs(d, exist_ok=True); open(os.path.join(d, n + ".jsonl"), "w").write(body)
H = dt.timedelta(hours=1)
w("/home/u/work/auth-service", "a1", gen("auth-a1", "/home/u/work/auth-service", now - 6.5 * H, A, "登录接口改造"))
w("/home/u/work/auth-service", "a2", gen("auth-a2", "/home/u/work/auth-service", now - 2.8 * H, A[2:7], "登录接口改造-续"))
w("/home/u/work/order-svc", "b1", gen("ord-b1", "/home/u/work/order-svc", now - 4.5 * H, A[:5], "订单导出超时排查", branch="fix/export-timeout"))
w("/home/u/work/timetrace", "c1", gen("tt-c1", "/home/u/work/timetrace", now - 0.37 * H, A[:3], "日志解析器适配", False, "main"))
w("/home/u/work/portal-guard", "d1", gen("old-d1", "/home/u/work/portal-guard", now - 74 * H, A + A[:5], "发布巡检刹车", True, "main"))
w("/home/u/work/auth-service", "e1", gen("old-e1", "/home/u/work/auth-service", now - 216 * H, A[:6], "上周的登录改造"))
os.makedirs(os.path.join(D, "-home-u-work-order-svc"), exist_ok=True)
open(os.path.join(D, "-home-u-work-order-svc", "zz-broken.jsonl"), "w").write('{"type":"user","timestamp":"2026-11-04T10:12:00Z"\nnot valid json at line 218\n')
