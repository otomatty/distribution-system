/**
 * 請求・入金・返品の画面の部品（状態の表示、請求書の明細、帳票の状況、受注詳細の返品伝票の欄）。
 * 金額は usecases で計算した値を表示するだけ。
 */
import {
  DISPOSAL_REASON_LABELS,
  PAYMENT_METHOD_LABELS,
  type DisposalReason,
  type PaymentMethod,
} from "../../domain/billing";
import { RENDER_STATUS_LABELS, SEND_STATUS_LABELS } from "../../domain/documents";
import { INVOICE_STATUS_LABELS, type InvoiceStatus } from "../../domain/sales";
import type {
  InvoiceDocumentRef,
  InvoiceLineRecord,
  InvoiceTaxGroup,
} from "../../usecases/billing/invoices.port";
import type { OrderReturns } from "../../usecases/billing/returns";
import { paths } from "../paths";
import { Badge } from "./components";
import { centiYen, qty, yen } from "./format";
import { TaxCategoryLabel, TotalsFoot } from "./sales";

const STATUS_KIND: Readonly<Record<InvoiceStatus, "info" | "warning" | "success" | "neutral">> = {
  unpaid: "info",
  partial: "warning",
  paid: "success",
  cancelled: "neutral",
};

export function InvoiceStatusBadge(props: { status: InvoiceStatus; overdue?: boolean }) {
  return (
    <>
      <Badge kind={STATUS_KIND[props.status]}>{INVOICE_STATUS_LABELS[props.status]}</Badge>
      {props.overdue ? (
        <>
          {" "}
          <Badge kind="danger">期限超過</Badge>
        </>
      ) : null}
    </>
  );
}

export function paymentMethodLabel(method: PaymentMethod): string {
  return PAYMENT_METHOD_LABELS[method];
}

export function disposalReasonLabel(reason: DisposalReason | null): string {
  return reason ? DISPOSAL_REASON_LABELS[reason] : "";
}

/** 請求書の明細の写し（返品はマイナス）と、税率ごとの合計・消費税額 */
export function InvoiceLinesTable(props: {
  lines: readonly InvoiceLineRecord[];
  totals: {
    readonly taxSummary: readonly InvoiceTaxGroup[];
    readonly subtotal: number;
    readonly tax: number;
    readonly total: number;
  };
}) {
  const t = props.totals;
  return (
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>取引日</th>
            <th>品名</th>
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
            <tr class={l.sourceType === "return_line" ? "row-warning" : undefined}>
              <td class="nowrap">{l.transactionDate}</td>
              <td>{l.description}</td>
              <td class="num">
                {qty(l.quantity)}
                {l.unitName ? <span class="muted small">{l.unitName}</span> : null}
              </td>
              <td class="num">{centiYen(l.unitPriceCenti)}</td>
              <td>
                <TaxCategoryLabel category={l.taxCategory} />
              </td>
              <td class="num">{yen(l.amount)}</td>
              <td></td>
            </tr>
          ))}
        </tbody>
        <TotalsFoot
          summary={{ groups: t.taxSummary, subtotal: t.subtotal, tax: t.tax, total: t.total }}
          incomplete={false}
          columns={7}
        />
      </table>
      <p class="hint">※は軽減税率の対象です。返品はマイナスの明細です。</p>
    </div>
  );
}

/** 帳票（PDF）の状況と、帳票の詳細（送付）・ダウンロードへのリンク */
export function DocumentLinks(props: { document: InvoiceDocumentRef | null; label: string }) {
  const d = props.document;
  if (!d) return <span class="muted">—</span>;
  return (
    <span class="inline">
      <a href={paths.document(d.documentId)}>{props.label}を開く（送付・送付履歴）</a>{" "}
      {d.cancelled ? <Badge>取消済み</Badge> : null}{" "}
      {d.status === "ready" ? (
        <a class="btn btn-secondary btn-sm" href={paths.documentDownload(d.documentId)}>
          PDF
        </a>
      ) : (
        <Badge kind={d.status === "failed" ? "danger" : "neutral"}>
          {RENDER_STATUS_LABELS[d.status]}
        </Badge>
      )}{" "}
      {d.lastSendStatus ? (
        <Badge kind={d.lastSendStatus === "failed" ? "danger" : "success"}>
          {SEND_STATUS_LABELS[d.lastSendStatus]}
        </Badge>
      ) : (
        <Badge>未送付</Badge>
      )}
    </span>
  );
}

/** 受注詳細の「返品伝票」の欄（返品伝票の一覧と、登録へのリンク） */
export function SalesReturnsSection(props: {
  orderId: string;
  data: OrderReturns;
  canManage: boolean;
}) {
  const { data } = props;
  return (
    <section class="card" id="so-returns">
      <h2>返品伝票</h2>
      {data.returns.length === 0 ? (
        <p class="muted">返品伝票はありません。</p>
      ) : (
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>返品伝票</th>
                <th>返品日</th>
                <th class="num">返品額（税抜）</th>
                <th>明細</th>
                <th>請求</th>
              </tr>
            </thead>
            <tbody>
              {data.returns.map((r) => (
                <tr class={r.cancelled ? "row-muted" : undefined}>
                  <td class="nowrap">
                    <a href={paths.salesReturn(r.id)}>{r.number}</a>
                    {r.cancelled ? (
                      <>
                        {" "}
                        <Badge>取消</Badge>
                      </>
                    ) : null}
                  </td>
                  <td class="nowrap">{r.returnedOn}</td>
                  <td class="num">{yen(r.subtotal)}</td>
                  <td class="small">
                    {r.lines
                      .map(
                        (l) =>
                          `${l.itemName} ${qty(l.quantity)}${l.unitName}（${l.restock ? `在庫に戻す：${l.locationName ?? ""}` : "廃棄"}）`,
                      )
                      .join("、")}
                  </td>
                  <td>
                    {r.invoiceId ? (
                      <a href={paths.invoice(r.invoiceId)}>{r.invoiceNumber}</a>
                    ) : r.cancelled ? null : (
                      "未請求（次の請求書に載せる）"
                    )}
                    {r.creditNoteNumber ? (
                      <div class="small">返還請求書 {r.creditNoteNumber}</div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.canRecord && props.canManage ? (
        <a class="btn btn-secondary" href={paths.salesReturnNew(props.orderId)}>
          返品伝票を登録
        </a>
      ) : null}
    </section>
  );
}
