/* 两个视觉方向共用的交互与渲染。只读 mock.js，无后端。
 * 结构差异通过 <html data-dir="a|b"> 与 CSS 变量体现。 */
(() => {
  'use strict';
  const M = window.MOCK, DIR = document.documentElement.dataset.dir || 'a', NOW = M.now;
  const PH = M.PHASES, PHN = Object.fromEntries(PH.map((p) => [p.id, p]));
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const p2 = (n) => String(n).padStart(2, '0');
  const store = { get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* 隐私模式 */ } } };
  const Q = new URLSearchParams(location.search);

  /* ---------- 工具（适配器）---------- */
  const TL = Object.fromEntries(M.TOOLS.map((t) => [t.id, t]));
  const LF_CAP = { perm: 1, ttft: 1, cost: 1 };
  const CAPS = [['ts', '时间戳'], ['tools', '工具调用'], ['tokens', 'token'], ['sub', '子代理'], ['perm', '权限等待'], ['ttft', '首 token'], ['cost', '成本']];
  const toolOfSid = (sid) => { for (const r of M.reqs) for (const s of r.sessions) if (s.id === sid) return TL[s.tool] || M.TOOLS[0]; return M.TOOLS[0]; };
  const toolsOf = (r) => [...new Set(r.sessions.map((s) => s.tool))].map((id) => TL[id]).filter(Boolean);
  const tb = (t) => `<span class="tb" title="${esc(t.name)}">${t.short}</span>`;
  const hasCap = (tool, k, lf) => !!(tool.cap[k] || (lf && LF_CAP[k]));
  const capsHtml = (tool, lf) => `<span class="caps" aria-label="该数据源能提供的字段">${CAPS.map(([k, n]) => `<span class="cap ${hasCap(tool, k, lf) ? 'ok' : 'no'}">${hasCap(tool, k, lf) ? '✓' : '–'} ${n}</span>`).join('')}</span>`;

  /* ---------- 格式 ---------- */
  // 统一时长格式：≥1h → 1h05m；<1h → 12m；<1m → <1m；单轮级(opt.s)：2m05s / 45s
    const ic = (k, z = 14) => (window.ICONS && ICONS[k]) ? `<svg class="ic" width="${z}" height="${z}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k].inner}</svg>` : '';
function fmt(sec, o = {}) {
    sec = Math.round(sec);
    if (sec <= 0) return o.zero || '0m';
    const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    if (h > 0) return `${h}h${p2(m)}m`;
    if (o.s) return m > 0 ? `${m}m${p2(s)}s` : `${s}s`;
    return m > 0 ? `${m}m` : '<1m';
  }
  const hm = (ms) => { const d = new Date(ms); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; };
  const md = (ms) => { const d = new Date(ms); return `${p2(d.getMonth() + 1)}/${p2(d.getDate())}`; };
  const dt = (ms) => `${md(ms)} ${hm(ms)}`;
  const pct = (a, b) => (b > 0 ? Math.round(a * 100 / b) : 0) + '%';

  /* ---------- 状态 ---------- */
  const S = {
    sel: Q.get('r') || 'r4', seg: 0, area: 'list', q: '', range: 'all', sort: 'act',
    view: Q.get('view') || 'main', scenario: Q.get('s') || 'normal',
    theme: Q.get('theme') || store.get('theme', 'auto'),
    manage: false, picked: new Set(), renaming: false, splitMode: false, cut: null, sessPick: new Set(),
    dash: { range: Q.get('range') || '30' }, drawer: null, proc: null, src: Q.get('src') || null, todayOpen: Q.get('today') === '1',
    tl: { mode: 'auto', zoom: 1, fold: true, open: new Set(), sel: null, L: null, cs: null, W: 600 },
    set: { thr: 10, win: 4, rules: '~/.config/cc-time/phases.yaml', src: M.sources.map((d) => ({ ...d })), rulesMsg: '', adv: { mode: Q.get('adv') === 'llm' ? 'llm' : 'rules', provider: 'anthropic', base: 'https://api.anthropic.com', model: 'claude-sonnet-5-5', key: Q.get('adv') === 'llm' ? 'sk-••••••••' : '', send: Q.get('send') || 'agg', test: null } },
    advRun: { status: Q.get('advs') || 'idle', out: null, err: '' },
    toolF: Q.get('tool') || 'all', adding: null,
    undo: null,
  };

  function applyTheme() {
    const el = document.documentElement;
    if (S.theme === 'auto') delete el.dataset.theme; else el.dataset.theme = S.theme;
    store.set('theme', S.theme);
  }

  /* ---------- 派生数据（空闲阈值实时生效） ---------- */
  const cache = new Map();
  function derive(r) {
    const key = r.id + ':' + r.v + ':' + S.set.thr;
    if (cache.has(key)) return cache.get(key);
    const thr = S.set.thr * 60;
    const by = {}; PH.forEach((p) => { by[p.id] = 0; });
    let wait = 0, idle = 0, maxWait = 0, idleN = 0;
    const turns = r.turns.map((t, i) => {
      const dur = t.running ? Math.max(1, (NOW - t.t) / 1000) : t.dur;
      let kind = 'none', w = 0, id = 0;
      if (t.gap != null) { if (t.gap >= thr) { kind = 'idle'; id = t.gap; idleN++; } else { kind = 'wait'; w = t.gap; } }
      by[t.phase] += dur; wait += w; idle += id; if (w > maxWait) maxWait = w;
      return { ...t, i, dur, end: t.t + dur * 1000, kind, w, idleSec: id };
    });
    const work = PH.reduce((a, p) => a + by[p.id], 0);
    const act = work + wait;
    const segs = [];
    turns.forEach((t) => {
      const last = segs[segs.length - 1];
      if (last && last.phase === t.phase) { last.turns.push(t); last.to = t.i; last.work += t.dur; last.wait += t.w; last.t1 = t.end; }
      else segs.push({ id: 's' + segs.length, phase: t.phase, turns: [t], from: t.i, to: t.i, work: t.dur, wait: t.w, t0: t.t, t1: t.end });
    });
    segs.forEach((s, k) => { s.k = k; s.dur = s.work + s.wait; s.summary = s.turns[0].summary + (s.turns.length > 1 ? ' …' : ''); s.manual = s.turns.some((t) => t.manual); });
    const d = {
      turns, segs, by, work, wait, act, idle, idleN, maxWait, empty: !turns.length,
      start: turns.length ? turns[0].t : null, end: turns.length ? turns[turns.length - 1].end : null,
      fixPct: act ? by.fix / act : 0, live: turns.some((t) => t.running),
    };
    cache.set(key, d); return d;
  }
  const cur = () => M.reqs.find((r) => r.id === S.sel) || M.reqs[0];
  const bump = (r) => { r.v++; };

  /* ---------- 通用片段 ---------- */
  function bar(d, cls = '') {
    if (!d.act) return `<div class="bar ${cls} empty" aria-label="无数据"></div>`;
    let h = '';
    PH.forEach((p) => { const v = d.by[p.id]; if (v > 0) h += `<i class="ph-${p.id}" style="flex:${v}" title="${p.name} ${fmt(v)}"></i>`; });
    if (d.wait > 0) h += `<i class="ph-wait" style="flex:${d.wait}" title="等我 ${fmt(d.wait)}"></i>`;
    return `<div class="bar ${cls}" role="img" aria-label="阶段占比">${h}</div>`;
  }
  function legend(d, withIdle) {
    let h = '<div class="legend">';
    PH.forEach((p) => {
      h += `<div class="lg"><i class="sw ph-${p.id}"></i><span class="lg-n"><span class="k">${ic(p.id, 13)}</span>${p.name}</span><span class="num dim" style="text-align:right">${fmt(d.by[p.id], { zero: '–' })}</span><span class="num p">${pct(d.by[p.id], d.act)}</span></div>`;
    });
    h += `<div class="lg"><i class="sw ph-wait"></i><span class="lg-n"><span class="k">${ic('wait', 13)}</span>等我</span><span class="num dim" style="text-align:right">${fmt(d.wait, { zero: '–' })}</span><span class="num p">${pct(d.wait, d.act)}</span></div>`;
    if (withIdle) h += `<div class="lg lg-idle"><i class="sw"></i><span class="lg-n"><span class="k">${ic('idle', 13)}</span>空闲</span><span class="num dim" style="text-align:right">${fmt(d.idle, { zero: '–' })}</span><span class="num p dim" title="不计入活跃">不计</span></div>`;
    return h + '</div>';
  }
  const live = () => '<span class="live"><i></i>进行中</span>';

  /* ---------- 顶栏 / 状态栏 ---------- */
  const nFiles = () => S.set.src.filter((x) => x.on).reduce((a, x) => a + x.files, 0);
  function renderTop() {
    $('#top').innerHTML = `
      <span class="brand">${DIR === 'a' ? 'TIMETRACE' : '时迹'}</span>
      <label>原型状态 <select id="scn" aria-label="原型状态">
        ${[['normal', '正常'], ['partial', '部分解析失败'], ['error', '全部解析失败'], ['empty', '没找到日志']].map(([v, n]) => `<option value="${v}" ${S.scenario === v ? 'selected' : ''}>${n}</option>`).join('')}
      </select></label>
      <button id="b-dash" aria-pressed="${S.view === 'dash'}" title="洞察：最耗时的部分与建议">洞察</button>
      <button id="b-today" aria-pressed="${S.todayOpen}" title="今日概览（托盘面板）">今日</button>
      <button id="b-set" aria-pressed="${S.view === 'settings'}">设置</button>
      <select id="theme" aria-label="主题">${[['auto', '跟随系统'], ['light', '浅色'], ['dark', '深色']].map(([v, n]) => `<option value="${v}" ${S.theme === v ? 'selected' : ''}>${n}</option>`).join('')}</select>`;
    $('#status').innerHTML = `
      <span><kbd>↑</kbd><kbd>↓</kbd>切换需求</span><span><kbd>Enter</kbd>展开明细</span><span><kbd>←</kbd><kbd>→</kbd>选轮次</span><span><kbd>Esc</kbd>关抽屉/返回</span><span><kbd>/</kbd>搜索</span><span><kbd>F2</kbd>改名</span>
      <span class="sp">${S.scenario === 'empty' ? '0 个文件' : S.scenario === 'error' ? '解析失败 3/' + nFiles() : '已解析 ' + nFiles() + ' 个文件 · ' + S.set.src.filter((x) => x.on).length + ' 个数据源'} · 空闲阈值 ${S.set.thr}m · 时区 UTC+8</span>`;
  }

  /* ---------- 左栏 ---------- */
  function visible() {
    const q = S.q.trim().toLowerCase();
    const lim = { all: Infinity, day: M.dayStart, '7': NOW - 7 * 864e5, '30': NOW - 30 * 864e5 }[S.range];
    const key = { act: (d) => d.act, fix: (d) => d.fixPct, wait: (d) => d.wait }[S.sort];
    return M.reqs.filter((r) => {
      const d = derive(r);
      if (q && !r.name.toLowerCase().includes(q)) return false;
      if (S.toolF !== 'all' && !r.sessions.some((s) => s.tool === S.toolF)) return false;
      if (S.range !== 'all' && (d.end == null || d.end < lim)) return false;
      return true;
    }).sort((a, b) => key(derive(b)) - key(derive(a)));
  }
  function renderList() {
    const el = $('#list'); const old = $('.rows', el); const st = old ? old.scrollTop : 0;
    const vis = visible();
    const rowsHtml = vis.map((r) => {
      const d = derive(r);
      const warn = S.scenario === 'partial' && r.warn ? `<span class="warn" title="${esc(r.warn)}">⚠</span>` : '';
      const meta = d.empty ? '无可统计的轮次' : `改代码 ${pct(d.by.fix, d.act)} · 等我 ${fmt(d.wait)} · ${d.turns.length} 轮`;
      return `<div class="row ${r.id === S.sel ? 'sel' : ''}" role="option" aria-selected="${r.id === S.sel}" data-id="${r.id}" tabindex="-1">
        <input class="ck" type="checkbox" ${S.picked.has(r.id) ? 'checked' : ''} aria-label="选择 ${esc(r.name)}">
        <span class="nm"><span class="t" title="${esc(r.name)}">${esc(r.name)}</span>${toolsOf(r).map(tb).join('')}${warn}${r.status === 'active' ? live() : ''}</span>
        <span class="tm num">${d.empty ? '–' : fmt(d.act)}</span>
        ${bar(d, 'mini')}
        <span class="meta num">${meta}</span></div>`;
    }).join('');
    const n = S.picked.size;
    el.className = S.manage ? 'manage' : '';
    el.innerHTML = `
      <div class="lh">
        <div class="r1"><input id="q" type="search" placeholder="搜索需求名  /" value="${esc(S.q)}" aria-label="搜索需求"><button id="b-manage" aria-pressed="${S.manage}" title="多选后合并需求">${S.manage ? '完成' : '管理'}</button></div>
        <div class="r2">
          <select id="range" aria-label="时间范围">${[['all', '全部时间'], ['day', '今天'], ['7', '近 7 天'], ['30', '近 30 天']].map(([v, t]) => `<option value="${v}" ${S.range === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
          <select id="sort" aria-label="排序">${[['act', '按活跃时长'], ['fix', '按改代码占比'], ['wait', '按等我时长']].map(([v, t]) => `<option value="${v}" ${S.sort === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
        </div>
        <div class="r2"><select id="toolf" aria-label="按工具筛选"><option value="all">全部工具</option>${M.TOOLS.map((t) => `<option value="${t.id}" ${S.toolF === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div>
        <div class="cnt"><span>${vis.length} 个需求</span><span class="num">合计 ${fmt(vis.reduce((a, r) => a + derive(r).act, 0))}</span></div>
      </div>
      <div class="rows" role="listbox" aria-label="需求列表">${rowsHtml || '<div class="dim" style="padding:16px">没有符合条件的需求</div>'}</div>
      ${S.manage ? `<div class="actbar"><span class="dim">已选 ${n}</span><span class="sp"></span><button id="b-merge" class="pri" ${n < 2 ? 'disabled' : ''}>合并所选 (${n})</button></div>` : ''}`;
    $('.rows', el).scrollTop = st;
    const q = $('#q'); if (S.qFocus) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
  }

  /* ---------- 右栏详情 ---------- */
  function renderDetail() {
    if (S.proc) { renderProc(); return; }
    const box = $('#detail'); const r = cur(); const d = derive(r);
    const keepScroll = box.dataset.rid === r.id ? box.scrollTop : 0;
    box.dataset.rid = r.id;
    if (S.seg >= d.segs.length) S.seg = 0;
    const title = S.renaming
      ? `<h1><input id="rn" type="text" value="${esc(r.name)}" aria-label="需求名" maxlength="60"></h1>`
      : `<h1><span id="nm" title="双击或 F2 改名">${esc(r.name)}</span>${r.status === 'active' ? live() : ''}</h1>`;
    const acts = S.renaming
      ? `<div class="acts"><button id="rn-ok" class="pri">保存</button><button id="rn-no">取消 Esc</button></div>`
      : `<div class="acts"><button id="b-proc" ${d.empty ? 'disabled' : ''} title="查看一个会话内每一轮的过程（span 瀑布）">过程</button><button id="b-rename">重命名</button><button id="b-split" aria-pressed="${S.splitMode}" ${d.turns.length < 2 ? 'disabled' : ''}>按轮拆分</button></div>`;
    const warn = S.scenario === 'partial' && r.warn ? `<div class="banner"><span class="warn">⚠</span>${esc(r.warn)}<span class="sp"></span><button class="ghost">查看</button></div>` : '';
    let body;
    if (d.empty) {
      body = `<div class="fs" style="margin-top:16px"><h3>该需求没有可统计的对话轮</h3><p>解析到 ${r.sessions.length} 个会话，但 0 轮有效的 user → assistant 往返。可能是只含 sidechain / 空会话，或被阶段规则整体过滤。</p><div class="line"><button>查看原始会话文件</button><button>合并到其他需求</button></div></div>`;
    } else {
      const thrNote = d.idleN ? `空闲 ${fmt(d.idle)}（${d.idleN} 段，不计入）` : '无空闲段';
      body = `
      <div class="metrics">
        <div class="metric"><div class="lb">活跃耗时</div><div class="v">${fmt(d.act)}</div><div class="s num">AI 工作 ${fmt(d.work)} + 等我 ${fmt(d.wait)} · ${thrNote}</div></div>
        <div class="metric"><div class="lb">等我回复</div><div class="v">${fmt(d.wait)}</div><div class="s num">占活跃 ${pct(d.wait, d.act)} · 最长一次 ${fmt(d.maxWait, { s: true })}</div></div>
      </div>
      <div class="sec-t">阶段占比<span class="dim num">改代码 ${pct(d.by.fix, d.act)}${d.by.fix / d.act > .3 ? ' · 返工偏多' : ''}</span></div>
      ${bar(d, 'big')}${legend(d, true)}
      <div class="sec-t">时间轴<span class="dim num">${dt(d.start)} → ${dt(d.end)} · ${d.turns.length} 轮 · ${d.segs.length} 段</span></div>
      <div id="tlbar" class="tl-bar"></div><div id="tlbody"></div><div id="splitbox"></div>
      <div class="sec-t">阶段明细<span class="dim">连续同阶段合并 · Enter 打开对话</span></div>
      <div class="segs" role="listbox" aria-label="阶段明细">
        <div class="seg-h"><span>阶段</span><span>摘要</span><span class="r">轮数</span><span class="r">时长</span><span class="c-ft">起止</span></div>
        ${d.segs.map((s) => segRow(s)).join('')}
      </div>
      <div class="sec-t">会话 <span class="dim">${r.sessions.length} 个 · 勾选后可拆为新需求</span></div>
      ${sessHtml(r, d)}`;
    }
    box.innerHTML = `<div class="dh">${title}${acts}</div>
      <div class="sub num"><span>${d.empty ? '无时间范围' : dt(d.start) + ' – ' + dt(d.end)}</span><span>${r.sessions.length} 会话</span><span>${d.turns.length} 轮</span><span>${toolsOf(r).map((t) => t.name).join(' + ')}</span>${r.status === 'active' ? '<span>更新于 20s 前</span>' : ''}</div>${warn}${body}`;
    box.scrollTop = keepScroll;
    if (!d.empty) { renderTlBar(); renderTimeline(); renderSplit(); }
    if (S.renaming) { const i = $('#rn'); i.focus(); i.select(); }
  }
  function segRow(s) {
    const p = PHN[s.phase];
    return `<div class="seg ${s.k === S.seg ? 'sel' : ''}" role="option" data-k="${s.k}" tabindex="-1">
      <span class="pn"><i class="sw ph-${s.phase}"></i><span class="dim ico">${ic(s.phase, 13)}</span>${p.name}${s.manual ? '<span class="tagm" title="手动修改过阶段">手动</span>' : ''}</span>
      <span class="sm" title="${esc(s.turns[0].summary)}">${esc(s.summary)}</span>
      <span class="r num">${s.turns.length}</span><span class="r num">${fmt(s.dur)}</span>
      <span class="ft num c-ft">${hm(s.t0)}–${hm(s.t1)} · #${s.from + 1}${s.to > s.from ? '–' + (s.to + 1) : ''}</span></div>`;
  }
  function sessHtml(r, d) {
    const rows = r.sessions.map((s) => {
      const ts = d.turns.filter((t) => t.sid === s.id); const act = ts.reduce((a, t) => a + t.dur + t.w, 0);
      return `<div class="si"><input type="checkbox" data-sid="${s.id}" ${S.sessPick.has(s.id) ? 'checked' : ''} aria-label="选择会话 ${esc(s.title)}"><div><div>${tb(TL[s.tool])} ${esc(s.title)}</div><div class="f" title="${esc(s.file)}">${esc(s.file)}</div></div><span class="num dim">${ts.length} 轮</span><span class="num">${fmt(act)}</span><button data-proc-sid="${s.id}" ${ts.length ? '' : 'disabled'}>过程</button></div>`;
    }).join('');
    const n = S.sessPick.size, all = n === r.sessions.length;
    return `<div class="sess">${rows}<div class="sess-act"><span class="dim">已选 ${n}</span><button id="b-split-s" ${n < 1 || all ? 'disabled' : ''} class="${n && !all ? 'pri' : ''}">拆为新需求</button><span class="dim">${all ? '不能拆走全部会话' : r.sessions.length < 2 ? '只有 1 个会话：用上方「按轮拆分」' : ''}</span></div></div>`;
  }

  /* ---------- 时间轴 ---------- */
  const IDLE_FOLD = 30, IDLE_OPEN = 84, RUNW = 5;
  function layout(d, W) {
    const T = S.tl; const m = T.mode === 'auto' ? (d.turns.length > 120 ? 'time' : 'turn') : T.mode;
    const items = []; let fixed = 0, n = 0, sec = 0;
    // 折叠的空闲块宽度随个数自适应：最多占 25% 宽度，下限 8px，上限 30px
    const foldW = Math.max(8, Math.min(IDLE_FOLD, Math.floor(W * 0.25 / Math.max(1, d.idleN))));
    d.turns.forEach((t) => {
      items.push({ k: 't', t }); n++; sec += t.dur + t.w;
      if (t.kind === 'idle') { const it = { k: 'i', id: 'i' + t.i, dur: t.idleSec, t0: t.end, after: t.i }; it.open = !T.fold || T.open.has(it.id); it.w = it.open ? IDLE_OPEN : foldW; fixed += it.w; items.push(it); }
    });
    const avail = Math.max(120, W - fixed - 2), u = avail / n, p = avail / Math.max(1, sec);
    let x = 0;
    items.forEach((it) => { if (it.k === 't') it.w = Math.max(0.5, (m === 'turn' ? u : (it.t.dur + it.t.w) * p) * T.zoom); it.l = x; x += it.w; });
    return { m, items, total: x + fixed * 0 };
  }
  function cellsOf(L, minw) {
    const out = []; let run = null; const flush = () => { if (run) { out.push(run); run = null; } };
    L.items.forEach((it) => {
      if (it.k === 'i') { flush(); out.push({ k: 'i', ...it }); return; }
      const t = it.t;
      if (run && run.phase === t.phase && run.w < minw && it.w < minw) { run.w += it.w; run.b = t.i; run.wait += t.w; run.work += t.dur; run.live = run.live || !!t.running; }
      else { flush(); run = { k: 'c', phase: t.phase, l: it.l, w: it.w, a: t.i, b: t.i, wait: t.w, work: t.dur, live: !!t.running }; }
      if (run.w >= minw) flush();
    });
    flush(); return out;
  }
  function renderTlBar() {
    const T = S.tl, d = derive(cur());
    $('#tlbar').innerHTML = `
      <span class="grp" role="group" aria-label="横轴">${[['auto', '自动'], ['turn', '按轮'], ['time', '按时间']].map(([v, n]) => `<button data-tlm="${v}" aria-pressed="${T.mode === v}" title="${v === 'turn' ? '每轮等宽' : v === 'time' ? '宽度∝耗时' : '超过 120 轮自动用按时间'}">${n}</button>`).join('')}</span>
      <span class="grp" role="group" aria-label="缩放"><button data-z="out" aria-label="缩小" title="缩小 (−)">−</button><button data-z="fit" title="适应宽度 (0)">适应</button><button data-z="in" aria-label="放大" title="放大 (+)">+</button></span>
      <span class="num dim">×${T.zoom < 10 ? T.zoom.toFixed(1) : Math.round(T.zoom)}</span>
      <label><input type="checkbox" id="fold" ${T.fold ? 'checked' : ''}>折叠空闲${d.idleN ? ` (${d.idleN})` : ''}</label>
      <span class="sp dim">Ctrl+滚轮缩放 · 拖动小地图框平移</span>`;
  }
  function renderTimeline() {
    const box = $('#tlbody'); if (!box) return;
    const r = cur(), d = derive(r), T = S.tl;
    const oldS = $('.tl-scroll', box); const sl = oldS ? oldS.scrollLeft : 0;
    const W = Math.max(300, box.clientWidth - 2); T.W = W;
    const L = layout(d, W); T.L = L;
    const inner = Math.max(W, L.total), k = W / inner;
    const cs = cellsOf(L, RUNW); T.cs = cs;
    const selSeg = d.segs[S.seg];
    const cutI = S.splitMode ? S.cut : null;
    const showLetter = (c) => c.w >= 16;
    let h = '';
    cs.forEach((c) => {
      if (c.k === 'i') {
        h += `<div class="idle" style="left:${c.l}px;width:${c.w}px" data-idle="${c.id}" title="空闲 ${fmt(c.dur)}${c.open ? '' : '（点击展开）'}">${c.open ? '空闲 ' + fmt(c.dur) : c.w >= 20 ? '⋯' : ''}</div>`;
      } else {
        const tot = c.work + c.wait, wp = tot ? c.wait / tot * 100 : 0;
        const sel = T.sel != null && T.sel >= c.a && T.sel <= c.b;
        const hl = selSeg && c.a >= selSeg.from && c.b <= selSeg.to && !sel;
        const dim = cutI != null && c.a >= cutI;
        h += `<div class="cell ph-${c.phase} ${c.w < 6 ? 'tiny' : ''} ${sel ? 'sel' : ''} ${hl ? 'hl' : ''} ${dim ? 'dim' : ''} ${c.live ? 'run' : ''}" style="left:${c.l}px;width:${c.w}px" data-a="${c.a}" data-b="${c.b}" role="button" aria-label="第 ${c.a + 1}${c.b > c.a ? '–' + (c.b + 1) : ''} 轮 ${PHN[c.phase].name}">${showLetter(c) ? `<b title="${PHN[c.phase].name}">${ic(c.phase, 12)}</b>` : ''}${wp > 0 ? `<i class="wt ph-wait" style="width:${wp}%"></i>` : ''}</div>`;
      }
    });
    if (cutI != null) { const c = cs.find((x) => x.k === 'c' && cutI >= x.a && cutI <= x.b); if (c) h += `<div class="cutline" style="left:${c.l}px"></div>`; }
    // 刻度：约每 90px 一个起始时间；末端显示结束时间
    let ticks = '', lastX = -999, lastDay = '';
    L.items.forEach((it) => {
      if (it.k !== 't' || it.l < lastX + 90 || it.l > inner - 110) return;
      const day = md(it.t.t); ticks += `<div class="tick" style="left:${it.l}px">${day !== lastDay ? day + ' ' : ''}${hm(it.t.t)}</div>`; lastX = it.l; lastDay = day;
    });
    ticks += `<div class="tick end" style="left:${inner - 1}px">${hm(d.end)}</div>`;
    h += `<div class="ruler">${ticks}</div>`;
    // 小地图
    const mcs = cellsOf(L, 3 / k); let mh = '';
    mcs.forEach((c) => {
      if (c.k === 'i') mh += `<div class="mi" style="left:${c.l * k}px;width:${Math.max(1, c.w * k)}px"></div>`;
      else mh += `<div class="mc ph-${c.phase}" style="left:${c.l * k}px;width:${Math.max(1.5, c.w * k)}px"></div>`;
    });
    box.innerHTML = `<div class="tl-mini" id="tlmini" title="小地图：点击或拖动框平移">${mh}<div class="vp" id="tlvp"></div></div>
      <div class="tl-scroll" id="tlscroll"><div class="tl-inner" style="width:${inner}px">${h}</div></div>
      <div class="tl-hint">${L.m === 'time' ? '按时间：宽度∝（AI 工作 + 等我）' : '按轮：每轮等宽'}；${L.items.some((i) => i.k === 'i') ? '虚线块为空闲，宽度固定、不按时间缩放；' : ''}右端黄色棋盘格 = 该轮之后等我的时间${cs.some((c) => c.k === 'c' && c.b > c.a) ? '；窄于 5px 的相邻同阶段轮已合并显示' : ''}</div>`;
    const sc = $('#tlscroll'); sc.scrollLeft = T.pendingSL != null ? T.pendingSL : sl; T.pendingSL = null;
    updateVp();
  }
  function updateVp() {
    const sc = $('#tlscroll'), vp = $('#tlvp'); if (!sc || !vp) return;
    const k = sc.clientWidth / sc.scrollWidth;
    vp.style.left = (sc.scrollLeft * k) + 'px'; vp.style.width = Math.max(10, sc.clientWidth * k) + 'px';
    vp.style.display = k >= .999 ? 'none' : 'block';
  }
  function setZoom(z, anchorX) {
    const T = S.tl, sc = $('#tlscroll'); z = Math.min(60, Math.max(1, z));
    if (sc) { const ax = anchorX ?? sc.clientWidth / 2; const ratio = (sc.scrollLeft + ax) / sc.scrollWidth; T.zoom = z; renderTimeline(); const n = $('#tlscroll'); n.scrollLeft = ratio * n.scrollWidth - ax; updateVp(); }
    else T.zoom = z;
    renderTlBar();
  }
  function revealTurn(i) {
    const sc = $('#tlscroll'); const c = S.tl.cs && S.tl.cs.find((x) => x.k === 'c' && i >= x.a && i <= x.b); if (!sc || !c) return;
    if (c.l < sc.scrollLeft + 20) sc.scrollLeft = Math.max(0, c.l - 60);
    else if (c.l + c.w > sc.scrollLeft + sc.clientWidth - 20) sc.scrollLeft = c.l + c.w - sc.clientWidth + 60;
    updateVp();
  }
  function renderSplit() {
    const el = $('#splitbox'); if (!el) return;
    if (!S.splitMode) { el.innerHTML = ''; return; }
    const d = derive(cur());
    if (S.cut == null) { el.innerHTML = `<div class="splitbar"><b>按轮拆分</b><span class="dim">点击时间轴上的一格作为「新需求的第一轮」</span><span class="sp"></span><button id="sp-no">取消 Esc</button></div>`; return; }
    const rest = d.turns.slice(S.cut), act = rest.reduce((a, t) => a + t.dur + t.w, 0);
    el.innerHTML = `<div class="splitbar"><b>从第 ${S.cut + 1} 轮拆分</b><span class="dim num">新需求：${rest.length} 轮 · ${fmt(act)}；原需求保留前 ${S.cut} 轮</span><span class="sp"></span><button id="sp-ok" class="pri" ${S.cut < 1 ? 'disabled' : ''}>确认拆分</button><button id="sp-no">取消</button></div>`;
  }

  /* ---------- 抽屉 ---------- */
  function openDrawer(segK, turnI) { S.drawer = { seg: segK, turn: turnI ?? null, all: false }; S.seg = segK; renderDrawer(); markSeg(); }
  function closeDrawer() { S.drawer = null; renderDrawer(); }
  function renderDrawer() {
    const el = $('#drawer');
    $('.scrim')?.remove();
    if (!S.drawer) { el.classList.remove('open'); el.setAttribute('aria-hidden', 'true'); return; }
    const r = cur(), d = derive(r), s = d.segs[S.drawer.seg]; if (!s) { S.drawer = null; return; }
    const lim = 30, shown = S.drawer.all ? s.turns : s.turns.slice(0, lim);
    el.innerHTML = `
      <div class="dr-h">
        <div class="r1"><span class="ttl" title="${esc(r.name)}">${esc(r.name)}</span>
          <button id="dr-proc" title="在过程视图中查看这一轮（瀑布图）">过程</button><button id="dr-prev" aria-label="上一段" title="上一段 [" ${s.k === 0 ? 'disabled' : ''}>‹</button><button id="dr-next" aria-label="下一段" title="下一段 ]" ${s.k === d.segs.length - 1 ? 'disabled' : ''}>›</button>
          <button id="dr-x" aria-label="关闭">Esc</button></div>
        <div class="r2 num"><label>阶段 <select id="dr-phase" aria-label="修改该段阶段">${PH.map((p) => `<option value="${p.id}" ${p.id === s.phase ? 'selected' : ''}>${p.key} ${p.name}</option>`).join('')}</select></label>
          <span>${s.turns.length} 轮 · ${fmt(s.dur)} · 等我 ${fmt(s.wait)}</span><span>${dt(s.t0)} – ${hm(s.t1)}</span><span class="dim">按 1–6 快速改阶段</span></div>
      </div>
      <div class="dr-b">${shown.map((t) => `<div class="tn ${S.drawer.turn === t.i ? 'sel' : ''}" id="tn${t.i}">
        <div class="tn-h num"><span>#${t.i + 1}</span><span>${hm(t.t)}</span><span>AI ${fmt(t.dur, { s: true })}${t.running ? ' · 进行中' : ''}</span><span class="sp">${t.kind === 'wait' ? '等我 ' + fmt(t.w, { s: true }) : t.kind === 'idle' ? '之后空闲 ' + fmt(t.idleSec) : ''}</span></div>
        <div class="tn-p"><div class="who">我</div>${esc(t.prompt)}</div>
        <div class="tn-r"><div class="who">AI 回复摘要</div>${esc(t.reply)}</div>
        ${t.tools.length ? `<ul class="tools" aria-label="工具调用">${t.tools.map((x) => `<li><code>${esc(x.n)}</code><span class="a" title="${esc(x.a)}">${esc(x.a)}</span>${x.ok ? '' : '<span class="bad">失败</span>'}</li>`).join('')}</ul>` : '<div class="dim" style="padding:0 10px 8px;font-size:11.5px">无工具调用</div>'}</div>`).join('')}
        ${s.turns.length > lim && !S.drawer.all ? `<div style="padding:10px 0"><button id="dr-all">展开其余 ${s.turns.length - lim} 轮</button></div>` : ''}</div>`;
    el.classList.add('open'); el.setAttribute('aria-hidden', 'false'); el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', '对话详情');
    if (S.drawer.turn != null) { const tn = S.drawer.turn; if (tn - s.from >= lim) S.drawer.all = true; setTimeout(() => $('#tn' + tn)?.scrollIntoView({ block: 'center' }), 0); }
  }
  function setPhase(p) {
    const r = cur(), d = derive(r), s = d.segs[S.drawer.seg]; if (!s || s.phase === p) return;
    s.turns.forEach((t) => { const o = r.turns[t.i]; o.phase = p; o.manual = true; });
    bump(r); const ni = derive(r).segs.find((x) => x.from <= s.from && x.to >= s.from);
    S.drawer.seg = S.seg = ni ? ni.k : 0;
    toast(`已把 ${s.turns.length} 轮改为「${PHN[p].name}」，标记为手动`, '撤销', () => { s.turns.forEach((t) => { r.turns[t.i].phase = s.phase; delete r.turns[t.i].manual; }); bump(r); render(); });
    render();
  }


  /* ---------- 过程视图：一个会话内，逐轮看 span 瀑布 ---------- */
  const KIND = { llm: ['L', 'LLM 请求'], tool: ['T', '工具调用'], perm: ['W', '等权限确认'], agent: ['A', '子代理'] };
  const fs = (x) => (x <= 0 ? '0s' : x < 10 ? x.toFixed(1) + 's' : fmt(x, { s: true }));
  const tk = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'k' : String(n));
  const srcOf = (r) => S.src || r.source || 'jsonl';
  // Langfuse / OTel 叠加目前只对能导出 OTel 的 Claude Code 有意义
  const srcFor = (r, sid) => (toolOfSid(sid).id === 'cc' ? srcOf(r) : 'jsonl');
  // jsonl 没有「等权限」这种独立 span：权限等待的时间并入随后的工具耗时
  function spansOf(t, src) {
    let a = (t.spans || []).map((x) => ({ ...x }));
    if (!toolOfSid(t.sid).cap.sub) a = a.filter((x) => x.k !== 'agent' && x.depth === 0);
    if (src === 'jsonl') {
      const out = []; let carry = null;
      a.forEach((x) => {
        if (x.k === 'perm') { carry = x; return; }
        if (carry && x.depth === 0 && (x.k === 'tool' || x.k === 'agent')) { x.off = carry.off; x.dur = +(x.dur + carry.dur).toFixed(1); carry = null; }
        out.push(x);
      });
      a = out;
    }
    if (t.running && a.length) { const l = a[a.length - 1]; l.running = true; l.dur = Math.max(l.dur, t.dur - l.off); }
    return a;
  }
  function openProc(sid, turnI) {
    const r = cur(), d = derive(r);
    const sess = r.sessions.find((x) => x.id === sid && d.turns.some((t) => t.sid === x.id)) || r.sessions.find((x) => d.turns.some((t) => t.sid === x.id));
    if (!sess) return;
    const ts = d.turns.filter((t) => t.sid === sess.id);
    S.drawer = null; S.proc = { sid: sess.id, turn: ts.some((t) => t.i === turnI) ? turnI : ts[0].i, sp: 0 };
    render();
  }
  function spanPanel(x, src) {
    const lf = src === 'langfuse', na = (why) => `<span class="dim" title="${why}">– <small>（${why}）</small></span>`;
    const row = (k, v) => `<div class="kv"><span>${k}</span><span class="num">${v}</span></div>`;
    let h = `<div class="sp-h"><i class="kd kd-${x.k}" title="${KIND[x.k][1]}">${ic(x.k, 13)}</i><b>${esc(x.name)}</b>${x.name === KIND[x.k][1] ? '' : `<span class="dim">${KIND[x.k][1]}</span>`}</div>`;
    if (x.arg) h += `<div class="mono dim" style="font-size:11.5px;word-break:break-all;margin-bottom:6px">${esc(x.arg)}</div>`;
    h += row('开始', '+' + fs(x.off)) + row('耗时', fs(x.dur) + (x.running ? '（进行中）' : '')) + row('状态', x.ok ? '✓ 成功' : '✕ 失败');
    if (x.k === 'llm') {
      h += row('模型', esc(x.model)) + row('输入 / 输出', `${x.tin.toLocaleString()} / ${x.tout.toLocaleString()}`) + row('缓存命中', x.cache.toLocaleString()) + row('停止原因', x.stop);
      h += row('首 token', lf ? x.ttft + 's' : na('本地日志无此字段')) + row('成本', lf ? '$' + x.cost.toFixed(3) : na('本地日志无此字段'));
    }
    if (x.k === 'perm') h += row('等待对象', '我（人工确认）');
    if (x.out) h += `<div class="sp-o"><div class="who">${x.k === 'llm' ? '输出摘要' : '输出'}</div>${esc(x.out)}</div>`;
    if (x.k === 'tool' && x.arg) h += `<div class="sp-o"><div class="who">输入</div><span class="mono">${esc(x.arg)}</span></div>`;
    return h;
  }
  function renderProc() {
    const box = $('#detail'), r = cur(), d = derive(r), P = S.proc, src = srcFor(r, P.sid);
    const sessions = r.sessions.filter((x) => d.turns.some((t) => t.sid === x.id));
    if (!sessions.some((x) => x.id === P.sid)) P.sid = sessions[0].id;
    const ts = d.turns.filter((t) => t.sid === P.sid);
    if (!ts.some((t) => t.i === P.turn)) P.turn = ts[0].i;
    const t = d.turns[P.turn], sp = spansOf(t, src); if (P.sp >= sp.length) P.sp = 0;
    const total = Math.max(t.dur, 1, ...sp.map((x) => x.off + x.dur));
    const keepS = box.scrollTop, keepX = $('.pstrip')?.scrollLeft || 0;
    let llm = 0, tool = 0, perm = 0, fail = 0, tin = 0, tout = 0, cost = 0;
    ts.forEach((x) => spansOf(x, src).forEach((s) => {
      if (s.depth === 0) { if (s.k === 'llm') llm += s.dur; else if (s.k === 'perm') perm += s.dur; else tool += s.dur; }
      if (!s.ok) fail++;
      if (s.k === 'llm') { tin += s.tin; tout += s.tout; cost += s.cost; }
    }));
    const tool0 = toolOfSid(P.sid);
    const stat = (lb, v, tip) => `<div title="${tip || ''}"><div class="lb">${lb}</div><div class="v">${v}</div></div>`;
    const lf = src === 'langfuse';
    const strip = ts.map((x) => {
      const bad = spansOf(x, src).some((s) => !s.ok);
      return `<button class="pcell ph-${x.phase} ${x.i === P.turn ? 'sel' : ''} ${bad ? 'bad' : ''}" data-ptn="${x.i}" aria-label="第 ${x.i + 1} 轮 ${PHN[x.phase].name}${bad ? '，有工具失败' : ''}" title="#${x.i + 1} ${PHN[x.phase].name} · ${fs(x.dur)}${bad ? ' · 有失败' : ''}"></button>`;
    }).join('');
    const rows = sp.map((s, k) => {
      const [, kn] = KIND[s.k], l = s.off / total * 100, w = Math.max(.6, s.dur / total * 100);
      const lab = `<span class="wf-d num" style="${l + w > 82 ? `right:calc(${100 - l}% + 4px)` : `left:calc(${l + w}% + 4px)`}">${fs(s.dur)}${s.running ? '…' : ''}</span>`;
      const bc = s.k === 'perm' ? 'ph-wait' : 'b-' + s.k;
      return `<div class="wf-r ${k === P.sp ? 'sel' : ''} ${s.ok ? '' : 'bad'}" data-psp="${k}" role="option" aria-selected="${k === P.sp}" tabindex="-1"><div class="wf-n" style="padding-left:${8 + s.depth * 16}px"><i class="kd kd-${s.k}" title="${kn}">${ic(s.k, 12)}</i><span class="nmx">${esc(s.name)}</span>${s.arg ? `<span class="ag">${esc(s.arg)}</span>` : ''}${s.ok ? '' : '<span class="x" title="失败">✕</span>'}</div><div class="wf-t"><div class="wf-b ${bc} ${s.ok ? '' : 'fail'} ${s.running ? 'run' : ''}" style="left:${l}%;width:${w}%"></div>${lab}</div></div>`;
    }).join('');
    const ticks = [0, .25, .5, .75, 1].map((p) => `<span style="left:${p * 100}%">${fs(total * p)}</span>`).join('');
    const turnPerm = sp.filter((x) => x.k === 'perm').reduce((a, x) => a + x.dur, 0);
    box.innerHTML = `<div class="proc">
      <div class="dh"><h1><button id="pr-back" class="ghost" title="返回 Esc">← 返回</button><span>过程 · ${esc(r.name)}</span></h1>
        <div class="acts"><label class="dim" style="display:flex;gap:4px;align-items:center">数据源 <select id="pr-src" aria-label="数据源"><option value="jsonl" ${src === 'jsonl' ? 'selected' : ''}>本地日志</option><option value="langfuse" ${lf ? 'selected' : ''} ${toolOfSid(P.sid).id === 'cc' ? '' : 'disabled'}>Langfuse（OTel span）</option></select></label></div></div>
      <div class="sub"><label style="display:flex;gap:4px;align-items:center">会话 <select id="pr-sess" aria-label="会话">${sessions.map((x) => `<option value="${x.id}" ${x.id === P.sid ? 'selected' : ''}>${esc(x.title)}（${d.turns.filter((y) => y.sid === x.id).length} 轮）</option>`).join('')}</select></label>
        <span>${tb(tool0)} ${esc(tool0.name)}</span>${capsHtml(tool0, lf)}</div>
      <div class="pstats num">${stat('LLM 耗时', fmt(llm, { s: true }))}${stat('工具耗时', fmt(tool, { s: true }))}${stat('权限等待', hasCap(tool0, 'perm', lf) ? fmt(perm, { s: true, zero: '0s' }) : '–', hasCap(tool0, 'perm', lf) ? '' : '本地日志无法区分')}${stat('工具失败', fail)}${stat('输入 / 输出 token', hasCap(tool0, 'tokens', lf) ? `${tk(tin)} / ${tk(tout)}` : '–', hasCap(tool0, 'tokens', lf) ? '' : '该适配器无 token 字段')}${stat('成本', hasCap(tool0, 'cost', lf) ? '$' + cost.toFixed(2) : '–', hasCap(tool0, 'cost', lf) ? '' : '本地日志无成本字段')}</div>
      <div class="sec-t">轮次<span class="dim">${ts.length} 轮 · ←→ 切换 · [ ] 换会话</span></div>
      <div class="pstrip" role="listbox" aria-label="会话内的轮">${strip}</div>
      <div class="sec-t">第 ${t.i + 1} 轮<span class="tag-ph"><i class="sw ph-${t.phase}"></i><span class="dim ico">${ic(t.phase, 13)}</span> ${PHN[t.phase].name}</span><span class="dim num">${hm(t.t)} · AI ${fs(t.dur)}${t.kind === 'wait' ? ' · 之后等我 ' + fs(t.w) : ''}${turnPerm ? ' · 其中等权限 ' + fs(turnPerm) : ''}</span></div>
      <div class="pq"><span class="who">我</span> ${esc(t.prompt)}</div>
      <div class="pgrid"><div class="wf" role="listbox" aria-label="span 瀑布图">
        <div class="wf-ax"><span class="wf-axl">span（↑↓ 选择）</span><div class="wf-ticks">${ticks}</div></div>${rows}</div>
        <aside class="spanp" aria-label="span 详情">${spanPanel(sp[P.sp], src)}</aside></div>
      <div class="tl-hint">条形宽度 ∝ 耗时，横轴为该轮 0 → ${fs(total)}。图标：✦ LLM 请求，扳手 工具，分叉 子代理（缩进为其内部调用），锁 等权限确认（等我）；✕ = 失败。</div>
    </div>`;
    box.scrollTop = keepS; const st = $('.pstrip'); if (st) st.scrollLeft = keepX;
    $('.pcell.sel')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }
  function procKeys(e, d) {
    const P = S.proc, r = cur(), ts = d.turns.filter((t) => t.sid === P.sid), k = ts.findIndex((t) => t.i === P.turn), n = spansOf(d.turns[P.turn], srcFor(r, P.sid)).length;
    const sess = r.sessions.filter((x) => d.turns.some((t) => t.sid === x.id)), si = sess.findIndex((x) => x.id === P.sid);
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); P.turn = ts[Math.max(0, Math.min(ts.length - 1, k + (e.key === 'ArrowRight' ? 1 : -1)))].i; P.sp = 0; renderProc(); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); P.sp = Math.max(0, Math.min(n - 1, P.sp + (e.key === 'ArrowDown' ? 1 : -1))); renderProc(); $(`.wf-r[data-psp="${P.sp}"]`)?.scrollIntoView({ block: 'nearest' }); }
    else if ((e.key === '[' && si > 0) || (e.key === ']' && si < sess.length - 1)) openProc(sess[si + (e.key === ']' ? 1 : -1)].id);
  }

  /* ---------- 今日概览 ---------- */
  function renderToday() {
    const el = $('#today'); el.classList.toggle('open', S.todayOpen); if (!S.todayOpen) return;
    const by = {}; PH.forEach((p) => { by[p.id] = 0; }); let wait = 0; const per = []; const byTool = M.TOOLS.map((t) => ({ t, a: 0 }));
    M.reqs.forEach((r) => {
      const d = derive(r); let a = 0;
      d.turns.forEach((t) => { if (t.t >= M.dayStart) { by[t.phase] += t.dur; wait += t.w; a += t.dur + t.w; } });
      if (a) per.push({ r, a });
      d.turns.forEach((t) => { if (t.t >= M.dayStart) { const x = byTool.find((y) => y.t.id === toolOfSid(t.sid).id); if (x) x.a += t.dur + t.w; } });
    });
    const act = PH.reduce((s, p) => s + by[p.id], 0) + wait; const dd = { by, wait, act };
    const run = M.reqs.filter((r) => r.status === 'active');
    el.innerHTML = `<div class="hd"><span class="big">${fmt(act)}</span><b>今日活跃 · ${md(NOW)} 周五</b></div>
      ${bar(dd, 'big')}${legend(dd, false)}
      <h4>按工具</h4>
      ${byTool.filter((x) => x.a).map((x) => `<div class="li"><span class="n">${tb(x.t)} ${esc(x.t.name)}</span><span class="num">${fmt(x.a)}</span></div>`).join('')}
      <h4>正在进行 (${run.length})</h4>
      ${run.map((r) => { const d = derive(r), l = d.turns[d.turns.length - 1]; return `<div class="li"><span class="n">${live()} ${esc(r.name)}</span><span class="num dim"><i class="ph-${l.phase}" style="display:inline-block;width:10px;height:10px;border-radius:2px;vertical-align:-1px"></i> ${PHN[l.phase].name} · ${fmt(l.dur, { s: true })}</span></div>`; }).join('') || '<div class="dim">当前没有进行中的会话</div>'}
      <h4>今日投入最多</h4>
      ${per.sort((a, b) => b.a - a.a).slice(0, 4).map((x) => `<div class="li"><span class="n">${esc(x.r.name)}</span><span class="num">${fmt(x.a)}</span></div>`).join('')}
      <div style="margin-top:10px;display:flex;gap:6px"><button id="t-open" class="pri">打开主窗口</button><span class="dim" style="align-self:center;font-size:11.5px">托盘/菜单栏弹出面板 · 340px</span></div>`;
  }


  /* ---------- 洞察（Dashboard） ---------- */
  function dashData() {
    const R = S.dash.range, DAY = 864e5, lim = R === 'all' ? 0 : NOW - (+R) * DAY, plim = R === 'all' ? 0 : lim - (+R) * DAY;
    const zero = () => { const o = {}; PH.forEach((p) => { o[p.id] = 0; }); return o; };
    const by = zero(), pby = zero(); let wait = 0, pwait = 0, maxWait = 0, maxWaitReq = null, longTurns = [], idle = 0;
    const days = []; for (let i = 13; i >= 0; i--) { const t0 = new Date(M.dayStart).getTime() - i * DAY; days.push({ t0, by: zero(), wait: 0 }); }
    const reqs = [];
    M.reqs.forEach((r) => {
      const d = derive(r); if (d.empty) return;
      const rb = zero(); let rw = 0, ra = 0, loops = 0, lastTest = false;
      d.turns.forEach((t) => {
        if (t.t >= lim) { by[t.phase] += t.dur; wait += t.w; rb[t.phase] += t.dur; rw += t.w; ra += t.dur + t.w; idle += t.idleSec;
          if (t.w > maxWait) { maxWait = t.w; maxWaitReq = r; }
          if (t.dur >= 600) longTurns.push({ r, t }); }
        else if (plim && t.t >= plim) { pby[t.phase] += t.dur; pwait += t.w; }
        const dd = days.find((x) => t.t >= x.t0 && t.t < x.t0 + DAY); if (dd) { dd.by[t.phase] += t.dur; dd.wait += t.w; }
      });
      d.segs.forEach((g) => { if (g.phase === 'test') lastTest = true; else if (g.phase === 'fix' && lastTest) { loops++; lastTest = false; } else if (g.phase !== 'fix') lastTest = g.phase === 'test'; });
      if (ra) reqs.push({ r, by: rb, wait: rw, act: ra, loops });
    });
    const work = PH.reduce((a, p) => a + by[p.id], 0), act = work + wait;
    const pact = PH.reduce((a, p) => a + pby[p.id], 0) + pwait;
    const rank = [...PH.map((p) => ({ id: p.id, name: p.name, v: by[p.id], pv: pby[p.id] })), { id: 'wait', name: '等我', v: wait, pv: pwait }].sort((a, b) => b.v - a.v);
    return { by, wait, act, pact, rank, reqs: reqs.sort((a, b) => b.act - a.act), maxWait, maxWaitReq, longTurns, days, idle, hasPrev: !!plim && pact > 0 };
  }
  function dashAdvice(D) {
    const A = [], pc = (v) => D.act ? Math.round(v * 100 / D.act) : 0, by = D.by;
    const top = (key) => [...D.reqs].sort((a, b) => (key === 'wait' ? b.wait - a.wait : b.by[key] - a.by[key])).slice(0, 2);
    const loopReqs = D.reqs.filter((x) => x.loops >= 2).sort((a, b) => b.loops - a.loops);
    if (pc(by.fix) >= 25) A.push({ w: by.fix, ph: 'fix', t: '改代码占比偏高，先把「做对」的标准说清楚', ev: `改代码 ${fmt(by.fix)}（${pc(by.fix)}%）` + (loopReqs.length ? ` · ${loopReqs.length} 个需求出现 ≥2 次「测试→改代码」来回，最多 ${loopReqs[0].loops} 次` : ''),
      do: ['动手前花一轮「聊方案」，把验收条件和边界写进提示词', '让 AI 先写/先跑测试，再改实现', '返工多的需求，把失败原因记进项目说明文件，避免下次重犯'], reqs: top('fix').map((x) => x.r) });
    if (pc(by.plan) < 6 && pc(by.fix) >= 20) A.push({ w: by.fix * .3, ph: 'plan', t: '聊方案时间很少，改代码时间很多', ev: `聊方案 ${fmt(by.plan)}（${pc(by.plan)}%） vs 改代码 ${pc(by.fix)}%`, do: ['复杂需求先让 AI 给方案并确认，再开始写', '这是相关性而非因果：只有一部分返工来自方案不清'], reqs: [] });
    if (D.act && D.wait / D.act >= .15) A.push({ w: D.wait, ph: 'wait', t: 'AI 在等你回复的时间不少', ev: `等我 ${fmt(D.wait)}（${pc(D.wait)}%）· 最长一次 ${fmt(D.maxWait)}${D.maxWaitReq ? '（' + D.maxWaitReq.name + '）' : ''}`,
      do: ['给常用只读命令加权限白名单，减少卡在确认上', '长任务开启完成通知，不用盯屏', '一次把需求交代完整，减少来回追问'], reqs: top('wait').map((x) => x.r) });
    if (pc(by.research) >= 18) A.push({ w: by.research * .5, ph: 'research', t: '调研占比较高，把查到的结论留下来', ev: `调研 ${fmt(by.research)}（${pc(by.research)}%）`, do: ['把常查的结论沉淀进项目文档，下次直接引用', '先划定调研范围和产出，避免无限发散'], reqs: top('research').map((x) => x.r) });
    if (D.longTurns.length >= 3) A.push({ w: D.longTurns.reduce((a, x) => a + x.t.dur, 0) * .4, ph: 'other', t: `有 ${D.longTurns.length} 个单轮超过 10 分钟`, ev: `最长 ${fmt(Math.max(...D.longTurns.map((x) => x.t.dur)))}`, do: ['把大任务拆成几个小步，每步可验证', '在「过程」视图里看这些轮耗在 LLM、工具还是子代理上'], reqs: [...new Set(D.longTurns.map((x) => x.r))].slice(0, 2) });
    A.sort((a, b) => b.w - a.w); return A.slice(0, 4);
  }

  /* ---------- 建议：规则 / 大模型 ---------- */
  const ADV_PROV = { anthropic: ['Anthropic', 'https://api.anthropic.com', 'claude-sonnet-5-5'], openai: ['OpenAI 兼容', 'https://api.openai.com/v1', ''], ollama: ['本地 Ollama', 'http://localhost:11434', ''] };
  const advOn = () => { const a = S.set.adv; return a.mode === 'llm' && (a.provider === 'ollama' || !!a.key) && !!a.model; };
  const SEND_LV = { agg: ['只发聚合数字', '阶段 / 日期的秒数；需求以「需求 A/B…」代称；不含任何对话内容'], names: ['聚合 + 需求名称', '在上面的基础上带真实需求名'], summ: ['聚合 + 需求名 + 每段摘要', '再带每段的一句话摘要（可能含代码、路径、业务信息）'] };
  function advPayload(D) {
    const lv = S.set.adv.send, nm = (r, i) => lv === 'agg' ? '需求' + 'ABCDEFGH'[i] : r.name;
    const o = { range: S.dash.range === 'all' ? '全部' : '近' + S.dash.range + '天', idle_threshold_min: S.set.thr, active_sec: Math.round(D.act), by_phase_sec: Object.fromEntries([...Object.entries(D.by), ['wait', D.wait]].map(([k, v]) => [k, Math.round(v)])), max_wait_sec: Math.round(D.maxWait), turns_over_10min: D.longTurns.length,
      daily_active_sec: D.days.map((x) => Math.round(PH.reduce((a, p) => a + x.by[p.id], 0) + x.wait)),
      top_requirements: D.reqs.slice(0, 5).map((x, i) => { const e = { name: nm(x.r, i), active_sec: Math.round(x.act), by_phase_sec: Object.fromEntries(Object.entries(x.by).map(([k, v]) => [k, Math.round(v)])), test_fix_loops: x.loops }; if (lv === 'summ') e.segment_summaries = derive(x.r).segs.slice(0, 3).map((g) => g.summary); return e; }),
      rule_findings: dashAdvice(D).map((a) => a.t) };
    return o;
  }
  function advMock(D) {
    const a = S.set.adv, lv = a.send, pc = (v) => D.act ? Math.round(v * 100 / D.act) : 0, R = D.reqs;
    const n = (i) => !R[i] ? '' : lv === 'agg' ? '需求' + 'ABCDEFGH'[i] : `「${R[i].r.name}」`;
    const fixTop = [...R].map((x, i) => ({ x, i })).sort((p, q) => q.x.by.fix - p.x.by.fix)[0];
    const loopTop = [...R].map((x, i) => ({ x, i })).sort((p, q) => q.x.loops - p.x.loops)[0];
    const peak = D.days.map((x) => PH.reduce((s, p) => s + x.by[p.id], 0) + x.wait);
    const hi = peak.filter((v) => v > 4 * 3600).length;
    const items = [];
    if (fixTop && fixTop.x.by.fix > 0) items.push({ ph: 'fix', t: `返工集中在${n(fixTop.i)}，不是普遍问题`, ev: `${n(fixTop.i)}的改代码 ${fmt(fixTop.x.by.fix)}，占全部改代码的 ${Math.round(fixTop.x.by.fix * 100 / Math.max(1, D.by.fix))}%`, do: ['回看这个需求的第一轮方案：验收标准是否缺了边界情况', '同类需求下次先写测试，再让 AI 实现', '其余需求的返工水平接近常态，不必整体调整'], reqs: [fixTop.x.r] });
    if (loopTop && loopTop.x.loops >= 2) items.push({ ph: 'test', t: `${n(loopTop.i)}反复在「测试 ↔ 改代码」之间来回`, ev: `来回 ${loopTop.x.loops} 次；这类循环通常说明失败原因没被一次说清`, do: ['出现第二次失败时，先停下让 AI 总结失败原因，再改', '把稳定复现的失败写成一条用例，固定下来'], reqs: [loopTop.x.r] });
    if (D.act && D.wait / D.act >= .1) items.push({ ph: 'wait', t: '等待多半来自少数几次长停顿，而不是持续的小卡顿', ev: `等我共 ${fmt(D.wait)}（${pc(D.wait)}%），最长一次 ${fmt(D.maxWait)}`, do: ['最长的几次停顿，先看是不是卡在权限确认或等你拍板', '给固定的只读命令加白名单；需要拍板的事，一次问完'], reqs: D.maxWaitReq ? [D.maxWaitReq] : [] });
    if (hi >= 2) items.push({ ph: 'other', t: `近两周有 ${hi} 天活跃超过 4 小时`, ev: `单日最高 ${fmt(Math.max(...peak))}`, do: ['高强度的日子，复盘当天是否集中处理了同一个难点', '把容易被打断的调研放在上午整块时间里'], reqs: [] });
    const inTok = Math.round(JSON.stringify(advPayload(D)).length / 2.2);
    return { summary: `${S.dash.range === 'all' ? '整体' : '这段时间'}最大的时间消耗是${PHN[D.rank[0].id] ? PHN[D.rank[0].id].name : '等待'}（${pc(D.rank[0].v)}%）。${fixTop ? `其中改代码主要来自${n(fixTop.i)}，` : ''}把精力放在这一处，比整体提速更划算。`, items: items.slice(0, 4), model: a.model || '—', ms: 3200, inTok, outTok: 520 };
  }
  function adviceSection(D, rules) {
    const a = S.set.adv, on = advOn(), run = S.advRun;
    const card = (x) => `<div class="adv"><div class="a-h"><span class="hi ph-${x.ph}">${ic(x.ph, 16)}</span><b>${esc(x.t)}</b></div><div class="a-e num">${esc(x.ev)}</div><ul>${x.do.map((y) => `<li>${esc(y)}</li>`).join('')}</ul>${x.reqs.length ? `<div class="a-r"><span class="dim">来看看：</span>${x.reqs.map((r) => `<a href="#" data-goreq="${r.id}">${esc(r.name)}</a>`).join('')}</div>` : ''}</div>`;
    const rulesH = rules.length ? `<div class="advs">${rules.map(card).join('')}</div>` : '<p class="dim">这个范围内没有触发任何规则，分布看起来均衡。</p>';
    const badge = (k, t) => `<span class="srcb ${k}">${t}</span>`;
    let head, body;
    if (!on) {
      head = `${badge('r', '规则生成')}<span class="sp"></span><a href="#" id="goadv" class="dim">想要更贴合你情况的建议？配置一个模型（可选）→</a>`;
      body = rulesH;
    } else if (run.status === 'loading') {
      head = `${badge('m', '模型 · ' + esc(a.model))}<span class="sp"></span><span class="dim"><i class="spin"></i> 生成中…</span>`;
      body = `<div class="skel"><i></i><i></i><i style="width:70%"></i></div><div class="advs dimmed">${[0, 1].map(() => '<div class="adv skel"><i></i><i></i><i style="width:60%"></i></div>').join('')}</div>`;
    } else if (run.status === 'error') {
      head = `${badge('r', '规则生成')}<span class="sp"></span><button id="adv-run">重试</button>`;
      body = `<div class="note bad" role="alert"><b>模型调用失败</b>：${esc(run.err || '请求超时')}。下面显示的是规则建议，数据没有丢。<a href="#" id="goadv">检查模型设置</a></div>${rulesH}`;
    } else if (run.status === 'done' && run.out) {
      const o = run.out;
      head = `${badge('m', '模型 · ' + esc(o.model))}<span class="sp"></span><button id="adv-run">重新生成</button>`;
      body = `<p class="a-sum">${esc(o.summary)}</p><div class="advs">${o.items.map(card).join('')}</div>
        <div class="a-f dim num">${(o.ms / 1000).toFixed(1)}s · 输入约 ${(o.inTok / 1000).toFixed(1)}k / 输出约 ${(o.outTok / 1000).toFixed(1)}k token · 发送范围：${SEND_LV[a.send][0]} · 内容由模型生成，请自行核对数字</div>
        <details class="cmp"><summary>对照规则建议（${rules.length} 条）</summary>${rulesH}</details>`;
    } else {
      head = `${badge('r', '规则生成')}<span class="sp"></span><button class="pri" id="adv-run">用 ${esc(a.model)} 生成</button>`;
      body = rulesH + `<div class="dim" style="font-size:12px;margin-top:8px">已配置模型。点击后会发送「${SEND_LV[a.send][0]}」给 ${esc(ADV_PROV[a.provider][0])}；发送内容可在 <a href="#" id="goadv">设置</a> 里预览。</div>`;
    }
    return `<div class="fs"><h3 class="advh">建议 ${head}</h3>${body}</div>`;
  }
  function advSettings() {
    const a = S.set.adv, P = ADV_PROV[a.provider], on = a.mode === 'llm', D = dashData(), t = a.test;
    return `<div class="fs" id="advset"><h3>建议生成（可选）</h3>
      <p>默认用本地规则生成建议，不联网。配置一个大模型后，洞察页会多出「用模型生成」，给出更贴合你情况的建议；模型失败时自动退回规则建议。</p>
      <div class="line"><label class="radio"><input type="radio" name="advmode" data-adv="mode" value="rules" ${on ? '' : 'checked'}> 只用规则（不联网）</label><label class="radio"><input type="radio" name="advmode" data-adv="mode" value="llm" ${on ? 'checked' : ''}> 规则 + 大模型</label></div>
      ${on ? `<div class="advf">
        <div class="line"><label class="dim">服务</label><select data-adv="provider" aria-label="模型服务">${Object.entries(ADV_PROV).map(([k, v]) => `<option value="${k}" ${a.provider === k ? 'selected' : ''}>${v[0]}</option>`).join('')}</select></div>
        <div class="line"><label class="dim">地址</label><input type="text" data-adv="base" value="${esc(a.base)}" aria-label="接口地址"></div>
        <div class="line"><label class="dim">模型</label><input type="text" data-adv="model" value="${esc(a.model)}" placeholder="模型名" aria-label="模型名"></div>
        <div class="line"><label class="dim">API Key</label><input type="password" data-adv="key" value="${esc(a.key)}" placeholder="${a.provider === 'ollama' ? '本地服务无需 Key' : '粘贴 API Key'}" aria-label="API Key" ${a.provider === 'ollama' ? 'disabled' : ''}><button id="adv-test">测试连接</button></div>
        <div class="num ${t ? (t.ok ? 'ok' : 'bad') : 'dim'}" style="font-size:12px;margin-left:78px">${t ? esc(t.msg) : 'Key 存系统钥匙串，不写入配置文件'}</div>
        <h4 style="margin:14px 0 6px">发送给模型的内容</h4>
        ${Object.entries(SEND_LV).map(([k, v]) => `<label class="radio blk"><input type="radio" name="advsend" data-adv="send" value="${k}" ${a.send === k ? 'checked' : ''}><span><b>${v[0]}</b>${k === 'agg' ? ' <span class="tagm">默认</span>' : ''}<br><span class="dim" style="font-size:12px">${v[1]}</span></span></label>`).join('')}
        <details class="cmp"><summary>预览将要发送的内容（当前范围：${S.dash.range === 'all' ? '全部' : '近 ' + S.dash.range + ' 天'}）</summary><pre class="pv">${esc(JSON.stringify(advPayload(D), null, 2))}</pre></details>
        ${a.provider !== 'ollama' ? '<p class="dim" style="font-size:12px;margin-top:6px">选「本地 Ollama」时数据不出本机。其余服务会把上面的内容发到对应的接口地址。</p>' : ''}
      </div>` : ''}</div>`;
  }
  function renderDash() {
    const D = dashData(), adv = dashAdvice(D), pc = (v) => D.act ? Math.round(v * 100 / D.act) : 0, top = D.rank[0];
    const delta = (x) => { if (!D.hasPrev) return ''; const d = x.v - x.pv; return Math.abs(d) < 120 ? '<span class="dl dim">持平</span>' : `<span class="dl ${d > 0 ? 'up' : 'dn'}" title="较上一个同长周期">${d > 0 ? '↑' : '↓'} ${fmt(Math.abs(d))}</span>`; };
    const rl = { 7: '近 7 天', 30: '近 30 天', all: '全部' }[S.dash.range];
    const dmax = Math.max(1, ...D.days.map((x) => PH.reduce((a, p) => a + x.by[p.id], 0) + x.wait));
    const wk = '日一二三四五六';
    const rmax = Math.max(1, D.rank[0].v);
    $('#main').innerHTML = `<div class="page"><div class="inner dash">
      <div class="dh"><h1>洞察</h1><div class="acts"><div class="rg" role="group" aria-label="时间范围">${[['7', '近 7 天'], ['30', '近 30 天'], ['all', '全部']].map(([v, n]) => `<button data-drange="${v}" aria-pressed="${S.dash.range === v}">${n}</button>`).join('')}</div><button id="set-back">返回 Esc</button></div></div>
      <div class="sub">${rl} · ${D.reqs.length} 个需求 · 数据来自本机日志 · ${advOn() ? '建议默认用规则；点「用模型生成」才会发送' + SEND_LV[S.set.adv.send][0] + (S.set.adv.provider === 'ollama' ? '（本地模型，不出本机）' : '') : '建议由本地规则生成，不调用模型、不上传'}</div>
      ${!D.act ? '<div class="fs"><p>这个时间范围内没有活跃记录。</p></div>' : `
      <div class="hero">
        <div class="h-main"><div class="k">最耗时的部分</div>
          <div class="h-t"><span class="hi ph-${top.id}">${ic(top.id, 22)}</span><b>${esc(top.name)}</b></div>
          <div class="h-n"><span class="big">${fmt(top.v)}</span><span class="dim"> 占活跃 ${pc(top.v)}%${D.hasPrev ? ' · ' + delta(top).replace(/<[^>]+>/g, '') + '（较上期）' : ''}</span></div>
          ${bar({ by: D.by, wait: D.wait, act: D.act }, 'big')}
        </div>
        <div class="h-kpi">
          <div><span class="k">活跃耗时</span><b class="num">${fmt(D.act)}</b>${D.hasPrev ? delta({ v: D.act, pv: D.pact }) : ''}</div>
          <div><span class="k">需求数</span><b class="num">${D.reqs.length}</b><span class="dim">平均 ${fmt(D.act / D.reqs.length)}</span></div>
          <div><span class="k">等我占比</span><b class="num">${pc(D.wait)}%</b><span class="dim">${fmt(D.wait)}</span></div>
          <div><span class="k">最长等待</span><b class="num">${fmt(D.maxWait)}</b><span class="dim">一次</span></div>
        </div>
      </div>
      ${adviceSection(D, adv)}
      <div class="two">
        <div class="fs"><h3>阶段排名</h3>
          ${D.rank.map((x) => `<div class="rk"><span class="rn">${ic(x.id, 14)}${esc(x.name)}</span><div class="rb"><i class="ph-${x.id}" style="width:${x.v / rmax * 100}%"></i></div><span class="num">${fmt(x.v, { zero: '–' })}</span><span class="num dim">${pc(x.v)}%</span><span class="rd">${delta(x)}</span></div>`).join('')}
        </div>
        <div class="fs"><h3>最近 14 天</h3>
          <div class="cols">${D.days.map((x) => { const tot = PH.reduce((a, p) => a + x.by[p.id], 0) + x.wait; return `<div class="col" title="${md(x.t0)} · ${fmt(tot, { zero: '无记录' })}"><div class="st">${tot ? `<div class="stk" style="height:${tot / dmax * 100}%">${PH.map((p) => x.by[p.id] > 0 ? `<i class="ph-${p.id}" style="flex:${x.by[p.id]}"></i>` : '').join('')}${x.wait > 0 ? `<i class="ph-wait" style="flex:${x.wait}"></i>` : ''}</div>` : ''}</div><span class="dx">${wk[new Date(x.t0).getDay()]}</span></div>`; }).join('')}</div>
          <div class="dim" style="font-size:11.5px;margin-top:6px">柱高 = 当天活跃时长，最高 ${fmt(dmax)}；悬停看当天总计</div>
        </div>
      </div>
      <div class="fs"><h3>最耗时的需求</h3>
        ${D.reqs.slice(0, 5).map((x) => { const m = PH.reduce((a, p) => x.by[p.id] > x.by[a.id] ? p : a, PH[0]); return `<button class="rq" data-goreq="${x.r.id}"><span class="n">${esc(x.r.name)}</span><span class="rbar">${bar({ by: x.by, wait: x.wait, act: x.act }, 'mini')}</span><span class="dim">${ic(m.id, 13)} ${m.name} ${Math.round(x.by[m.id] * 100 / x.act)}%</span><b class="num">${fmt(x.act)}</b></button>`; }).join('')}
      </div>`}
    </div></div>`;
  }

  /* ---------- 设置 ---------- */
  function renderSettings() {
    const s = S.set, d = derive(cur());
    $('#main').innerHTML = `<div class="page"><div class="inner">
      <div class="dh"><h1>设置</h1><div class="acts"><button id="set-back">返回 Esc</button></div></div><div class="sub"></div>
      <div class="fs"><h3>数据源</h3><p>一个数据源 = 一个<b>适配器</b> + 一个目录。适配器负责把某个工具的日志翻译成统一的会话 / 轮 / span；要支持新工具，添加一个数据源即可。</p>
        <div class="srcs">${s.src.map((x, i) => { const t = TL[x.tool]; return `<div class="src ${x.on ? '' : 'off'}"><input type="checkbox" data-son="${i}" ${x.on ? 'checked' : ''} aria-label="启用 ${esc(t.name)} ${esc(x.path)}">${tb(t)}<div class="sn"><div>${esc(t.name)}${t.custom ? ' <span class="dim">（自定义适配器）</span>' : ''}</div><div class="mono dim p" title="${esc(x.path)}">${esc(x.path)}</div></div><span class="st num ${x.ok ? 'ok' : ''}">${x.ok ? '✓ ' + x.files + ' 个文件' : '未扫描'}</span><button data-rmsrc="${i}">移除</button></div>`; }).join('')}</div>
        ${S.adding ? addPanel() : `<div class="line"><button id="addsrc" class="pri">添加数据源…</button><button id="rescan">重新扫描</button></div>`}</div>
      <div class="fs"><h3>适配器能力</h3><p>各适配器能提供的字段不同；缺失的字段在界面里显示为灰色「–」，不会估算或编造。</p>
        <div class="capt"><div class="capr h"><span>适配器</span>${CAPS.map(([, n]) => `<span>${n}</span>`).join('')}</div>${M.TOOLS.map((t) => `<div class="capr"><span>${tb(t)} ${esc(t.name)}</span>${CAPS.map(([k]) => `<span class="${t.cap[k] ? 'ok' : 'no'}">${t.cap[k] ? '✓' : '–'}</span>`).join('')}</div>`).join('')}<div class="capr"><span><span class="tb">LF</span> Langfuse（叠加）</span>${CAPS.map(([k]) => `<span class="${LF_CAP[k] ? 'ok' : 'no'}">${LF_CAP[k] ? '✓' : '·'}</span>`).join('')}</div></div>
        <div class="dim" style="font-size:11.5px;margin-top:6px">Langfuse / OTel 作为可选的叠加来源：补充权限等待、首 token、成本，并使轮内耗时由推算变为实测。· = 不改变该项。</div></div>
      <div class="fs"><h3>空闲阈值</h3><p>我两次发言之间超过该时长，记为「空闲」，不计入活跃；未超过的记为「等我」。</p>
        <div class="line"><input id="thr" type="range" min="2" max="60" step="1" value="${s.thr}" aria-label="空闲阈值（分钟）"><span class="num" id="thrv" style="min-width:48px;text-align:right">${s.thr} 分钟</span></div>
        <div class="dim num" id="thrp" style="font-size:12px">${thrPreview(d)}</div></div>
      <div class="fs"><h3>需求聚合时间窗</h3><p>同一目录下，相邻会话间隔不超过该时长，自动归为同一需求；之后可手动合并/拆分。</p>
        <div class="line"><input id="win" type="number" min="0" max="72" value="${s.win}" style="width:72px" aria-label="聚合时间窗（小时）"><span>小时</span><span class="dim" style="font-size:12px">修改后需重新聚合，手动合并/拆分的结果会保留</span></div></div>
      <div class="fs"><h3>阶段规则文件</h3><p>YAML，定义「工具调用 / 关键词 → 阶段」的规则；缺省使用内置规则。</p>
        <div class="line"><input id="rules" type="text" value="${esc(s.rules)}" aria-label="阶段规则文件路径"><button id="rules-ok">校验</button><button>选择…</button></div>
        <div class="num ${s.rulesMsg ? 'ok' : 'dim'}" style="font-size:12px">${s.rulesMsg || '尚未校验'}</div></div>
      ${advSettings()}
    </div></div>`;
  }
  function addPanel() {
    const A = S.adding, t = TL[A.tool], tt = A.test;
    return `<div class="addp"><div class="line"><label style="width:70px" class="dim">适配器</label><select id="add-tool" aria-label="适配器">${M.TOOLS.filter((x) => !x.custom).map((x) => `<option value="${x.id}" ${A.tool === x.id ? 'selected' : ''}>${esc(x.name)}（内置）</option>`).join('')}<option value="my" ${A.tool === 'my' ? 'selected' : ''}>自定义：加载适配器文件…</option></select></div>
      <div class="line"><label style="width:70px" class="dim">目录</label><input id="add-path" type="text" value="${esc(A.path || t.path)}" aria-label="日志目录"><button>选择…</button></div>
      ${t.custom ? `<div class="line"><label style="width:70px" class="dim">适配器文件</label><input id="add-yaml" type="text" value="${esc(A.yaml || t.yaml)}" aria-label="适配器文件（YAML）"><button>选择…</button></div><div class="dim" style="font-size:11.5px;margin:0 0 4px 78px">声明式 YAML：用 JSONPath 映射 时间戳 / 角色 / 文本 / 工具名 / 工具参数 / usage 等字段，无需写代码。</div>` : ''}
      <div class="line"><button id="add-test">测试扫描</button><button id="add-ok" class="pri" ${tt && tt.ok ? '' : 'disabled'}>添加</button><button id="add-no">取消</button></div>
      ${tt ? `<div class="testr ${tt.ok ? '' : 'bad'}"><div class="num">${tt.ok ? '✓' : '✕'} ${esc(tt.msg)}</div>${tt.ok ? `<div style="margin-top:4px">${capsHtml(t, false)}</div>` : ''}${tt.warn ? `<div class="dim" style="font-size:11.5px;margin-top:4px">⚠ ${esc(tt.warn)}</div>` : ''}</div>` : ''}</div>`;
  }
  function testScan() {
    const A = S.adding, t = TL[A.tool];
    A.test = t.custom
      ? { ok: true, msg: '找到 5 个文件 · 识别 3 个会话 · 41 轮。字段映射：timestamp ✓ role ✓ tool_name ✓ usage ✗（未映射，将没有 token）', warn: '1 行无法解析（第 17 行缺少 $.ts），已跳过' }
      : { ok: true, msg: `找到 ${t.id === 'cx' ? 21 : 9} 个文件 · 识别 ${t.id === 'cx' ? 14 : 6} 个会话 · ${t.id === 'cx' ? 87 : 52} 轮`, warn: '' };
  }
  const thrPreview = (d) => d.empty ? '' : `按当前阈值，「${cur().name}」有 ${d.idleN} 段空闲，共 ${fmt(d.idle, { zero: '0m' })}；活跃 ${fmt(d.act)}，等我 ${fmt(d.wait)}`;

  /* ---------- 空 / 错误状态 ---------- */
  function renderState() {
    if (S.scenario === 'empty') {
      $('#main').innerHTML = `<div class="state"><div class="box"><h2>还没有找到任何 LLM 工具的会话日志</h2>
        <div class="dim">已在默认位置检测以下工具（均未找到）。选择目录即可添加；没列出的工具可用自定义适配器接入。</div>
        <div class="errl">${M.TOOLS.filter((t) => !t.custom).map((t) => `<div class="detrow"><span>${tb(t)} ${esc(t.name)}<br><span class="f">${esc(t.path)}</span></span><span class="e">未找到</span><button data-addtool="${t.id}">选择目录…</button></div>`).join('')}</div>
        <ul><li>仅读取本机文件，不上传任何内容，也不修改原文件</li><li>日志可能在别的磁盘或自定义配置目录下，请手动选择</li></ul>
        <div class="btns"><button class="pri" id="usedef">重新扫描默认位置</button><button id="goset">添加自定义数据源…</button></div></div></div>`;
    } else {
      $('#main').innerHTML = `<div class="state"><div class="box"><h2>解析失败：${nFiles()} 个文件中 3 个无法读取</h2>
        <div class="dim">没有一个需求能完整统计。下面是失败原因（原始文件不会被修改）：</div>
        <div class="errl">${M.errors.map((e) => `<div><span class="f">${tb(TL[e.tool])} ${esc(e.file)} · 第 ${e.line} 行</span><span class="e">${esc(e.reason)}</span></div>`).join('')}</div>
        <div class="btns"><button class="pri" id="retry">重试</button><button id="skip">跳过失败文件并继续</button><button>复制错误信息</button><button id="goset">检查数据目录</button></div></div></div>`;
    }
  }

  /* ---------- 渲染入口 ---------- */
  function render() {
    renderTop();
    const main = $('#main');
    if (S.scenario === 'empty' || S.scenario === 'error') { renderState(); }
    else if (S.view === 'settings') renderSettings();
    else if (S.view === 'dash') renderDash();
    else {
      if (!$('#list')) main.innerHTML = '<aside id="list"></aside><section id="detail"></section>';
      renderList(); renderDetail();
    }
    renderDrawer(); renderToday();
    $('#app').dataset.area = S.area;
    $('#app').dataset.view = S.view;
  }
  function markSeg() {
    $$('.seg').forEach((e) => e.classList.toggle('sel', +e.dataset.k === S.seg));
    const d = derive(cur()), s = d.segs[S.seg];
    if (s && S.tl.sel != null && (S.tl.sel < s.from || S.tl.sel > s.to)) S.tl.sel = s.from;
    renderTimeline();
    $(`.seg[data-k="${S.seg}"]`)?.scrollIntoView({ block: 'nearest' });
  }
  function selectReq(id) { S.proc = null; S.sel = id; S.seg = 0; S.tl.sel = null; S.tl.zoom = 1; S.tl.open = new Set(); S.splitMode = false; S.cut = null; S.sessPick = new Set(); S.renaming = false; render(); $(`.row[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' }); }

  /* ---------- 提示 ---------- */
  let toastT;
  function toast(msg, label, fn) {
    const el = $('#toast'); el.innerHTML = `<span>${esc(msg)}</span>${label ? `<button id="toast-b">${label}</button>` : ''}`; el.classList.add('open');
    S.undo = fn || null; clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('open'), 7000);
  }

  /* ---------- 合并 / 拆分 ---------- */
  const renumber = (r) => { r.turns.sort((a, b) => a.t - b.t); bump(r); };
  function snapshot() { return JSON.stringify(M.reqs); }
  function restore(js) { const a = JSON.parse(js); M.reqs.length = 0; a.forEach((x) => M.reqs.push(x)); cache.clear(); }
  function mergeReqs() {
    const ids = [...S.picked]; if (ids.length < 2) return; const snap = snapshot(), sel0 = S.sel;
    const rs = ids.map((i) => M.reqs.find((r) => r.id === i)).sort((a, b) => (a.turns[0]?.t ?? 9e15) - (b.turns[0]?.t ?? 9e15));
    const t = rs[0]; rs.slice(1).forEach((o) => { t.sessions.push(...o.sessions); t.turns.push(...o.turns); if (o.status === 'active') t.status = 'active'; M.reqs.splice(M.reqs.indexOf(o), 1); });
    renumber(t); S.picked.clear(); S.manage = false; S.sel = t.id; S.seg = 0;
    toast(`已合并 ${rs.length} 个需求 → 「${t.name}」`, '撤销', () => { restore(snap); S.sel = sel0; render(); }); render();
  }
  function splitBySessions() {
    const r = cur(), snap = snapshot(), ids = new Set(S.sessPick); if (!ids.size || ids.size >= r.sessions.length) return;
    const n = { id: r.id + 'x' + Date.now() % 1e5, name: r.name + '（拆出）', status: 'done', sessions: r.sessions.filter((s) => ids.has(s.id)), turns: r.turns.filter((t) => ids.has(t.sid)), warn: null, v: 0 };
    r.sessions = r.sessions.filter((s) => !ids.has(s.id)); r.turns = r.turns.filter((t) => !ids.has(t.sid));
    renumber(r); renumber(n); M.reqs.splice(M.reqs.indexOf(r) + 1, 0, n); S.sessPick.clear(); const old = r.id;
    toast(`已拆出 ${n.sessions.length} 个会话为新需求`, '撤销', () => { restore(snap); S.sel = old; render(); }); selectReq(n.id);
  }
  function splitAtTurn() {
    const r = cur(), snap = snapshot(), c = S.cut; if (c == null || c < 1) return;
    const rest = r.turns.slice(c), sids = new Set(rest.map((t) => t.sid));
    const n = { id: r.id + 'y' + Date.now() % 1e5, name: r.name + '（拆出）', status: r.status, sessions: r.sessions.filter((s) => sids.has(s.id)).map((s) => ({ ...s })), turns: rest, warn: null, v: 0 };
    r.turns = r.turns.slice(0, c); r.status = 'done'; renumber(r); renumber(n);
    M.reqs.splice(M.reqs.indexOf(r) + 1, 0, n); S.splitMode = false; S.cut = null; const old = r.id;
    toast(`已从第 ${c + 1} 轮拆出 ${rest.length} 轮为新需求`, '撤销', () => { restore(snap); S.sel = old; render(); }); selectReq(n.id);
  }
  function commitRename(ok) {
    const r = cur();
    if (ok) { const v = ($('#rn')?.value || '').trim(); if (v && v !== r.name) { const o = r.name; r.name = v; toast(`已改名为「${v}」`, '撤销', () => { r.name = o; render(); }); } }
    S.renaming = false; render();
  }

  /* ---------- 事件 ---------- */
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('#toast-b')) { const f = S.undo; $('#toast').classList.remove('open'); f && f(); return; }
    if (S.todayOpen && !t.closest('#today') && !t.closest('#b-today')) { S.todayOpen = false; renderToday(); renderTop(); }
    if (t.closest('#b-today')) { S.todayOpen = !S.todayOpen; renderToday(); renderTop(); return; }
    if (t.closest('#t-open')) { S.todayOpen = false; renderToday(); renderTop(); return; }
    if (t.closest('#b-set') || t.closest('#goset')) { S.view = S.view === 'settings' && !t.closest('#goset') ? 'main' : 'settings'; if (t.closest('#goset')) S.scenario = 'normal'; render(); return; }
    if (t.closest('#set-back')) { S.view = 'main'; render(); return; }
    if (t.closest('#goadv')) { e.preventDefault(); S.view = 'settings'; render(); $('#advset')?.scrollIntoView({ block: 'start' }); return; }
    if (t.closest('#adv-run')) { S.advRun = { status: 'loading', out: null, err: '' }; renderDash(); const D = dashData(); setTimeout(() => { if (S.view !== 'dash') return; S.advRun = Q.get('fail') === '1' ? { status: 'error', out: null, err: '接口返回 401：API Key 无效或已过期' } : { status: 'done', out: advMock(D), err: '' }; renderDash(); }, 1400); return; }
    if (t.closest('#adv-test')) { const a = S.set.adv; a.test = (a.provider !== 'ollama' && !a.key) ? { ok: false, msg: '✕ 缺少 API Key' } : !a.model ? { ok: false, msg: '✕ 请填写模型名' } : { ok: true, msg: '✓ 连通 · 模型可用 · 延迟 0.8s' }; renderSettings(); return; }
    if (t.closest('#b-dash')) { S.view = S.view === 'dash' ? 'main' : 'dash'; render(); return; }
    const dr = t.closest('[data-drange]'); if (dr) { S.dash.range = dr.dataset.drange; S.advRun = { status: 'idle', out: null, err: '' }; renderDash(); return; }
    const gr = t.closest('[data-goreq]'); if (gr) { e.preventDefault(); S.sel = gr.dataset.goreq; S.seg = 0; S.view = 'main'; render(); return; }
    if (t.closest('#usedef') || t.closest('#pick') || t.closest('#retry')) { toast('原型：此处会触发重新扫描，状态切回「正常」', ''); S.scenario = 'normal'; render(); return; }
    if (t.closest('#skip')) { S.scenario = 'partial'; render(); return; }
    // 过程
    if (t.closest('#b-proc')) { const d0 = derive(cur()); openProc(d0.turns[S.tl.sel ?? 0]?.sid, S.tl.sel ?? 0); return; }
    const ps = t.closest('[data-proc-sid]'); if (ps) { openProc(ps.dataset.procSid); return; }
    if (t.closest('#pr-back')) { S.proc = null; render(); return; }
    const pt = t.closest('[data-ptn]'); if (pt) { S.proc.turn = +pt.dataset.ptn; S.proc.sp = 0; renderProc(); return; }
    const pp = t.closest('[data-psp]'); if (pp) { S.proc.sp = +pp.dataset.psp; renderProc(); return; }
    if (t.closest('#dr-proc')) { const d0 = derive(cur()), sg = d0.segs[S.drawer.seg]; openProc(sg.turns[0].sid, S.drawer.turn ?? sg.from); return; }
    // 抽屉
    if (t.closest('#dr-x')) return closeDrawer();
    if (t.closest('#dr-prev')) return openDrawer(S.drawer.seg - 1);
    if (t.closest('#dr-next')) return openDrawer(S.drawer.seg + 1);
    if (t.closest('#dr-all')) { S.drawer.all = true; return renderDrawer(); }
    // 列表
    const row = t.closest('.row');
    if (row) {
      const id = row.dataset.id;
      if (S.manage) { S.picked.has(id) ? S.picked.delete(id) : S.picked.add(id); renderList(); return; }
      S.area = 'list'; if (id !== S.sel) selectReq(id); else render(); return;
    }
    if (t.closest('#b-manage')) { S.manage = !S.manage; S.picked.clear(); renderList(); return; }
    if (t.closest('#b-merge')) return mergeReqs();
    // 详情
    if (t.closest('#b-rename')) { S.renaming = true; renderDetail(); return; }
    if (t.closest('#rn-ok')) return commitRename(true);
    if (t.closest('#rn-no')) return commitRename(false);
    if (t.closest('#b-split')) { S.splitMode = !S.splitMode; S.cut = null; renderDetail(); return; }
    if (t.closest('#sp-no')) { S.splitMode = false; S.cut = null; renderDetail(); return; }
    if (t.closest('#sp-ok')) return splitAtTurn();
    if (t.closest('#b-split-s')) return splitBySessions();
    const sg = t.closest('.seg'); if (sg) { S.area = 'detail'; openDrawer(+sg.dataset.k); $('#app').dataset.area = 'detail'; return; }
    const ck = t.closest('[data-sid]'); if (ck) { const id = ck.dataset.sid; ck.checked ? S.sessPick.add(id) : S.sessPick.delete(id); renderDetail(); return; }
    // 时间轴
    const tm = t.closest('[data-tlm]'); if (tm) { S.tl.mode = tm.dataset.tlm; renderTlBar(); renderTimeline(); return; }
    const z = t.closest('[data-z]'); if (z) { const v = z.dataset.z; setZoom(v === 'fit' ? 1 : v === 'in' ? S.tl.zoom * 1.6 : S.tl.zoom / 1.6); return; }
    const idl = t.closest('[data-idle]');
    if (idl) { const id = idl.dataset.idle; if (S.tl.fold) { S.tl.open.has(id) ? S.tl.open.delete(id) : S.tl.open.add(id); renderTimeline(); } return; }
    const cell = t.closest('.cell');
    if (cell) {
      const a = +cell.dataset.a; const d = derive(cur()); const sg2 = d.segs.find((s) => a >= s.from && a <= s.to);
      S.area = 'detail'; $('#app').dataset.area = 'detail';
      if (S.splitMode) { S.cut = a; renderSplit(); renderTimeline(); return; }
      S.tl.sel = a; openDrawer(sg2.k, a); return;
    }
    // 设置
    const rm = t.closest('[data-rmsrc]'); if (rm) { S.set.src.splice(+rm.dataset.rmsrc, 1); renderSettings(); renderTop(); return; }
    const so = t.closest('[data-son]'); if (so) { S.set.src[+so.dataset.son].on = so.checked; renderSettings(); renderTop(); return; }
    if (t.closest('#addsrc')) { S.adding = { tool: 'cx', path: '', yaml: '', test: null }; renderSettings(); return; }
    if (t.closest('#add-no')) { S.adding = null; renderSettings(); return; }
    if (t.closest('#add-test')) { testScan(); renderSettings(); return; }
    if (t.closest('#add-ok')) { const A = S.adding, tl = TL[A.tool]; S.set.src.push({ tool: A.tool, path: A.path || tl.path, files: A.tool === 'cx' ? 21 : 9, ok: true, on: true }); S.adding = null; renderSettings(); renderTop(); toast('已添加数据源：' + tl.name, ''); return; }
    const at = t.closest('[data-addtool]'); if (at) { S.set.src.push({ tool: at.dataset.addtool, path: TL[at.dataset.addtool].path, files: 12, ok: true, on: true }); S.scenario = 'normal'; render(); toast('原型：已添加并扫描', ''); return; }
    if (t.closest('#rescan')) { S.set.src.forEach((x) => { x.ok = true; }); renderSettings(); return; }
    if (t.closest('#rules-ok')) { S.set.rulesMsg = '✓ 6 个阶段 · 23 条规则 · 无冲突'; renderSettings(); return; }
  });
  document.addEventListener('dblclick', (e) => { if (e.target.closest('#nm')) { S.renaming = true; renderDetail(); } });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'scn') { S.scenario = t.value; S.view = 'main'; render(); }
    else if (t.id === 'theme') { S.theme = t.value; applyTheme(); }
    else if (t.id === 'range') { S.range = t.value; renderList(); }
    else if (t.id === 'toolf') { S.toolF = t.value; renderList(); }
    else if (t.id === 'sort') { S.sort = t.value; renderList(); }
    else if (t.id === 'fold') { S.tl.fold = t.checked; renderTlBar(); renderTimeline(); }
    else if (t.id === 'dr-phase') setPhase(t.value);
    else if (t.id === 'pr-src') { S.src = t.value; renderProc(); }
    else if (t.id === 'pr-sess') openProc(t.value);
    else if (t.id === 'win') S.set.win = +t.value;
    else if (t.dataset.adv) { const a = S.set.adv, k = t.dataset.adv; a[k] = t.value; a.test = null; if (k === 'provider') { a.base = ADV_PROV[t.value][1]; a.model = ADV_PROV[t.value][2]; } S.advRun = { status: 'idle', out: null, err: '' }; renderSettings(); }
    else if (t.id === 'add-tool') { S.adding = { tool: t.value, path: '', yaml: '', test: null }; renderSettings(); }
    else if (t.id === 'add-path') { S.adding.path = t.value; S.adding.test = null; }
    else if (t.id === 'add-yaml') { S.adding.yaml = t.value; S.adding.test = null; }
    else if (t.id === 'rules') { S.set.rules = t.value; S.set.rulesMsg = ''; }
  });
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'q') { S.q = t.value; S.qFocus = true; renderList(); S.qFocus = false; }
    else if (t.id === 'thr') { S.set.thr = +t.value; $('#thrv').textContent = S.set.thr + ' 分钟'; $('#thrp').textContent = thrPreview(derive(cur())); renderTop(); }
  });
  document.addEventListener('focusin', (e) => { if (e.target.id === 'q') S.qFocus = false; });

  // 时间轴悬停、小地图、滚轮
  const tip = $('#tip');
  document.addEventListener('mousemove', (e) => {
    const c = e.target.closest?.('.cell');
    if (!c || !S.tl.L) { tip.style.display = 'none'; return; }
    const a = +c.dataset.a, b = +c.dataset.b, d = derive(cur()), t = d.turns[a];
    let h;
    if (b > a) { const ts = d.turns.slice(a, b + 1), du = ts.reduce((x, y) => x + y.dur, 0), w = ts.reduce((x, y) => x + y.w, 0); h = `<div class="k">#${a + 1}–${b + 1} · ${hm(t.t)}–${hm(ts[ts.length - 1].end)}</div><b>${PHN[t.phase].name}</b> ${ts.length} 轮 · ${fmt(du + w)}<br><span class="k">放大后可看单轮摘要</span>`; }
    else h = `<div class="k">#${a + 1} · ${hm(t.t)} · AI ${fmt(t.dur, { s: true })}${t.kind === 'wait' ? ' · 等我 ' + fmt(t.w, { s: true }) : ''}</div><b>${PHN[t.phase].key} ${PHN[t.phase].name}</b>：${esc(t.summary)}<br><span class="k">我：${esc(t.prompt)}</span>`;
    tip.innerHTML = h; tip.style.display = 'block';
    const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8), y = e.clientY + 18 + tip.offsetHeight > innerHeight ? e.clientY - tip.offsetHeight - 10 : e.clientY + 18;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
    $$('.seg').forEach((s) => s.classList.toggle('hl', +s.dataset.k === d.segs.find((g) => a >= g.from && a <= g.to).k && +s.dataset.k !== S.seg));
  });
  document.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  document.addEventListener('mouseover', (e) => {
    const s = e.target.closest?.('.seg'); $$('.cell.hl').forEach((c) => c.classList.remove('hl'));
    if (!s) return; const d = derive(cur()), g = d.segs[+s.dataset.k]; if (!g) return;
    $$('.cell').forEach((c) => { if (+c.dataset.a >= g.from && +c.dataset.b <= g.to && !c.classList.contains('sel')) c.classList.add('hl'); });
  });
  let drag = null;
  document.addEventListener('pointerdown', (e) => {
    const mini = e.target.closest?.('#tlmini'); if (!mini) return;
    const sc = $('#tlscroll'), vp = $('#tlvp'), rect = mini.getBoundingClientRect(), k = sc.clientWidth / sc.scrollWidth;
    const x = e.clientX - rect.left; const onVp = e.target === vp;
    drag = { off: onVp ? x - sc.scrollLeft * k : sc.clientWidth * k / 2, k, rect };
    if (!onVp) sc.scrollLeft = (x - drag.off) / k;
    mini.setPointerCapture(e.pointerId); e.preventDefault();
  });
  document.addEventListener('pointermove', (e) => { if (!drag) return; const sc = $('#tlscroll'); sc.scrollLeft = (e.clientX - drag.rect.left - drag.off) / drag.k; });
  document.addEventListener('pointerup', () => { drag = null; });
  document.addEventListener('scroll', (e) => { if (e.target.id === 'tlscroll') updateVp(); }, true);
  document.addEventListener('wheel', (e) => {
    const sc = e.target.closest?.('#tlscroll'); if (!sc) return;
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); setZoom(S.tl.zoom * (e.deltaY < 0 ? 1.25 : 0.8), e.clientX - sc.getBoundingClientRect().left); }
    else if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && sc.scrollWidth > sc.clientWidth) { sc.scrollLeft += e.deltaY; e.preventDefault(); }
  }, { passive: false });
  let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if ($('#tlbody')) renderTimeline(); }, 80); });

  /* ---------- 键盘 ---------- */
  document.addEventListener('keydown', (e) => {
    const tag = e.target.tagName, typing = /INPUT|TEXTAREA|SELECT/.test(tag) && e.target.type !== 'checkbox' && e.target.type !== 'range';
    if (e.key === 'Escape') {
      if (S.drawer) { closeDrawer(); return; }
      if (S.todayOpen) { S.todayOpen = false; renderToday(); renderTop(); return; }
      if (S.proc) { S.proc = null; render(); return; }
      if (S.renaming) { commitRename(false); return; }
      if (S.splitMode) { S.splitMode = false; S.cut = null; renderDetail(); return; }
      if (S.view === 'settings' || S.view === 'dash') { S.view = 'main'; render(); return; }
      if (typing) { e.target.blur(); return; }
      if (S.manage) { S.manage = false; S.picked.clear(); renderList(); return; }
      if (S.area === 'detail') { S.area = 'list'; $('#app').dataset.area = 'list'; return; }
      return;
    }
    if (S.renaming && e.key === 'Enter') { commitRename(true); return; }
    if (typing) return;
    if (e.key === '/' && S.view === 'main') { e.preventDefault(); $('#q')?.focus(); return; }
    if (S.view !== 'main' || S.scenario === 'empty' || S.scenario === 'error') return;
    const d = derive(cur());
    if (S.drawer) {
      if (e.key === '[' && S.drawer.seg > 0) openDrawer(S.drawer.seg - 1);
      else if (e.key === ']' && S.drawer.seg < d.segs.length - 1) openDrawer(S.drawer.seg + 1);
      else if (/^[1-6]$/.test(e.key)) setPhase(PH[+e.key - 1].id);
      return;
    }
    if (S.proc) { procKeys(e, d); return; }
    if (e.key === 'F2') { e.preventDefault(); S.renaming = true; renderDetail(); return; }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (d.empty) return; e.preventDefault();
      const i = S.tl.sel == null ? d.segs[S.seg].from : S.tl.sel + (e.key === 'ArrowRight' ? 1 : -1);
      S.tl.sel = Math.max(0, Math.min(d.turns.length - 1, i)); S.area = 'detail'; $('#app').dataset.area = 'detail';
      S.seg = d.segs.find((s) => S.tl.sel >= s.from && S.tl.sel <= s.to).k; markSeg(); revealTurn(S.tl.sel); return;
    }
    if (e.key === '+' || e.key === '=') { setZoom(S.tl.zoom * 1.6); return; }
    if (e.key === '-') { setZoom(S.tl.zoom / 1.6); return; }
    if (e.key === '0') { setZoom(1); return; }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault(); const dn = e.key === 'ArrowDown' ? 1 : -1;
      if (S.area === 'list') {
        const vis = visible(); let i = vis.findIndex((r) => r.id === S.sel); i = Math.max(0, Math.min(vis.length - 1, i + dn));
        if (vis[i] && vis[i].id !== S.sel) selectReq(vis[i].id);
      } else if (!d.empty) {
        S.seg = Math.max(0, Math.min(d.segs.length - 1, S.seg + dn)); S.tl.sel = d.segs[S.seg].from; markSeg(); revealTurn(S.tl.sel);
      }
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (S.area === 'list') { if (d.empty) return; S.area = 'detail'; S.seg = S.seg || 0; $('#app').dataset.area = 'detail'; markSeg(); $('#detail').scrollTo({ top: $('.segs')?.offsetTop - 120, behavior: 'smooth' }); }
      else if (!d.empty) openDrawer(S.seg, S.tl.sel);
    }
  });

  /* ---------- 启动 ---------- */
  applyTheme(); render();
  if (Q.get('drawer') === '1') { const d = derive(cur()); if (d.segs.length) openDrawer(Math.min(2, d.segs.length - 1)); }
  if (Q.get('proc') === '1') { const d = derive(cur()); const ti = Math.min(+Q.get('turn') || 3, d.turns.length - 1); if (d.turns.length) openProc(d.turns[ti].sid, ti); }
  if (Q.get('zoom')) setZoom(+Q.get('zoom'));
  if (Q.get('split') === '1') { S.splitMode = true; S.cut = 20; renderDetail(); }
  if (Q.get('manage') === '1') { S.manage = true; S.picked = new Set(['r1', 'r6']); renderList(); }
  if (Q.get('rename') === '1') { S.renaming = true; renderDetail(); }
  window.__S = S;
})();
