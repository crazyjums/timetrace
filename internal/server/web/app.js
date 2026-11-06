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
const ORDER = ["P", "R", "C", "F", "T", "O", "W"];
const icon = k => { const x = window.ICONS[k]; return x ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${x.inner}</svg>` : ""; };
const dur = s => {
  if (s == null) return '<span class="dash">–</span>';
  s = Math.round(s); if (s < 60) return s + "s";
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
  return h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
};
const when = t => new Date(t).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

async function api(path, opt = {}) {
  const r = await fetch(path, { ...opt, headers: { "X-Timetrace": "1", "Content-Type": "application/json" } });
  if (!r.ok) throw new Error((await r.text()).trim() || r.statusText);
  return r.json();
}
const post = (path, body, method = "POST") => api(path, { method, body: JSON.stringify(body) });

/* 阶段块：颜色 + 纹理 + 字母 + 图标；宽 <6px 去纹理，≥16px 显示字母和图标 */
function seg(p, w, extra = "") {
  const m = PH[p];
  return `<div class="seg ph-${m.c}" data-ph="${p}" style="${w}" title="${m.n} ${p}${extra}">${icon(m.i)}<span class="l">${p}</span></div>`;
}
function layoutSegs(root) {
  root.querySelectorAll(".seg").forEach(s => {
    const w = s.getBoundingClientRect().width;
    s.classList.toggle("thin", w < 6);
    s.classList.toggle("wide", w >= 16);
    s.classList.toggle("wider", w >= 30);
  });
}
function bar(byPhase, tall) {
  const tot = ORDER.reduce((a, p) => a + (byPhase[p] || 0), 0);
  if (!tot) return `<div class="bar${tall ? " tall" : ""}"></div>`;
  return `<div class="bar${tall ? " tall" : ""}" role="img" aria-label="阶段构成">` +
    ORDER.filter(p => byPhase[p] > 0).map(p => seg(p, `flex:${byPhase[p]} 1 0`, " " + dur(byPhase[p]).replace(/<[^>]+>/g, ""))).join("") + `</div>`;
}
const legend = () => `<div class="legend">` + ORDER.map(p => `<span class="chip"><span class="sw ph-${PH[p].c}"></span>${p} ${PH[p].n}</span>`).join("") +
  `<span class="chip"><span class="sw" style="border:1px dashed var(--mute)"></span>空闲（不计入）</span></div>`;

const main = $("#main"), drawer = $("#drawer");
let sel = null;

const routes = [
  [/^#\/r\/(.+)$/, detail], [/^#\/today$/, today], [/^#\/insights$/, insights], [/^#\/settings$/, settings], [/.*/, list],
];
async function route() {
  closeDrawer();
  const h = location.hash || "#/";
  document.querySelectorAll("nav a").forEach(a => a.classList.toggle("on", a.getAttribute("href") === h || (a.dataset.p === "list" && h.startsWith("#/r/"))));
  main.innerHTML = '<div class="empty">加载中…</div>';
  for (const [re, fn] of routes) {
    const m = h.match(re);
    if (m) {
      try { await fn(...m.slice(1).map(decodeURIComponent)); layoutSegs(main); }
      catch (e) { main.innerHTML = `<div class="banner err">加载失败：${esc(e.message)}</div>`; }
      return;
    }
  }
}
addEventListener("hashchange", route);
addEventListener("resize", () => layoutSegs(main));

/* ---------- 需求列表 ---------- */
async function list() {
  const d = await api("/api/requirements");
  let h = `<h1>需求</h1><div class="sub">按需求聚合的活跃时间 = AI 时间 + 等我；空闲不计入。</div>${legend()}<div style="height:12px"></div>`;
  if (d.parseErrors.length) h += `<div class="banner err">${d.parseErrors.length} 个文件解析失败（不影响其他文件）：<br>` +
    d.parseErrors.slice(0, 5).map(e => `<code>${esc(e.File)}</code> — ${esc(e.Reason)}`).join("<br>") + `</div>`;
  if (!d.requirements.length) {
    h += `<div class="empty"><b>未发现日志</b><br>${d.sources ? "已配置的数据源里没有可用会话。" : "还没有启用任何数据源。"} 到<a href="#/settings">设置</a>检查数据源目录。</div>`;
  }
  for (const r of d.requirements) {
    const coarse = r.coarse ? `<span class="badge">粗略 ×${r.coarse}：不显示耗时</span>` : "";
    h += `<a class="row" href="#/r/${encodeURIComponent(r.key)}">
      <span class="name">${esc(r.name)}</span><span class="dur">${r.turns || r.coarse === 0 ? dur(r.active) : dur(null)}</span>
      <div style="grid-column:1/-1">${bar(r.byPhase)}</div>
      <div class="meta"><span>${r.tools.map(esc).join(" · ")}</span><span>${r.sessions} 个会话 · ${r.turns} 轮</span><span>最近 ${when(r.end)}</span>${coarse}<code>${esc(r.cwd)}</code></div></a>`;
  }
  main.innerHTML = h;
}

/* ---------- 需求明细 ---------- */
async function detail(key) {
  const d = await api("/api/requirements/" + encodeURIComponent(key));
  const tot = ORDER.reduce((a, p) => a + (d.byPhase[p] || 0), 0);
  let h = `<p><a href="#/">← 需求列表</a></p>
  <h1><span id="nm">${esc(d.name)}</span> <button class="ghost" id="rn" title="改名">✎</button></h1>
  <div class="sub"><code>${esc(d.cwd)}</code></div>
  <div class="metrics"><div class="metric"><b>${dur(d.active)}</b><span>活跃时间</span></div>
  <div class="metric"><b>${dur(d.idle)}</b><span>空闲（不计入）</span></div>
  <div class="metric"><b>${d.sessions.length}</b><span>会话（同需求允许重叠，各算各的）</span></div></div>
  ${d.coarse ? `<div class="banner">有 ${d.coarse} 个会话是粗略档（只有起止时间）：只显示次数和跨度，耗时显示「–」，不计入上面的汇总。</div>` : ""}
  <h2>阶段分布</h2>${bar(d.byPhase, true)}${legend()}
  <table style="margin-top:8px"><tr><th>阶段</th><th class="num">时间</th><th class="num">占比</th></tr>` +
    ORDER.filter(p => d.byPhase[p] > 0).map(p => `<tr><td><span class="chip"><span class="sw ph-${PH[p].c}"></span>${p} ${PH[p].n}</span></td><td class="num">${dur(d.byPhase[p])}</td><td class="num">${(d.byPhase[p] / tot * 100).toFixed(0)}%</td></tr>`).join("") +
    `</table><h2>会话与时间轴</h2>`;
  d.sessions.forEach((s, i) => {
    const coarse = s.precision !== "exact";
    h += `<div class="card"><div class="form"><b>${esc(s.title || s.id.slice(0, 8))}</b><span class="badge">${esc(s.tool)}</span>
      ${coarse ? '<span class="badge">粗略</span>' : ""}<span class="dash">${when(s.start)} – ${when(s.end)}</span>
      <span style="flex:1"></span><span>${coarse ? dur(null) : dur(s.active)}</span>
      <button data-split="${esc(s.id)}" title="从该会话起另起一个需求">拆分</button>
      ${i > 0 ? `<button data-merge="${esc(d.sessions[i - 1].id)},${esc(s.id)}" title="与上一个会话强制归为同一需求">与上一个合并</button>` : ""}</div>`;
    if (coarse) h += `<div class="dash">粗略档：${s.turns.length ? "" : "无逐轮数据，"}仅显示起止跨度。</div>`;
    else h += timeline(s);
    h += `</div>`;
  });
  main.innerHTML = h;
  $("#rn").onclick = async () => {
    const n = prompt("需求名称（留空恢复默认）", d.name);
    if (n === null) return;
    await post("/api/overrides", { op: "rename", key: d.key, name: n }); route();
  };
  main.querySelectorAll("[data-split]").forEach(b => b.onclick = async () => { await post("/api/overrides", { op: "split", sid: b.dataset.split }); location.hash = "#/"; });
  main.querySelectorAll("[data-merge]").forEach(b => b.onclick = async () => { await post("/api/overrides", { op: "merge", sids: b.dataset.merge.split(",") }); route(); });
  main.querySelectorAll(".blk").forEach(b => b.onclick = () => openTurn(b.dataset.sid, +b.dataset.i, b));
}
function timeline(s) {
  if (!s.turns.length) return '<div class="dash">没有可展示的轮。</div>';
  const W = Math.max(600, main.clientWidth - 64), idleN = s.turns.filter(t => t.idle > 0).length;
  const tot = s.turns.reduce((a, t) => a + t.ai + t.wait, 0) || 1, avail = W - idleN * 10;
  let h = `<div class="tl" role="list">`;
  for (const t of s.turns) {
    const aiW = Math.max(2, t.ai / tot * avail), waitW = t.wait / tot * avail;
    h += `<button class="blk" role="listitem" style="width:${aiW + waitW}px;display:flex" data-sid="${esc(s.id)}" data-i="${t.i}" aria-label="第 ${t.i + 1} 轮 ${PH[t.phase].n} ${Math.round(t.ai)} 秒">` +
      seg(t.phase, `width:${aiW}px`, " · 第 " + (t.i + 1) + " 轮 " + Math.round(t.ai) + "s") + (waitW >= 1 ? seg("W", `width:${waitW}px`, " " + Math.round(t.wait) + "s") : "") + `</button>`;
    if (t.idle > 0) h += `<div class="idle" title="空闲 ${dur(t.idle).replace(/<[^>]+>/g, "")}（不计入）"></div>`;
  }
  return h + "</div>";
}

/* ---------- 对话抽屉 ---------- */
const KIND = { user: ["plan", "我"], llm: ["llm", "AI"], tool: ["tool", "工具"], agent: ["agent", "子 agent"] };
async function openTurn(sid, i, btn) {
  document.querySelectorAll(".blk.sel").forEach(x => x.classList.remove("sel")); btn.classList.add("sel");
  const t = await api(`/api/turn?sid=${encodeURIComponent(sid)}&i=${i}`);
  drawer.hidden = false;
  drawer.innerHTML = `<div class="form"><b>第 ${i + 1} 轮</b><span class="chip"><span class="sw ph-${PH[t.phase].c}"></span>${t.phase} ${PH[t.phase].n}</span><span>${dur(t.ai)}</span><span style="flex:1"></span><button id="dx" aria-label="关闭">✕</button></div>
  <div class="form"><label>改阶段 <select id="ps"><option value="">（自动判定）</option>${"PRCFTO".split("").map(p => `<option value="${p}">${p} ${PH[p].n}</option>`).join("")}</select></label></div>` +
    t.items.map(it => { const k = KIND[it.kind] || KIND.tool; return `<div class="item">${icon(k[0])}<div><div class="k">${k[1]}${it.kind === "tool" || it.kind === "agent" ? " · " + esc(it.text) : ""}</div>${it.kind === "tool" || it.kind === "agent" ? `<code>${esc(it.arg) || '<span class="dash">–</span>'}</code>` : `<pre>${esc(it.text)}</pre>`}</div></div>`; }).join("");
  $("#dx").onclick = closeDrawer;
  $("#ps").onchange = async e => { await post("/api/overrides", { op: "phase", sid, turn: i, phase: e.target.value }); route(); };
}
function closeDrawer() { drawer.hidden = true; drawer.innerHTML = ""; }
addEventListener("keydown", e => { if (e.key === "Escape") closeDrawer(); });

/* ---------- 今日 ---------- */
async function today() {
  const d = await api("/api/today");
  let h = `<h1>今日</h1><div class="sub">今天各需求的活跃时间；进行中的轮算到现在。</div>
  <div class="metrics"><div class="metric"><b>${dur(d.total)}</b><span>合计（可能因并发而大于墙钟时间）</span></div></div>`;
  if (!d.items.length) h += `<div class="empty">今天还没有记录。</div>`;
  const max = Math.max(1, ...d.items.map(i => i.active));
  for (const it of d.items) h += `<div class="card"><div class="form"><b>${esc(it.name)}</b>${it.running ? '<span class="badge">进行中</span>' : ""}<span style="flex:1"></span><b>${dur(it.active)}</b></div>
    <div class="bar"><div class="seg ph-other" style="flex:${it.active / max} 1 0"></div><div style="flex:${1 - it.active / max} 1 0"></div></div></div>`;
  main.innerHTML = h;
}

/* ---------- 洞察 ---------- */
async function insights() {
  const days = +(sessionStorage.getItem("days") || 7);
  const [d, pv] = await Promise.all([api("/api/insights?days=" + days), api("/api/llm/preview")]);
  let h = `<h1>洞察</h1><div class="form sub">统计最近 <select id="dy">${[1, 7, 14, 30].map(x => `<option ${x === days ? "selected" : ""}>${x}</option>`).join("")}</select> 天（本机规则计算，所有数字不经过大模型）</div>`;
  if (!d.topPhase) h += `<div class="empty">这个区间内没有可统计的精确档数据。</div>`;
  else {
    const m = PH[d.topPhase.phase];
    h += `<div class="metrics"><div class="metric"><b><span class="chip"><span class="sw ph-${m.c}"></span>${d.topPhase.phase} ${m.n}</span></b><span>最耗时阶段 · ${dur(d.topPhase.sec)} · ${d.topPhase.pct.toFixed(0)}%</span></div>` +
      (d.delta ? `<div class="metric"><b>${dur(d.delta.cur)}</b><span>本期活跃（上期 ${dur(d.delta.prev)}）</span></div>` : `<div class="metric"><b class="dash">–</b><span>较上期变化：上期无数据，不显示</span></div>`) + `</div>`;
    h += `<h2>Top 需求</h2>` + (d.topReqs || []).map((q, i) => `<div class="card form"><b>${i + 1}</b> ${esc(q.Name)}<span style="flex:1"></span><b>${dur(q.D / 1e9)}</b></div>`).join("");
    h += `<h2>建议</h2>` + (d.suggestions.length ? d.suggestions.map(s => `<div class="card">${esc(s)}</div>`).join("") : `<div class="dash">暂无建议。</div>`);
  }
  h += `<h2>大模型解读（可选）</h2><div class="card">`;
  if (!pv.enabled) h += `<div class="dash">未启用。默认关闭，需要时到<a href="#/settings">设置</a>里打开；打开后也只能手动触发，并且发送前会预览内容。</div>`;
  else h += `<div class="sub">发送范围：<b>${esc(pv.level)}</b>。以下 JSON 就是将要发送的全部内容：</div><pre class="json">${esc(JSON.stringify(pv.payload, null, 2))}</pre>
    <button class="primary" id="ls">确认并发送</button><div id="lo" style="margin-top:8px;white-space:pre-wrap"></div>`;
  main.innerHTML = h + "</div>";
  $("#dy").onchange = e => { sessionStorage.setItem("days", e.target.value); route(); };
  const ls = $("#ls");
  if (ls) ls.onclick = async () => {
    ls.disabled = true; $("#lo").textContent = "发送中…";
    try { const r = await post("/api/llm/send", { confirmed: pv.payload }); $("#lo").textContent = r.text + "\n\n（大模型只做解读；相关性不等于因果，数字以上方本机计算为准）"; }
    catch (e) { $("#lo").innerHTML = `<span style="color:var(--bad)">${esc(e.message)}</span>`; }
    ls.disabled = false;
  };
}

/* ---------- 设置 ---------- */
async function settings() {
  const [st, src] = await Promise.all([api("/api/settings"), api("/api/sources?refresh=1")]);
  const info = src.sources;
  let h = `<h1>设置</h1><h2>数据源与能力矩阵</h2><div class="card"><table><tr><th>启用</th><th>适配器</th><th>目录</th><th class="num">文件 / 会话</th><th></th></tr>` +
    st.sources.map((s, i) => { const x = info.find(y => y.dir === s.dir && y.adapter === s.adapter);
      return `<tr><td><input type="checkbox" data-en="${i}" ${s.enabled ? "checked" : ""} aria-label="启用"></td><td>${esc(s.adapter)}</td><td><code>${esc(s.dir)}</code>${x && x.missing ? ' <span class="badge">目录不可用</span>' : ""}${x && x.errors.length ? ` <span class="badge">${x.errors.length} 个错误</span>` : ""}</td><td class="num">${x ? x.files + " / " + x.sessions : '<span class="dash">–</span>'}</td><td><button data-rm="${i}">移除</button></td></tr>`; }).join("") +
    `</table>
    <h2>能力</h2><table><tr><th>适配器</th><th>能提供</th><th>缺失（显示「–」，不推测）</th></tr>` +
    Object.keys(src.capabilities).map(a => `<tr><td>${esc(a)}</td><td>${src.capabilities[a].map(esc).join("、")}</td><td class="dash">${(src.missing[a] || []).map(esc).join("、") || "–"}</td></tr>`).join("") + `</table>
    <div class="form"><b>添加数据源</b><select id="ad">${Object.keys(src.capabilities).map(a => `<option>${esc(a)}</option>`).join("")}</select><input id="dr" size="40" placeholder="日志目录，如 /mnt/d/.claude/projects"><button id="ts">测试扫描</button><button class="primary" id="add" disabled>添加</button></div><div id="tr"></div></div>
  <h2>计时</h2><div class="card form"><label>空闲阈值（分钟）<input id="idle" type="number" min="1" value="${st.idle_minutes}" style="width:70px"></label>
  <label>聚合窗口（小时）<input id="win" type="number" min="1" value="${st.window_hours}" style="width:70px"></label><button class="primary" id="sv">保存</button><span id="sm"></span></div>
  <h2>阶段规则</h2><div class="card"><div class="sub">纯规则判定，可在对话抽屉里对单轮人工覆盖（按优先级）：</div><ol>
  <li><b>T 测试</b>：Bash 命令匹配 go test / pytest / npm test / jest / cargo test 等</li>
  <li><b>F 改代码</b>：有 Edit 类工具，或有 Write 且 prompt 含修复 / 重构类词</li><li><b>C 写代码</b>：仅有 Write</li>
  <li><b>P 聊方案</b>：没有任何工具调用</li><li><b>R 调研</b>：只用 Read / Grep / Glob / WebFetch / WebSearch</li><li><b>O 其他</b>：其余</li></ol></div>
  <h2>大模型（默认关闭）</h2><div class="card form"><label><input type="checkbox" id="le" ${st.llm.enabled ? "checked" : ""}> 启用（仅手动触发）</label>
  <label>发送范围 <select id="ll">${[["counts", "仅聚合数（默认）"], ["names", "加需求名"], ["segments", "加分段摘要"]].map(([v, t]) => `<option value="${v}" ${st.llm.level === v ? "selected" : ""}>${t}</option>`).join("")}</select></label>
  <label>地址 <input id="lu" size="28" value="${esc(st.llm.endpoint)}" placeholder="http://127.0.0.1:11434"></label><label>模型 <input id="lm" size="14" value="${esc(st.llm.model)}"></label></div>`;
  main.innerHTML = h;
  const save = async msg => {
    const n = { ...st, idle_minutes: +$("#idle").value, window_hours: +$("#win").value, llm: { enabled: $("#le").checked, level: $("#ll").value, endpoint: $("#lu").value.trim(), model: $("#lm").value.trim() } };
    try { await post("/api/settings", n, "PUT"); return true; } catch (e) { $("#sm").innerHTML = `<span style="color:var(--bad)">${esc(e.message)}</span>`; return false; }
  };
  $("#sv").onclick = async () => { if (await save()) { $("#sm").textContent = "已保存"; } };
  main.querySelectorAll("[data-en]").forEach(c => c.onchange = async () => { st.sources[+c.dataset.en].enabled = c.checked; await save(); });
  main.querySelectorAll("[data-rm]").forEach(b => b.onclick = async () => { st.sources.splice(+b.dataset.rm, 1); if (await save()) route(); });
  $("#ts").onclick = async () => {
    $("#add").disabled = true;
    try {
      const r = await post("/api/sources/test", { adapter: $("#ad").value, dir: $("#dr").value.trim(), enabled: true });
      $("#tr").innerHTML = `<div class="banner">识别到 ${r.sessions} 个会话、${r.turns} 轮；${r.failed} 个文件解析失败。<br>能提供：${r.capabilities.map(esc).join("、")}；缺失：${r.missing.map(esc).join("、") || "–"}` +
        (r.errors.length ? "<br>" + r.errors.slice(0, 5).map(e => `<code>${esc(e.File)}</code> — ${esc(e.Reason)}`).join("<br>") : "") + `</div>`;
      $("#add").disabled = r.sessions === 0;
    } catch (e) { $("#tr").innerHTML = `<div class="banner err">${esc(e.message)}</div>`; }
  };
  $("#add").onclick = async () => { st.sources.push({ adapter: $("#ad").value, dir: $("#dr").value.trim(), enabled: true }); if (await save()) route(); };
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
