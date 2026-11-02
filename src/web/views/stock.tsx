/** 在庫の画面の部品（在庫不足の表示など。発送・入荷の取消などほかの区分の画面でも使う） */
import type { DomainError } from "../../domain/result";
import { STOCK_REASONS, type StockReason } from "../../domain/stock";
import type { ShortageDetail } from "../../usecases/stock/queries";
import { Alert, ErrorSummary } from "./components";
import { qty } from "./format";

/**
 * 業務エラーの表示。在庫不足（insufficient_stock）なら、足りない商品と数を表にする。
 * shortages はクエリ "stock.shortages" に error.details を渡した結果。
 */
export function StockErrorSummary(props: {
  error?: DomainError | null | undefined;
  shortages?: readonly ShortageDetail[] | undefined;
}) {
  const e = props.error;
  if (!e) return null;
  // details は機械向けの値（商品 ID など）なので、そのままは出さない
  if (e.code !== "insufficient_stock" || !props.shortages)
    return <ErrorSummary error={{ code: e.code, message: e.message }} />;
  return (
    <Alert kind="error">
      <strong>在庫が足りないため記録できませんでした。足りない商品と数：</strong>
      <table class="table shortage-table">
        <thead>
          <tr>
            <th>商品</th>
            <th>保管場所</th>
            <th class="num">現在庫</th>
            <th class="num">足りない数</th>
          </tr>
        </thead>
        <tbody>
          {props.shortages.map((s) => (
            <tr>
              <td>
                {s.itemCode} {s.itemName}
              </td>
              <td>{s.locationName}</td>
              <td class="num">
                {qty(s.onHand)}
                {s.salesUnitName}
              </td>
              <td class="num">
                {qty(s.shortBy)}
                {s.salesUnitName}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Alert>
  );
}

export function reasonLabel(reason: StockReason): string {
  return STOCK_REASONS[reason];
}

/** 符号つきの数量（+3 / −2） */
export function signedQty(n: number): string {
  return n > 0 ? `+${qty(n)}` : n < 0 ? `−${qty(-n)}` : "0";
}

/**
 * 明細の行の数量（タブレットでは「−」「＋」でも増減できる：public/assets/app.js の data-stepper）。
 * 行ごとに ID と読み上げ用の名前を付ける（同じ name の入力が複数並ぶため）
 */
export function LineQuantity(props: {
  name: string;
  id: string;
  label: string;
  value: string;
  min?: number;
  error?: string | undefined;
}) {
  return (
    <div class="stepper" data-stepper>
      <button
        type="button"
        class="btn btn-secondary stepper-btn"
        data-step="-1"
        aria-label={`${props.label}を1つ減らす`}
      >
        −
      </button>
      <input
        id={props.id}
        name={props.name}
        type="number"
        inputmode="numeric"
        step={1}
        min={props.min}
        value={props.value}
        aria-label={props.label}
        aria-invalid={props.error ? "true" : undefined}
        aria-describedby={props.error ? `${props.id}-error` : undefined}
      />
      <button
        type="button"
        class="btn btn-secondary stepper-btn"
        data-step="1"
        aria-label={`${props.label}を1つ増やす`}
      >
        ＋
      </button>
      {props.error ? (
        <p class="field-error" id={`${props.id}-error`}>
          {props.error}
        </p>
      ) : null}
    </div>
  );
}

/** 明細の行を消すボタン（public/assets/app.js の data-remove-row。通信なしで消す） */
export function RemoveRowButton(props: { label: string }) {
  return (
    <button
      type="button"
      class="btn btn-secondary"
      data-remove-row
      aria-label={`${props.label}を明細から外す`}
    >
      外す
    </button>
  );
}
