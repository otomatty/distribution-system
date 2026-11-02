/** 仕入の画面の部品（状態の表示など）。状態の判定はしない（ユースケースの値を表示するだけ） */
import {
  DESTINATION_LABELS,
  PURCHASE_ORDER_STATUS_LABELS,
  SUPPLIER_INVOICE_STATUS_LABELS,
  type DestinationKind,
  type PurchaseOrderStatus,
  type SupplierInvoiceStatus,
} from "../../domain/purchasing";
import type { DomainError } from "../../domain/result";
import type { ShortageDetail } from "../../usecases/stock/queries";
import { paths } from "../paths";
import { Badge, Field, FormKey, Version, type Option } from "./components";
import { StockErrorSummary } from "./stock";

const ORDER_BADGE: Readonly<
  Record<PurchaseOrderStatus, "neutral" | "info" | "success" | "warning" | "danger">
> = {
  draft: "warning",
  ordered: "info",
  received: "success",
  paid: "neutral",
  cancelled: "neutral",
};

export function OrderStatusBadge(props: { status: PurchaseOrderStatus }) {
  return (
    <Badge kind={ORDER_BADGE[props.status]}>{PURCHASE_ORDER_STATUS_LABELS[props.status]}</Badge>
  );
}

const INVOICE_BADGE: Readonly<
  Record<SupplierInvoiceStatus, "neutral" | "info" | "warning" | "success">
> = {
  unpaid: "warning",
  partial: "info",
  paid: "success",
  cancelled: "neutral",
};

export function SupplierInvoiceStatusBadge(props: { status: SupplierInvoiceStatus }) {
  return (
    <Badge kind={INVOICE_BADGE[props.status]}>{SUPPLIER_INVOICE_STATUS_LABELS[props.status]}</Badge>
  );
}

export const ORDER_STATUS_OPTIONS: Option[] = Object.entries(PURCHASE_ORDER_STATUS_LABELS).map(
  ([value, label]) => ({ value, label }),
);

export const INVOICE_STATUS_OPTIONS: Option[] = Object.entries(SUPPLIER_INVOICE_STATUS_LABELS).map(
  ([value, label]) => ({ value, label }),
);

/** 納入先の表示（保管場所名・販売先名、その他の届け先は住所の1行目） */
export function destinationText(order: {
  destinationKind: DestinationKind;
  destinationName: string | null;
  destinationAddress: string | null;
}): string {
  if (order.destinationKind === "other")
    return `${DESTINATION_LABELS.other}：${(order.destinationAddress ?? "").split("\n")[0] ?? ""}`;
  if (order.destinationKind === "customer") return `${order.destinationName ?? ""}（メーカー直）`;
  return order.destinationName ?? "";
}

/** 入荷の取消（理由を入力する。在庫を戻すとマイナスになる場合は、足りない商品と数を表示する） */
export function ReceiptCancelForm(props: {
  receiptId: string;
  number: string;
  version: number;
  error?: DomainError | null;
  shortages?: readonly ShortageDetail[] | undefined;
}) {
  return (
    <details id={`receipt-cancel-${props.receiptId}`} open={props.error ? true : undefined}>
      <summary class="btn btn-secondary btn-sm">取消</summary>
      <form
        method="post"
        action={paths.receiptCancel(props.receiptId)}
        hx-post={paths.receiptCancel(props.receiptId)}
        hx-target={`#receipt-cancel-${props.receiptId}`}
        hx-swap="outerHTML"
        class="form"
      >
        <StockErrorSummary error={props.error} shortages={props.shortages} />
        <FormKey />
        <Version value={props.version} />
        <input type="hidden" name="number" value={props.number} />
        <Field label={`${props.number} の取消の理由`} name={`reason-${props.receiptId}`}>
          <textarea id={`f-reason-${props.receiptId}`} name="reason" rows={2}></textarea>
        </Field>
        <button type="submit" class="btn btn-danger btn-sm">
          入荷を取り消す
        </button>
      </form>
    </details>
  );
}
