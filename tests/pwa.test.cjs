// يتحقق أن الموقع قابل للتثبيت كتطبيق (PWA) وأن عامل الخدمة لا يلمس طلبات Apps Script.
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..');

const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  const type = { '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg' }[path.extname(p)] || 'text/html; charset=utf-8';
  res.writeHead(200, { 'Content-Type': type });
  fs.createReadStream(file).pipe(res);
}).listen(0, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext();
    let appsScriptViaSw = 0;
    ctx.on('request', r => { if (r.serviceWorker() && /script\.google/.test(r.url())) appsScriptViaSw++; });
    await ctx.route('https://script.google.com/**', route => route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'application/json', body: '{"__appRpc":true,"ok":true,"value":{"ok":false}}' }));
    const page = await ctx.newPage();
    await page.goto(base + '/app/?page=admin');
    await page.waitForFunction(() => !document.getElementById('ishraf-boot'), null, { timeout: 15000 });
    // بعد استبدال الصفحة يجب أن يبقى رابط التطبيق في رأسها.
    assert.ok(await page.evaluate(() => !!document.querySelector('link[rel="manifest"]')), 'manifest link survives page render');
    await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 15000 }).catch(() => {});
    const cdp = await ctx.newCDPSession(page);
    const m = await cdp.send('Page.getAppManifest');
    assert.ok(m.url.endsWith('/app/manifest.webmanifest'), 'manifest found');
    assert.deepStrictEqual(m.errors, [], 'manifest has no errors');
    const inst = await cdp.send('Page.getInstallabilityErrors');
    assert.deepStrictEqual(inst.installabilityErrors.map(e => e.errorId), [], 'installable as an app');
    // فتح صفحة أخرى بوجود عامل الخدمة يعمل كالمعتاد.
    await page.goto(base + '/app/?page=result');
    await page.waitForFunction(() => !document.getElementById('ishraf-boot'), null, { timeout: 15000 });
    assert.strictEqual(appsScriptViaSw, 0, 'service worker never touches Apps Script requests');
    console.log('PASS: installable PWA (manifest + service worker + icons), Apps Script requests untouched.');
  } finally {
    await browser.close();
    srv.close();
  }
});
