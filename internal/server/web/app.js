"use strict";
// 所有来自日志的文本一律经 esc() 转义后再进 innerHTML，避免日志内容注入。
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const PH = {
  P: { n: "聊方案", c: "plan", i: "plan" }, R: { n: "调研", c: "research", i: "research" },
  C: { n: "写代码", c: "code", i: "code" }, F: { n: "改代码", c: "fix", i: "fix" },
  T: { n: "测试", c: "test", i: "test" }, O: { n: "其他", c: "other", i: "other" },
  W: { n: "等我", c: "wait", i: "wait" },
};
const PHASES = ["P", "R", "C", "F", "T", "O"];
const TOOLNAME = { "claude-code": "cc", codex: "codex", pi: "pi", omp: "omp", cursor: "cursor" };
const tn = t => TOOLNAME[t] || t;
const icon = k => { const x = window.ICONS[k]; return x ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${x.inner}</svg>` : ""; };
const DASH = '<span class="dash">–</span>';
const plain = h => String(h).replace(/<[^>]+>/g, "");

/* 时长：≥1h 显示 "6h 42m"，≥1m 显示 "24m"（精确档需要秒时用 durS）。 */
function dur(s) {
  if (s == null) return DASH;
  const m = Math.round(s / 60);
  if (s < 60) return Math.round(s) + "s";
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}
function durS(s) {
  if (s == null) return DASH;
  s = Math.round(s);
  if (s < 60) return s + "s";
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor(s % 3600 / 60)).padStart(2, "0")}m`;
}
const pad = n => String(n).padStart(2, "0");
const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const WD = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
function when(t) {
  const d = new Date(t), now = new Date();
  const dd = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5);
  if (dd === 0) return "今天 " + hm(d);
  if (dd === 1) return "昨天 " + hm(d);
  if (dd > 1 && dd < 7) return WD[d.getDay()] + " " + hm(d);
  return `${d.getMonth() + 1}/${d.getDate()} ${hm(d)}`;
}
const shortPath = (p, home) => home && p.startsWith(home) ? "~" + p.slice(home.length) : p;

async function api(path, opt = {}) {
  const r = await fetch(path, { ...opt, headers: { "X-Timetrace": "1", "Content-Type": "application/json" } });
  if (!r.ok) throw new Error((await r.text()).trim() || r.statusText);
  return r.json();
}
const post = (path, body, method = "POST") => api(path, { method, body: JSON.stringify(body) });

/* 阶段块：颜色 + 纹理 + 字母 + 图标四重编码。宽 <6px 去纹理；≥20px 显示字母。 */
const seg = (p, style, tip = "") => `<div class="seg ph-${PH[p].c}" style="${style}" title="${esc(PH[p].n + " " + p + tip)}"><span class="l">${p}</span></div>`;
// 先统一读宽度、再统一改 class，避免每个块都触发一次强制重排（行数多时差别很大）。
function layoutSegs(root) {
  const segs = [...root.querySelectorAll(".seg")];
  const ws = segs.map(s => s.offsetWidth);
  segs.forEach((s, i) => { s.classList.toggle("thin", ws[i] < 6); s.classList.toggle("wide", ws[i] >= 20); });
}
/* 阶段构成条：只含 AI 时间（等我单独列）。 */
function bar(byPhase, cls = "") {
  const tot = PHASES.reduce((a, p) => a + (byPhase[p] || 0), 0);
  if (!tot) return `<div class="bar ${cls}"></div>`;
  return `<div class="bar ${cls}" role="img" aria-label="阶段构成">` + PHASES.filter(p => byPhase[p] > 0).map(p => seg(p, `flex:${byPhase[p]} 1 0`, " " + plain(dur(byPhase[p])))).join("") + `</div>`;
}
const legend = (right = "") => `<div class="lg">` + PHASES.map(p => `<span class="i"><span class="sw ph-${PH[p].c}"></span><span class="ic">${icon(PH[p].i)}</span>${p} ${PH[p].n}</span>`).join("") + (right ? `<span class="r">${right}</span>` : "") + `</div>`;

const main = $("#main"), dlg = $("#dlg");
let timer;
const state = { range: sessionStorage.getItem("range") || "week", irange: sessionStorage.getItem("irange") || "week", sel: null, hl: false };

const routes = [[/^#\/s\/([^/]+)(?:\/(\d+))?$/, sessionPage], [/^#\/r\/(.+)$/, detail], [/^#\/today$/, today], [/^#\/insights$/, insights], [/^#\/settings$/, settings], [/.*/, list]];
let ready = false;
async function route(quiet) {
  clearInterval(timer); clearTimeout(timer);
  if (!ready) {
    const st = await api("/api/status").catch(() => null);
    if (!st || !st.index.ready) return boot(st);
    ready = true;
  }
  const h = location.hash || "#/";
  document.querySelectorAll("#nav a").forEach(a => a.classList.toggle("on", a.getAttribute("href") === h || (a.dataset.p === "list" && h.startsWith("#/r/")) || (a.dataset.p === "list" && h === "#/")));
  if (!quiet) main.innerHTML = '<div class="empty">加载中…</div>';
  for (const [re, fn] of routes) {
    const m = h.match(re);
    if (m) {
      try { await fn(...m.slice(1).map(x => x === undefined ? x : decodeURIComponent(x))); layoutSegs(main); idxLine(); }
      catch (e) { main.innerHTML = `<div class="warn" style="background:var(--bad-bg);border-color:var(--bad-line);color:var(--bad-fg)">加载失败：${esc(e.message)}</div>`; }
      return;
    }
  }
}
addEventListener("hashchange", () => { state.sel = null; route(); });

/* ---------- 首次建立索引 ---------- */
function boot(st) {
  const ix = st ? st.index : { done: 0, total: 0 };
  const pct = ix.total ? Math.round(ix.done / ix.total * 100) : 0;
  main.innerHTML = `<div class="boot card"><h1>正在建立索引</h1><div class="sub">首次使用会把会话日志全部扫描一遍并建立索引，之后打开各个页面都直接读索引。日志有新增或改动时，后台只增量处理变化的文件。</div>
    <div class="prog"><div style="width:${pct}%"></div></div><div class="sub">${ix.total ? `已解析 ${ix.done} / ${ix.total} 个文件` : "正在查找日志文件…"}</div>
    <h3 style="margin-top:16px">将读取的目录</h3><ul>${(st && st.dirs.length ? st.dirs : ["（还没有启用的数据源）"]).map(d => `<li><code>${esc(d)}</code></li>`).join("")}</ul>
    <div class="sub">只读打开，不修改、不删除；数据不离开本机。</div></div>`;
  timer = setTimeout(() => route(), 400);
}
async function idxLine() {
  try {
    const st = await api("/api/status");
    const t = st.index.scanAt ? new Date(st.index.scanAt) : null;
    $("#idx").textContent = `已索引 ${st.index.sessions} 个会话${t ? " · " + hm(t) + " 更新" : ""}`;
  } catch { }
}
setInterval(idxLine, 15000);
addEventListener("resize", () => layoutSegs(main));

const RANGES = [["today", "今天"], ["week", "本周"], ["month", "本月"], ["all", "全部"]];
const RNAME = { today: "今天", week: "本周", month: "本月", all: "全部" };
function rangeCtl(cur, opts) {
  return `<div class="seg-ctl" role="group" aria-label="时间范围">` + RANGES.filter(r => opts.includes(r[0])).map(([k, n]) => `<button data-r="${k}" class="${k === cur ? "on" : ""}">${n}</button>`).join("") + `</div>`;
}

/* ---------- 需求列表 ---------- */
async function list() {
  const d = await api(`/api/requirements?range=${state.range}`);
  const q = (sessionStorage.getItem("q") || "").toLowerCase();
  const rows = d.requirements.filter(r => !q || (r.name + " " + r.cwd).toLowerCase().includes(q));
  let h = `<div class="top"><h1>需求</h1><span class="sub">共 ${d.requirements.length} 个 · ${RNAME[d.range]}</span><span class="grow"></span>
    <input id="q" class="search" type="search" placeholder="搜索需求或项目路径" value="${esc(sessionStorage.getItem("q") || "")}" aria-label="搜索">${rangeCtl(state.range, ["today", "week", "month", "all"])}</div>`;
  if (d.parseErrors.length) {
    const e = d.parseErrors[0];
    h += `<div class="warn"><b>${d.parseErrors.length} 个文件解析失败</b><span>${esc(e.File.split(/[\\/]/).pop())} · ${esc(e.Reason)}，其余文件不受影响。</span><a href="#/settings">查看原因</a></div>`;
  }
  h += legend("「活跃」= AI 工作 + 等我；空闲不计入");
  if (!rows.length) {
    h += `<div class="empty"><b>${d.requirements.length ? "没有匹配的需求" : (d.sources ? "这个时间范围内没有记录" : "未发现日志")}</b><br>${d.sources ? "换个时间范围试试，或到" : "还没有启用任何数据源，到"}<a href="#/settings">数据源与设置</a>检查日志目录。</div>`;
  } else {
    h += `<div class="tbl"><div class="tr th"><span>需求</span><span>阶段构成（AI 工作时间）</span><span class="num">活跃</span><span class="num">其中等我</span><span>工具</span><span class="last">最近</span></div>`;
    for (const r of rows) {
      const noTime = r.turns === 0 && r.coarse > 0;
      h += `<a class="tr" href="#/r/${encodeURIComponent(r.key)}"><span class="nm"><b>${esc(r.name)}</b><div>${esc(shortPath(r.cwd, d.home))} · ${r.sessions} 个会话${noTime ? ` · 共 ${r.coarse} 次` : ` · ${r.turns} 轮`}${r.running ? " · 当前一轮计到现在" : ""}</div></span>
        <span>${noTime ? `<div class="bar placeholder">耗时不可得 · 仅显示次数和跨度</div>` : bar(r.byPhase)}</span>
        <span class="num b">${noTime ? DASH : dur(r.active)}</span><span class="num">${noTime ? DASH : dur(r.wait)}</span>
        <span>${r.tools.map(t => `<span class="tag">${esc(tn(t))}</span>`).join("")}${r.running ? '<span class="pill run">运行中</span>' : ""}${r.coarse ? '<span class="pill coarse">粗略</span>' : ""}</span>
        <span class="last">${r.running ? "进行中" : when(r.end)}</span></a>`;
    }
    h += `</div>`;
  }
  h += `<div class="note"><span>粗略档需求（如 Cursor 转录）不计入汇总数字。</span><span>点一行进入明细；合并、拆分、改名都在明细里。</span></div>`;
  main.innerHTML = h;
  main.querySelectorAll("[data-r]").forEach(b => b.onclick = () => { state.range = b.dataset.r; sessionStorage.setItem("range", state.range); route(true); });
  $("#q").oninput = e => { sessionStorage.setItem("q", e.target.value); clearTimeout(list.t); list.t = setTimeout(() => route(true).then(() => { const i = $("#q"); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }), 200); };
}

/* ---------- 对话框 ---------- */
function modal(html, onOk, okText = "确定") {
  dlg.innerHTML = html + `<div class="act"><button id="dc">取消</button><button id="dk" class="primary">${okText}</button></div>`;
  $("#dc").onclick = () => dlg.close();
  $("#dk").onclick = async () => { try { await onOk(); dlg.close(); } catch (e) { alert(e.message); } };
  dlg.showModal();
}

/* ---------- 需求明细 ---------- */
async function detail(key) {
  const d = await api("/api/requirements/" + encodeURIComponent(key));
  const toolSum = Object.entries(d.toolCount).map(([t, n]) => `${tn(t)} ×${n}`).join("、");
  const ss = d.sessionList;
  const aiTot = PHASES.reduce((a, p) => a + (d.byPhase[p] || 0), 0);
  const avg = d.turns ? d.active / d.turns : null;
  let h = `<div class="sub"><a href="#/">需求</a> &nbsp;/&nbsp; ${esc(shortPath(d.cwd, d.home))}</div>
  <div class="top"><h1>${esc(d.name)}</h1><span class="grow"></span><button id="mg">合并</button><button id="sp">拆分</button><button id="rn">改名</button></div>
  <div class="sub">${ss.length} 个会话（${esc(toolSum)}）· ${when(d.start)} 至 ${when(d.end)} · 空闲 ${dur(d.idle)} 不计入</div>
  <div class="cards">
    <div class="metric"><div class="t">活跃时间</div><div class="v">${dur(d.active)}</div><div class="d">AI + 等我</div></div>
    <div class="metric"><div class="t">AI 工作</div><div class="v">${dur(d.ai)}</div><div class="d">含工具与子 agent</div></div>
    <div class="metric"><div class="t">等我</div><div class="v">${dur(d.wait)}</div><div class="d">${d.active ? Math.round(d.wait / d.active * 100) + "% 的活跃时间" : DASH}</div></div>
    <div class="metric"><div class="t">轮数</div><div class="v">${d.turns}</div><div class="d">${avg == null ? DASH : "平均 " + durS(avg) + " / 轮"}</div></div>
    <div class="metric ${d.longTurns ? "click" : ""}" id="lg"><div class="t">超过 10 分钟的轮</div><div class="v">${d.longTurns}</div><div class="d">${d.longTurns ? "点开看是哪几轮" : "没有"}</div></div></div>
  ${d.coarse ? `<div class="warn">有 ${d.coarse} 个会话是粗略档（只有起止时间）：只显示次数和跨度，耗时显示「–」，不计入上面的汇总。</div>` : ""}
  <div class="cols"><div class="stack">
    <div class="card"><h3>阶段分布 <small>只含 AI 工作时间 · 阶段由规则判定，可手动改</small></h3><div style="height:10px"></div>${bar(d.byPhase, "tall")}
      <div class="pl">${PHASES.map(p => `<div><span class="n"><span class="sw ph-${PH[p].c}"></span>${PH[p].n}</span><b>${d.byPhase[p] ? dur(d.byPhase[p]) + " · " + Math.round(d.byPhase[p] / aiTot * 100) + "%" : DASH}</b></div>`).join("")}</div></div>
    <div class="card"><h3>时间轴 <small>按会话，一格是一轮；空闲已折叠为虚线框</small></h3>`;
  for (const s of ss) {
    const coarse = s.precision !== "exact";
    h += `<div class="tlrow"><div class="lab"><a href="#/s/${encodeURIComponent(s.id)}" title="查看这个会话的完整对话"><b>${esc(tn(s.tool))}</b><span>${when(s.start)} · ${coarse ? DASH : dur(s.active)}</span><div class="go">查看对话 →</div></a></div>`;
    h += coarse ? `<div class="bar placeholder">粗略档：仅显示起止跨度</div>` : timeline(s) ;
    h += `</div>`;
  }
  h += `<div class="sub" style="margin-top:12px">黄色细条是「等我」；黑框是当前在右侧查看的一轮。同一时段的并发会话各算各的，允许重叠。</div></div></div>
  <div class="card panel" id="pn"></div></div>`;
  main.innerHTML = h;
  renderPanel(null);
  main.querySelectorAll(".blk").forEach(b => b.onclick = () => openTurn(b.dataset.sid, +b.dataset.i));
  if (state.sel) { const b = $(`.blk[data-sid="${CSS.escape(state.sel.sid)}"][data-i="${state.sel.i}"]`); if (b) openTurn(state.sel.sid, state.sel.i); }
  const lg = $("#lg"); if (lg && d.longTurns) lg.onclick = () => { main.querySelectorAll(".blk.long").forEach(b => b.classList.toggle("hl")); const f = $(".blk.long"); if (f) f.scrollIntoView({ block: "center" }); };
  $("#rn").onclick = () => modal(`<h3>改名</h3><input id="nm" type="text" value="${esc(d.name)}" aria-label="需求名称"><div class="sub">留空恢复默认名称。人工修改会保留。</div>`, async () => { await post("/api/overrides", { op: "rename", key: d.key, name: $("#nm").value }); route(true); });
  $("#mg").onclick = () => {
    if (!d.siblings.length) return modal(`<h3>合并</h3><div>没有其他需求可以合并。</div>`, async () => { });
    modal(`<h3>合并</h3><div class="sub">把另一个需求的会话并入「${esc(d.name)}」，可跨目录。</div><select id="ms">${d.siblings.map(x => `<option value="${esc(x.key)}">${esc(x.name)} · ${esc(shortPath(x.cwd, d.home))}</option>`).join("")}</select>`,
      async () => { await post("/api/overrides", { op: "merge", sids: [d.key, $("#ms").value] }); route(true); }, "合并");
  };
  $("#sp").onclick = () => {
    if (ss.length < 2) return modal(`<h3>拆分</h3><div>只有一个会话，无法拆分。</div>`, async () => { });
    modal(`<h3>拆分</h3><div class="sub">从所选会话起（含之后的会话）另起一个需求。</div><select id="ps">${ss.slice(1).map(x => `<option value="${esc(x.id)}">${esc(tn(x.tool))} · ${when(x.start)}</option>`).join("")}</select><div class="sub"><a href="#" id="rs">撤销本需求相关的合并 / 拆分，恢复自动聚合</a></div>`,
      async () => { await post("/api/overrides", { op: "split", sid: $("#ps").value }); location.hash = "#/"; }, "拆分");
    $("#rs").onclick = async e => { e.preventDefault(); for (const x of ss) await post("/api/overrides", { op: "reset", sid: x.id }); dlg.close(); route(true); };
  };
}
function timeline(s, width) {
  if (!s.turns.length) return '<div class="dash">没有可展示的轮。</div>';
  const W = width || Math.max(380, main.clientWidth - 360 - 190 - 80);
  const idleN = s.turns.filter(t => t.idle > 0).length, gaps = s.turns.length * 2;
  const tot = s.turns.reduce((a, t) => a + t.ai + t.wait, 0) || 1, avail = Math.max(60, W - idleN * 21 - gaps);
  let h = `<div class="tl" role="list">`;
  for (const t of s.turns) {
    const aiW = Math.max(3, t.ai / tot * avail), wW = t.wait > 0 ? Math.max(3, t.wait / tot * avail) : 0;
    const sel = state.sel && state.sel.sid === s.id && state.sel.i === t.i ? " sel" : "";
    h += `<button class="blk${t.long ? " long" : ""}${sel}" role="listitem" style="width:${aiW + wW}px" data-sid="${esc(s.id)}" data-i="${t.i}" aria-label="第 ${t.i + 1} 轮 ${PH[t.phase].n} ${Math.round(t.ai)} 秒">` +
      seg(t.phase, `width:${aiW}px`, " · 第 " + (t.i + 1) + " 轮 " + Math.round(t.ai) + "s") + (wW ? seg("W", `width:${wW}px`, " " + Math.round(t.wait) + "s") : "") + `</button>`;
    if (t.idle > 0) h += `<div class="idle" title="空闲 ${plain(dur(t.idle))}（不计入）">${icon("idle")}</div>`;
  }
  return h + "</div>";
}

/* ---------- 过程面板 ---------- */
function renderPanel(t) {
  const pn = $("#pn"); if (!pn) return;
  if (!t) { pn.innerHTML = `<div class="bd"><div class="empty" style="border:0">点时间轴上的一格，在这里查看这一轮的消息和过程。</div></div>`; return; }
  const ph = PH[t.phase];
  const items = t.items.filter(i => i.kind !== "user");
  const user = t.items.find(i => i.kind === "user");
  const KIND = { llm: "llm", tool: "tool", agent: "agent" };
  pn.innerHTML = `<div class="hd"><div class="row1"><b>第 ${t.i + 1} 轮</b><span class="badge-ph ph-${ph.c}">${t.phase} ${ph.n}</span></div>
    <div class="sub">${when(t.start)} · ${esc(tn(t.tool))} · ${durS(t.ai)} · ${t.precision === "exact" ? "精确" : "粗略"}${t.branch ? " · " + esc(t.branch) : ""}</div></div>
    <div class="bd"><div class="um"><div class="k">用户消息</div><div>${esc(user ? user.text : "")}</div></div>
    <div class="sp-h"><span>这一轮的过程</span><span>共 ${items.length} 段</span></div>` +
    items.map(it => {
      const llm = it.kind === "llm";
      const title = llm ? "LLM 思考" : it.kind === "agent" ? "子 agent · " + it.text : it.text;
      const sub = llm ? (it.text || "") : it.arg;
      const meta = llm ? `${it.model ? esc(it.model) : "模型 –"} · ${it.tokIn || it.tokOut ? `入 ${it.tokIn} / 出 ${it.tokOut}` : "token –"}` : "";
      return `<div class="span" tabindex="0" title="点击展开"><span class="ic">${icon(KIND[it.kind] || "tool")}</span><div><div class="t">${esc(title)}</div><div class="s">${esc(sub) || DASH}</div>${meta ? `<div class="s">${meta}</div>` : ""}</div><span class="d">${durS(it.dur)}</span></div>`;
    }).join("") +
    `<div class="phase-edit"><span>阶段改为：</span><select id="ps" aria-label="改阶段"><option value="">（自动判定）${t.phase} ${ph.n}</option>${PHASES.map(p => `<option value="${p}">${p} ${PH[p].n}</option>`).join("")}</select><span class="r">手动改会保留</span></div>
    <div class="sub">工具执行与等待你批准的时间都计入 AI 时间，因为日志里分不出来。</div>
    <p><a href="#/s/${encodeURIComponent(t.sid)}/${t.i}">查看完整对话 →</a></p></div>`;
  pn.querySelectorAll(".span").forEach(e => { e.onclick = () => e.classList.toggle("open"); e.onkeydown = ev => { if (ev.key === "Enter") e.classList.toggle("open"); }; });
  $("#ps").onchange = async e => { await post("/api/overrides", { op: "phase", sid: t.sid, turn: t.i, phase: e.target.value }); route(true); };
}
async function openTurn(sid, i) {
  state.sel = { sid, i };
  main.querySelectorAll(".blk.sel").forEach(x => x.classList.remove("sel"));
  const b = $(`.blk[data-sid="${CSS.escape(sid)}"][data-i="${i}"]`); if (b) b.classList.add("sel");
  renderPanel(await api(`/api/turn?sid=${encodeURIComponent(sid)}&i=${i}`));
}

/* ---------- 今日 ---------- */
async function today() {
  const d = await api("/api/today"), now = new Date(d.now), T = d.total;
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  let lo = 8, hi = 20;
  for (const r of d.items) for (const b of r.blocks) { const s = (new Date(b.start) - dayStart) / 36e5; lo = Math.min(lo, Math.floor(s)); hi = Math.max(hi, Math.ceil(s + (b.ai + b.wait) / 3600)); }
  hi = Math.min(24, Math.max(hi, now.getHours() + 1, lo + 4));
  const span = hi - lo, pos = ms => (ms - dayStart) / 36e5;
  const pct = h => ((h - lo) / span * 100).toFixed(3) + "%";
  let h = `<div class="top"><h1>今日</h1><span class="sub">${now.getMonth() + 1} 月 ${now.getDate()} 日 ${WD[now.getDay()]} · 现在 ${hm(now)}</span></div>
  <div class="cards">
    <div class="metric"><div class="t">活跃时间</div><div class="v">${dur(T.active)}</div><div class="d">AI 工作 + 等我</div></div>
    <div class="metric"><div class="t">AI 工作</div><div class="v">${dur(T.ai)}</div><div class="d">含工具与子 agent</div></div>
    <div class="metric"><div class="t">等我</div><div class="v">${dur(T.wait)}</div><div class="d">${T.active ? "占活跃时间 " + Math.round(T.wait / T.active * 100) + "%" : DASH}</div></div>
    <div class="metric"><div class="t">空闲，不计入</div><div class="v">${dur(T.idle)}</div><div class="d">间隔超过 ${d.idleMinutes} 分钟的部分</div></div></div>`;
  if (!d.items.length) h += `<div class="empty">今天还没有记录。</div>`;
  else {
    h += `<div class="card"><h3>今天的时间线 <small>按真实时钟；空白是空闲或没在用</small></h3><div class="tl2" style="--hours:${span}"><div class="axis">` +
      Array.from({ length: span + 1 }, (_, k) => k).filter(k => k % 2 === 0 || span <= 8).map(k => `<span style="left:${pct(lo + k)}">${pad(lo + k)}:00</span>`).join("") + `</div>`;
    const nowPos = pos(now.getTime());
    for (const r of d.items) {
      h += `<div class="trow"><div class="lab"><b>${esc(r.name)}</b><span>${r.tools.map(tn).map(esc).join(" · ")}</span></div><div class="track">`;
      for (const b of r.blocks) {
        const s = pos(new Date(b.start).getTime()), aiH = b.ai / 3600, wH = b.wait / 3600;
        h += `<div class="b" style="left:${pct(s)};width:calc(${(aiH / span * 100).toFixed(3)}% + 3px)">${seg(b.phase, "width:100%;height:100%", " " + plain(dur(b.ai)))}</div>`;
        if (wH > 0) h += `<div class="b" style="left:calc(${pct(s + aiH)} + 3px);width:max(3px,${(wH / span * 100).toFixed(3)}%)">${seg("W", "width:100%;height:100%", " " + plain(dur(b.wait)))}</div>`;
      }
      h += `<div class="nowline" style="left:${pct(nowPos)}"></div></div></div>`;
    }
    h += `<div class="nowtag" style="left:calc(150px + (100% - 150px) * ${((nowPos - lo) / span).toFixed(4)});top:-2px">现在</div></div>` + `<div style="height:8px"></div>` + legend() + `</div>`;
  }
  const badge = r => r.status === "running" ? '<span class="pill run">运行中 · 计到现在</span>' : r.status === "waiting" ? `<span class="pill wait">等我中 · ${Math.max(1, Math.round(r.waitingFor / 60))} 分钟</span>` : `<span class="pill end">已结束 ${hm(new Date(r.endedAt))}</span>`;
  h += `<div class="cols even" style="grid-template-columns:1.6fr 1fr"><div class="card"><h3>今天动过的需求</h3><div class="st th" style="grid-template-columns:1.6fr 1fr 80px 1.4fr"><span>需求</span><span>工具</span><span style="text-align:right">活跃</span><span>状态</span></div>` +
    (d.items.map(r => `<a class="st" style="grid-template-columns:1.6fr 1fr 80px 1.4fr;color:inherit;text-decoration:none" href="#/r/${encodeURIComponent(r.key)}"><b>${esc(r.name)}</b><span>${r.tools.map(tn).map(esc).join(" · ")}</span><b style="text-align:right">${dur(r.active)}</b><span>${badge(r)}</span></a>`).join("") || `<div class="dash" style="padding:10px 0">–</div>`) + `</div>
    <div class="card"><h3>怎么算的</h3><p><b>等我</b>：AI 做完一轮后，${d.idleMinutes} 分钟内你还没回，这段算等我，计入活跃。</p><p><b>空闲</b>：超过 ${d.idleMinutes} 分钟没动静，视为你不在，不计入。阈值可在设置里改，改完立即重算。</p><p><b>进行中的一轮</b>：计到现在，轮结束后以实际结束时间为准。</p></div></div>`;
  main.innerHTML = h;
  timer = setInterval(() => route(true), 30000);
}

/* ---------- 洞察 ---------- */
async function insights() {
  const [d, pv] = await Promise.all([api("/api/insights?range=" + state.irange), api("/api/llm/preview")]);
  const rn = RNAME[state.irange], prevName = { today: "昨天", week: "上周", month: "上月" }[state.irange];
  let h = `<div class="top"><h1>洞察</h1><span class="grow"></span>${rangeCtl(state.irange, ["today", "week", "month"])}</div>`;
  if (!d.top) h += `<div class="empty"><b>${rn}没有可统计的精确档数据</b><br>换个时间范围试试。</div>`;
  else {
    const m = PH[d.top.phase], sec = d.second ? PH[d.second.phase] : null;
    const delta = d.prevActive != null ? d.active - d.prevActive : null;
    h += `<div class="cards three">
      <div class="card"><div class="sub">${rn}最耗时的阶段</div><div style="display:flex;gap:12px;align-items:center;margin-top:6px"><span class="sw ph-${m.c}" style="width:44px;height:44px;border-radius:8px"></span><div><div style="font-size:20px;font-weight:650">${m.n} ${dur(d.top.sec)}</div><div class="sub">占活跃时间 ${Math.round(d.top.pct)}%${sec ? ` · 其次是${sec.n} ${dur(d.second.sec)}` : ""}</div></div></div></div>
      <div class="card"><div class="sub">活跃时间</div><div class="metric-v" style="font-size:22px;font-weight:650;margin:4px 0">${dur(d.active)}</div><div class="sub">${delta == null ? `上期无数据，不显示变化` : `较${prevName} ${delta >= 0 ? "+" : "−"}${dur(Math.abs(delta))}`} · ${d.reqCount} 个需求</div></div>
      <div class="card"><div class="sub">等我</div><div style="font-size:22px;font-weight:650;margin:4px 0">${dur(d.wait)}</div><div class="sub">占活跃时间 ${Math.round(d.waitPct)}%</div></div></div>
    <div class="cols even"><div class="stack">
      <div class="card"><h3>阶段排名 <small>AI 工作时间 ${dur(d.ai)}，不含等我</small></h3><div style="height:6px"></div>` +
      d.ranking.map(r => { const p = PH[r.phase]; return `<div class="rank"><span class="i" style="display:inline-flex;align-items:center;gap:6px"><span class="sw ph-${p.c}"></span>${p.n}</span><div class="tk"><div class="ph-${p.c}" style="width:${r.pct.toFixed(1)}%"></div></div><span class="v">${dur(r.sec)} · ${Math.round(r.pct)}%</span></div>`; }).join("") + `</div>
      <div class="card"><h3>耗时最多的需求 <small>点一行进入明细</small></h3>` +
      d.topReqs.map(q => `<a class="topreq" style="color:inherit;text-decoration:none" href="#/r/${encodeURIComponent(q.key)}"><b>${esc(q.name)}</b>${bar(q.byPhase)}<b style="text-align:right">${dur(q.active)}</b></a>`).join("") +
      ((d.coarse || []).length ? `<div class="sub" style="margin-top:8px">「${(d.coarse || []).map(esc).join("、")}」是粗略档，没有耗时，不计入以上数字。</div>` : "") + `</div></div>
    <div class="card"><h3>建议<span class="chip">规则生成</span><small>本地计算，不联网</small></h3>` +
      (d.suggestions.length ? d.suggestions.map(s => `<div class="sug"><b>${esc(s.title)}</b><div>${esc(s.detail)}</div><div class="try"><b style="display:inline">可以试：</b>${esc(s.try)}</div><div class="why">依据：${esc(s.basis)}</div></div>`).join("") : `<div class="sub" style="margin-top:10px">暂无建议。</div>`) +
      `<div class="llm"><button id="lb" ${pv.enabled ? "" : "disabled"}>用大模型解读</button><span class="sub">${pv.enabled ? `发送范围：${esc(pv.level)}` : `未配置，默认关闭。<a href="#/settings">去设置</a>`}</span></div><div id="lo" style="margin-top:8px;white-space:pre-wrap"></div>
      <div class="sub" style="margin-top:8px">打开后只会手动触发，发送前先预览发送的内容；所有数字仍由本地算出。</div></div></div>`;
  }
  main.innerHTML = h;
  main.querySelectorAll("[data-r]").forEach(b => b.onclick = () => { state.irange = b.dataset.r; sessionStorage.setItem("irange", state.irange); route(true); });
  const lb = $("#lb");
  if (lb) lb.onclick = () => modal(`<h3>将要发送的内容</h3><div class="sub">发送范围：${esc(pv.level)}。以下 JSON 就是全部内容：</div><pre class="json">${esc(JSON.stringify(pv.payload, null, 2))}</pre>`,
    async () => { $("#lo").textContent = "发送中…"; try { const r = await post("/api/llm/send", { confirmed: pv.payload }); $("#lo").textContent = r.text + "\n\n（大模型只做解读；相关性不等于因果，数字以本机计算为准）"; } catch (e) { $("#lo").textContent = "失败：" + e.message; } }, "确认并发送");
}

/* ---------- 数据源与设置 ---------- */
async function settings() {
  const [st, src] = await Promise.all([api("/api/settings"), api("/api/sources")]);
  const status = t => !t.implemented ? `<b>暂不支持</b><div class="sub">适配器未实现</div>` : !t.configured ? `<b>未配置</b><div class="sub">添加目录后启用</div>` :
    t.missing ? `<b>目录不可用</b><div class="sub">检查路径</div>` : `<b>已发现</b><div class="sub">${t.sessions} 个会话${t.failed ? ` · ${t.failed} 个文件失败` : ""}</div>`;
  let h = `<div><h1>数据源与设置</h1><div class="sub">启动时自动发现本机已装工具的日志，只读，不改原文件。</div></div><div class="cols" style="grid-template-columns:1fr 340px"><div class="stack">
  <div class="card"><h3>数据源 <small>每个工具对应一个适配器</small></h3><div class="st th"><span>工具</span><span>日志位置</span><span>状态</span><span>精度</span><span>启用</span></div>` +
    src.tools.map(t => `<div class="st"><b>${esc(t.name)}</b><span><code>${esc(t.dir || t.defaultPath)}</code> ${t.implemented && t.configured ? `<a href="#" data-dir="${t.index}">修改</a>` : ""}</span><span>${status(t)}</span>
      <span>${t.implemented ? `<span class="pill ${t.precision === "exact" ? "exact" : "coarse"}">${t.precision === "exact" ? "精确" : "粗略"}</span>` : `<span class="pill none">–</span>`}</span>
      <span class="sw-t"><input type="checkbox" ${t.enabled ? "checked" : ""} ${t.implemented && t.configured ? "" : "disabled"} data-en="${t.index}" aria-label="启用 ${esc(t.name)}"></span></div>`).join("") +
    `<div class="sub" style="margin-top:10px"><a href="#" id="ad">添加另一个日志目录…</a> · 想接新工具：写一个适配器配置文件（声明式适配器，计划在后续版本支持）。</div></div>
  <div class="card"><h3>能力矩阵 <small>适配器读到了哪些字段；没有的字段显示「–」，不会估算</small></h3><div class="cap h" style="margin-top:6px"><span>工具</span>${src.capCols.map(c => `<span>${esc(c)}</span>`).join("")}</div>` +
    src.tools.filter(t => t.implemented).map(t => `<div class="cap"><span>${esc(t.name)}</span>${src.caps[t.id].map(v => v ? '<span class="y">有</span>' : '<span class="n">–</span>').join("")}</div>`).join("") +
    `<div class="sub" style="margin-top:8px">以每次扫描时适配器读到的日志为准。没有逐事件时间戳的工具归为「粗略」，只显示次数和跨度。</div></div></div>
  <div class="stack"><div class="card"><h3>计时与聚合</h3>
    <div class="kv"><span>空闲阈值</span><span><input id="idle" type="number" min="1" value="${st.idle_minutes}" aria-label="空闲阈值（分钟）"><span class="u">分钟</span></span></div>
    <div class="kv"><span>需求聚合窗口</span><span><input id="win" type="number" min="1" value="${st.window_hours}" aria-label="聚合窗口（小时）"><span class="u">小时</span></span></div>
    <div class="kv"><span>阶段规则</span><button id="rules">查看规则</button></div>
    <div class="sub" style="margin-top:8px"><button class="primary" id="sv">保存</button> <span id="sm"></span><br>改阈值后会立即重算；手动合并、拆分、改名和改阶段会保留。</div></div>
  <div class="card"><h3>大模型建议 <small>${st.llm.enabled ? "已开启" : "已关闭"}</small></h3>
    <div class="kv"><span>启用（仅手动触发）</span><span class="sw-t"><input type="checkbox" id="le" ${st.llm.enabled ? "checked" : ""} aria-label="启用大模型建议"></span></div>
    <div class="sub" style="margin-top:6px">发送范围（打开后选择）</div>` +
    [["counts", "只发聚合数（默认）"], ["names", "加上需求名"], ["segments", "加上分段摘要"]].map(([v, t]) => `<label style="display:block;margin:4px 0"><input type="radio" name="ll" value="${v}" ${st.llm.level === v ? "checked" : ""}> ${t}</label>`).join("") +
    `<div class="kv"><span>地址</span><input id="lu" type="text" size="22" value="${esc(st.llm.endpoint)}" placeholder="http://127.0.0.1:11434"></div><div class="kv"><span>模型</span><input id="lm" type="text" size="16" value="${esc(st.llm.model)}"></div>
    <div class="sub">可接本机 Ollama。每次发送前都会预览内容。</div></div>` +
    (src.parseErrors.length ? `<div class="errcard"><b>${src.parseErrors.length} 个文件解析失败</b>` + src.parseErrors.slice(0, 5).map(e => `<code>${esc(e.File)}</code><div>${esc(e.Reason)}，其他文件不受影响。</div>`).join("") + `<button id="rs" style="margin-top:8px">重新扫描</button></div>` : "") + `</div></div>`;
  main.innerHTML = h;
  const collect = () => ({ ...st, idle_minutes: +$("#idle").value, window_hours: +$("#win").value, llm: { enabled: $("#le").checked, level: (main.querySelector('input[name=ll]:checked') || {}).value || "counts", endpoint: $("#lu").value.trim(), model: $("#lm").value.trim() } });
  const save = async () => { try { await post("/api/settings", collect(), "PUT"); return true; } catch (e) { $("#sm").innerHTML = `<span style="color:var(--bad-fg)">${esc(e.message)}</span>`; return false; } };
  $("#sv").onclick = async () => { if (await save()) { $("#sm").textContent = "已保存"; route(true); } };
  $("#le").onchange = async () => { if (await save()) route(true); };
  main.querySelectorAll("[data-en]").forEach(c => c.onchange = async () => { st.sources[+c.dataset.en].enabled = c.checked; if (await save()) route(true); });
  main.querySelectorAll("[data-dir]").forEach(a => a.onclick = e => { e.preventDefault(); const i = +a.dataset.dir; const v = prompt("日志目录", st.sources[i].dir); if (v && v.trim()) { st.sources[i].dir = v.trim(); save().then(() => route(true)); } });
  const rs = $("#rs"); if (rs) rs.onclick = async () => { rs.disabled = true; rs.textContent = "扫描中…"; await api("/api/sources?refresh=1"); route(true); };
  $("#rules").onclick = () => modal(`<h3>阶段规则</h3><div class="sub">纯规则判定，按优先级；可在需求明细里对单轮人工覆盖。规则文件暂不支持自定义。</div><ol><li><b>T 测试</b>：Bash 命令匹配 go test / pytest / npm test / jest / cargo test 等</li><li><b>F 改代码</b>：有 Edit 类工具，或有 Write 且 prompt 含修复 / 重构类词</li><li><b>C 写代码</b>：仅有 Write</li><li><b>P 聊方案</b>：没有任何工具调用</li><li><b>R 调研</b>：只用 Read / Grep / Glob / WebFetch / WebSearch</li><li><b>O 其他</b>：其余</li></ol>`, async () => { }, "知道了");
  $("#ad").onclick = e => {
    e.preventDefault();
    modal(`<h3>添加日志目录</h3><select id="aa">${src.tools.filter(t => t.implemented).map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("")}</select><input id="ar" type="text" placeholder="例如 D:\\\\data\\\\.claude\\\\projects 或 /mnt/d/.claude/projects"><div id="at" class="sub"></div><button id="ats">测试扫描</button>`,
      async () => { st.sources.push({ adapter: $("#aa").value, dir: $("#ar").value.trim(), enabled: true }); await post("/api/settings", st, "PUT"); route(true); }, "添加");
    $("#dk").disabled = true;
    $("#ats").onclick = async () => { try { const r = await post("/api/sources/test", { adapter: $("#aa").value, dir: $("#ar").value.trim(), enabled: true }); $("#at").textContent = `识别到 ${r.sessions} 个会话、${r.turns} 轮；${r.failed} 个文件解析失败。`; $("#dk").disabled = r.sessions === 0; } catch (e) { $("#at").textContent = e.message; $("#dk").disabled = true; } };
  };
}


/* ---------- 会话详情：还原成聊天记录 ---------- */
// 轻量 Markdown：先整体转义，再处理代码块、行内代码、粗体。不执行任何来自日志的 HTML。
function md(text) {
  const parts = String(text || "").split(/```/);
  return parts.map((p, i) => {
    if (i % 2 === 1) { const nl = p.indexOf("\n"); return `<pre>${esc(nl >= 0 && nl < 30 ? p.slice(nl + 1) : p)}</pre>`; }
    return esc(p).replace(/`([^`\n]+)`/g, "<code>$1</code>").replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  }).join("");
}
const CHAT_BATCH = 15;
const chatOpt = { tools: sessionStorage.getItem("c.tools") !== "0", side: sessionStorage.getItem("c.side") === "1" };

async function sessionPage(sid, turnStr) {
  const [d, tr] = await Promise.all([api("/api/session/" + encodeURIComponent(sid)), api("/api/session/" + encodeURIComponent(sid) + "/transcript")]);
  const target = turnStr === undefined ? null : +turnStr;
  const tok = d.tokIn || d.tokOut ? `入 ${d.tokIn.toLocaleString()} / 出 ${d.tokOut.toLocaleString()}（入不含缓存命中）` : DASH;
  let h = `<div class="sub"><a href="#/">需求</a> &nbsp;/&nbsp; <a href="#/r/${encodeURIComponent(d.req.key)}">${esc(d.req.name)}</a> &nbsp;/&nbsp; 会话</div>
  <div class="top"><h1>${esc(d.title || d.id)}</h1><span class="tag">${esc(tn(d.tool))}</span><span class="pill ${d.precision === "exact" ? "exact" : "coarse"}">${d.precision === "exact" ? "精确" : "粗略"}</span></div>
  <div class="sub">${esc(shortPath(d.cwd, d.home))}${d.branch ? " · " + esc(d.branch) : ""} · ${when(d.start)} 至 ${when(d.end)} · 模型 ${d.models.length ? d.models.map(esc).join("、") : DASH} · token ${tok}</div>
  <div class="cards">
    <div class="metric"><div class="t">活跃时间</div><div class="v">${dur(d.active)}</div><div class="d">AI + 等我</div></div>
    <div class="metric"><div class="t">AI 工作</div><div class="v">${dur(d.ai)}</div><div class="d">含工具与子 agent</div></div>
    <div class="metric"><div class="t">等我</div><div class="v">${dur(d.wait)}</div><div class="d">空闲 ${dur(d.idle)} 不计入</div></div>
    <div class="metric"><div class="t">轮数</div><div class="v">${d.turns.length}</div><div class="d">${tr.messages.length} 条消息</div></div></div>
  <div class="card"><h3>时间轴 <small>一格是一轮，点一下跳到对应位置</small></h3>${timeline({ id: d.id, turns: d.turns }, Math.max(380, main.clientWidth - 90))}</div>
  <div class="chatbar"><label><input type="checkbox" id="ct" ${chatOpt.tools ? "checked" : ""}>显示工具调用</label><label><input type="checkbox" id="cs" ${chatOpt.side ? "checked" : ""}>显示子 agent 消息</label>
    <span class="grow"></span><span title="${esc(tr.file)}">原始日志：<code>${esc(shortPath(tr.file, d.home))}</code>（只读）</span></div>
  <div class="chat" id="chat"></div><div class="more" id="more"></div>`;
  main.innerHTML = h;

  // 工具结果按 tool_use id 配对，放进对应的工具卡片
  const results = {};
  for (const m of tr.messages) if (m.role === "tool_result") for (const b of m.blocks) if (b.toolId) results[b.toolId] = { b, t: m.t };
  const groups = new Map();
  for (const m of tr.messages) { if (!groups.has(m.turn)) groups.set(m.turn, []); groups.get(m.turn).push(m); }
  const order = [...groups.keys()].sort((a, b) => a - b);
  const turnMeta = Object.fromEntries(d.turns.map(t => [t.i, t]));
  let rendered = 0;
  const chat = $("#chat"), more = $("#more");

  const renderTurn = k => {
    let out = "";
    const t = turnMeta[k];
    if (t) {
      const p = PH[t.phase];
      out += `<div class="tsep" id="turn-${k}"><span>第 ${k + 1} 轮</span><span class="badge-ph ph-${p.c}">${t.phase} ${p.n}</span><span>${hm(new Date(t.start))} · AI ${durS(t.ai)}${t.wait ? " · 等我 " + durS(t.wait) : ""}${t.idle ? " · 之后空闲 " + plain(dur(t.idle)) : ""}</span></div>`;
    } else if (k < 0) out += `<div class="tsep"><span>第一条用户消息之前</span></div>`;
    let side = "";
    const flushSide = () => { if (side) { out += `<div class="side" ${chatOpt.side ? "" : "hidden"}><div class="lbl">子 agent</div>${side}</div>`; side = ""; } };
    for (const m of groups.get(k)) {
      const html = renderMsg(m);
      if (!html) continue;
      if (m.side) side += html; else { flushSide(); out += html; }
    }
    flushSide();
    return out;
  };
  const renderMsg = m => {
    if (m.role === "tool_result") { // 已配对的结果在工具卡片里显示；未配对的单独显示
      return m.blocks.filter(b => !b.toolId || !hasUse(b.toolId)).map(b => toolCard({ name: "工具结果", input: "" }, { b, t: m.t }, m.t)).join("");
    }
    const user = m.role === "user";
    let text = "", out = "";
    for (const b of m.blocks) {
      if (b.kind === "text" && b.text) text += (text ? "\n\n" : "") + b.text;
      else if (b.kind === "image") text += (text ? "\n" : "") + "[图片]";
      else if (b.kind === "thinking" && b.text) out += `<details class="think"><summary>思考</summary><div class="md">${md(b.text)}</div></details>`; // 日志里思考正文为空时不显示
      else if (b.kind === "tool_use") out += toolCard(b, results[b.toolId], m.t);
    }
    const bubble = text ? `<div class="msg ${user ? "user" : "ai"}"><div class="mt">${user ? "我" : "AI" + (m.model ? " · " + esc(m.model) : "")} · ${hm(new Date(m.t))}</div><div class="md">${md(text)}</div></div>` : "";
    return user ? bubble : bubble + out;
  };
  const uses = new Set();
  for (const m of tr.messages) for (const b of m.blocks) if (b.kind === "tool_use" && b.toolId) uses.add(b.toolId);
  const hasUse = id => uses.has(id);
  const toolCard = (b, r, t0) => {
    const res = r ? r.b : null, err = res && res.isError;
    const secs = r ? Math.max(0, (new Date(r.t) - new Date(t0)) / 1000) : null;
    let arg = "";
    try { const o = JSON.parse(b.input || "{}"); arg = o.command || o.file_path || o.path || o.pattern || o.url || o.query || o.description || ""; } catch { }
    const kind = b.name === "Task" || b.name === "Agent" ? "agent" : "tool";
    return `<details class="tool${err ? " err" : ""}" ${chatOpt.tools ? "" : "hidden"}><summary>${icon(kind)}<b>${esc(b.name)}</b><span class="a">${esc(arg)}</span>${err ? '<span class="pill" style="background:var(--bad-bg);color:var(--bad-fg)">出错</span>' : ""}<span class="d">${secs == null ? DASH : durS(secs)}</span></summary>
      <div class="body">${b.input && b.input !== "{}" ? `<div class="k">参数</div><pre class="out">${esc(b.input)}</pre>` : ""}
      <div class="k">输出</div>${res ? `<pre class="out">${esc(res.text) || "（空）"}</pre>${res.truncated ? `<div class="trunc">已截断，原文 ${res.len.toLocaleString()} 字符，完整内容见原始日志。</div>` : ""}` : `<div class="dash">没有对应的输出记录</div>`}</div></details>`;
  };
  const renderUpTo = n => {
    let html = "";
    while (rendered < order.length && rendered < n) html += renderTurn(order[rendered++]);
    if (html) chat.insertAdjacentHTML("beforeend", html);
    more.textContent = rendered < order.length ? `已显示 ${rendered} / ${order.length} 段，继续向下滚动加载…` : (order.length ? "— 会话结束 —" : "这个会话没有可显示的消息。");
  };
  const jump = k => {
    const idx = order.indexOf(k);
    if (idx >= 0) renderUpTo(idx + CHAT_BATCH);
    const el = $(`#turn-${k}`);
    if (el) { main.querySelectorAll(".tsep.hl").forEach(x => x.classList.remove("hl")); el.classList.add("hl"); el.scrollIntoView({ block: "start" }); }
    main.querySelectorAll(".blk.sel").forEach(x => x.classList.remove("sel"));
    const b = $(`.blk[data-i="${k}"]`); if (b) b.classList.add("sel");
  };
  renderUpTo(CHAT_BATCH);
  const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) renderUpTo(rendered + CHAT_BATCH); }, { rootMargin: "800px" });
  io.observe(more);
  main.querySelectorAll(".blk").forEach(b => b.onclick = () => { history.replaceState(null, "", `#/s/${encodeURIComponent(sid)}/${b.dataset.i}`); jump(+b.dataset.i); });
  $("#ct").onchange = e => { chatOpt.tools = e.target.checked; sessionStorage.setItem("c.tools", chatOpt.tools ? "1" : "0"); chat.querySelectorAll(".tool").forEach(x => x.hidden = !chatOpt.tools); };
  $("#cs").onchange = e => { chatOpt.side = e.target.checked; sessionStorage.setItem("c.side", chatOpt.side ? "1" : "0"); chat.querySelectorAll(".side").forEach(x => x.hidden = !chatOpt.side); };
  if (target != null) requestAnimationFrame(() => jump(target));
}

/* ---------- 主题 ---------- */
const root = document.documentElement;
try { const t = localStorage.getItem("theme"); if (t) root.dataset.theme = t; } catch { }
$("#theme").onclick = () => {
  const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = dark ? "light" : "dark";
  try { localStorage.setItem("theme", root.dataset.theme); } catch { }
};
route();
