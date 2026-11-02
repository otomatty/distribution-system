// 印刷用のページ（発送リスト・仕分けリスト）の「印刷する」ボタン。
// 画面の CSP はページに埋め込んだスクリプトを許さないので、このファイルに置く（ビルドしない素の JavaScript）
(function () {
  "use strict";
  document.addEventListener("click", function (event) {
    var button = event.target.closest ? event.target.closest("[data-print]") : null;
    if (button) window.print();
  });
})();
