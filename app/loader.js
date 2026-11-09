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
          post({ action: 'apprpc', fn: name, args: args })
            .then(function (d) {
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
    if (title && !document.title) document.title = title;
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
    post({ action: 'apppage', params: params })
      .then(function (d) {
        if (!d || !d.ok || typeof d.html !== 'string') throw new Error((d && d.message) || 'استجابة غير متوقعة');
        render(d.html, d.title);
      })
      .catch(function () {
        showMessage('تعذر تحميل الصفحة', 'تحقق من الاتصال بالإنترنت ثم أعد المحاولة.', true);
      });
  }

  start();
})();
