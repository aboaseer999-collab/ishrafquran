// اختبار loader.js في متصفح حقيقي مع خادم Apps Script وهمي (لا يتصل بالنظام الحقيقي).
// التشغيل: node tests/loader.test.cjs
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const DELAY = 300;

function serveStatic() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const file = path.join(ROOT, p);
      if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': p.endsWith('.js') ? 'text/javascript' : p.endsWith('.json') ? 'application/json' : 'text/html; charset=utf-8' });
      fs.createReadStream(file).pipe(res);
    }).listen(0, '127.0.0.1', () => resolve(srv));
  });
}

// صفحات تحاكي تدفق الصفحات الحقيقية: تحقق ثم بيانات.
const PAGES = {
  home: '<!doctype html><html><head><title>home</title></head><body><div id="out">HOME</div></body></html>',
  admin: `<!doctype html><html><head><title>admin</title></head><body><div id="out">...</div><button id="go">visits</button><button id="logout">out</button><script>
    var token = localStorage.getItem('studentExamAuthToken');
    google.script.run.withSuccessHandler(function (s) {
      if (!s || !s.ok) { document.getElementById('out').textContent = 'LOGIN'; return; }
      google.script.run.withSuccessHandler(function (d) { document.getElementById('out').textContent = 'STATS:' + d.n; })
        .getSupervisorDashboardStats(token, {});
    }).authStaffPortalVerify(token);
    document.getElementById('go').onclick = function () {
      google.script.run.withSuccessHandler(function (r) { location.href = r.url; }).authPortalCreateNavigationTicket(token, 'visits');
    };
    document.getElementById('logout').onclick = function () {
      google.script.run.withSuccessHandler(function () { localStorage.removeItem('studentExamAuthToken'); document.getElementById('out').textContent = 'BYE'; })
        .authStaffPortalLogout(token);
    };
  </script></body></html>`,
  visits: `<!doctype html><html><head><title>visits</title></head><body><div id="out">...</div><script>
    var NAV_TICKET = '';
    window.__renders = 0;
    google.script.run.withSuccessHandler(function (res) {
      if (!res || !res.ok) { document.getElementById('out').textContent = 'LOGIN:' + (res && res.message); return; }
      google.script.run.withSuccessHandler(function (d) {
        window.__renders++;
        document.getElementById('out').textContent = 'DATA:' + d.n;
      }).getFieldVisits(res.token, { year: 1447 });
    }).withFailureHandler(function (e) { document.getElementById('out').textContent = 'ERR:' + e.message; })
      .authPortalConsumeNavigationTicket(NAV_TICKET, 'visits');
  </script></body></html>`
};

function mockServer({ appboot }) {
  const state = { counts: {}, total: 0, valid: new Set(['TOKEN-ABCDEFGHIJKLMNOP']), n: 1, log: [] };
  function run(fn, args) {
    if (fn === 'authStaffPortalVerify' || fn === 'securityVerifySupervisorSession') {
      return state.valid.has(args[0]) ? { ok: true, authenticated: true, role: 'admin', displayName: 'مشرف' }
        : { ok: false, authenticated: false, message: 'انتهت الجلسة' };
    }
    if (fn === 'authPortalConsumeNavigationTicket') return { ok: false, authenticated: false, message: 'server ticket' };
    if (fn === 'authStaffPortalLogout') { state.valid.delete(args[0]); return { ok: true }; }
    if (fn === 'getSupervisorDashboardStats' || fn === 'getFieldVisits') {
      if (!state.valid.has(args[0])) return { ok: false, message: 'no session' };
      return { ok: true, n: state.n };
    }
    throw new Error('unexpected ' + fn);
  }
  async function handle(route) {
    const body = JSON.parse(route.request().postData() || '{}');
    state.total++;
    const tag = body.action === 'apprpc' ? 'rpc:' + body.fn : body.action;
    state.counts[tag] = (state.counts[tag] || 0) + 1;
    state.log.push(tag);
    await new Promise(r => setTimeout(r, DELAY));
    let out;
    if (body.action === 'apprpc') {
      try { out = { __appRpc: true, ok: true, value: run(body.fn, body.args) }; } catch (e) { out = { __appRpc: true, ok: false, error: e.message }; }
    } else if (body.action === 'appboot' && appboot) {
      let token = body.token || '';
      let stop = false;
      const results = body.calls.map(c => {
        if (stop) return { skipped: true };
        const args = c.args.map(a => (a === '$TOKEN' ? token : a));
        const v = run(c.fn, args);
        if (/Verify|Consume/.test(c.fn) && (!v || !v.ok)) stop = true;
        return { ok: true, value: v };
      });
      out = { ok: true, results, token: stop ? '' : token };
    } else if (body.action === 'apppage') {
      out = { ok: true, html: PAGES[body.params.page] || '<html><body>?</body></html>', title: 't' };
    } else {
      out = { ok: false, code: 'UNKNOWN_ACTION' };
    }
    await route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }, body: JSON.stringify(out) });
  }
  return { state, handle, reset() { state.counts = {}; state.total = 0; state.log = []; } };
}

async function scenario(browser, base, { appboot }) {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const mock = mockServer({ appboot });
  await ctx.route('https://script.google.com/**', mock.handle);
  await ctx.route('**/app/pages/*.json', route => {
    const name = path.basename(new URL(route.request().url()).pathname, '.json');
    if (!PAGES[name]) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ html: PAGES[name], title: name }) });
  });
  const page = await ctx.newPage();
  const out = () => page.textContent('#out');
  const waitOut = async (prefix, ms = 8000) => {
    await page.waitForFunction(p => { const el = document.getElementById('out'); return el && el.textContent.indexOf(p) === 0; }, prefix, { timeout: ms });
    return out();
  };

  // تسجيل دخول محاكى.
  await page.goto(base + '/app/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('studentExamAuthToken', 'TOKEN-ABCDEFGHIJKLMNOP'); });

  // 1) أول فتح للوحة المشرف: الصفحة من GitHub (لا apppage)، تحقق + بيانات.
  mock.reset();
  await page.goto(base + '/app/?page=admin');
  assert.strictEqual(await waitOut('STATS:'), 'STATS:1');
  assert.ok(!mock.state.counts.apppage, 'no apppage when snapshot exists');
  assert.strictEqual(mock.state.total, 2, 'first admin open: verify + data = ' + mock.state.log);

  // 2) فتح الزيارات من اللوحة: التذكرة محلية (بلا طلب)، ثم تحقق + بيانات.
  mock.reset();
  await page.click('#go');
  await page.waitForURL(/page=visits&ticket=Lk/);
  assert.strictEqual(await waitOut('DATA:'), 'DATA:1');
  assert.ok(!mock.state.counts['rpc:authPortalCreateNavigationTicket'], 'ticket must be local');
  assert.ok(!mock.state.counts['rpc:authPortalConsumeNavigationTicket'], 'local ticket not sent to server');
  assert.strictEqual(mock.state.total, 2, 'first visits open = ' + mock.state.log);

  // 3) فتح الزيارات مرة ثانية: عرض فوري من المحفوظ، وطلب واحد فقط (appboot) إن كان الخادم يدعمه.
  await page.goto(base + '/app/?page=admin');
  await waitOut('STATS:');
  mock.reset();
  mock.state.n = 2;
  const t0 = Date.now();
  await page.click('#go');
  await page.waitForURL(/page=visits/);
  const first = await waitOut('DATA:');
  const instantMs = Date.now() - t0;
  assert.strictEqual(first, 'DATA:1', 'stale data shown first');
  assert.ok(instantMs < DELAY, 'stale data should appear before any server reply (took ' + instantMs + 'ms)');
  assert.strictEqual(await waitOut('DATA:2'), 'DATA:2', 'fresh data replaces stale');
  await page.waitForTimeout(DELAY * 3);
  if (appboot) assert.deepStrictEqual(mock.state.log, ['appboot'], 'one request: ' + mock.state.log);
  else assert.ok(mock.state.counts.appboot === 1 && mock.state.total === 3, 'fallback when appboot unsupported: ' + mock.state.log);
  assert.strictEqual(await page.evaluate(() => window.__renders), 2);
  assert.strictEqual(await page.evaluate(() => !!document.getElementById('ishraf-updating')), false, 'updating badge removed');

  // 4) تسجيل الخروج يمسح البيانات المحفوظة والتذاكر المحلية.
  await page.goto(base + '/app/?page=admin');
  await waitOut('STATS:');
  const visitsUrl = await page.evaluate(() => new Promise(res => google.script.run.withSuccessHandler(r => res(r.url)).authPortalCreateNavigationTicket(localStorage.getItem('studentExamAuthToken'), 'visits')));
  await page.click('#logout');
  await waitOut('BYE');
  const leftovers = await page.evaluate(() => Object.keys(sessionStorage).filter(k => k.indexOf('ishraf:data:') === 0).length +
    Object.keys(localStorage).filter(k => k.indexOf('ishraf:nav:') === 0).length);
  assert.strictEqual(leftovers, 0, 'session data wiped on logout');
  await page.goto(visitsUrl);
  assert.match(await waitOut('LOGIN:'), /انتهت صلاحية رابط الدخول/);

  // 5) جلسة انتهت في الخادم بينما البيانات محفوظة: تُعرض لحظة ثم تُمسح ويظهر طلب الدخول.
  await page.evaluate(() => localStorage.setItem('studentExamAuthToken', 'TOKEN-ABCDEFGHIJKLMNOP'));
  mock.state.valid.add('TOKEN-ABCDEFGHIJKLMNOP');
  await page.goto(base + '/app/?page=admin');
  await waitOut('STATS:');
  await page.click('#go');
  await page.waitForURL(/page=visits/);
  await waitOut('DATA:');
  await page.goto(base + '/app/?page=admin');
  await waitOut('STATS:');
  mock.state.valid.clear();
  await page.click('#go');
  await page.waitForURL(/page=visits/);
  assert.match(await waitOut('LOGIN:', 10000), /انتهت (الجلسة|صلاحية رابط الدخول)/);
  const stale = await page.evaluate(() => Object.keys(sessionStorage).filter(k => k.indexOf('ishraf:data:') === 0).length);
  assert.strictEqual(stale, 0, 'stale data wiped after server says session ended');

  await ctx.close();
}

(async () => {
  const srv = await serveStatic();
  const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch();
  try {
    await scenario(browser, base, { appboot: true });
    console.log('PASS: v244 server — snapshot pages, local tickets, one appboot request, instant stale data, logout wipe.');
    await scenario(browser, base, { appboot: false });
    console.log('PASS: v243 server (no appboot) — loader falls back and everything still works.');
  } finally {
    await browser.close();
    srv.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
