// 画面の補助スクリプト。htmx で足りない部分だけをここに置く。
// - 通信が途切れたときの表示と再送信（同じ受付番号で送り直すので二重登録にならない）
// - 入力途中の内容を端末に下書きとして保存（data-draft を付けたフォーム）
// - 数量の「−」「＋」ボタン（タブレット向け）
// - ダイアログ（商品選択など）の開閉。<dialog> の showModal は htmx ではできないため
// - 明細の行を外すボタン（倉庫の Wi-Fi が途切れても使えるよう、通信せずに消す）
(function () {
  "use strict";

  var DRAFT_PREFIX = "draft:";
  var banner = document.getElementById("offline-banner");
  var retryButton = document.getElementById("offline-retry");
  var failedElement = null;

  function safeStorage() {
    try {
      var s = window.localStorage;
      var probe = "__probe__";
      s.setItem(probe, "1");
      s.removeItem(probe);
      return s;
    } catch {
      return null;
    }
  }
  var storage = safeStorage();

  // ---- 通信断の表示と再送信 ----------------------------------------------------
  function showOffline(canRetry) {
    if (!banner) return;
    banner.hidden = false;
    if (retryButton) retryButton.hidden = !canRetry;
  }
  function hideOffline() {
    if (!banner) return;
    banner.hidden = true;
    if (retryButton) retryButton.hidden = true;
  }

  window.addEventListener("offline", function () {
    showOffline(failedElement !== null);
  });
  window.addEventListener("online", function () {
    if (failedElement === null) hideOffline();
  });

  if (retryButton) {
    retryButton.addEventListener("click", function () {
      var el = failedElement;
      if (!el || !window.htmx) return;
      failedElement = null;
      hideOffline();
      if (el.tagName === "FORM") window.htmx.trigger(el, "submit");
      else window.htmx.trigger(el, "click");
    });
  }

  document.addEventListener("htmx:sendError", function (event) {
    failedElement = event.detail.elt || null;
    showOffline(true);
  });
  document.addEventListener("htmx:timeout", function (event) {
    failedElement = event.detail.elt || null;
    showOffline(true);
  });
  document.addEventListener("htmx:afterRequest", function (event) {
    if (event.detail.successful) {
      failedElement = null;
      hideOffline();
    }
  });
  document.addEventListener("htmx:responseError", function (event) {
    var xhr = event.detail.xhr;
    if (xhr && xhr.status === 401) return; // ログインし直し（HX-Redirect で移動する）
    var message = xhr && xhr.responseText ? xhr.responseText : "エラーが発生しました";
    if (message.length > 300)
      message = "エラーが発生しました。時間をおいてもう一度お試しください。";
    showToast(message);
  });

  function showToast(message) {
    var el = document.createElement("div");
    el.className = "alert alert-error";
    el.setAttribute("role", "alert");
    el.style.position = "fixed";
    el.style.right = "1rem";
    el.style.bottom = "1rem";
    el.style.zIndex = "50";
    el.style.maxWidth = "28rem";
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(function () {
      el.remove();
    }, 6000);
  }

  // ---- htmx の設定 ------------------------------------------------------------
  document.addEventListener("DOMContentLoaded", function () {
    if (!window.htmx) return;
    window.htmx.config.timeout = 20000;
    window.htmx.config.historyCacheSize = 0;
    // 競合（409）と入力エラー（422）も、返した HTML で画面を差し替える
    window.htmx.config.responseHandling = [
      { code: "204", swap: false },
      { code: "[23]..", swap: true },
      { code: "409", swap: true, error: false },
      { code: "422", swap: true, error: false },
      { code: "[45]..", swap: false, error: true },
    ];
  });

  // ---- 下書き ---------------------------------------------------------------
  function draftKey(form) {
    return DRAFT_PREFIX + form.getAttribute("data-draft");
  }

  // 明細の行（data-draft-lines を付けたフォーム）：商品 ID と数量を行の順に保存し、
  // 開き直したときはサーバーから行を取り直してから数量を戻す
  var LINE_ITEM = "lineItemId";
  var LINE_QUANTITY = "lineQuantity";
  // 入力の name と重ならない、下書きの中の明細の置き場所
  var LINES_KEY = "@lines";

  function serializeLines(form) {
    var lines = [];
    var rows = form.querySelectorAll("[data-line-item]");
    for (var i = 0; i < rows.length; i++) {
      var qtyInput = rows[i].querySelector("input[name=" + LINE_QUANTITY + "]");
      lines.push({
        itemId: rows[i].getAttribute("data-line-item"),
        quantity: qtyInput ? qtyInput.value : "",
      });
    }
    return lines;
  }

  function restoreLines(form, lines) {
    var url = form.getAttribute("data-draft-lines");
    var target = form.getAttribute("data-draft-lines-target");
    if (!url || !target || !window.htmx || !Array.isArray(lines) || lines.length === 0) return;
    var ids = lines.map(function (l) {
      return l.itemId;
    });
    window.htmx
      .ajax("POST", url, {
        source: form,
        target: target,
        swap: "beforeend",
        values: { itemIds: ids },
      })
      .then(function () {
        lines.forEach(function (l) {
          var row = form.querySelector('[data-line-item="' + CSS.escape(l.itemId) + '"]');
          var qtyInput = row ? row.querySelector("input[name=" + LINE_QUANTITY + "]") : null;
          if (qtyInput && typeof l.quantity === "string") qtyInput.value = l.quantity;
        });
        saveDraft(form);
        return null;
      });
  }

  function serialize(form) {
    var data = {};
    var withLines = form.hasAttribute("data-draft-lines");
    if (withLines) data[LINES_KEY] = serializeLines(form);
    var elements = form.elements;
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      if (!el.name || el.disabled) continue;
      if (withLines && (el.name === LINE_ITEM || el.name === LINE_QUANTITY)) continue;
      if (el.type === "checkbox" || el.type === "radio") {
        data[el.name + "|" + el.value] = el.checked;
      } else if (el.tagName === "SELECT" && el.multiple) {
        var values = [];
        for (var j = 0; j < el.options.length; j++)
          if (el.options[j].selected) values.push(el.options[j].value);
        data[el.name] = values;
      } else if (el.type !== "file" && el.type !== "submit" && el.type !== "button") {
        data[el.name] = el.value;
      }
    }
    return data;
  }

  function restore(form, data) {
    var elements = form.elements;
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      if (!el.name) continue;
      if (el.type === "checkbox" || el.type === "radio") {
        var k = el.name + "|" + el.value;
        if (Object.prototype.hasOwnProperty.call(data, k)) el.checked = Boolean(data[k]);
      } else if (Object.prototype.hasOwnProperty.call(data, el.name)) {
        var v = data[el.name];
        if (el.tagName === "SELECT" && el.multiple && Array.isArray(v)) {
          for (var j = 0; j < el.options.length; j++)
            el.options[j].selected = v.indexOf(el.options[j].value) >= 0;
        } else if (typeof v === "string") {
          el.value = v;
        }
      }
    }
  }

  // 登録が終わったフォーム。入力の直後に登録すると、下書きの保存（400ms 後）が下書きを消した後に動き、
  // 終わった登録の内容（受付番号を含む）が下書きとして残ってしまうので、終わったフォームは保存しない
  var finishedForms = new WeakSet();

  function saveDraft(form) {
    if (!storage || finishedForms.has(form)) return;
    try {
      storage.setItem(
        draftKey(form),
        JSON.stringify({ savedAt: Date.now(), data: serialize(form) }),
      );
    } catch {
      // 容量不足などで保存できなくても入力は続けられる
    }
  }

  function clearDraft(form) {
    if (!storage) return;
    try {
      storage.removeItem(draftKey(form));
    } catch {
      /* 無視してよい */
    }
  }

  var readyForms = new WeakSet();
  function initDraft(form, allowRestore) {
    if (readyForms.has(form)) return;
    readyForms.add(form);
    if (storage && allowRestore) {
      var raw = null;
      try {
        raw = storage.getItem(draftKey(form));
      } catch {
        raw = null;
      }
      if (raw) {
        try {
          var parsed = JSON.parse(raw);
          if (parsed && parsed.data) {
            restore(form, parsed.data);
            restoreLines(form, parsed.data[LINES_KEY]);
            var note = document.createElement("div");
            note.className = "alert alert-info";
            note.setAttribute("role", "status");
            note.textContent = "前回の入力途中の内容を復元しました。 ";
            var discard = document.createElement("button");
            discard.type = "button";
            discard.className = "btn btn-secondary btn-sm";
            discard.textContent = "破棄して最初から入力する";
            discard.addEventListener("click", function () {
              clearDraft(form);
              window.location.reload();
            });
            note.appendChild(discard);
            form.insertBefore(note, form.firstChild);
          }
        } catch {
          clearDraft(form);
        }
      }
    }
    var timer = null;
    form.addEventListener("input", function () {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        saveDraft(form);
      }, 400);
    });
    form.addEventListener("change", function () {
      saveDraft(form);
    });
  }

  // 登録・保存が終わったら下書きを消す（成功時はサーバーが HX-Redirect を返す）。
  // htmx は HX-Redirect の応答では successful を設定しないので、状態コードで判断する
  document.addEventListener("htmx:afterRequest", function (event) {
    var elt = event.detail.elt;
    var xhr = event.detail.xhr;
    if (!elt || !xhr || xhr.status < 200 || xhr.status >= 300) return;
    var form = elt.tagName === "FORM" ? elt : elt.closest && elt.closest("form");
    if (form && form.hasAttribute("data-draft") && xhr.getResponseHeader("HX-Redirect")) {
      finishedForms.add(form);
      clearDraft(form);
    }
  });
  // htmx を使わない通常の送信でも、送信した時点で下書きを消す
  document.addEventListener("submit", function (event) {
    var form = event.target;
    if (
      form &&
      form.hasAttribute &&
      form.hasAttribute("data-draft") &&
      !form.hasAttribute("hx-post")
    ) {
      finishedForms.add(form);
      clearDraft(form);
    }
  });

  function clearAllDrafts() {
    if (!storage) return;
    var keys = [];
    for (var i = 0; i < storage.length; i++) {
      var k = storage.key(i);
      if (k && k.indexOf(DRAFT_PREFIX) === 0) keys.push(k);
    }
    keys.forEach(function (key) {
      storage.removeItem(key);
    });
  }

  // ---- 数量の増減ボタン -------------------------------------------------------
  document.addEventListener("click", function (event) {
    var button = event.target.closest ? event.target.closest("[data-step]") : null;
    if (!button) return;
    var wrap = button.closest("[data-stepper]");
    var input = wrap ? wrap.querySelector("input") : null;
    if (!input) return;
    var step = Number(button.getAttribute("data-step")) || 0;
    var current = Number(input.value) || 0;
    var next = current + step;
    if (input.min !== "" && next < Number(input.min)) next = Number(input.min);
    if (input.max !== "" && next > Number(input.max)) next = Number(input.max);
    input.value = String(next);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });

  // ---- ダイアログ（data-dialog-open="<dialog の id>" で開き、data-dialog-close で閉じる） ----
  // 開いたときに dialog へ picker-open を送る（商品選択ダイアログはこれで検索結果を読み込む）
  document.addEventListener("click", function (event) {
    var opener = event.target.closest ? event.target.closest("[data-dialog-open]") : null;
    if (opener) {
      var dialog = document.getElementById(opener.getAttribute("data-dialog-open"));
      if (!dialog || typeof dialog.showModal !== "function") return;
      if (!dialog.open) dialog.showModal();
      dialog.dispatchEvent(new CustomEvent("picker-open"));
      var search = dialog.querySelector("input[type=search]");
      if (search) search.focus();
      return;
    }
    var closer = event.target.closest ? event.target.closest("[data-dialog-close]") : null;
    if (closer) {
      var owner = closer.closest("dialog");
      if (owner) owner.close();
    }
  });

  // data-dialog-close-on-success：送信が成功したら、選択を外してダイアログを閉じる
  document.addEventListener("htmx:afterRequest", function (event) {
    var elt = event.detail.elt;
    if (!elt || !event.detail.successful || !elt.hasAttribute) return;
    if (!elt.hasAttribute("data-dialog-close-on-success")) return;
    var dialog = elt.closest("dialog");
    if (!dialog) return;
    var checks = dialog.querySelectorAll("input[type=checkbox]");
    for (var i = 0; i < checks.length; i++) checks[i].checked = false;
    dialog.close();
  });

  // ---- 明細の行を外す（data-remove-row） ---------------------------------------
  document.addEventListener("click", function (event) {
    var button = event.target.closest ? event.target.closest("[data-remove-row]") : null;
    if (!button) return;
    var row = button.closest("tr");
    var form = button.closest("form");
    if (row) row.remove();
    if (form && form.hasAttribute("data-draft")) saveDraft(form);
  });

  // 行を追加したフォームの下書きも保存し直す
  document.addEventListener("htmx:afterSwap", function (event) {
    var target = event.detail.target;
    var form = target && target.closest ? target.closest("form[data-draft]") : null;
    if (form && readyForms.has(form)) saveDraft(form);
  });

  // ---- 初期化 ---------------------------------------------------------------
  // 下書きの復元は画面を開いたときだけ行う（入力エラーで返ってきたフォームはサーバーの内容を使う）
  function init(root, allowRestore) {
    var forms = (root || document).querySelectorAll("form[data-draft]");
    for (var i = 0; i < forms.length; i++) initDraft(forms[i], allowRestore);
    if ((root || document).querySelector && (root || document).querySelector("[data-clear-drafts]"))
      clearAllDrafts();
  }
  document.addEventListener("DOMContentLoaded", function () {
    init(document, true);
    if (!navigator.onLine) showOffline(false);
  });
  document.addEventListener("htmx:load", function (event) {
    init(event.detail.elt.parentNode || event.detail.elt, false);
  });
})();
