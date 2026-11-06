# 时迹 Timetrace(暂定名)

纯本地工具:读取 LLM 编码工具的会话日志,按「需求」统计时间花在哪(聊方案 / 调研 / 写代码 / 改代码 / 测试 / 其他,外加等我、空闲),并给出洞察。数据全程在本机,没有账号、云同步和遥测。

当前状态:**后端核心 + CLI**。桌面界面尚未开始,技术栈待定。产品说明见 [docs/BRIEF.md](docs/BRIEF.md),原型见 `docs/prototype-v0/`、`docs/prototype-canvas/`。

## 已实现

- 统一模型与适配器接口,新增工具只需新增适配器。
- Claude Code 适配器(格式已对照真实日志核对)。只读打开日志,单个文件解析失败会给出原因,不影响其他文件。
- 计时、阶段判定、需求聚合,只在 `internal/core` 实现一次。
- 人工修正(重命名、改阶段、合并、拆分)与设置,保存在本机 JSON。
- 今日统计、本地规则洞察、可选大模型解读(默认关闭)。

## 未实现

- 桌面界面(5 个页面、阶段四重编码、亮暗主题)。
- Codex CLI、pi、omp、Cursor 适配器:缺真实日志样例,不猜格式。
- YAML 声明式适配器、过程视图。
- 跨 cwd 的手动合并。

## 使用

需要 Go 1.24+。

```bash
go run ./cmd/timetrace list                     # 需求列表与阶段分布(默认命令)
go run ./cmd/timetrace today                    # 今日各需求用时,进行中的轮算到现在
go run ./cmd/timetrace insights --days 7        # 洞察,上期为紧邻的同长度区间
go run ./cmd/timetrace llm-preview              # 仅预览将发送给大模型的 JSON
go run ./cmd/timetrace llm-send                 # 预览后发送,需先在设置里启用

# 人工修正(需求键见 list 输出的「键=」)
go run ./cmd/timetrace rename <需求键> <名称>
go run ./cmd/timetrace phase <会话ID> <轮序号> <P|R|C|F|T|O>
go run ./cmd/timetrace merge <会话ID> <会话ID>...   # 同 cwd 内强制归为一个需求
go run ./cmd/timetrace split <会话ID>               # 从该会话起另起需求
```

通用参数:`--claude-dir`(默认 `~/.claude/projects`)、`--state`(默认 `<用户配置目录>/timetrace/state.json`)。

测试:`go test ./...`

## 规则

**计时**

- 一轮:从用户一条消息,到下一条用户消息前的最后一个事件。子 agent(sidechain)和工具回传不开新轮。
- AI 时间:轮内首尾事件间隔。
- 轮后到下一轮的间隔:小于空闲阈值(默认 10 分钟)记为「等我」,否则记为空闲,不计入。
- 活跃时间 = AI 时间 + 等我。
- 最后一轮没有间隔。
- 日志里没有的字段显示「–」,不估算。只有会话起止、没有逐事件时间戳的工具归为「粗略档」,不显示耗时,不计入汇总。

**需求聚合**:同一 cwd,相邻会话间隔不超过 4 小时(默认)归为一个需求,同需求内会话允许重叠,各算各的。人工合并 / 拆分优先于窗口规则。

**阶段判定**(纯规则,可人工覆盖),按优先级:

1. Bash 命令匹配 `go test`、`pytest`、`npm test`、`jest`、`cargo test` 等:测试 T
2. 有 Edit 类工具,或有 Write 且 prompt 含修复 / 重构类词:改代码 F
3. 仅有 Write:写代码 C
4. 没有任何工具调用:聊方案 P
5. 只用 Read / Grep / Glob / WebFetch / WebSearch:调研 R
6. 其余:其他 O

> 以上规则按 BRIEF 推断。`docs/PRD.md` 不在仓库中,待导出后需要对照校验。

**大模型建议**:默认关闭,只能手动触发。发送范围三档(仅聚合数 / 加需求名 / 加分段摘要),发送前先打印 JSON 预览。所有数字由本地计算,发送内容只含聚合数字。Ollama 的调用格式(`/api/chat`)凭记忆编写,**不确定**,首次使用请对照官方文档核对。

## 目录

| 路径 | 内容 |
| --- | --- |
| `cmd/timetrace` | CLI 入口 |
| `internal/model` | 适配器输出的统一模型 |
| `internal/adapter` | 适配器接口与 `claudecode` 实现 |
| `internal/core` | 计时、阶段、聚合、今日 |
| `internal/insights` | 本地规则洞察 |
| `internal/llm` | 可选大模型解读 |
| `internal/store` | 人工修正与设置的本机存储 |
| `docs/` | 产品简报与界面原型 |

## 约束

- 只读打开原始日志,不修改、不删除。
- 数据不出本机,不加账号、云同步、遥测。
- 阶段用颜色 + 纹理 + 字母 + 图标四重编码(界面实现时遵守,见 BRIEF 第 7 节)。
