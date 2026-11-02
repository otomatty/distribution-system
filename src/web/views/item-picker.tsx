/**
 * 商品選択ダイアログ（要件定義書 3.8：発注・受注で共通。在庫操作・棚卸でも使う）。
 *
 * ## 置き方
 *
 * ```tsx
 * // 開くボタン。type="button" なので、呼び出し側の <form> の中に置いてよい
 * <ItemPickerButton picker="po-picker" />
 * // ダイアログ本体。中に <form> を持つので、呼び出し側の <form> の外（ページの末尾など）に置く
 * <ItemPicker
 *   id="po-picker"                      // ページの中で一意（英数字とハイフン）
 *   addUrl={paths.purchaseOrderLines()} // 選んだ商品を送る先（POST）
 *   target="#po-lines"                  // 応答の HTML を差し込む先（hx-target）
 *   swap="beforeend"                    // 差し込み方（hx-swap、既定は beforeend）
 *   include="#po-form"                  // addUrl に一緒に送る入力（hx-include。今の明細や保管場所など）
 *   supplierInput="#po-form [name=supplierId]" // 仕入先で絞るなら、仕入先の入力（name は supplierId）
 * />
 * ```
 *
 * 仕入先が決まっているなら `supplierInput` の代わりに `supplierId="..."` を渡す。
 *
 * ## 動き
 *
 * - ボタンを押すと `<dialog>` をモーダルで開き（public/assets/app.js）、検索結果を読み込む
 * - 商品名・商品コード・JAN で検索する（入力して 300ms 後、または Enter）。取扱終了の商品は出さない
 * - チェックボックスで複数選べる。検索し直しても、選んだ商品は先頭に残る
 * - 「選んだ商品を追加」で `addUrl` に hx-post する。送る値は `itemIds`（選んだ商品の ID、複数）と、
 *   `include` で指定した要素の中の入力。応答の HTML を `target` に `swap` で差し込み、成功したらダイアログを閉じる
 *
 * ## addUrl の作り方（呼び出し側）
 *
 * - `strs(form, "itemIds")` で選んだ商品の ID を受け取り、クエリ `items.getMany` で商品を読んで、明細の行を返す
 * - すでに明細にある商品を除くのは呼び出し側で行う（`include` で今の明細の商品 ID を一緒に送る）
 * - 何も選ばれていなければ空の応答（200）を返す
 */
import type { ItemRecord } from "../../usecases/masters/items.port";
import { strs, type FormData_ } from "../form";
import { paths } from "../paths";
import { centiYen } from "./format";

/** addUrl で、選んだ商品の ID（itemIds、重複を除く）を読む */
export function pickedItemIds(form: FormData_): string[] {
  return [...new Set(strs(form, "itemIds"))].slice(0, 200);
}

/** ページの中の要素 ID に使うので、英数字とハイフンだけにする */
export function isPickerId(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9-]{0,39}$/.test(value);
}

export function ItemPickerButton(props: { picker: string; label?: string; large?: boolean }) {
  return (
    <button
      type="button"
      class={props.large ? "btn btn-secondary btn-lg" : "btn btn-secondary"}
      data-dialog-open={props.picker}
      aria-haspopup="dialog"
    >
      {props.label ?? "商品を追加"}
    </button>
  );
}

export function ItemPicker(props: {
  id: string;
  addUrl: string;
  target: string;
  swap?: string;
  include?: string;
  supplierId?: string;
  supplierInput?: string;
  title?: string;
}) {
  const resultsId = `${props.id}-results`;
  const searchInclude = [`#${resultsId}`, props.supplierInput].filter(Boolean).join(", ");
  return (
    <dialog id={props.id} class="dialog item-picker" aria-labelledby={`${props.id}-title`}>
      <div class="dialog-header">
        <h2 id={`${props.id}-title`}>{props.title ?? "商品を選ぶ"}</h2>
        <button type="button" class="btn btn-secondary" data-dialog-close>
          閉じる
        </button>
      </div>
      <form
        class="picker-search"
        role="search"
        method="get"
        action={paths.itemPicker()}
        hx-get={paths.itemPicker()}
        hx-target={`#${resultsId}`}
        hx-swap="outerHTML"
        hx-trigger="submit, input changed delay:300ms from:find input[name=q], picker-open from:closest dialog"
        hx-include={searchInclude}
      >
        <input type="hidden" name="pickerId" value={props.id} />
        {props.supplierId ? (
          <input type="hidden" name="supplierId" value={props.supplierId} />
        ) : null}
        <div class="field">
          <label for={`${props.id}-q`}>商品名・商品コード・JAN で検索</label>
          <input id={`${props.id}-q`} name="q" type="search" autocomplete="off" />
        </div>
        <button type="submit" class="btn btn-secondary">
          検索
        </button>
      </form>
      <form
        class="picker-add"
        hx-post={props.addUrl}
        hx-target={props.target}
        hx-swap={props.swap ?? "beforeend"}
        hx-include={props.include}
        data-dialog-close-on-success
      >
        <div id={resultsId} class="picker-results">
          <p class="muted">読み込んでいます…</p>
        </div>
        <div class="dialog-actions">
          <button type="button" class="btn btn-secondary" data-dialog-close>
            キャンセル
          </button>
          <button type="submit" class="btn btn-primary">
            選んだ商品を追加
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** 検索結果（GET /items/picker の応答）。選択済みの商品を先頭に、チェックした状態で出す */
export function ItemPickerResults(props: {
  pickerId: string;
  selected: readonly ItemRecord[];
  results: readonly ItemRecord[];
  total: number;
}) {
  const rows = [
    ...props.selected.map((item) => ({ item, checked: true })),
    ...props.results.map((item) => ({ item, checked: false })),
  ];
  const more = props.total - props.results.length;
  return (
    <div id={`${props.pickerId}-results`} class="picker-results">
      {rows.length === 0 ? (
        <p class="empty">条件に合う商品はありません</p>
      ) : (
        <table class="table picker-table">
          <thead>
            <tr>
              <th>
                <span class="sr-only">選ぶ</span>
              </th>
              <th>商品コード</th>
              <th>商品名</th>
              <th>仕入先</th>
              <th>単位</th>
              <th class="num">卸単価</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ item, checked }) => {
              const cb = `${props.pickerId}-cb-${item.id}`;
              return (
                <tr>
                  <td>
                    <input
                      type="checkbox"
                      id={cb}
                      name="itemIds"
                      value={item.id}
                      checked={checked}
                    />
                  </td>
                  <td class="nowrap">
                    <label for={cb}>{item.code}</label>
                  </td>
                  <td>
                    <label for={cb}>
                      {item.name}
                      {item.jan ? <span class="muted small"> JAN {item.jan}</span> : null}
                    </label>
                  </td>
                  <td>{item.supplierName}</td>
                  <td class="nowrap">
                    {item.salesUnitName}（{item.purchaseUnitName}＝{item.unitsPerPurchaseUnit}
                    {item.salesUnitName}）
                  </td>
                  <td class="num">{centiYen(item.salesPriceCenti)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {more > 0 ? (
        <p class="muted small">ほかに {more} 件あります。検索の条件を足して絞り込んでください。</p>
      ) : null}
    </div>
  );
}
