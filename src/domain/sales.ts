/** 受注・発送・請求書・入金のルール（要件定義書 3.8〜3.11、4章）。 */
import { err, ok, type Result } from "./result";

export type SalesOrderStatus = "received" | "shipped" | "cancelled";

export const SALES_ORDER_STATUS_LABELS: Readonly<Record<SalesOrderStatus, string>> = {
  received: "受注済み",
  shipped: "発送済み",
  cancelled: "取消",
};

export function canEditSalesOrder(status: SalesOrderStatus): boolean {
  return status === "received";
}

export function shipSalesOrder(status: SalesOrderStatus): Result<"shipped"> {
  return status === "received"
    ? ok("shipped")
    : err("invalid_state", "受注済みの受注だけを発送できます");
}

export function cancelSalesOrder(status: SalesOrderStatus): Result<"cancelled"> {
  return status === "received"
    ? ok("cancelled")
    : err("invalid_state", "発送前の受注だけを取り消せます");
}

/** 発送の取消：請求書が未発行または取消済みのときだけ可能（実質的に入金前のみ）。 */
export function cancelShipment(
  status: SalesOrderStatus,
  hasActiveInvoice: boolean,
): Result<"received"> {
  if (status !== "shipped") return err("invalid_state", "発送済みの受注だけ発送を取り消せます");
  if (hasActiveInvoice)
    return err("invalid_state", "請求書が発行されています。先に請求書を取り消してください");
  return ok("received");
}

/** 受注の分割：各明細の分割数は 0〜元の数量。すべて 0、またはすべて全数は不可。 */
export function validateSplit(
  lines: readonly { id: string; quantity: number }[],
  splitQuantities: ReadonlyMap<string, number>,
): Result<{ id: string; keep: number; move: number }[]> {
  const result: { id: string; keep: number; move: number }[] = [];
  for (const l of lines) {
    const move = splitQuantities.get(l.id) ?? 0;
    if (!Number.isInteger(move) || move < 0 || move > l.quantity) {
      return err("validation", "分割する数量は0から元の数量までの整数で入力してください");
    }
    result.push({ id: l.id, keep: l.quantity - move, move });
  }
  if (result.every((r) => r.move === 0)) return err("validation", "分割する数量を入力してください");
  if (result.every((r) => r.keep === 0))
    return err("validation", "すべての数量を移す場合は分割ではなく受注を編集してください");
  return ok(result);
}

/** 最低ロットの警告（登録は可能）。 */
export function lotWarnings(quantity: number, minLot: number): string[] {
  const warnings: string[] = [];
  if (minLot > 1 && quantity < minLot) warnings.push(`最低ロット（${minLot}）未満です`);
  if (minLot > 1 && quantity % minLot !== 0)
    warnings.push(`最低ロット（${minLot}）の倍数ではありません`);
  return warnings;
}

export type InvoiceStatus = "unpaid" | "partial" | "paid" | "cancelled";

export const INVOICE_STATUS_LABELS: Readonly<Record<InvoiceStatus, string>> = {
  unpaid: "未入金",
  partial: "一部入金",
  paid: "入金済み",
  cancelled: "取消済み",
};

/** 消込の合計から請求書の状態を決める。 */
export function invoiceStatus(total: number, allocated: number, cancelled: boolean): InvoiceStatus {
  if (cancelled) return "cancelled";
  if (allocated <= 0) return "unpaid";
  return allocated >= total ? "paid" : "partial";
}

export function cancelInvoice(status: InvoiceStatus, allocated: number): Result<"cancelled"> {
  if (status === "cancelled") return err("invalid_state", "すでに取り消されています");
  if (allocated !== 0)
    return err(
      "invalid_state",
      "入金の消込がある請求書は取り消せません。先に消込を取り消してください",
    );
  return ok("cancelled");
}

export type AllocationAdjustmentKind = "bank_fee" | "discount" | "other";

export const ALLOCATION_ADJUSTMENT_LABELS: Readonly<Record<AllocationAdjustmentKind, string>> = {
  bank_fee: "振込手数料",
  discount: "値引き",
  other: "その他",
};

export interface AllocationInput {
  readonly invoiceId: string;
  /** 入金から充てる額 */
  readonly amount: number;
  /** 差額として処理する額（請求残高を減らすが入金は使わない） */
  readonly adjustment: number;
}

/**
 * 消込の検証。入金額を超えて充てられず、請求残高を超えて消し込めない。
 * 戻り値は入金の未消込残高。
 */
export function validateAllocations(
  paymentAmount: number,
  alreadyAllocated: number,
  inputs: readonly AllocationInput[],
  invoiceOutstanding: ReadonlyMap<string, number>,
): Result<number> {
  let used = 0;
  for (const a of inputs) {
    if (
      !Number.isInteger(a.amount) ||
      !Number.isInteger(a.adjustment) ||
      a.amount < 0 ||
      a.adjustment < 0
    ) {
      return err("validation", "消込額と差額は0以上の整数で入力してください");
    }
    const outstanding = invoiceOutstanding.get(a.invoiceId);
    if (outstanding === undefined) return err("validation", "対象外の請求書が含まれています");
    if (a.amount + a.adjustment > outstanding)
      return err("validation", "請求残高を超えて消し込めません");
    used += a.amount;
  }
  const remaining = paymentAmount - alreadyAllocated - used;
  if (remaining < 0) return err("validation", "入金額を超えて消し込めません");
  return ok(remaining);
}

/** 返還請求書の交付義務：税込1万円未満は任意（インボイス制度の少額特例）。 */
export function creditNoteRequired(totalWithTax: number): boolean {
  return Math.abs(totalWithTax) >= 10_000;
}
