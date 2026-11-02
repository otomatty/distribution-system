// 倉庫のタブレット向けの service worker（要件定義書 7章「倉庫の通信」の Should）。
// 発送リスト（/shipping）と入荷予定一覧（/receiving）だけを受け持ち、最後に読み込んだ画面を Cache Storage に
// 1つずつ残して、通信が途切れたときに表示する（読み込んだ時刻は画面に出ている）。
// - 登録は public/assets/app.js が、data-offline-snapshot のある画面で行う。範囲（scope）は /shipping と /receiving だけ
// - 画面は通信を優先し、取れなかったときだけ残しておいた画面を返す。そのとき目印の属性を "cached" に変え、
//   画面に「通信が途切れているため、読み込んだ時刻の内容を表示しています」を出す（app.css・app.js）
// - 残すのは、目印のある正常な HTML の応答だけ（ログイン画面への移動やエラーは残さない）
// - ログアウトすると app.js が Cache Storage を消し、この service worker の登録も外す（共有のタブレットのため）
// - 状態を変える操作（POST）や、ほかの画面には手を出さない
"use strict";

var CACHE = "offline-snapshots-v1";
var PAGES = ["/shipping", "/receiving"];
// 残した画面を表示するのに使うファイル（通信を優先し、取れなければ残しておいたものを使う）
var ASSETS = ["/assets/app.css", "/assets/app.js", "/assets/vendor/htmx.min.js"];
var LIVE = 'data-offline-snapshot="live"';
var CACHED = 'data-offline-snapshot="cached"';

function pageKey(pathname) {
  return new URL(pathname, self.location.origin).href;
}

function isPage(url) {
  return url.origin === self.location.origin && PAGES.indexOf(url.pathname) >= 0;
}

/** 目印のある、正常な同じ生成元の HTML の応答なら残す（見出しは CSP なども含めてそのまま残す） */
function storePage(url, response) {
  var type = response.headers.get("Content-Type") || "";
  if (!response.ok || response.type !== "basic" || response.redirected) return Promise.resolve();
  if (type.indexOf("text/html") !== 0) return Promise.resolve();
  return response.text().then(function (html) {
    if (html.indexOf(LIVE) < 0) return undefined;
    var headers = new Headers(response.headers);
    return caches.open(CACHE).then(function (cache) {
      return cache.put(pageKey(url.pathname), new Response(html, { headers: headers }));
    });
  });
}

function cachedPage(url) {
  return caches
    .open(CACHE)
    .then(function (cache) {
      return cache.match(pageKey(url.pathname));
    })
    .then(function (response) {
      if (!response) return Response.error();
      var headers = new Headers(response.headers);
      return response.text().then(function (html) {
        return new Response(html.replace(LIVE, CACHED), { headers: headers });
      });
    });
}

function networkFirstPage(request, url) {
  return fetch(request).then(
    function (response) {
      // 残す処理は応答を返すのを待たない（失敗しても画面は表示する）
      storePage(url, response.clone()).catch(function () {});
      return response;
    },
    function () {
      return cachedPage(url);
    },
  );
}

/** 絞り込み（htmx）の応答も画面全体なので、最後に読み込んだ内容として残す。通信の失敗は htmx に任せる */
function fetchAndStorePage(request, url) {
  return fetch(request).then(function (response) {
    storePage(url, response.clone()).catch(function () {});
    return response;
  });
}

function networkFirstAsset(request, url) {
  return fetch(request).then(
    function (response) {
      if (response.ok) {
        var copy = response.clone();
        caches
          .open(CACHE)
          .then(function (cache) {
            return cache.put(pageKey(url.pathname), copy);
          })
          .catch(function () {});
      }
      return response;
    },
    function () {
      return caches.match(pageKey(url.pathname)).then(function (cached) {
        return cached || Response.error();
      });
    },
  );
}

self.addEventListener("install", function (event) {
  self.skipWaiting();
  event.waitUntil(
    caches
      .open(CACHE)
      .then(function (cache) {
        return cache.addAll(ASSETS);
      })
      .catch(function () {
        // 通信が悪くても登録は続ける（ファイルは次に読み込んだときに残る）
      }),
  );
});

self.addEventListener("activate", function (event) {
  // 古い版の service worker が残したものは消す（名前の版を上げたとき）
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys
            .filter(function (key) {
              return key.indexOf("offline-snapshots-") === 0 && key !== CACHE;
            })
            .map(function (key) {
              return caches.delete(key);
            }),
        );
      })
      .then(function () {
        return self.clients.claim();
      }),
  );
});

// 初めて開いた画面は、登録の前に読み込んだので残っていない。app.js からの知らせで、その画面を読み直して残す
self.addEventListener("message", function (event) {
  var data = event.data || {};
  if (data.type !== "snapshot" || typeof data.url !== "string") return;
  var url = new URL(data.url, self.location.origin);
  if (!isPage(url)) return;
  event.waitUntil(
    fetch(url.href, { credentials: "same-origin" })
      .then(function (response) {
        return storePage(url, response);
      })
      .catch(function () {}),
  );
});

self.addEventListener("fetch", function (event) {
  var request = event.request;
  if (request.method !== "GET") return;
  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isPage(url)) {
    if (request.mode === "navigate") event.respondWith(networkFirstPage(request, url));
    else if (request.headers.get("HX-Request") === "true")
      event.respondWith(fetchAndStorePage(request, url));
    return;
  }
  if (ASSETS.indexOf(url.pathname) >= 0) event.respondWith(networkFirstAsset(request, url));
});
