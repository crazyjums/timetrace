<h1 align="center">时迹 Timetrace</h1>

<p align="center">
  纯本地的桌面客户端:读取 LLM 编码工具的会话日志,告诉你一个需求的时间花在了哪。
</p>

<p align="center">
  <a href="https://github.com/crazyjums/timetrace/actions/workflows/ci-release.yml"><img alt="CI" src="https://github.com/crazyjums/timetrace/actions/workflows/ci-release.yml/badge.svg?branch=master"></a>
  <a href="https://github.com/crazyjums/timetrace/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/crazyjums/timetrace?display_name=tag"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <img alt="Go" src="https://img.shields.io/github/go-mod/go-version/crazyjums/timetrace">
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey">
  <img alt="Local first" src="https://img.shields.io/badge/data-100%25%20local-2ea44f">
</p>

<p align="center">
  <img src="docs/screenshots/detail.png" alt="需求明细:阶段分布、时间轴与过程面板" width="920">
</p>

> **项目状态:早期,自用阶段。** 目前只支持 Claude Code 的日志;其他工具的适配器还在等真实日志样例。计时与阶段规则是按产品简报推断的,尚未对照完整 PRD 校验,见[已知限制](#已知限制)。

## 目录

- [特性](#特性)
- [截图](#截图)
- [下载与安装](#下载与安装)
- [快速开始](#快速开始)
- [计时与阶段规则](#计时与阶段规则)
- [支持的工具](#支持的工具)
- [隐私与安全](#隐私与安全)
- [命令行](#命令行)
- [架构](#架构)
- [开发](#开发)
- [新增一个适配器](#新增一个适配器)
- [已知限制](#已知限制)
- [贡献](#贡献)
- [许可证](#许可证)

## 特性

- **按需求聚合**:同一目录下相邻会话(默认间隔 ≤ 4 小时)自动归为一个需求,可手动合并、拆分、改名,人工修正会保留。
- **阶段拆分**:每一轮自动判定为聊方案 P、调研 R、写代码 C、改代码 F、测试 T、其他 O,另有「等我」W;空闲不计入。阶段由规则判定,可在界面里改单轮。
- **四重编码**:阶段用颜色 + 纹理 + 字母 + 图标同时表达,不依赖颜色单独传达;亮 / 暗两套主题。
- **时间轴与过程**:按会话展示每一轮,点开看这一轮的消息,以及每段 LLM、工具、子 agent 的耗时。
- **会话还原成聊天记录**:每个会话都能打开详情,按轮还原完整对话——用户与 AI 的消息、可展开的工具调用(参数与输出)、子 agent 消息;每轮标注阶段与耗时,点时间轴直接跳转。
- **新版本提示**:GitHub 上发布新版本后,左侧栏会提示并给出下载链接;只请求版本号、不发送本地数据,可在设置里关闭。
- **首次建立索引,之后秒开**:第一次使用时把日志全部扫描一遍建立索引并保存在本机;之后各页面直接读内存中的索引,后台每 10 秒只增量处理新增或改动的文件。
- **今日面板**:按真实时钟看今天各需求用了多久,进行中的轮算到「现在」,并区分运行中 / 等我中 / 已结束。
- **本地洞察**:最耗时的阶段、较上期变化(上期有数据才显示)、Top 需求,以及最多 4 条带「依据」的建议。
- **诚实的数据**:日志里没有的字段显示「–」,不估算;没有逐事件时间戳的工具归为「粗略档」,不显示耗时、不计入汇总。
- **可选的大模型解读**:默认关闭,只能手动触发,发送前先预览内容,支持本机 Ollama。所有数字都由本地算出。
- **纯本地**:没有账号、云同步和遥测;只读打开原始日志,不修改、不删除;解析失败的文件会说明原因,且不影响其他文件。

## 截图

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/list.png" alt="需求列表"><br><sub><b>需求列表</b> · 时间范围切换、阶段构成条、运行中与解析失败提示</sub></td>
    <td width="50%"><img src="docs/screenshots/today.png" alt="今日"><br><sub><b>今日</b> · 真实时钟时间线,运行中 / 等我中 / 已结束</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/insights.png" alt="洞察"><br><sub><b>洞察</b> · 阶段排名、Top 需求、带依据的建议</sub></td>
    <td width="50%"><img src="docs/screenshots/settings.png" alt="数据源与设置"><br><sub><b>数据源与设置</b> · 数据源、能力矩阵、计时、大模型开关</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/session.png" alt="会话详情"><br><sub><b>会话详情</b> · 还原成聊天记录,每轮标注阶段与耗时,工具调用可展开</sub></td>
    <td width="50%"><img src="docs/screenshots/session-dark.png" alt="暗色主题"><br><sub><b>暗色主题</b> · 跟随系统,也可在侧栏手动切换</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/indexing.png" alt="首次建立索引"><br><sub><b>首次建立索引</b> · 列出将读取的目录,只读、不上传</sub></td>
    <td width="50%"><img src="docs/screenshots/update.png" alt="新版本提示"><br><sub><b>新版本提示</b> · 侧栏提示新版本,设置里可关闭自动检查</sub></td>
  </tr>
</table>

> 截图使用的是演示数据,不是真实的工作记录。

## 下载与安装

到 [Releases](https://github.com/crazyjums/timetrace/releases) 下载对应平台的桌面客户端(每次合并到 `master` 会自动发布一个版本):

| 平台 | 文件(以 Release 页面为准) | 说明 |
| --- | --- | --- |
| Windows x64 | `Timetrace-Portable-*.exe` | 单文件便携版,双击运行,无需安装 |
| Windows x64 | `Timetrace-Setup-*.exe` | 安装版,可选择安装目录 |
| macOS Apple 芯片 | `Timetrace-*-mac-arm64.dmg` | 拖进「应用程序」 |
| macOS Intel | `Timetrace-*-mac-x64.dmg` | 同上 |
| Linux x64 | `Timetrace-*-linux-x86_64.AppImage` | `chmod +x` 后运行 |

**注意:**

- 目前没有代码签名。Windows 首次运行会出现 SmartScreen 提示(「更多信息 → 仍要运行」);macOS 首次打开需要到「系统设置 → 隐私与安全性」里放行。
- 有新版本时左侧栏会提示(每 6 小时检查一次,可在「数据源与设置 → 检查更新」里关闭);下载和替换需要你自己完成,不会自动安装。
- 我只在 Linux 上实际启动过打包后的应用;Windows 和 macOS 的安装包由 GitHub Actions 构建成功,但还没有经过实机验证。遇到问题请[提 issue](https://github.com/crazyjums/timetrace/issues)。

## 快速开始

1. 打开应用。它会自动读取 Claude Code 的默认日志目录:
   - macOS / Linux:`~/.claude/projects`
   - Windows:`%USERPROFILE%\.claude\projects`(路径格式未在 Windows 上核对,不对的话到设置页修改)
2. 第一次打开会先建立索引,界面显示进度(参考:600 个会话、约 190 MB 日志,在 4 核机器上约 2 秒)。之后再打开会直接读取保存的索引。
3. 「需求」页列出聚合后的需求,点一行进入明细,点时间轴上的一格查看这一轮的过程;点会话名或「查看完整对话」打开会话详情。
4. 日志不在默认位置?到「数据源与设置」页点「修改」,或「添加另一个日志目录…」,先点「测试扫描」确认能识别再添加。

你的人工修正(改名、合并、拆分、改阶段)和设置保存在本机一个 JSON 文件里,位置由系统的用户配置目录决定:

| 系统 | 路径 |
| --- | --- |
| Linux | `~/.config/timetrace/state.json` |
| macOS | `~/Library/Application Support/timetrace/state.json` |
| Windows | `%AppData%\timetrace\state.json` |

索引缓存保存在系统的用户缓存目录,只是原始日志的解析结果,可以随时删除,删除后下次启动会重新扫描:

| 系统 | 路径 |
| --- | --- |
| Linux | `~/.cache/timetrace/index.gob` |
| macOS | `~/Library/Caches/timetrace/index.gob` |
| Windows | `%LocalAppData%\timetrace\index.gob` |

## 计时与阶段规则

> 下列规则来自产品简报的推断,PRD 尚未纳入仓库,存在与最终规则不一致的可能。

**概念**

| 概念 | 含义 |
| --- | --- |
| 会话 | 某个工具的一份日志文件 |
| 轮 | 从用户一条消息,到下一条用户消息之前的最后一个事件;子 agent 和工具回传不会另开一轮 |
| AI 时间 | 一轮内第一个到最后一个事件的间隔 |
| 等我 | 一轮结束后、到下一条用户消息之前,间隔小于空闲阈值的部分(默认阈值 10 分钟) |
| 空闲 | 间隔不小于阈值的部分,视为你不在,**不计入** |
| 活跃时间 | AI 时间 + 等我 |
| 需求 | 同一目录下相邻会话间隔 ≤ 聚合窗口(默认 4 小时)自动聚合;人工合并(可跨目录)与拆分优先于窗口规则 |
| 并发 | 同一需求下的多个会话允许时间重叠,各算各的 |

**进行中的一轮**:最后事件距现在小于空闲阈值时,若 AI 还在干活(最后是工具调用或工具回传),算「运行中」,AI 时间计到现在;若最后是 AI 的最终回复,算「等我中」,等我时间计到现在;否则算「已结束」。

**阶段判定**(纯规则,按优先级,可手动覆盖单轮):

| 优先级 | 阶段 | 条件 |
| --- | --- | --- |
| 1 | T 测试 | Bash 命令匹配 `go test`、`pytest`、`npm test`、`jest`、`cargo test` 等 |
| 2 | F 改代码 | 有 Edit 类工具;或有 Write 且 prompt 含「修复 / 重构」等词 |
| 3 | C 写代码 | 仅有 Write |
| 4 | P 聊方案 | 没有任何工具调用 |
| 5 | R 调研 | 只用 Read / Grep / Glob / WebFetch / WebSearch |
| 6 | O 其他 | 其余 |

**精度分档**:每个事件都有时间戳的是「精确档」,显示轮级和阶段级耗时;只有会话起止时间的是「粗略档」,耗时显示「–」,只显示次数和跨度,不计入任何汇总数字。

## 支持的工具

| 工具 | 状态 | 精度 |
| --- | --- | --- |
| Claude Code | ✅ 已支持 | 精确 |
| Codex CLI | ⏳ 计划中(缺真实日志样例) | 精确 |
| pi / omp | ⏳ 计划中(缺真实日志样例) | 精确 |
| Cursor 转录 | ⏳ 计划中(缺真实日志样例) | 粗略 |

Claude Code 适配器的字段能力:逐事件时间戳、token、模型、子 agent、分支为「有」;费用、权限等待日志里分不出来,显示「–」,权限等待的时间计入 AI 时间。同一条 AI 消息在日志里会拆成多行且重复记录 usage,token 按消息 ID 去重;`input_tokens` 不含缓存命中。

想让某个工具尽快支持?把一份**脱敏后的真实日志样例**发到 issue 里,比任何描述都有用。

## 隐私与安全

- **数据不出本机**:没有账号、云同步、遥测。界面只访问 `127.0.0.1` 上的本机服务,外链交给系统浏览器打开。
- **唯一的对外请求是检查更新**:每 6 小时向 GitHub 请求一次最新 Release 的版本号(`GET api.github.com/repos/crazyjums/timetrace/releases/latest`),不携带任何本地数据,请求头只有通用的客户端名;可在设置里关闭。提示里的下载链接只会指向本仓库的 Release 页面。
- **只读日志**:不修改、不删除原始日志文件。
- **大模型默认关闭**:打开后也只能手动触发;发送范围分三档(仅聚合数 [默认] / 加需求名 / 加分段摘要),发送前先预览将要发送的 JSON,并且发送内容必须与预览一致;支持本机 Ollama。
- **本机服务加固**:只监听 `127.0.0.1`;修改类请求必须带自定义请求头(防 CSRF)并校验 Host(防 DNS rebinding);来自日志的文本一律转义后再渲染;Electron 关闭 `nodeIntegration`,开启 `contextIsolation` 与沙箱。
- 不会写「高于正常水平」这类断言(没有可信基线);相关性建议会标明「相关,不等于因果」。

## 命令行

核心层可以脱离界面使用:

```bash
go run ./cmd/timetrace list                      # 需求列表与阶段分布(默认命令)
go run ./cmd/timetrace today                     # 今日各需求用时
go run ./cmd/timetrace insights --days 7         # 洞察;7 为自然周,其他值为最近 N 天
go run ./cmd/timetrace llm-preview               # 仅预览将发送给大模型的 JSON
go run ./cmd/timetrace llm-send                  # 预览后发送,需先在设置里启用

# 人工修正(需求键见 list 输出的「键=」)
go run ./cmd/timetrace rename <需求键> <名称>
go run ./cmd/timetrace phase <会话ID> <轮序号> <P|R|C|F|T|O>
go run ./cmd/timetrace merge <会话ID> <会话ID>...   # 强制归为同一需求(可跨目录)
go run ./cmd/timetrace split <会话ID>               # 从该会话起另起需求
```

通用参数:`--claude-dir`(默认 `~/.claude/projects`)、`--state`(状态文件路径)。

## 架构

```mermaid
flowchart LR
    L["原始日志<br/>(只读)"] --> A["适配器<br/>internal/adapter"]
    A -->|"统一模型<br/>Session / Event"| X["索引<br/>增量 · 持久化<br/>internal/index"]
    X --> C["核心层<br/>计时 · 阶段 · 聚合<br/>internal/core"]
    A -.->|"按需还原对话"| S
    C --> I["洞察<br/>internal/insights"]
    C --> S["本机服务<br/>internal/server<br/>127.0.0.1 JSON API"]
    I --> S
    ST[("状态文件<br/>internal/store")] <--> S
    S --> W["界面<br/>HTML / CSS / JS<br/>内嵌在二进制里"]
    E["Electron 外壳"] -.->|"启动服务并加载界面"| S
```

两条原则:**计时规则只在核心层实现一次**,适配器只提供原始事件和字段;**新增工具只加适配器,不改核心和界面**。

| 路径 | 内容 |
| --- | --- |
| `cmd/timetrace` | 命令行入口 |
| `cmd/timetrace-server` | 本机服务入口(监听 `127.0.0.1`,启动后输出 `LISTENING <地址>`) |
| `internal/model` | 适配器输出的统一模型 |
| `internal/adapter` | 适配器接口与 `claudecode` 实现 |
| `internal/core` | 计时、阶段、需求聚合、区间统计、今日 |
| `internal/index` | 解析索引:首次全量、之后按文件修改时间与大小增量更新,持久化到本机缓存 |
| `internal/insights` | 本地规则洞察 |
| `internal/llm` | 可选的大模型解读(默认关闭) |
| `internal/update` | 检查 GitHub 上的新版本(只请求版本号,可关闭) |
| `internal/store` | 人工修正与设置的本机存储 |
| `internal/server` | JSON API 与内嵌界面(`web/`,无构建步骤) |
| `electron/` | Electron 外壳:只启动本机服务并加载界面,不含业务逻辑 |
| `docs/` | 产品简报、界面原型与 README 截图 |
| `scripts/screenshots/` | 重新生成 README 截图的脚本(演示数据 + 截图) |

## 开发

需要 Go 1.24+;跑桌面窗口或打安装包还需要 Node.js 20+。

```bash
# 仅浏览器:启动本机服务,按输出的地址访问
go run ./cmd/timetrace-server --port 8765

# Electron 桌面窗口
cd electron && npm install && npm start

# 为当前系统打安装包(产物在 electron/dist/)
cd electron && npm run dist

# 测试与检查(CI 同款)
gofmt -l .
go vet ./...
go test -race ./...
```

**CI 与发布**:`.github/workflows/ci-release.yml`。提交 PR 时跑 `gofmt`、`go vet`、`go test -race` 与前端脚本语法检查;合并到 `master` 后,检查通过则在 Windows / macOS / Linux 的原生 runner 上打包,并自动发布 Release。版本号取已发布的最新 `v0.1.x` 标签再加 1,每次合并递增 1。

**更新截图**:README 里的截图都用演示数据生成。改了页面后运行下面的命令重新截图(需要 Python 3 与 Playwright):

```bash
scripts/screenshots/run.sh            # 造演示数据 → 启动本机服务 → 截图到 docs/screenshots/
```

演示数据由 `scripts/screenshots/gen-demo.py` 生成(虚构的项目与对话),截图步骤在 `scripts/screenshots/shoot.js`;新增页面时在 `shoot.js` 里补一张,并在 README 的[截图](#截图)里引用。

## 新增一个适配器

适配器只做一件事:把某个工具的原始日志翻译成统一模型。

1. 在 `internal/adapter/<tool>/` 实现 `adapter.Adapter` 接口(`ID` / `Discover` / `Parse`):
   - `Discover` 只读扫描目录,返回候选日志文件;
   - `Parse` 只读解析单个文件,输出 `model.Session`(含逐事件的 `model.Event`);解析失败要返回带原因的 error,**不要影响其他文件**;
   - 日志里没有的字段保持零值,界面会显示「–」,**不要估算**;
   - 想支持会话详情页,再实现可选的 `adapter.Transcriber` 接口(`Transcript`),返回完整消息;分轮规则在核心层,适配器只需把用户发言标成 `user`、工具回传标成 `tool_result`。
2. 没有逐事件时间戳的工具,把 `Session.Precision` 设为 `model.Coarse`。
3. 在 `internal/server/server.go` 的 `adapterFor`、`toolCatalog`、`capHas` 里各注册一行。
4. 补测试:输入一份**脱敏的真实日志样例**,断言输出的统一模型(解析层必须能脱离界面单独测试)。

> 不确定的日志格式、API、版本,请先去核对真实样例,不要凭记忆写。

## 已知限制

- 只支持 Claude Code;Codex CLI、pi、omp、Cursor 的适配器缺真实日志样例。
- 计时与阶段规则按产品简报推断,`docs/PRD.md` 不在仓库中,待导出后对照校验。
- 「等我」超过 15% 才给建议、「长轮」按 10 分钟算,是固定的提示线,不是「正常水平」。
- 阶段规则文件暂不支持自定义(界面里是只读的「查看规则」)。
- 大模型解读的 Ollama 调用格式(`/api/chat`)凭记忆编写,**不确定**,首次使用请对照官方文档核对。
- 没有代码签名、没有自定义应用图标(目前是 Electron 默认图标);有新版本只提示,不会自动下载安装。
- 阶段规则偏粗:只要一轮里跑过测试命令就判为「测试」。用真实日志验证时,大部分轮都被判成了测试,规则需要结合 PRD 调整。
- 会话详情里单个工具输出超过 2 万字符会截断显示(原始日志不受影响);暂不支持在会话内搜索。
- 声明式(YAML)适配器尚未实现。

## 贡献

欢迎 issue 和 PR,尤其是**脱敏的真实日志样例**(Codex CLI、pi、omp、Cursor)。

- 提 PR 前先跑一遍 `gofmt -l .`、`go vet ./...`、`go test -race ./...`。
- 改了页面(布局、文案、交互、新增页面),在同一个 PR 里同步更新 README 的相关描述,并用 `scripts/screenshots/run.sh` 重新生成截图。
- 改动请遵守[不能破的规则](CLAUDE.md#不能破的规则):数据全程本机、计时只在核心层实现、缺失字段显示「–」、阶段四重编码、只读日志。
- 产品背景与页面清单见 [`docs/BRIEF.md`](docs/BRIEF.md),界面原型见 [`docs/prototype-canvas/`](docs/prototype-canvas/) 与 [`docs/prototype-v0/`](docs/prototype-v0/)(阶段色板与图标以 `prototype-v0` 为准)。

## 许可证

[MIT](LICENSE) © 2026 crazyjums
