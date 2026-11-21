/*
 * بوابة ishrafquran.com لنظام الإشراف — v244
 * - هيكل الصفحات (HTML عام بلا بيانات) يُعرض من نسخة محفوظة في المتصفح أو من GitHub،
 *   ولا يُطلب من Apps Script إلا إذا لم تتوفر نسخة جاهزة.
 * - كل استدعاءات google.script.run تمر عبر apprpc (قائمة مسموحات في الخادم).
 * - طلب افتتاحي واحد (appboot) يجمع التحقق من الجلسة وبيانات الشاشة بدل عدة طلبات متتالية.
 * - آخر بيانات الشاشة تُحفظ في sessionStorage (هذه النافذة فقط) لعرضها فوراً ثم تحديثها،
 *   وتُمسح عند تسجيل الخروج أو انتهاء الجلسة. البيانات الأصلية تبقى في Google Sheets.
 */
(function () {
  'use strict';

  var PROD_EXEC = 'https://script.google.com/macros/s/AKfycbzpDJKLle8sT7AyxX_EhFNbRkYm2aE4Ztd3dToGb_qaZZwX4YtNMEBc5xBAR5M7aq4r/exec';
  // نشرات اختبار معتمدة فقط (يضيفها صاحب النظام). تُفعَّل بإضافة ?__test=1 للرابط وتُلغى بـ ?__test=0
  // لا يُقبل أي رابط آخر من الرابط أو من المتصفح حتى لا تُوجَّه كلمات المرور إلى خادم غريب.
  var TEST_EXECS = [];

  var ORIGIN = location.origin;
  var HOME = ORIGIN + '/';
  var APP = ORIGIN + '/app/';
  var EXEC_RE = /https:\/\/script\.google\.com\/(?:a\/[^\/"'\s]+\/)?macros\/s\/[\w-]+\/exec(\?[^"'\s<>)`]*)?/g;
  var PUBLIC_PAGES = ['', 'home', 'dashboard', 'main', 'register', 'registration', 'studentregistration',
    'student-registration', 'result', 'studentresult', 'student-result'];
  // معاملات تقرؤها الصفحة داخل المتصفح فقط (لا تغيّر HTML القادم من الخادم).
  var CLIENT_PARAMS = { view: 1, requestId: 1, logout: 1, staff: 1, __test: 1 };
  // في هذه الصفحات "ticket" رمز مرفق يستخدمه الخادم، لا تذكرة تنقّل.
  var SERVER_TICKET_PAGES = ['dataentry', 'data-entry', 'entry'];
  var NAV_TARGETS = ['direct', 'summary', 'executive', 'schedule', 'visits', 'certificates', 'rewards', 'deliveries'];

  var AUTH_FNS = { authPortalConsumeNavigationTicket: 1, securityVerifySupervisorSession: 1, authStaffPortalVerify: 1 };
  // قراءات آمنة يجوز جمعها في الطلب الافتتاحي (الخادم يطبّق القائمة نفسها).
  var BOOT_READS = {
    getSupervisorDashboardStats: 1, getSupervisorTodayTests: 1, getStudentSummaryPortalData: 1,
    getPendingStudentsForDirectTest: 1, getFieldVisits: 1, getFieldVisitOptions: 1,
    getFieldVisitExamData: 1, getExecutiveReports: 1, getExecutiveReportData: 1, getAuthorizedExecutiveReportData: 1,
    getCertificateDeliveryData: 1, getRewardDeliveryData: 1, getCombinedDeliveryData: 1
  };
  // لا تُعرض من المحفوظ أبداً: قوائم يجب أن تكون حيّة لحظة العمل (مباشرة الاختبار).
  var NO_STALE = { getPendingStudentsForDirectTest: 1 };
  var LOGOUT_FNS = { authStaffPortalLogout: 1, authPortalLogout: 1 };

  var PAGE_PREFIX = 'ishraf:page:v2:';
  var BOOT_PREFIX = 'ishraf:boot:v1:';
  var DATA_PREFIX = 'ishraf:data:v1:';
  var NAV_PREFIX = 'ishraf:nav:v1:';
  var TOKEN_KEY = 'studentExamAuthToken';

  /* ---------- أدوات تخزين آمنة ---------- */
  function store(kind) {
    try { var s = window[kind]; var k = '__ishraf_t'; s.setItem(k, '1'); s.removeItem(k); return s; } catch (e) { return null; }
  }
  var LS = store('localStorage');
  var SS = store('sessionStorage');
  function sget(s, k) { try { return s ? s.getItem(k) : null; } catch (e) { return null; } }
  function sset(s, k, v) { try { if (s) s.setItem(k, v); return !!s; } catch (e) { return false; } }
  function sdel(s, k) { try { if (s && k) s.removeItem(k); } catch (e) {} }
  function skeys(s, prefix) {
    var out = [];
    try { if (s) for (var i = 0; i < s.length; i++) { var k = s.key(i); if (k && k.indexOf(prefix) === 0) out.push(k); } } catch (e) {}
    return out;
  }
  function jget(s, k) { var raw = sget(s, k); if (!raw) return null; try { return JSON.parse(raw); } catch (e) { return null; } }
  function log() {
    if (sget(LS, 'ishraf:debug') !== '1') return;
    try { console.info.apply(console, ['[ishraf]'].concat([].slice.call(arguments))); } catch (e) {}
  }

  /* ---------- اختيار الخادم ---------- */
  var EXEC = PROD_EXEC;
  var TEST_MODE = false;
  (function () {
    var q = new URLSearchParams(location.search).get('__test');
    if (q === '0') sdel(SS, 'ishraf:test');
    else if (q === '1' && TEST_EXECS.length) sset(SS, 'ishraf:test', '1');
    if (sget(SS, 'ishraf:test') === '1' && TEST_EXECS.length) { EXEC = TEST_EXECS[0]; TEST_MODE = true; }
  })();
  if (TEST_MODE) { PAGE_PREFIX = 'ishraf:page:test:'; BOOT_PREFIX = 'ishraf:boot:test:'; DATA_PREFIX = 'ishraf:data:test:'; }
  var BOOT_OFF_KEY = 'ishraf:noboot:' + EXEC.slice(-16);
  var BOOT_OFF_RETRY = 60 * 60 * 1000;

  function mapUrl(match, query) { return query ? APP + query : HOME; }
  function mapString(s) { return typeof s === 'string' ? s.replace(EXEC_RE, mapUrl) : s; }
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

  function hash(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
  }

  function randomId(n) {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    var bytes = new Uint8Array(n);
    window.crypto.getRandomValues(bytes);
    var out = '';
    for (var i = 0; i < n; i++) out += chars.charAt(bytes[i] % chars.length);
    return out;
  }

  /* ==========================================================
   * حالة الجلسة داخل المتصفح
   * ========================================================== */
  var STATE = {
    page: '',
    ticket: '',          // تذكرة التنقّل في الرابط (إن وُجدت)
    tokens: {},          // رموز الجلسة المعروفة (لاستبدالها بـ $TOKEN عند المقارنة)
    boot: null,          // { planned, used, results, promise }
    record: [],
    recording: true,
    interactedAt: 0,
    stalePending: 0,
    generation: 0        // يزيد عند الخروج؛ الردود المتأخرة من جلسة سابقة لا تُحفظ.
  };

  function storedToken() {
    return sget(LS, TOKEN_KEY) || sget(SS, TOKEN_KEY) || '';
  }

  function knowToken(t) {
    if (typeof t === 'string' && t.length >= 16) STATE.tokens[t] = 1;
  }

  // صيغة ثابتة للمعاملات: رمز الجلسة ← $TOKEN، تذكرة الرابط ← $TICKET.
  function normalizeArgs(args) {
    return (args || []).map(function (a) {
      if (typeof a !== 'string') return a === undefined ? null : a;
      if (STATE.tokens[a]) return '$TOKEN';
      if (STATE.ticket && a === STATE.ticket) return '$TICKET';
      return a;
    });
  }

  function tokenOf(args) {
    for (var i = 0; i < (args || []).length; i++) if (typeof args[i] === 'string' && STATE.tokens[args[i]]) return args[i];
    return '';
  }

  /* ---------- تذاكر تنقّل محلية ----------
   * بدل طلب تذكرة من الخادم قبل كل انتقال (ثانيتان)، تُنشأ تذكرة عشوائية محلياً تشير إلى رمز الجلسة
   * المحفوظ أصلاً في هذا المتصفح. الصفحة التالية تتحقق من الجلسة لدى الخادم كالمعتاد. */
  var LOCAL_TICKET_RE = /^Lk[A-Za-z0-9]{40}$/;
  var NAV_TTL = 60 * 60 * 1000;

  function navCreate(token, target) {
    skeys(LS, NAV_PREFIX).forEach(function (k) { var d = jget(LS, k); if (!d || d.exp < Date.now()) sdel(LS, k); });
    var ticket = 'Lk' + randomId(40);
    if (!sset(LS, NAV_PREFIX + ticket, JSON.stringify({ token: token, target: target, exp: Date.now() + NAV_TTL }))) return '';
    return ticket;
  }

  function navGet(ticket) {
    if (!LOCAL_TICKET_RE.test(String(ticket || ''))) return null;
    var d = jget(LS, NAV_PREFIX + ticket);
    if (!d || !d.token || d.exp < Date.now()) return null;
    return d;
  }

  /* ---------- مسح البيانات المحفوظة (خروج / انتهاء جلسة) ---------- */
  function wipeSessionData() {
    STATE.generation++;
    skeys(SS, DATA_PREFIX).forEach(function (k) { sdel(SS, k); });
    skeys(LS, NAV_PREFIX).forEach(function (k) { sdel(LS, k); });
  }

  /* ==========================================================
   * عرض فوري لآخر بيانات (sessionStorage) ثم تحديثها
   * ========================================================== */
  var STALE_MAX_AGE = 30 * 60 * 1000;

  function staleKey(name, args, normKey) {
    if (NO_STALE[name] || !(AUTH_FNS[name] || BOOT_READS[name])) return null;
    var t = tokenOf(args);
    if (!t) return null; // بيانات المنسوبين فقط، ومربوطة ببصمة الجلسة الحالية.
    return DATA_PREFIX + hash(t) + ':' + name + ':' + hash(normKey);
  }

  function staleGet(key) {
    var d = key ? jget(SS, key) : null;
    if (!d || Date.now() - d.t > STALE_MAX_AGE) return null;
    return d;
  }

  function stalePut(key, value) {
    if (!key) return;
    var text;
    try { text = JSON.stringify({ t: Date.now(), v: value }); } catch (e) { return; }
    if (text.length > 1500000) return;
    if (!sset(SS, key, text)) {
      skeys(SS, DATA_PREFIX).forEach(function (k) { sdel(SS, k); });
      sset(SS, key, text);
    }
  }

  function authFailed(v) {
    return !v || v.ok === false || v.authenticated === false;
  }

  /* ---------- مؤشرات صغيرة ---------- */
  function updatingBadge(show) {
    try {
      var el = document.getElementById('ishraf-updating');
      if (!show) { if (el) el.parentNode.removeChild(el); return; }
      if (el || !document.body) return;
      el = document.createElement('div');
      el.id = 'ishraf-updating';
      el.setAttribute('role', 'status');
      el.textContent = 'جارٍ تحديث البيانات…';
      el.style.cssText = 'position:fixed;bottom:12px;left:12px;z-index:2147483000;background:rgba(31,59,77,.88);color:#fff;' +
        'font:13px/1.4 Tahoma,Arial,sans-serif;padding:6px 12px;border-radius:999px;pointer-events:none;direction:rtl';
      document.body.appendChild(el);
    } catch (e) {}
  }

  function testBadge() {
    if (!TEST_MODE) return;
    try {
      var el = document.createElement('div');
      el.textContent = 'نسخة تجريبية';
      el.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483000;background:#b4232c;color:#fff;font:12px Tahoma,Arial,sans-serif;' +
        'padding:3px 10px;border-bottom-right-radius:8px;pointer-events:none';
      document.body.appendChild(el);
    } catch (e) {}
  }

  /* ==========================================================
   * الطلب الافتتاحي الموحّد (appboot)
   * تتعلّم الصفحة تسلسل استدعاءاتها الأولى (التحقق ثم البيانات)، وفي الفتح التالي
   * تُرسلها كلها في طلب واحد ينفّذها الخادم بالترتيب.
   * ========================================================== */
  function bootDisabled() {
    var t = Number(sget(LS, BOOT_OFF_KEY) || 0);
    return t && Date.now() - t < BOOT_OFF_RETRY;
  }

  function startBoot(page, nav) {
    if (bootDisabled()) return;
    var d = jget(LS, BOOT_PREFIX + page);
    var rec = d && Array.isArray(d.calls) ? d.calls : null;
    if (!rec || !rec.length) return;
    var token = nav ? nav.token : storedToken();
    var calls = [];
    for (var i = 0; i < rec.length && calls.length < 8; i++) {
      var c = rec[i];
      if (!c || !(AUTH_FNS[c.fn] || BOOT_READS[c.fn]) || !Array.isArray(c.args)) continue;
      var text = JSON.stringify(c.args);
      if (c.fn === 'authPortalConsumeNavigationTicket' && nav) {
        // التذكرة محلية: يكفي التحقق من الجلسة نفسها.
        calls.push({ fn: 'securityVerifySupervisorSession', args: ['$TOKEN'] });
        continue;
      }
      if (text.indexOf('"$TICKET"') !== -1 && !STATE.ticket) return;
      if (text.indexOf('"$TOKEN"') !== -1 && !token && !STATE.ticket) return;
      calls.push({ fn: c.fn, args: c.args });
    }
    if (!calls.length) return;
    var boot = {
      planned: calls.map(function (c) { return c.fn + '|' + JSON.stringify(c.args); }),
      used: {},
      results: null
    };
    var t0 = Date.now();
    boot.promise = post({ action: 'appboot', token: token, ticket: nav ? '' : STATE.ticket, calls: calls })
      .then(function (res) {
        if (res && res.code === 'UNKNOWN_ACTION') { sset(LS, BOOT_OFF_KEY, String(Date.now())); throw new Error('appboot unsupported'); }
        if (!res || !res.ok || !Array.isArray(res.results)) throw new Error('bad appboot');
        if (res.token) knowToken(res.token);
        boot.results = res.results;
        log('appboot ' + (Date.now() - t0) + 'ms, ' + calls.length + ' calls');
      });
    boot.promise.catch(function (e) { log('appboot failed', e && e.message); });
    STATE.boot = boot;
  }

  // نتيجة الاستدعاء من الطلب الافتتاحي إن كان مخططاً له (تُستخدم مرة واحدة)، وإلا null.
  function bootLookup(name, normKey) {
    var boot = STATE.boot;
    if (!boot) return null;
    var id = name + '|' + normKey;
    var idx = -1;
    for (var i = 0; i < boot.planned.length; i++) if (boot.planned[i] === id && !boot.used[i]) { idx = i; break; }
    if (idx === -1) return null;
    boot.used[idx] = 1;
    return boot.promise.then(function () {
      var r = boot.results[idx];
      if (!r || r.skipped) throw new Error('skipped');
      return r;
    });
  }

  function rpc(name, args) {
    var t0 = Date.now();
    return post({ action: 'apprpc', fn: name, args: args }).then(function (d) {
      log('rpc ' + name + ' ' + (Date.now() - t0) + 'ms' + (d && d.cached ? ' (cache)' : ''));
      if (d && d.__appRpc) {
        if (d.ok) return d.value;
        throw new Error(d.error || 'تعذر تنفيذ الطلب.');
      }
      return d;
    });
  }

  // من الطلب الافتتاحي إن أمكن، وإلا طلب مستقل.
  function serverCall(name, args, normKey) {
    var fromBoot = bootLookup(name, normKey);
    if (!fromBoot) return rpc(name, args);
    return fromBoot.then(function (r) {
      if (r.ok) return r.value;
      throw new Error(r.error || 'تعذر تنفيذ الطلب.');
    }, function () { return rpc(name, args); });
  }

  function recordCall(name, args) {
    if (!STATE.recording || !(AUTH_FNS[name] || BOOT_READS[name]) || STATE.record.length >= 8) return;
    var norm = normalizeArgs(args);
    if (JSON.stringify(norm).length > 1500) return;
    STATE.record.push({ fn: name, args: norm });
    // يُحفظ التسلسل فقط إذا وصل إلى طلب بيانات (أي أن الدخول نجح).
    if (STATE.record.some(function (c) { return BOOT_READS[c.fn]; })) {
      sset(LS, BOOT_PREFIX + STATE.page, JSON.stringify({ t: Date.now(), calls: STATE.record }));
    }
  }

  /* ==========================================================
   * بديل google.script.run
   * ========================================================== */
  function deliver(fn, value, userObject) {
    if (fn) setTimeout(function () { fn(value, userObject); }, 0);
  }

  function track(value) {
    if (value && typeof value === 'object' && typeof value.token === 'string') knowToken(value.token);
    return value;
  }

  function callWithStale(name, args, ok, fail, userObject) {
    var normKey = JSON.stringify(normalizeArgs(args));
    var key = staleKey(name, args, normKey);
    var stale = staleGet(key);
    var servedStale = false;
    var staleText = '';
    if (stale) {
      servedStale = true;
      staleText = JSON.stringify(stale.v);
      STATE.stalePending++;
      updatingBadge(true);
      deliver(ok, track(mapDeep(stale.v)), userObject);
      log('stale ' + name);
    }
    function settle() {
      STATE.stalePending = Math.max(0, STATE.stalePending - 1);
      if (!STATE.stalePending) updatingBadge(false);
    }
    var startedAt = Date.now();
    var generation = STATE.generation;
    serverCall(name, args, normKey).then(function (value) {
      value = value === undefined ? null : value;
      if (generation !== STATE.generation) key = null;
      if (AUTH_FNS[name] && authFailed(value)) {
        sdel(SS, key);
        if (servedStale) {
          // عُرض من المحفوظ ثم تبيّن أن الجلسة انتهت: نمسح كل شيء ونعيد فتح الصفحة.
          wipeSessionData();
          location.reload();
          return;
        }
      } else {
        stalePut(key, value);
      }
      if (!servedStale) { deliver(ok, track(mapDeep(value)), userObject); return; }
      settle();
      var changed = JSON.stringify(value) !== staleText;
      var touched = STATE.interactedAt > startedAt;
      // لا نعيد الرسم إذا بدأ المستخدم العمل على الشاشة، ولا لنتائج التحقق (الجلسة صالحة).
      if (changed && !touched && !AUTH_FNS[name]) deliver(ok, track(mapDeep(value)), userObject);
    }, function (err) {
      if (servedStale) { settle(); return; }
      if (fail) deliver(fail, err, userObject); else console.error(err);
    });
  }

  function consumeLocalTicket(ticket, target, ok, fail, userObject) {
    var nav = navGet(ticket);
    if (!nav) {
      deliver(ok, { ok: false, authenticated: false, message: 'انتهت صلاحية رابط الدخول. افتح الصفحة من بوابة النظام.' }, userObject);
      return;
    }
    if (String(nav.target) !== String(target || '').trim().toLowerCase()) {
      deliver(ok, { ok: false, authenticated: false, message: 'رابط الدخول لا يخص هذه الصفحة أو انتهت صلاحيته.' }, userObject);
      return;
    }
    knowToken(nav.token);
    callWithStale('securityVerifySupervisorSession', [nav.token], function (s) {
      if (authFailed(s)) {
        deliver(ok, { ok: false, authenticated: false, message: (s && s.message) || 'انتهت الجلسة. سجّل الدخول من جديد.' }, userObject);
        return;
      }
      deliver(ok, {
        ok: true, authenticated: true, token: nav.token, role: s.role || '',
        displayName: s.displayName || s.name || s.identifier || '', identifier: s.identifier || ''
      }, userObject);
    }, fail, userObject);
  }

  function makeRunner(ok, fail, userObject) {
    return new Proxy({}, {
      get: function (_, name) {
        if (name === 'withSuccessHandler') return function (f) { return makeRunner(f, fail, userObject); };
        if (name === 'withFailureHandler') return function (f) { return makeRunner(ok, f, userObject); };
        if (name === 'withUserObject') return function (o) { return makeRunner(ok, fail, o); };
        if (typeof name !== 'string' || name === 'then') return undefined;
        return function () {
          var args = Array.prototype.slice.call(arguments);
          if (name === 'getSystemWebAppUrl') { deliver(ok, APP, userObject); return; }

          if (name === 'authPortalCreateNavigationTicket') {
            var target = String(args[1] || '').trim().toLowerCase();
            var ticket = args[0] && NAV_TARGETS.indexOf(target) !== -1 ? navCreate(String(args[0]), target) : '';
            if (ticket) {
              knowToken(String(args[0]));
              deliver(ok, { ok: true, authenticated: true, ticket: ticket,
                url: APP + '?page=' + encodeURIComponent(target) + '&ticket=' + encodeURIComponent(ticket) }, userObject);
              return;
            }
          }

          if (AUTH_FNS[name] && typeof args[0] === 'string' && name !== 'authPortalConsumeNavigationTicket') knowToken(args[0]);
          recordCall(name, args);

          if (name === 'authPortalConsumeNavigationTicket' && LOCAL_TICKET_RE.test(String(args[0] || ''))) {
            consumeLocalTicket(String(args[0]), args[1], ok, fail, userObject);
            return;
          }

          if (LOGOUT_FNS[name]) {
            wipeSessionData();
            rpc(name, args).then(function (v) { deliver(ok, mapDeep(v), userObject); },
              function (e) { if (fail) deliver(fail, e, userObject); });
            return;
          }

          callWithStale(name, args, ok, fail, userObject);
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

  function injectTicket(html, ticket) {
    return html.replace(/((?:NAV_TICKET|EMBEDDED_NAVIGATION_TICKET)\s*=\s*)(["'])\2/g, function (m, pre, q) {
      return pre + q + ticket + q;
    });
  }

  var rendered = false;
  function render(html, title) {
    if (rendered) return;
    // لا يصح استبدال الصفحة أثناء قراءة المتصفح لها، فننتظر اكتمال قراءة الهيكل.
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { render(html, title); }, { once: true });
      return;
    }
    rendered = true;
    html = mapString(html);
    if (STATE.ticket) html = injectTicket(html, STATE.ticket);
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
    // document.open يمسح المستمعين السابقين، فنثبّتها بعد العرض.
    var mark = function () { STATE.interactedAt = Date.now(); STATE.recording = false; };
    ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) {
      document.addEventListener(ev, mark, { capture: true, passive: true });
    });
    setTimeout(function () { STATE.recording = false; }, 25000);
    testBadge();
  }

  /* ---------- نسخ الصفحات ---------- */
  var SNAPSHOT_PAGES = ['', 'admin', 'register', 'result', 'dataentry', 'direct', 'summary', 'rewards',
    'deliveries', 'certificates', 'visits', 'executive', 'schedule'];
  var PAGE_ALIASES = {
    home: '', dashboard: '', main: '', login: 'admin', supervisor: 'admin', registration: 'register',
    studentregistration: 'register', 'student-registration': 'register', studentresult: 'result',
    'student-result': 'result', 'data-entry': 'dataentry', entry: 'dataentry', directtest: 'direct',
    'direct-test': 'direct', studentsummary: 'summary', 'student-summary': 'summary',
    'certificate-delivery': 'certificates', 'field-visits': 'visits', 'executive-report': 'executive',
    'today-tests': 'schedule', 'tests-schedule': 'schedule'
  };

  function canonicalPage(page) {
    return Object.prototype.hasOwnProperty.call(PAGE_ALIASES, page) ? PAGE_ALIASES[page] : page;
  }

  function fetchSnapshot(page) {
    if (TEST_MODE || SNAPSHOT_PAGES.indexOf(page) === -1) return Promise.reject(new Error('no snapshot'));
    return fetch(ORIGIN + '/app/pages/' + (page || 'home') + '.json', { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error('no snapshot'); return r.json(); })
      .then(function (d) {
        if (!d || typeof d.html !== 'string') throw new Error('bad snapshot');
        return { html: d.html, title: d.title || '' };
      });
  }

  function fetchPage(params) {
    return post({ action: 'apppage', params: params }).then(function (d) {
      if (!d || !d.ok || typeof d.html !== 'string') throw new Error((d && d.message) || 'استجابة غير متوقعة');
      return { html: d.html, title: d.title || '' };
    });
  }

  // يُحفظ HTML الصفحة فقط (عام ومتاح لأي زائر)، ولا تُحفظ فيه بيانات طلاب أو جلسات.
  function cacheKey(serverParams) {
    var keys = Object.keys(serverParams);
    for (var i = 0; i < keys.length; i++) if (keys[i] !== 'page') return null;
    return PAGE_PREFIX + canonicalPage(String(serverParams.page || '').trim().toLowerCase());
  }

  function cacheGet(key) {
    var d = key ? jget(LS, key) : null;
    return d && typeof d.html === 'string' ? d : null;
  }

  function cacheSet(key, d) {
    if (!key || !d) return;
    var text = JSON.stringify({ html: d.html, title: d.title, t: Date.now() });
    if (!sset(LS, key, text)) {
      skeys(LS, 'ishraf:page:').forEach(function (k) { sdel(LS, k); });
      sset(LS, key, text);
    }
  }

  // تحديث النسخة المحفوظة: من GitHub (سريع ولا يشغل Apps Script)، وApps Script عند الحاجة فقط.
  var REFRESH_FROM_SERVER_AFTER = 6 * 60 * 60 * 1000;
  function refreshCached(page, serverParams, key, cached) {
    fetchSnapshot(page).catch(function () {
      if (!TEST_MODE && Date.now() - (cached.t || 0) < REFRESH_FROM_SERVER_AFTER) throw new Error('fresh enough');
      return fetchPage(serverParams);
    }).then(function (d) { cacheSet(key, d); }).catch(function () {});
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
          if (ks.length === 1 && ks[0] === 'page') page = canonicalPage(String(u.searchParams.get('page')).toLowerCase());
          else if (!ks.length) page = '';
        }
        if (page !== null && pages.indexOf(page) === -1) pages.push(page);
      });
    } catch (e) {}
    return pages;
  }

  function schedulePrefetch() {
    setTimeout(function () {
      var queue = linkedPages().filter(function (p) { return !cacheGet(PAGE_PREFIX + p); }).slice(0, 6);
      (function next() {
        if (!queue.length) return;
        var p = queue.shift();
        fetchSnapshot(p)
          .then(function (d) { cacheSet(PAGE_PREFIX + p, d); })
          .catch(function () {})
          .then(function () { setTimeout(next, 300); });
      })();
    }, 2500);
  }

  /* ==========================================================
   * البدء
   * ========================================================== */
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

    // معاملات الخادم فقط تحدد نسخة الصفحة؛ التذكرة والمعاملات الأخرى تُقرأ داخل المتصفح.
    var serverParams = {};
    Object.keys(params).forEach(function (k) {
      if (CLIENT_PARAMS[k]) return;
      if (k === 'ticket' && SERVER_TICKET_PAGES.indexOf(page) === -1 && /^[A-Za-z0-9]{8,300}$/.test(String(params.ticket))) {
        STATE.ticket = String(params.ticket);
        return;
      }
      serverParams[k] = params[k];
    });

    STATE.page = canonicalPage(page);
    var stored = storedToken();
    if (stored) knowToken(stored);
    var nav = STATE.ticket ? navGet(STATE.ticket) : null;
    if (nav) knowToken(nav.token);
    // لا جلسة ولا تذكرة: لا تبقى أي بيانات محفوظة من جلسة سابقة.
    if (!stored && !STATE.ticket) wipeSessionData();

    // الطلب الافتتاحي يبدأ فوراً بالتوازي مع عرض الصفحة.
    startBoot(STATE.page, nav);

    var key = cacheKey(serverParams);
    var cached = cacheGet(key);
    if (cached) {
      render(cached.html, cached.title);
      refreshCached(STATE.page, serverParams, key, cached);
      schedulePrefetch();
      return;
    }

    var snap = key ? fetchSnapshot(STATE.page) : Promise.reject(new Error('no snapshot'));
    snap.catch(function () { return fetchPage(serverParams); })
      .then(function (d) {
        if (key) cacheSet(key, d);
        render(d.html, d.title);
        schedulePrefetch();
      })
      .catch(function () {
        showMessage('تعذر تحميل الصفحة', 'تحقق من الاتصال بالإنترنت ثم أعد المحاولة.', true);
      });
  }

  start();
})();
