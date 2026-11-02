/**
 * 納品書（要件定義書 3.10）。A4 縦。発送のときに保存したスナップショット（usecases/sales/snapshots.ts）を表示するだけで、
 * 金額は計算しない。インボイスの記載事項に合わせて、発行者の登録番号・取引年月日・軽減税率の対象である旨（※）・
 * 税率ごとの合計と消費税額・宛名を載せる。
 */
import { TAX_CATEGORY_LABELS } from "../../../domain/money";
import {
  deliveryNoteSnapshotSchema,
  type DeliveryNoteSnapshot,
} from "../../../usecases/sales/snapshots";
import { centiYen, rate, qty, yen } from "../format";
import { Addressee, DocumentDate, DocumentMeta, DocumentTitle, Issuer } from "./parts";
import { defineTemplate } from "./template";

function reducedRateLabel(data: DeliveryNoteSnapshot): string {
  const g = data.taxGroups.find((t) => t.category === "reduced");
  return g ? `（${rate(g.rateBps)}）` : "";
}

function DeliveryNoteDocument(props: { snapshot: DeliveryNoteSnapshot }) {
  const d = props.snapshot;
  const hasReduced = [...d.lines, ...d.charges].some((l) => l.reduced);
  return (
    <>
      <DocumentTitle title="納品書" />
      <DocumentMeta
        items={[
          ["納品書番号", d.number],
          ["納品日", <DocumentDate date={d.shippedOn} />],
          ["受注番号", d.salesOrderNumber],
        ]}
      />
      <div class="doc-head">
        <Addressee to={d.customer} />
        <Issuer from={d.issuer} />
      </div>
      {d.customer.contactName ? <p class="small">ご担当：{d.customer.contactName} 様</p> : null}
      <p class="doc-lead">下記のとおり納品いたします。</p>
      <p class="doc-total">合計金額（税込） {yen(d.total)}</p>
      <table class="doc-table">
        <thead>
          <tr>
            <th>商品コード</th>
            <th>品名</th>
            <th>数量</th>
            <th>単位</th>
            <th>単価（税抜）</th>
            <th>金額（税抜）</th>
          </tr>
        </thead>
        <tbody>
          {d.lines.map((l) => (
            <tr>
              <td>{l.itemCode}</td>
              <td>
                {l.name}
                {l.reduced ? " ※" : ""}
              </td>
              <td class="num">{qty(l.quantity)}</td>
              <td class="center">{l.unitName}</td>
              <td class="num">{centiYen(l.unitPriceCenti)}</td>
              <td class="num">{yen(l.amount)}</td>
            </tr>
          ))}
          {d.charges.map((ch) => (
            <tr>
              <td></td>
              <td>
                {ch.description}
                {ch.reduced ? " ※" : ""}
              </td>
              <td class="num">{qty(ch.quantity)}</td>
              <td></td>
              <td class="num">{yen(ch.unitAmount)}</td>
              <td class="num">{yen(ch.amount)}</td>
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
              小計（税抜）
            </th>
            <td class="num">{yen(d.subtotal)}</td>
          </tr>
          <tr>
            <th colspan={5} class="num">
              消費税
            </th>
            <td class="num">{yen(d.tax)}</td>
          </tr>
          <tr>
            <th colspan={5} class="num">
              合計（税込）
            </th>
            <td class="num">{yen(d.total)}</td>
          </tr>
        </tfoot>
      </table>
      {hasReduced ? <p class="small">※は軽減税率{reducedRateLabel(d)}の対象です。</p> : null}
      {d.memo ? <p class="doc-note">{d.memo}</p> : null}
    </>
  );
}

export const deliveryNoteTemplate = defineTemplate({
  schema: deliveryNoteSnapshotSchema,
  render: (data) => <DeliveryNoteDocument snapshot={data} />,
});
