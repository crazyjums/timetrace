/* Mock 数据。覆盖：正常、很长(320 轮)、很短(3 轮)、进行中、空数据(0 轮)。
 * 所有时间为毫秒时间戳；dur / gap 为秒。
 * turn 字段: t(开始) dur(AI 工作秒) phase gap(AI 结束后到我下一条 prompt 的秒数；最后一轮为 null) sid summary prompt reply tools running manual
 * 等我 / 空闲 不存储，由 gap 与「空闲阈值」在前端推导：gap >= 阈值 → 空闲，否则 → 等我。
 */
(function () {
  const NOW = new Date(2026, 10, 6, 14, 20, 0).getTime();

  const PHASES = [
    { id: 'plan', name: '聊方案', key: 'P' },
    { id: 'research', name: '调研', key: 'R' },
    { id: 'code', name: '写代码', key: 'C' },
    { id: 'fix', name: '改代码', key: 'F' },
    { id: 'test', name: '测试', key: 'T' },
    { id: 'other', name: '其他', key: 'O' },
  ];

  const rnd = (seed) => { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); };
  const pick = (r, a) => a[Math.floor(r() * a.length)];

  const POOL = {
    plan: {
      sum: ['确认触发条件与补偿策略', '梳理现有状态机与回调时序', '对比延迟队列与定时扫表', '确定灰度与回滚步骤', '评审表结构变更与兼容', '拆分任务并排期'],
      prompt: ['先别写代码，把边界条件过一遍', '现在是怎么处理回调乱序的？', '两种方案各自的风险是什么', '方案 B 的回滚怎么做', '按这个思路拆成几个小步骤'],
      reply: ['列出 4 类边界条件，建议先统一状态机再改回调', '对比了两种方案：扫表简单但有延迟，队列需要额外组件', '给出三步灰度：开关 → 5% → 全量，回滚只需关开关'],
      tools: [],
    },
    research: {
      sum: ['阅读 order 包状态流转代码', '查所有 CloseOrder 上游调用', '查看压测报告与慢查询日志', '检索延迟队列用法', '确认三方回调重试策略'],
      prompt: ['看一下现在谁在调 CloseOrder', '这个表有哪些慢查询', '三方回调会重试几次？间隔多久', '搜下 redis zset 做延迟队列的坑'],
      reply: ['共 7 处调用，其中 2 处在定时任务里没有幂等保护', '慢查询集中在 status+created_at 缺联合索引', '三方最多重试 5 次，间隔 1/5/15/30/60 分钟'],
      tools: [['Grep', 'CloseOrder'], ['Read', 'order/state.go'], ['Glob', '**/*_test.go'], ['WebSearch', 'redis delay queue'], ['Read', 'repo/order_repo.go']],
    },
    code: {
      sum: ['实现延迟队列消费者', '新增 order_timeout 表迁移', '接入幂等 key 校验', '补充 repo 层方法', '实现补偿任务'],
      prompt: ['按方案 B 实现消费者', '加一个迁移，带回滚', '幂等 key 用订单号 + 事件类型', '把 repo 层补上', '写补偿任务，每分钟扫一次'],
      reply: ['已新增 job/timeout.go，含重试与死信处理', '迁移 012 已添加，down 脚本可回滚', '幂等校验接入 CloseOrder，冲突时返回已处理'],
      tools: [['Write', 'job/timeout.go'], ['Edit', 'order/close.go'], ['Edit', 'repo/order_repo.go'], ['Write', 'migrations/012_timeout.sql'], ['Bash', 'go build ./...']],
    },
    fix: {
      sum: ['修复竞态导致重复关单', '修正测试中的时间依赖', '处理 nil 指针', '修复迁移回滚失败', '调整重试次数边界'],
      prompt: ['这个测试偶尔挂，查下原因', '这里会 nil panic，改掉', '回滚脚本报错了', '重试次数不对，应该是 5 次'],
      reply: ['原因是两个 goroutine 同时更新状态，加了行锁', '测试依赖 time.Now，已改为注入 clock', '补了 nil 判断并加用例'],
      tools: [['Edit', 'order/close.go'], ['Edit', 'order/close_test.go'], ['Bash', 'go test ./order/...'], ['Edit', 'job/timeout.go']],
    },
    test: {
      sum: ['运行单测并查看失败', '补充集成测试', '本地压测回调接口', '检查覆盖率', '验证灰度开关'],
      prompt: ['跑一下全部测试', '补一个集成测试覆盖超时关单', '压一下回调接口 1000 qps', '看下覆盖率'],
      reply: ['全部通过，覆盖率 71%，close.go 分支覆盖不足', '压测 p99 38ms，无错误', '2 个用例失败，集中在时间边界'],
      tools: [['Bash', 'go test ./...'], ['Bash', 'go vet ./...'], ['Bash', 'go test -race ./order/...'], ['Bash', 'hey -n 1000 localhost:8080/cb']],
    },
    other: {
      sum: ['整理 commit 并推送', '更新 README 与变更说明', '清理临时文件', '查看 CI 状态', '回答与需求无关的 shell 问题'],
      prompt: ['帮我整理成两个 commit', '更新一下变更说明', '顺便问下 awk 怎么按列求和', '看下 CI 为啥红了'],
      reply: ['已拆成 feat 与 test 两个 commit', 'CI 红在 lint，已定位到未使用的 import'],
      tools: [['Bash', 'git status'], ['Bash', 'git commit'], ['Edit', 'README.md']],
    },
  };

  const NEXT = {
    plan: [['research', .5], ['code', .4], ['plan', .1]],
    research: [['plan', .2], ['code', .6], ['research', .2]],
    code: [['test', .45], ['fix', .25], ['code', .2], ['other', .1]],
    fix: [['test', .5], ['fix', .35], ['code', .1], ['other', .05]],
    test: [['fix', .45], ['code', .15], ['other', .1], ['plan', .05], ['test', .25]],
    other: [['code', .4], ['plan', .2], ['test', .2], ['other', .2]],
  };
  const BASE = { plan: [60, 240], research: [90, 400], code: [120, 600], fix: [60, 420], test: [30, 300], other: [20, 150] };


  const OUT = { Read: '读取 218 行', Edit: '已应用 2 处修改', Write: '已写入 64 行', Bash: 'exit 0 · 14 行输出', Grep: '7 处匹配', Glob: '12 个文件', WebSearch: '返回 8 条结果' };
  const ERRS = ['exit 1 · FAIL order/close_test.go:88 expected 2, got 1', 'old_string 未找到唯一匹配，未修改', '权限被拒绝：路径超出工作目录'];
  const KID = [['Grep', 'CloseOrder'], ['Read', 'order/state.go'], ['Glob', '**/*.go']];
  // 每轮的 span：相对该轮开始的偏移（秒）。k: llm | tool | perm | agent；depth 1 为子代理内部
  function mkSpans(seed, dur, tools, phase, reply) {
    const r = rnd(seed), spans = [], parts = [];
    for (let i = 0; i <= tools.length; i++) {
      parts.push({ k: 'llm', w: .8 + r() * 2.6 });
      if (i < tools.length) {
        const t = tools[i];
        if (/^(Edit|Write|Bash)$/.test(t.n) && r() < .22) parts.push({ k: 'perm', w: .5 + r() * 2.2, f: t.n });
        parts.push({ k: 'tool', t, w: .3 + r() * 2.2 });
      }
    }
    if ((phase === 'research' || phase === 'code') && r() < .2) parts.splice(1 + Math.floor(r() * 2), 0, { k: 'agent', w: 3 + r() * 4 });
    const W = parts.reduce((a, p) => a + p.w, 0);
    const llm = (off, d, depth) => {
      const tin = Math.round(3000 + r() * 60000), tout = Math.round(80 + r() * 1400), cache = Math.round(r() * Math.min(tin, 50000));
      return { k: 'llm', name: 'LLM 请求', arg: '', off, dur: d, ok: true, depth, model: 'sonnet-5.5', tin, tout, cache, ttft: +(.4 + r() * 1.8).toFixed(1), stop: 'tool_use', cost: +(((tin - cache) * 3 + cache * .3 + tout * 15) / 1e6).toFixed(3), out: '' };
    };
    let off = 0;
    parts.forEach((p) => {
      const d = Math.max(.4, +(p.w / W * dur).toFixed(1));
      if (p.k === 'llm') spans.push(llm(off, d, 0));
      else if (p.k === 'perm') spans.push({ k: 'perm', name: '等待权限确认', arg: p.f, off, dur: d, ok: true, depth: 0, out: '已允许（手动确认）' });
      else if (p.k === 'tool') spans.push({ k: 'tool', name: p.t.n, arg: p.t.a, off, dur: d, ok: p.t.ok, depth: 0, out: p.t.ok ? (OUT[p.t.n] || 'ok') : ERRS[Math.floor(r() * ERRS.length)] });
      else {
        spans.push({ k: 'agent', name: 'Task（子代理）', arg: 'explore：查 CloseOrder 的调用方', off, dur: d, ok: true, depth: 0, out: '返回 7 处调用，其中 2 处缺幂等保护' });
        const seq = [llm(0, 0, 1), { k: 'tool', t: KID[0] }, { k: 'tool', t: KID[1] }, llm(0, 0, 1)]; let o2 = off; const share = d / seq.length;
        seq.forEach((c) => {
          if (c.k === 'llm') { c.off = +o2.toFixed(1); c.dur = +share.toFixed(1); spans.push(c); }
          else spans.push({ k: 'tool', name: c.t[0], arg: c.t[1], off: +o2.toFixed(1), dur: +share.toFixed(1), ok: true, depth: 1, out: OUT[c.t[0]] });
          o2 += share;
        });
      }
      off = +(off + d).toFixed(1);
    });
    const ls = spans.filter((s) => s.k === 'llm' && s.depth === 0), last = ls[ls.length - 1];
    if (last) { last.stop = 'end_turn'; last.out = reply; }
    return spans;
  }

  function nextPhase(r, cur, fixHeavy) {
    let tbl = NEXT[cur];
    if (fixHeavy && (cur === 'test' || cur === 'fix')) tbl = [['fix', .6], ['test', .25], ['code', .1], ['other', .05]];
    let x = r(), acc = 0;
    for (const [p, w] of tbl) { acc += w; if (x <= acc) return p; }
    return tbl[0][0];
  }

  function gen(o) {
    const r = rnd(o.seed);
    const turns = [];
    let cur = 'plan', cursor = 0;
    const sidCount = o.sessions || 1;
    for (let i = 0; i < o.n; i++) {
      cur = i === 0 ? (o.first || 'plan') : nextPhase(r, cur, o.fixHeavy);
      const [lo, hi] = BASE[cur];
      const dur = Math.round(lo + r() * (hi - lo) * (r() < .08 ? 2.2 : 1));
      const P = POOL[cur];
      const nt = P.tools.length ? Math.floor(r() * 4) : 0;
      const tools = [];
      for (let k = 0; k < nt; k++) { const [n, a] = pick(r, P.tools); tools.push({ n, a, ok: r() > .08 }); }
      let gap;
      if (i === o.n - 1) gap = null;
      else if (o.idleEvery && r() < 1 / o.idleEvery) gap = Math.round(1500 + r() * 24000);
      else gap = Math.round(o.waitHeavy ? 40 + r() * 520 : 5 + r() * 130);
      const turn = {
        t: cursor, dur, phase: cur, gap,
        sid: o.id + '-s' + (Math.floor(i * sidCount / o.n) + 1),
        summary: pick(r, P.sum), prompt: pick(r, P.prompt), reply: pick(r, P.reply), tools,
      };
      turn.spans = mkSpans(o.seed * 1009 + i, dur, tools, cur, turn.reply);
      turns.push(turn);
      cursor += dur + (gap || 0);
    }
    if (turns.length) {
      const last = turns[turns.length - 1];
      const endSec = last.t + last.dur;
      const off = o.endAt - endSec * 1000;
      turns.forEach((t) => { t.t = off + t.t * 1000; });
      if (o.running) last.running = true;
    }
    const sessions = [];
    for (let k = 1; k <= sidCount; k++) sessions.push({ id: o.id + '-s' + k, title: o.stitles ? o.stitles[k - 1] : '会话 ' + k, file: '~/.claude/projects/' + o.dir + '/' + o.id + '-' + k + '.jsonl' });
    return { id: o.id, name: o.name, status: o.running ? 'active' : 'done', source: o.source || 'jsonl', sessions, turns, warn: o.warn || null, v: 0 };
  }

  const H = 3600e3, D = 24 * H;
  const reqs = [
    gen({ id: 'r1', name: '订单超时关单重构', source: 'langfuse', seed: 11, n: 46, sessions: 2, endAt: NOW - 1 * D - 2 * H, idleEvery: 14, dir: 'order-svc', stitles: ['梳理状态机', '实现延迟队列'] }),
    gen({ id: 'r2', name: '支付回调幂等改造', seed: 23, n: 320, sessions: 5, endAt: NOW - 3 * D, idleEvery: 11, fixHeavy: true, dir: 'pay-gateway', stitles: ['摸底', '方案评审', '核心实现', '联调返工', '压测与灰度'] }),
    gen({ id: 'r3', name: '修复 cache nil pointer', seed: 5, n: 3, first: 'fix', endAt: NOW - 5 * H, dir: 'cache-lib' }),
    gen({ id: 'r4', name: '热线自动值班 skill', source: 'langfuse', seed: 31, n: 28, sessions: 2, endAt: NOW - 20e3, running: true, idleEvery: 16, dir: 'hotline', stitles: ['接入飞书', '排查 skill'] }),
    gen({ id: 'r5', name: 'Grafana 指标血缘分析', seed: 47, n: 61, sessions: 3, endAt: NOW - 2 * D, idleEvery: 12, dir: 'metrics', warn: '2 行 jsonl 无法解析，已跳过（会话 2，第 482、483 行）' }),
    gen({ id: 'r6', name: 'feat: 用户导出 CSV', seed: 59, n: 18, endAt: NOW - 3.5 * H, dir: 'user-svc' }),
    { id: 'r7', name: '（空需求）临时探索', source: 'jsonl', status: 'done', sessions: [{ id: 'r7-s1', title: '会话 1', file: '~/.claude/projects/scratch/r7-1.jsonl' }], turns: [], warn: null, v: 0 },
    gen({ id: 'r8', name: 'gRPC 网关超时排查', seed: 71, n: 35, sessions: 2, endAt: NOW - 6 * D, waitHeavy: true, idleEvery: 18, dir: 'gateway' }),
    gen({ id: 'r9', name: '升级 Go 1.23', seed: 83, n: 12, endAt: NOW - 12 * D, dir: 'infra' }),
  ];
  // 让 r6 与 r1 的部分轮次落在「今天」内，便于今日概览
  const day0 = new Date(NOW); day0.setHours(0, 0, 0, 0);

  // ---- 多工具：适配器注册表（路径与能力为示例，未逐一核实各工具真实日志格式） ----
  const TOOLS = [
    { id: 'cc', name: 'Claude Code', short: 'CC', path: '~/.claude/projects', cap: { ts: 1, tools: 1, tokens: 1, sub: 1 } },
    { id: 'cx', name: 'Codex CLI', short: 'CX', path: '~/.codex/sessions', cap: { ts: 1, tools: 1, tokens: 1 } },
    { id: 'gm', name: 'Gemini CLI', short: 'GM', path: '~/.gemini/tmp', cap: { ts: 1, tools: 1 } },
    { id: 'my', name: '自定义 · my-agent', short: 'MY', path: '~/agents/logs', cap: { ts: 1, tools: 1 }, custom: true, yaml: '~/.config/timetrace/adapters/my-agent.yaml' },
  ];
  const ASSIGN = { r1: ['cc', 'cx'], r5: ['gm', 'gm', 'cc'], r6: ['cx'], r8: ['my', 'my'] };
  const TP = Object.fromEntries(TOOLS.map((t) => [t.id, t]));
  reqs.forEach((r) => r.sessions.forEach((s, i) => {
    s.tool = (ASSIGN[r.id] || [])[i] || 'cc';
    if (s.tool !== 'cc') s.file = s.file.replace('~/.claude/projects', TP[s.tool].path);
  }));

  window.MOCK = {
    now: NOW,
    dayStart: +day0,
    PHASES,
    TOOLS,
    reqs,
    // 已配置的数据源 = 适配器 + 目录
    sources: [
      { tool: 'cc', path: '~/.claude/projects', files: 128, ok: true, on: true },
      { tool: 'cc', path: '/Volumes/work/.claude/projects', files: 34, ok: true, on: true },
      { tool: 'cx', path: '~/.codex/sessions', files: 21, ok: true, on: true },
      { tool: 'gm', path: '~/.gemini/tmp', files: 9, ok: true, on: true },
      { tool: 'my', path: '~/agents/logs', files: 5, ok: true, on: true },
    ],
    errors: [
      { tool: 'cc', file: '~/.claude/projects/metrics/6f2a…c1.jsonl', line: 482, reason: 'JSON 不完整（文件可能仍在写入）' },
      { tool: 'gm', file: '~/.gemini/tmp/a90d…77/session.json', line: 12, reason: '未知的 message 类型 "attachment_v2"' },
      { tool: 'my', file: '~/agents/logs/03be…5e.jsonl', line: 1, reason: '适配器映射失败：找不到字段 $.ts' },
    ],
  };
})();
