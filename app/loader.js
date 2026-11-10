/*
 * بوابة ishrafquran.com لنظام الإشراف
 * - الصفحات تُطلب من Apps Script لحظة الفتح (apppage) فتظهر دائماً بآخر نسخة منشورة.
 * - كل استدعاءات google.script.run تمر عبر apprpc (قائمة مسموحات في الخادم).
 * - البيانات لا تُخزَّن هنا؛ تبقى في Google Sheets.
 */
(function () {
  'use strict';

  var EXEC = 'https://script.google.com/macros/s/AKfycbzpDJKLle8sT7AyxX_EhFNbRkYm2aE4Ztd3dToGb_qaZZwX4YtNMEBc5xBAR5M7aq4r/exec';
  var ORIGIN = location.origin;
  var HOME = ORIGIN + '/';
  var APP = ORIGIN + '/app/';
  var EXEC_RE = /https:\/\/script\.google\.com\/(?:a\/[^\/"'\s]+\/)?macros\/s\/[\w-]+\/exec(\?[^"'\s<>)`]*)?/g;
  var PUBLIC_PAGES = ['', 'home', 'dashboard', 'main', 'register', 'registration', 'studentregistration',
    'student-registration', 'result', 'studentresult', 'student-result'];

  function mapUrl(match, query) {
    return query ? APP + query : HOME;
  }

  function mapString(s) {
    return typeof s === 'string' ? s.replace(EXEC_RE, mapUrl) : s;
  }

  function mapDeep(v) {
    if (typeof v === 'string') return mapString(v);
    if (Array.isArray(v)) return v.map(mapDeep);
    if (v && typeof v === 'object') {
      var out = {};
      Object.keys(v).forEach(function (k) { out[k] = mapDeep(v[k]); });
      return out;
    }
    return v;
  }

  function post(body) {
    return fetch(EXEC, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); });
  }

  function currentParams() {
    var p = {};
    new URLSearchParams(location.search).forEach(function (v, k) { p[k] = v; });
    var fixed = window.ISHRAF_FIXED_PARAMS || {};
    Object.keys(fixed).forEach(function (k) { if (!(k in p)) p[k] = fixed[k]; });
    return p;
  }

  /* ---------- بديل google.script.* داخل المتصفح ---------- */
  function makeRunner(ok, fail, userObject) {
    return new Proxy({}, {
      get: function (_, name) {
        if (name === 'withSuccessHandler') return function (f) { return makeRunner(f, fail, userObject); };
        if (name === 'withFailureHandler') return function (f) { return makeRunner(ok, f, userObject); };
        if (name === 'withUserObject') return function (o) { return makeRunner(ok, fail, o); };
        if (typeof name !== 'string' || name === 'then') return undefined;
        return function () {
          var args = Array.prototype.slice.call(arguments);
          if (name === 'getSystemWebAppUrl') {
            setTimeout(function () { if (ok) ok(APP, userObject); }, 0);
            return;
          }
          var t0 = Date.now();
          post({ action: 'apprpc', fn: name, args: args })
            .then(function (d) {
              try { if (localStorage.getItem('ishraf:debug') === '1') console.info('[ishraf-rpc] ' + name + ' ' + (Date.now() - t0) + 'ms'); } catch (e) {}
              if (d && d.__appRpc) {
                if (d.ok) { if (ok) ok(mapDeep(d.value), userObject); }
                else {
                  var err = new Error(d.error || 'تعذر تنفيذ الطلب.');
                  if (fail) fail(err, userObject); else console.error(err);
                }
              } else if (ok) {
                ok(mapDeep(d), userObject);
              }
            })
            .catch(function (e) { if (fail) fail(e, userObject); else console.error(e); });
        };
      }
    });
  }

  function installGoogleShim(win) {
    var noop = function () {};
    win.google = win.google || {};
    win.google.script = {
      run: makeRunner(null, null, undefined),
      url: {
        getLocation: function (cb) {
          var parameter = {}, parameters = {};
          new URLSearchParams(location.search).forEach(function (v, k) {
            parameter[k] = v;
            (parameters[k] = parameters[k] || []).push(v);
          });
          setTimeout(function () {
            cb({ parameter: parameter, parameters: parameters, hash: location.hash.replace(/^#/, '') });
          }, 0);
        }
      },
      host: { close: noop, setHeight: noop, setWidth: noop, origin: ORIGIN, editor: { focus: noop } },
      history: { push: noop, replace: noop, setChangeHandler: noop }
    };
  }

  /* ---------- واجهة التحميل والأخطاء ---------- */
  function showMessage(title, text, retry) {
    var box = document.getElementById('ishraf-boot');
    if (!box) return;
    box.innerHTML =
      '<div class="ib-card"><h1>' + title + '</h1><p>' + text + '</p>' +
      (retry ? '<button type="button" id="ib-retry">إعادة المحاولة</button>' : '') +
      '<a href="' + HOME + '">الصفحة الرئيسية</a></div>';
    var b = document.getElementById('ib-retry');
    if (b) b.onclick = function () { location.reload(); };
  }

  function render(html, title) {
    // لا يصح استبدال الصفحة أثناء قراءة المتصفح لها (يحدث مع النسخة المحفوظة لأنها فورية)،
    // فننتظر حتى تكتمل قراءة الهيكل ثم نعرض.
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { render(html, title); }, { once: true });
      return;
    }
    html = mapString(html);
    // النافذة نفسها تبقى بعد document.open، فنثبّت البديل قبلها ونعيد تثبيته احتياطاً داخل الصفحة.
    window.__ishrafInstall = installGoogleShim;
    installGoogleShim(window);
    var shim = '<script>if(!(window.google&&window.google.script&&window.google.script.run)&&window.__ishrafInstall)' +
      'window.__ishrafInstall(window);<\/script>';
    if (/<head[^>]*>/i.test(html)) html = html.replace(/<head([^>]*)>/i, function (m) { return m + shim; });
    else html = shim + html;
    document.open();
    document.write(html);
    document.close();
    if (title) document.title = title;
  }

  function start() {
    var params = currentParams();
    var page = String(params.page || '').trim().toLowerCase();
    var secure = location.protocol === 'https:' || /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
    if (!secure && PUBLIC_PAGES.indexOf(page) === -1) {
      showMessage('اتصال آمن مطلوب',
        'صفحات منسوبي الجمعية تعمل عبر اتصال آمن (https) فقط لحماية كلمات المرور والبيانات. جرّب الرابط نفسه مع https.',
        false);
      return;
    }
    // صفحات المنسوبين تُفتح برابط فيه تذكرة تنقّل؛ الصفحة نفسها لا تختلف إلا في قيمة التذكرة
    // داخل متغير NAV_TICKET، فنعرض النسخة الجاهزة ونضع التذكرة فيها داخل المتصفح.
    var ticket = null;
    var keysNow = Object.keys(params);
    if (keysNow.indexOf('ticket') !== -1 && keysNow.every(function (k) { return k === 'page' || k === 'ticket'; }) &&
        /^[A-Za-z0-9]{8,300}$/.test(String(params.ticket))) {
      ticket = String(params.ticket);
      params = { page: params.page };
    }
    var key = cacheKey(params);
    var cached = key ? cacheGet(key) : null;
    var fresh = fetchPage(params).then(function (d) {
      if (key) cacheSet(key, d);
      return d;
    });
    if (ticket) {
      var origRender = render;
      render = function (html, title) { origRender(injectTicket(html, ticket), title); };
    }

    if (cached) {
      // عرض فوري من النسخة المحفوظة، وتحديثها في الخلفية للزيارة التالية.
      render(cached.html, cached.title);
      fresh.catch(function () {});
      schedulePrefetch();
      return;
    }

    // أول زيارة: نسخة جاهزة من الصفحة على GitHub (تُحدَّث تلقائياً كل نصف ساعة)،
    // وفي الوقت نفسه نطلب النسخة الحية؛ أيهما وصل أولاً يُعرض.
    var done = false;
    function show(d) {
      if (done || !d) return;
      done = true;
      render(d.html, d.title);
      schedulePrefetch();
    }
    var snap = key ? fetchSnapshot(page) : Promise.reject(new Error('no snapshot'));
    snap.then(show).catch(function () {});
    fresh.then(show).catch(function () {
      snap.catch(function () {
        if (!done) showMessage('تعذر تحميل الصفحة', 'تحقق من الاتصال بالإنترنت ثم أعد المحاولة.', true);
      });
    });
  }

  function injectTicket(html, ticket) {
    return html.replace(/((?:NAV_TICKET|EMBEDDED_NAVIGATION_TICKET)\s*=\s*)(["'])\2/g, function (m, pre, q) {
      return pre + q + ticket + q;
    });
  }

  var SNAPSHOT_PAGES = ['', 'admin', 'register', 'result', 'dataentry', 'direct', 'summary', 'rewards',
    'deliveries', 'certificates', 'visits', 'executive', 'schedule'];

  function fetchSnapshot(page) {
    if (SNAPSHOT_PAGES.indexOf(page) === -1) return Promise.reject(new Error('no snapshot'));
    return fetch(ORIGIN + '/app/pages/' + (page || 'home') + '.json', { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error('no snapshot'); return r.json(); })
      .then(function (d) {
        if (!d || typeof d.html !== 'string') throw new Error('bad snapshot');
        return { html: d.html, title: d.title || '' };
      });
  }

  /* ---------- تسريع: حفظ هيكل الصفحات في المتصفح وتحميل الصفحات التالية مسبقاً ----------
   * يُحفظ HTML الصفحة فقط (وهو عام ومتاح لأي زائر)، ولا تُحفظ أي بيانات طلاب أو جلسات.
   * الصفحات التي في رابطها تذكرة أو رمز دخول لا تُحفظ أبداً. */
  var CACHE_PREFIX = 'ishraf:page:v1:';

  function fetchPage(params) {
    return post({ action: 'apppage', params: params }).then(function (d) {
      if (!d || !d.ok || typeof d.html !== 'string') throw new Error((d && d.message) || 'استجابة غير متوقعة');
      return { html: d.html, title: d.title || '' };
    });
  }

  function cacheKey(params) {
    var keys = Object.keys(params);
    for (var i = 0; i < keys.length; i++) if (keys[i] !== 'page') return null;
    return CACHE_PREFIX + String(params.page || '').trim().toLowerCase();
  }

  function cacheGet(key) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return null;
      var d = JSON.parse(raw);
      return d && typeof d.html === 'string' ? d : null;
    } catch (e) { return null; }
  }

  function cacheSet(key, d) {
    try {
      localStorage.setItem(key, JSON.stringify({ html: d.html, title: d.title, t: Date.now() }));
    } catch (e) {
      try {
        Object.keys(localStorage).forEach(function (k) { if (k.indexOf(CACHE_PREFIX) === 0) localStorage.removeItem(k); });
        localStorage.setItem(key, JSON.stringify({ html: d.html, title: d.title, t: Date.now() }));
      } catch (e2) {}
    }
  }

  function linkedPages() {
    var pages = [];
    try {
      Array.prototype.forEach.call(document.querySelectorAll('a[href]'), function (a) {
        var u = new URL(a.getAttribute('href'), location.href);
        if (u.origin !== ORIGIN) return;
        var page = null;
        if (u.pathname === '/' && !u.search) page = '';
        else if (u.pathname === '/register/') page = 'register';
        else if (u.pathname === '/result/') page = 'result';
        else if (u.pathname === '/app/') {
          var ks = []; u.searchParams.forEach(function (v, k) { ks.push(k); });
          if (ks.length === 1 && ks[0] === 'page') page = u.searchParams.get('page');
          else if (!ks.length) page = '';
        }
        if (page !== null && pages.indexOf(page) === -1) pages.push(page);
      });
    } catch (e) {}
    return pages;
  }

  function schedulePrefetch() {
    setTimeout(function () {
      var queue = linkedPages().filter(function (p) {
        return !cacheGet(CACHE_PREFIX + String(p).toLowerCase());
      }).slice(0, 6);
      (function next() {
        if (!queue.length) return;
        var p = queue.shift();
        var params = p ? { page: p } : {};
        fetchSnapshot(String(p).toLowerCase())
          .catch(function () { return fetchPage(params); })
          .then(function (d) { cacheSet(cacheKey(params), d); })
          .catch(function () {})
          .then(function () { setTimeout(next, 300); });
      })();
    }, 2500);
  }

  start();
})();
