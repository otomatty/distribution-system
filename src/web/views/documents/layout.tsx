/**
 * 帳票（発注書・納品書・請求書・返還請求書）と印刷用の画面の共通レイアウト。A4（縦が基本、横も可）。
 * Browser Rendering で PDF にするので、HTML だけで完結させる（外部のファイル・スクリプト・Web フォントを読まない）。
 * 文字は Browser Rendering に入っている日本語フォント（Noto CJK、IPA フォント）を使い、
 * 手元のブラウザで開いた場合は Windows・Mac の日本語フォントで表示する。
 *
 * 画面（app.css）とは別に、ここで <style> を埋め込む。JSX は <style> の中身もエスケープするので、
 * PRINT_CSS には「> < & " '」を使わない（documents.test.ts で確かめている）。
 */
import type { Child } from "hono/jsx";

import type { Orientation } from "../../../domain/documents";

export const PRINT_CSS = `
@page { size: A4 portrait; margin: 12mm 12mm 14mm; }
@page landscape { size: A4 landscape; margin: 10mm 10mm 12mm; }
html {
  font-family: Noto Sans CJK JP, Noto Sans JP, IPAexGothic, IPAGothic, Hiragino Sans,
    Hiragino Kaku Gothic ProN, Yu Gothic, YuGothic, Meiryo, sans-serif;
  font-size: 9.5pt;
  line-height: 1.5;
  color: #111;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
body { margin: 0; }
.sheet { break-after: page; }
.sheet:last-child { break-after: auto; }
.sheet.landscape { page: landscape; }
h1.doc-title {
  margin: 0 0 6mm;
  font-size: 18pt;
  font-weight: 700;
  text-align: center;
  letter-spacing: 0.4em;
}
.doc-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 8mm; }
.doc-to { flex: 1; }
.doc-to p,
.doc-from p { margin: 0; }
.doc-to .name {
  font-size: 13pt;
  font-weight: 700;
  border-bottom: 0.3mm solid #111;
  padding-bottom: 1mm;
}
.doc-from { width: 72mm; font-size: 8.5pt; }
.doc-from .name { font-size: 11pt; font-weight: 700; }
.doc-meta { margin: 0 0 3mm auto; border-collapse: collapse; font-size: 9pt; }
.doc-meta th { padding: 0.5mm 3mm 0.5mm 0; text-align: left; font-weight: 400; color: #444; }
.doc-meta td { padding: 0.5mm 0; text-align: right; }
.doc-lead { margin: 4mm 0; }
.doc-total {
  display: inline-block;
  margin: 2mm 0 4mm;
  padding: 1.5mm 4mm;
  border: 0.4mm solid #111;
  font-size: 13pt;
  font-weight: 700;
}
table.doc-table { width: 100%; border-collapse: collapse; margin: 2mm 0; }
.doc-table th,
.doc-table td { border: 0.25mm solid #555; padding: 1mm 1.6mm; vertical-align: top; }
.doc-table thead th { background: #eee; font-weight: 700; text-align: center; white-space: nowrap; }
.doc-table tfoot td,
.doc-table tfoot th { font-weight: 700; }
.doc-table tr { break-inside: avoid; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.center { text-align: center; }
.muted { color: #555; }
.small { font-size: 8pt; }
.doc-note { margin-top: 4mm; padding: 2mm 3mm; border: 0.25mm solid #999; white-space: pre-wrap; }
.doc-footer { margin-top: 6mm; font-size: 8pt; color: #444; }
@media screen {
  body { background: #e5e7eb; padding: 8mm 0; }
  .sheet {
    width: 186mm;
    min-height: 273mm;
    margin: 0 auto 8mm;
    padding: 12mm;
    background: #fff;
    box-shadow: 0 1mm 3mm rgba(0, 0, 0, 0.2);
  }
  .sheet.landscape { width: 277mm; min-height: 190mm; }
}
`;

export interface PrintSheet {
  readonly orientation: Orientation;
  readonly body: Child;
}

/** 印刷用の HTML。sheets の1つが1枚（または続きのページ）になり、間で改ページする */
export function PrintDocument(props: { title: string; sheets: readonly PrintSheet[] }) {
  return (
    <html lang="ja">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex,nofollow" />
        <title>{props.title}</title>
        <style>{PRINT_CSS}</style>
      </head>
      <body>
        {props.sheets.map((s) => (
          <section class={s.orientation === "landscape" ? "sheet landscape" : "sheet"}>
            {s.body}
          </section>
        ))}
      </body>
    </html>
  );
}

/** 印刷用の HTML を画面で開くときの CSP。埋め込みの <style> だけを許し、スクリプトや外部の読み込みは許さない */
export const PRINT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
