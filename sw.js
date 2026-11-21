/*
 * عامل خدمة نظام الإشراف (v244)
 * يحفظ هيكل الموقع فقط (ملفات GitHub العامة) ليفتح بسرعة ويعمل كتطبيق على الشاشة الرئيسية.
 * لا يلمس طلبات Apps Script إطلاقاً (البيانات لا تُحفظ هنا أبداً).
 */
var VERSION = 'ishraf-sw-v244-1';
var SHELL = ['/', '/app/', '/app/loader.js', '/app/manifest.webmanifest', '/app/icons/icon-192.png'];

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function networkFirst(request, cacheKey) {
  return fetch(request).then(function (response) {
    if (response && response.ok) {
      var copy = response.clone();
      caches.open(VERSION).then(function (c) { c.put(cacheKey || request, copy); });
    }
    return response;
  }).catch(function () {
    return caches.match(cacheKey || request).then(function (hit) { return hit || caches.match('/app/'); });
  });
}

function staleWhileRevalidate(request) {
  return caches.open(VERSION).then(function (c) {
    return c.match(request).then(function (hit) {
      var fresh = fetch(request).then(function (response) {
        if (response && response.ok) c.put(request, response.clone());
        return response;
      }).catch(function () { return hit; });
      return hit || fresh;
    });
  });
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;
  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // Apps Script والخطوط وغيرها: بلا تدخل.
  if (request.mode === 'navigate') {
    // كل صفحات /app/ هيكل واحد؛ المعاملات تُقرأ داخل الصفحة.
    var key = url.pathname.indexOf('/app/') === 0 ? '/app/' : url.pathname;
    event.respondWith(networkFirst(request, key));
    return;
  }
  if (/^\/app\/(img|icons)\//.test(url.pathname)) { event.respondWith(staleWhileRevalidate(request)); return; }
  if (url.pathname === '/app/loader.js') { event.respondWith(networkFirst(request)); return; }
});
