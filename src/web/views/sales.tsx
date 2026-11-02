/** 受注・発送の画面の部品（状態の表示、合計欄、明細の表）。金額は usecases で計算した値を表示するだけ */
import { TAX_CATEGORY_LABELS, type TaxCategory, type TaxSummary } from "../../domain/money";
import { SALES_ORDER_STATUS_LABELS, type SalesOrderStatus } from "../../domain/sales";
import type { EvaluatedLine } from "../../usecases/sales/evaluate";
import { Badge } from "./components";
import { centiYen, qty, rate, yen } from "./format";

const STATUS_KIND: Readonly<Record<SalesOrderStatus, "info" | "success" | "neutral">> = {
  received: "info",
  shipped: "success",
  cancelled: "neutral",
};

export function SalesOrderStatusBadge(props: { status: SalesOrderStatus }) {
  return <Badge kind={STATUS_KIND[props.status]}>{SALES_ORDER_STATUS_LABELS[props.status]}</Badge>;
}

/** 税区分の表示。軽減税率の対象には「※」を付ける（帳票と同じ） */
export function TaxCategoryLabel(props: { category: TaxCategory }) {
  return props.category === "reduced" ? (
    <span>※{TAX_CATEGORY_LABELS.reduced}</span>
  ) : (
    <span>{TAX_CATEGORY_LABELS.standard}</span>
  );
}

/**
 * 合計欄（表の tfoot）。税率ごとの対象額と消費税額、税込の合計。
 * columns は表の列数（金額の列は右から2番目）。id を渡すと htmx の差し替え先になる
 */
export function TotalsFoot(props: {
  summary: TaxSummary | null;
  incomplete: boolean;
  columns: number;
  id?: string;
  oob?: boolean;
}) {
  const label = props.columns - 2;
  const s = props.summary;
  return (
    <tfoot id={props.id} hx-swap-oob={props.oob ? "true" : undefined} class="totals">
      {s === null ? (
        <tr>
          <td colspan={props.columns} class="text-danger">
            受注日の税率が設定されていないため、合計を計算できません（管理者に連絡してください）
          </td>
        </tr>
      ) : (
        <>
          <tr>
            <th colspan={label} class="num">
              小計（税抜）
            </th>
            <td class="num" data-total="subtotal">
              {yen(s.subtotal)}
            </td>
            <td></td>
          </tr>
          {s.groups.map((g) => (
            <tr>
              <th colspan={label} class="num">
                {TAX_CATEGORY_LABELS[g.category]}（{rate(g.rateBps)}）対象 {yen(g.subtotal)}
                　消費税
              </th>
              <td class="num">{yen(g.tax)}</td>
              <td></td>
            </tr>
          ))}
          <tr class="grand-total">
            <th colspan={label} class="num">
              合計（税込）
            </th>
            <td class="num" data-total="total">
              {yen(s.total)}
            </td>
            <td></td>
          </tr>
        </>
      )}
      {props.incomplete ? (
        <tr>
          <td colspan={props.columns} class="hint">
            数量・単価が未入力の行は合計に含めていません。
          </td>
        </tr>
      ) : null}
    </tfoot>
  );
}

/** 明細の出荷可能数と警告（登録はできる）。メーカー直・発送後は出荷可能数を出さない */
export function LineStock(props: { line: EvaluatedLine }) {
  const l = props.line;
  return (
    <>
      {l.available === null ? (
        <span class="muted">—</span>
      ) : (
        <span class={l.available < 0 ? "text-danger" : undefined}>
          {qty(l.available)}
          <span class="muted small">
            {l.salesUnitName}（現在庫 {qty(l.onHand)}）
          </span>
        </span>
      )}
      {l.warnings.length > 0 ? (
        <ul class="line-warnings" role="status">
          {l.warnings.map((w) => (
            <li>{w}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** 受注詳細の明細の表（読み取り専用） */
export function OrderLinesTable(props: {
  lines: readonly EvaluatedLine[];
  saved: readonly { readonly itemId: string; readonly priceOverrideReason: string | null }[];
  charges: readonly {
    readonly description: string;
    readonly quantity: number;
    readonly unitAmount: number;
    readonly taxCategory: TaxCategory;
  }[];
  chargeAmounts: readonly (number | null)[];
  summary: TaxSummary | null;
  withStock: boolean;
}) {
  const reasons = new Map(props.saved.map((l) => [l.itemId, l.priceOverrideReason]));
  return (
    <div class="table-wrap">
      <table class="table so-lines">
        <thead>
          <tr>
            <th>商品</th>
            <th>{props.withStock ? "出荷可能数・警告" : ""}</th>
            <th class="num">数量</th>
            <th class="num">単価（税抜）</th>
            <th>税区分</th>
            <th class="num">金額</th>
            <th>
              <span class="sr-only">備考</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {props.lines.map((l) => (
            <tr class={l.warnings.length > 0 ? "row-warning" : undefined}>
              <td>
                <span class="muted small">{l.itemCode}</span> {l.itemName}
              </td>
              <td>{props.withStock ? <LineStock line={l} /> : null}</td>
              <td class="num">
                {qty(l.quantity)}
                <span class="muted small">{l.salesUnitName}</span>
              </td>
              <td class="num">
                {centiYen(l.unitPriceCenti)}
                {l.priceOverridden ? (
                  <div class="muted small">
                    卸単価 {centiYen(l.listPriceCenti)}・理由：{reasons.get(l.itemId) ?? "—"}
                  </div>
                ) : null}
              </td>
              <td>
                <TaxCategoryLabel category={l.taxCategory} />
              </td>
              <td class="num">{yen(l.amount)}</td>
              <td></td>
            </tr>
          ))}
        </tbody>
        {props.charges.length > 0 ? (
          <tbody>
            {props.charges.map((ch, i) => (
              <tr>
                <td>{ch.description}</td>
                <td></td>
                <td class="num">{qty(ch.quantity)}</td>
                <td class="num">{yen(ch.unitAmount)}</td>
                <td>
                  <TaxCategoryLabel category={ch.taxCategory} />
                </td>
                <td class="num">{yen(props.chargeAmounts[i])}</td>
                <td></td>
              </tr>
            ))}
          </tbody>
        ) : null}
        <TotalsFoot summary={props.summary} incomplete={false} columns={7} />
      </table>
      <p class="hint">※は軽減税率の対象です。</p>
    </div>
  );
}
