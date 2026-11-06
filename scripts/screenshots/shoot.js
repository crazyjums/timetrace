// 截取 README 用的界面截图。用法：node shoot.js <服务地址> <输出目录>
// 需要 Playwright（npm i -D playwright 或全局安装）。截图为 1280×800、2 倍像素。
const { chromium } = require('playwright');
const [base = 'http://127.0.0.1:8765/', out = 'docs/screenshots'] = process.argv.slice(2);
const U = base.endsWith('/') ? base : base + '/';
const dst = f => require('path').join(out, f);

(async () => {
  const b = await chromium.launch(); const errs = [];
  const mk = async scheme => {
    const c = await b.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: scheme, locale: 'zh-CN' });
    const p = await c.newPage();
    p.on('pageerror', e => errs.push(String(e))); p.on('console', m => m.type() === 'error' && errs.push(m.text()));
    return p;
  };
  // 首次建立索引：演示数据太少，索引一瞬间就建好了，所以拦截状态接口模拟进行中的进度
  const bp = await mk('light');
  await bp.route('**/api/status', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ index: { ready: false, scanning: true, done: 3421, total: 5120, sessions: 0 }, dirs: ['/home/u/.claude/projects'] }) }));
  await bp.goto(U); await bp.waitForSelector('.boot'); await bp.screenshot({ path: dst('indexing.png') });

  const p = await mk('light');
  await p.goto(U); await p.waitForSelector('a.tr'); await p.screenshot({ path: dst('list.png') });
  await p.click('a.tr >> text=登录接口改造'); await p.waitForSelector('.tl');
  await p.click('.blk >> nth=4'); await p.waitForSelector('.span'); await p.screenshot({ path: dst('detail.png') });
  const topOfChat = () => { document.querySelector('#turn-0').scrollIntoView({ block: 'start' }); window.scrollBy(0, -12); };
  await p.goto(U + '#/s/auth-a1'); await p.waitForSelector('.tsep');
  await p.evaluate(() => { document.querySelectorAll('details.tool')[0].open = true; });
  await p.evaluate(topOfChat); await p.waitForTimeout(300); await p.screenshot({ path: dst('session.png') });
  await p.goto(U + '#/today'); await p.waitForSelector('.trow'); await p.waitForTimeout(300); await p.screenshot({ path: dst('today.png') });
  await p.goto(U + '#/insights'); await p.waitForSelector('.rank'); await p.screenshot({ path: dst('insights.png') });
  await p.goto(U + '#/settings'); await p.waitForSelector('.cap'); await p.screenshot({ path: dst('settings.png') });

  const d = await mk('dark');
  await d.goto(U + '#/s/auth-a1'); await d.waitForSelector('.tsep'); await d.evaluate(topOfChat); await d.waitForTimeout(300);
  await d.screenshot({ path: dst('session-dark.png') });

  await b.close();
  if (errs.length) { console.error('页面报错:', errs); process.exit(1); }
  console.log('截图已写入', out);
})();
