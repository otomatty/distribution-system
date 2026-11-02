/**
 * 発注書（A4 縦）。スナップショット（usecases/purchasing/snapshots.ts）を表示するだけで、金額は計算しない。
 * 発行者（自社）・宛先（仕入先）・納入先・明細・税率ごとの合計と消費税・納品希望日・支払予定日・備考を載せる。
 */
import {
  purchaseOrderSnapshot,
  type PurchaseOrderSnapshot,
} from "../../../usecases/purchasing/snapshots";
import { centiYen, postal, qty, rate, yen } from "../format";
import { Addressee, DocumentDate, DocumentMeta, DocumentTitle, Issuer } from "./parts";
import { defineTemplate } from "./template";

const DESTINATION_KIND_LABELS: Readonly<
  Record<PurchaseOrderSnapshot["destination"]["kind"], string>
> = {
  location: "",
  customer: "（直送）",
  other: "",
};

function Destination(props: { destination: PurchaseOrderSnapshot["destination"] }) {
  const d = props.destination;
  // その他の届け先は、入力された名前と住所を行ごとに出す
  const addressLines = (d.address ?? "").split("\n").filter((x) => x.trim() !== "");
  return (
    <table class="doc-table">
      <tbody>
        <tr>
          <th class="center">納入先</th>
          <td>
            {d.name ? (
              <div>
                {d.name}
                {DESTINATION_KIND_LABELS[d.kind]}
              </div>
            ) : null}
            {d.postalCode ? <div>{postal(d.postalCode)}</div> : null}
            {addressLines.map((line) => (
              <div>{line}</div>
            ))}
            {d.phone ? <div>TEL：{d.phone}</div> : null}
          </td>
        </tr>
      </tbody>
    </table>
  );
}

export function PurchaseOrderDocument(props: { snapshot: PurchaseOrderSnapshot }) {
  const s = props.snapshot;
  const meta: [string, ReturnType<typeof DocumentDate> | string][] = [
    ["発注番号", s.number],
    ["発注日", <DocumentDate date={s.orderedOn} />],
  ];
  if (s.deliveryRequestedOn)
    meta.push(["納品希望日", <DocumentDate date={s.deliveryRequestedOn} />]);
  if (s.paymentDueOn) meta.push(["支払予定日", <DocumentDate date={s.paymentDueOn} />]);
  const hasReduced = s.lines.some((l) => l.taxCategory === "reduced");
  return (
    <>
      <DocumentTitle title="発注書" />
      <DocumentMeta items={meta} />
      <div class="doc-head">
        <div class="doc-to">
          <Addressee to={s.supplier} />
          {s.supplier.contactName ? <p>ご担当：{s.supplier.contactName} 様</p> : null}
          <p class="doc-lead">下記のとおり発注いたします。</p>
          <p class="doc-total">発注金額（税込） {yen(s.total)}</p>
        </div>
        <div>
          <Issuer from={s.issuer} />
          {s.employeeName ? <p class="small">担当：{s.employeeName}</p> : null}
        </div>
      </div>
      <Destination destination={s.destination} />
      <table class="doc-table">
        <thead>
          <tr>
            <th>No.</th>
            <th>商品コード</th>
            <th>商品名</th>
            <th>数量</th>
            <th>単位</th>
            <th>入数</th>
            <th>単価（税抜）</th>
            <th>金額（税抜）</th>
          </tr>
        </thead>
        <tbody>
          {s.lines.map((l) => (
            <tr>
              <td class="center">{l.no}</td>
              <td>{l.itemCode}</td>
              <td>
                {l.itemName}
                {l.taxCategory === "reduced" ? " ※" : ""}
                {l.memo ? <div class="small muted">{l.memo}</div> : null}
              </td>
              <td class="num">{qty(l.quantity)}</td>
              <td class="center">{l.purchaseUnitName}</td>
              <td class="num">
                {qty(l.unitsPerPurchaseUnit)}
                {l.salesUnitName}
              </td>
              <td class="num">{centiYen(l.unitPriceCenti)}</td>
              <td class="num">{yen(l.amount)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          {s.taxGroups.map((g) => (
            <tr>
              <th colspan={6} class="num">
                {rate(g.rateBps)}対象{g.category === "reduced" ? "（軽減税率）" : ""}
              </th>
              <td class="num">{yen(g.subtotal)}</td>
              <td class="num">消費税 {yen(g.tax)}</td>
            </tr>
          ))}
          <tr>
            <th colspan={7} class="num">
              小計（税抜）
            </th>
            <td class="num">{yen(s.subtotal)}</td>
          </tr>
          <tr>
            <th colspan={7} class="num">
              消費税
            </th>
            <td class="num">{yen(s.tax)}</td>
          </tr>
          <tr>
            <th colspan={7} class="num">
              合計（税込）
            </th>
            <td class="num">{yen(s.total)}</td>
          </tr>
        </tfoot>
      </table>
      {hasReduced ? <p class="small">※は軽減税率の対象です。</p> : null}
      {s.memo ? <div class="doc-note">{s.memo}</div> : null}
    </>
  );
}

export const purchaseOrderTemplate = defineTemplate({
  schema: purchaseOrderSnapshot,
  title: (data) => `発注書 ${data.number}`,
  render: (data) => <PurchaseOrderDocument snapshot={data} />,
});
