#!/usr/bin/env bash
# 一键重新生成 README 截图：造演示数据 → 启动本机服务 → 截图 → 关闭服务。
# 用法：scripts/screenshots/run.sh [输出目录，默认 docs/screenshots]
# 依赖：Go、Python 3、Node.js 与 Playwright。
# 演示日志默认写到 /home/u/.claude/projects（与截图里显示的路径一致），可用 DEMO_DIR 覆盖。
# 截图时不联网：服务关闭自动检查更新，「检查更新」的结果由 shoot.js 固定返回。
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-docs/screenshots}"
DEMO_DIR="${DEMO_DIR:-/home/u/.claude/projects}"
PORT="${PORT:-8799}"
WORK="$(mktemp -d)"
trap 'kill "${PID:-}" 2>/dev/null || true; rm -rf "$WORK"' EXIT

rm -rf "$DEMO_DIR" && mkdir -p "$DEMO_DIR" "$OUT"
python3 -I scripts/screenshots/gen-demo.py "$DEMO_DIR"
cat > "$WORK/state.json" <<JSON
{"settings":{"idle_minutes":10,"window_hours":4,"no_update_check":true,"llm":{"enabled":false,"endpoint":"","model":"","level":"counts"},
 "sources":[{"adapter":"claude-code","dir":"$DEMO_DIR","enabled":true}]},"overrides":{}}
JSON
go build -o "$WORK/server" ./cmd/timetrace-server
"$WORK/server" --port "$PORT" --state "$WORK/state.json" --cache "$WORK/index.gob" > "$WORK/server.log" 2>&1 &
PID=$!
for _ in $(seq 50); do curl -s "http://127.0.0.1:$PORT/api/status" | grep -q '"ready":true' && break; sleep 0.2; done
node scripts/screenshots/shoot.js "http://127.0.0.1:$PORT/" "$OUT"
