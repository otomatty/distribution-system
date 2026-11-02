/**
 * 請求書（要件定義書 3.10）。A4 縦。発行のときに保存したスナップショット（usecases/billing/snapshots.ts）を表示するだけで、
 * 金額は計算しない。インボイス制度の記載事項：発行者の名称と登録番号、取引年月日（発送日・返品日）、
 * 取引内容（軽減税率の対象である旨「※」）、税率ごとの合計額と適用税率、税率ごとの消費税額、宛名。
 */
import { TAX_CATEGORY_LABELS } from "../../../domain/money";
import { invoiceSnapshotSchema, type InvoiceSnapshot } from "../../../usecases/billing/snapshots";
import { centiYen, qty, rate, yen } from "../format";
import { Addressee, DocumentDate, DocumentMeta, DocumentTitle, Issuer } from "./parts";
import { defineTemplate } from "./template";

type Line = InvoiceSnapshot["deliveries"][number]["lines"][number];

function LineRow(props: { date: string; reference: string; line: Line; first: boolean }) {
  const l = props.line;
  return (
    <tr>
      <td>{props.first ? <DocumentDate date={props.date} /> : null}</td>
      <td class="small">{props.first ? props.reference : null}</td>
      <td>
        {l.name}
        {l.reduced ? " ※" : ""}
      </td>
      <td class="num">{qty(l.quantity)}</td>
      <td class="center">{l.unitName ?? ""}</td>
      <td class="num">{centiYen(l.unitPriceCenti)}</td>
      <td class="num">{yen(l.amount)}</td>
    </tr>
  );
}

/** 税率ごとの合計と消費税額（インボイスの記載事項） */
export function TaxBreakdown(props: { groups: InvoiceSnapshot["taxGroups"] }) {
  return (
    <table class="doc-table">
      <thead>
        <tr>
          <th>税率の区分</th>
          <th>適用税率</th>
          <th>対象額（税抜）</th>
          <th>消費税額</th>
        </tr>
      </thead>
      <tbody>
        {props.groups.map((g) => (
          <tr>
            <td>
              {TAX_CATEGORY_LABELS[g.category]}
              {g.category === "reduced" ? "（※）" : ""}
            </td>
            <td class="num">{rate(g.rateBps)}</td>
            <td class="num">{yen(g.subtotal)}</td>
            <td class="num">{yen(g.tax)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function reducedRateLabel(groups: InvoiceSnapshot["taxGroups"]): string {
  const g = groups.find((t) => t.category === "reduced");
  return g ? `（${rate(g.rateBps)}）` : "";
}

function InvoiceDocument(props: { snapshot: InvoiceSnapshot }) {
  const d = props.snapshot;
  const lines = [...d.deliveries.flatMap((x) => x.lines), ...d.returns.flatMap((x) => x.lines)];
  const hasReduced = lines.some((l) => l.reduced);
  const period =
    d.periodFrom && d.periodTo ? (
      <>
        <DocumentDate date={d.periodFrom} /> 〜 <DocumentDate date={d.periodTo} />
      </>
    ) : null;
  return (
    <>
      <DocumentTitle title="請求書" />
      <DocumentMeta
        items={[
          ["請求書番号", d.number],
          ["発行日", <DocumentDate date={d.issuedOn} />],
          ...(period ? ([["締め期間", period]] as const) : []),
          ...(d.dueOn ? ([["お支払期限", <DocumentDate date={d.dueOn} />]] as const) : []),
        ]}
      />
      <div class="doc-head">
        <Addressee to={d.recipient} />
        <Issuer from={d.issuer} />
      </div>
      <p class="doc-lead">下記のとおりご請求申し上げます。</p>
      <p class="doc-total">ご請求金額（税込） {yen(d.total)}</p>
      <TaxBreakdown groups={d.taxGroups} />
      <table class="doc-table">
        <thead>
          <tr>
            <th>取引年月日</th>
            <th>納品書・返品伝票</th>
            <th>品名</th>
            <th>数量</th>
            <th>単位</th>
            <th>単価（税抜）</th>
            <th>金額（税抜）</th>
          </tr>
        </thead>
        <tbody>
          {d.deliveries.map((x) =>
            x.lines.map((l, i) => (
              <LineRow
                date={x.shippedOn}
                reference={x.deliveryNoteNumber}
                line={l}
                first={i === 0}
              />
            )),
          )}
          {d.returns.map((x) =>
            x.lines.map((l, i) => (
              <LineRow
                date={x.returnedOn}
                reference={`返品 ${x.number}`}
                line={l}
                first={i === 0}
              />
            )),
          )}
        </tbody>
        <tfoot>
          {d.taxGroups.map((g) => (
            <tr>
              <th colspan={5} class="num">
                {TAX_CATEGORY_LABELS[g.category]}（{rate(g.rateBps)}）対象
              </th>
              <td class="num">{yen(g.subtotal)}</td>
              <td class="num">消費税 {yen(g.tax)}</td>
            </tr>
          ))}
          <tr>
            <th colspan={6} class="num">
              小計（税抜）
            </th>
            <td class="num">{yen(d.subtotal)}</td>
          </tr>
          <tr>
            <th colspan={6} class="num">
              消費税
            </th>
            <td class="num">{yen(d.tax)}</td>
          </tr>
          <tr>
            <th colspan={6} class="num">
              合計（税込）
            </th>
            <td class="num">{yen(d.total)}</td>
          </tr>
        </tfoot>
      </table>
      {hasReduced ? (
        <p class="small">※は軽減税率{reducedRateLabel(d.taxGroups)}の対象です。</p>
      ) : null}
      {d.returns.length > 0 ? (
        <p class="small">返品は数量・金額をマイナスで記載し、ご請求金額から差し引いています。</p>
      ) : null}
      {d.issuer.bankInfo ? <p class="doc-note">お振込先：{d.issuer.bankInfo}</p> : null}
      {d.reissuedFromNumber ? (
        <p class="doc-footer">
          この請求書は、請求書 {d.reissuedFromNumber} を取り消して再発行したものです。
        </p>
      ) : null}
      {d.memo ? <p class="doc-note">{d.memo}</p> : null}
    </>
  );
}

export const invoiceTemplate = defineTemplate({
  schema: invoiceSnapshotSchema,
  render: (data) => <InvoiceDocument snapshot={data} />,
});
