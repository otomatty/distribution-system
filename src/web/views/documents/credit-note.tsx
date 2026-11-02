/**
 * 返還請求書（適格返還請求書。要件定義書 3.11）。A4 縦。発行のときに保存したスナップショット
 * （usecases/billing/snapshots.ts）を表示するだけで、金額は計算しない。記載事項：発行者の名称と登録番号、
 * 返品を受けた年月日と元の取引の年月日、返品の内容（軽減税率の対象である旨「※」）、
 * 税率ごとの返還額の合計と適用税率、税率ごとの消費税額、宛名。
 */
import { TAX_CATEGORY_LABELS } from "../../../domain/money";
import {
  creditNoteSnapshotSchema,
  type CreditNoteSnapshot,
} from "../../../usecases/billing/snapshots";
import { centiYen, qty, rate, yen } from "../format";
import { TaxBreakdown } from "./invoice";
import { Addressee, DocumentDate, DocumentMeta, DocumentTitle, Issuer } from "./parts";
import { defineTemplate } from "./template";

function CreditNoteDocument(props: { snapshot: CreditNoteSnapshot }) {
  const d = props.snapshot;
  const reduced = d.taxGroups.find((g) => g.category === "reduced");
  return (
    <>
      <DocumentTitle title="返還請求書" />
      <DocumentMeta
        items={[
          ["返還請求書番号", d.number],
          ["発行日", <DocumentDate date={d.issuedOn} />],
          ["返品日", <DocumentDate date={d.returnedOn} />],
          ["元の取引年月日", <DocumentDate date={d.originalTransactionDate} />],
          ["返品伝票番号", d.returnNumber],
          ...(d.deliveryNoteNumber ? ([["納品書番号", d.deliveryNoteNumber]] as const) : []),
          ...(d.invoiceNumber ? ([["請求書番号", d.invoiceNumber]] as const) : []),
        ]}
      />
      <div class="doc-head">
        <Addressee to={d.recipient} />
        <Issuer from={d.issuer} />
      </div>
      <p class="doc-lead">下記の返品について、対価を返還いたします。</p>
      <p class="doc-total">返還額（税込） {yen(d.total)}</p>
      <TaxBreakdown groups={d.taxGroups} />
      <table class="doc-table">
        <thead>
          <tr>
            <th>商品コード</th>
            <th>品名</th>
            <th>数量</th>
            <th>単位</th>
            <th>単価（税抜）</th>
            <th>返還額（税抜）</th>
          </tr>
        </thead>
        <tbody>
          {d.lines.map((l) => (
            <tr>
              <td>{l.itemCode ?? ""}</td>
              <td>
                {l.name}
                {l.reduced ? " ※" : ""}
              </td>
              <td class="num">{qty(l.quantity)}</td>
              <td class="center">{l.unitName ?? ""}</td>
              <td class="num">{centiYen(l.unitPriceCenti)}</td>
              <td class="num">{yen(l.amount)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          {d.taxGroups.map((g) => (
            <tr>
              <th colspan={4} class="num">
                {TAX_CATEGORY_LABELS[g.category]}（{rate(g.rateBps)}）対象
              </th>
              <td class="num">{yen(g.subtotal)}</td>
              <td class="num">消費税 {yen(g.tax)}</td>
            </tr>
          ))}
          <tr>
            <th colspan={5} class="num">
              返還額（税込）
            </th>
            <td class="num">{yen(d.total)}</td>
          </tr>
        </tfoot>
      </table>
      {reduced ? <p class="small">※は軽減税率（{rate(reduced.rateBps)}）の対象です。</p> : null}
    </>
  );
}

export const creditNoteTemplate = defineTemplate({
  schema: creditNoteSnapshotSchema,
  render: (data) => <CreditNoteDocument snapshot={data} />,
});
