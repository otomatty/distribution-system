/** 発注・入荷・仕入先請求書のルール（要件定義書 3.5〜3.7、4章）。 */
import { err, ok, type Result } from "./result";

export type PurchaseOrderStatus = "draft" | "ordered" | "received" | "paid" | "cancelled";

export const PURCHASE_ORDER_STATUS_LABELS: Readonly<Record<PurchaseOrderStatus, string>> = {
  draft: "作成中",
  ordered: "発注済み",
  received: "入荷済み",
  paid: "支払済み",
  cancelled: "取消",
};

export type DestinationKind = "location" | "customer" | "other";

export const DESTINATION_LABELS: Readonly<Record<DestinationKind, string>> = {
  location: "保管場所",
  customer: "販売先（メーカー直）",
  other: "その他の届け先",
};

export interface PurchaseOrderLineState {
  readonly id: string;
  /** 発注数（仕入単位） */
  readonly quantity: number;
  /** これまでの受入数 + 返品数の合計（仕入単位） */
  readonly receivedQuantity: number;
  /** 残りを打ち切ったか */
  readonly closed: boolean;
}

export function remainingQuantity(line: PurchaseOrderLineState): number {
  return line.closed ? 0 : Math.max(0, line.quantity - line.receivedQuantity);
}

export function canEditOrder(status: PurchaseOrderStatus): boolean {
  return status === "draft";
}

export function confirmOrder(status: PurchaseOrderStatus, lineCount: number): Result<"ordered"> {
  if (status !== "draft") return err("invalid_state", "作成中の発注だけを確定できます");
  if (lineCount === 0) return err("validation", "明細を1行以上入力してください");
  return ok("ordered");
}

export function cancelOrder(
  status: PurchaseOrderStatus,
  receiptCount: number,
): Result<"cancelled"> {
  if (status !== "draft" && status !== "ordered")
    return err("invalid_state", "入荷前の発注だけを取り消せます");
  if (receiptCount > 0) return err("invalid_state", "入荷が記録された発注は取り消せません");
  return ok("cancelled");
}

export interface ReceiptLineInput {
  readonly lineId: string;
  /** 受入数（仕入単位） */
  readonly accepted: number;
  /** その場で返品した数（仕入単位） */
  readonly returned: number;
  /** 残りを打ち切るか */
  readonly closeRemaining: boolean;
}

/**
 * 入荷の記録を検証し、記録後の明細の状態と発注の状態を返す。
 * 全明細の残りが 0 になれば入荷済み、そうでなければ発注済みのまま（分納）。
 */
export function recordReceipt(
  status: PurchaseOrderStatus,
  lines: readonly PurchaseOrderLineState[],
  inputs: readonly ReceiptLineInput[],
): Result<{ lines: PurchaseOrderLineState[]; status: PurchaseOrderStatus }> {
  if (status !== "ordered") return err("invalid_state", "発注済みの発注だけに入荷を記録できます");
  const byId = new Map(inputs.map((i) => [i.lineId, i]));
  if (byId.size !== inputs.length) return err("validation", "同じ明細が複数あります");
  for (const id of byId.keys()) {
    if (!lines.some((l) => l.id === id)) return err("validation", "発注にない明細が含まれています");
  }
  let touched = false;
  const next: PurchaseOrderLineState[] = [];
  for (const line of lines) {
    const input = byId.get(line.id);
    if (!input) {
      next.push(line);
      continue;
    }
    const { accepted, returned } = input;
    if (
      !Number.isInteger(accepted) ||
      !Number.isInteger(returned) ||
      accepted < 0 ||
      returned < 0
    ) {
      return err("validation", "受入数と返品数は0以上の整数で入力してください");
    }
    if (accepted + returned > remainingQuantity(line)) {
      return err("validation", "受入数と返品数の合計が残りの数を超えています");
    }
    if (accepted + returned > 0 || input.closeRemaining) touched = true;
    next.push({
      ...line,
      receivedQuantity: line.receivedQuantity + accepted + returned,
      closed: line.closed || input.closeRemaining,
    });
  }
  if (!touched) return err("validation", "受入数・返品数・打ち切りのいずれかを入力してください");
  const done = next.every((l) => remainingQuantity(l) === 0);
  return ok({ lines: next, status: done ? "received" : "ordered" });
}

/** 入荷を取り消したときの発注の状態。支払済みの請求書に含まれる入荷は取り消せない。 */
export function cancelReceipt(
  status: PurchaseOrderStatus,
  includedInPaidInvoice: boolean,
): Result<"ordered"> {
  if (status !== "ordered" && status !== "received")
    return err("invalid_state", "この発注の入荷は取り消せません");
  if (includedInPaidInvoice)
    return err("invalid_state", "支払済みの請求書に含まれる入荷は取り消せません");
  return ok("ordered");
}

/** 在庫に入る数（販売単位）= 受入数 × 入数 */
export function stockQuantity(acceptedPurchaseUnits: number, unitsPerPurchaseUnit: number): number {
  return acceptedPurchaseUnits * unitsPerPurchaseUnit;
}

export type SupplierInvoiceStatus = "unpaid" | "paid" | "cancelled";

export const SUPPLIER_INVOICE_STATUS_LABELS: Readonly<Record<SupplierInvoiceStatus, string>> = {
  unpaid: "未払い",
  paid: "支払済み",
  cancelled: "取消",
};

/** 請求額とシステム計算額の差額。差額があるときは理由が必要。 */
export function invoiceDifference(
  invoicedAmount: number,
  computedAmount: number,
  reason: string,
): Result<number> {
  const diff = invoicedAmount - computedAmount;
  if (diff !== 0 && reason.trim() === "")
    return err("validation", "請求額と計算額に差額があります。理由を入力してください", {
      fields: [{ field: "differenceReason", message: "差額の理由を入力してください" }],
    });
  return ok(diff);
}
