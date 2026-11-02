/** 発注・入荷・仕入先請求書のルール（要件定義書 3.5〜3.7、4章）。 */
import {
  lineAmount,
  rateOn,
  roundRatio,
  summarizeTax,
  type AmountLine,
  type RoundingMode,
  type TaxCategory,
  type TaxRateEntry,
  type TaxSummary,
} from "./money";
import { err, ok, type Result } from "./result";
import { isValidEmail } from "./validation";

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

/** 発注書の送付方法。システムから送るのはメールだけ（FAX は PDF を社内の FAX 機で送り、手動の送付として記録する） */
export type SendMethod = "email" | "none";

export const SEND_METHOD_LABELS: Readonly<Record<SendMethod, string>> = {
  email: "メール",
  none: "送付しない（FAX・手渡しなど）",
};

/**
 * 確定（作成中 → 発注済み）。明細が1行以上で、送付方法がメールなら宛先が必要（要件定義書 4章の遷移表）。
 * 確定と送付は1つのユースケースで行う。
 */
export function confirmOrder(
  status: PurchaseOrderStatus,
  lineCount: number,
  sendMethod: SendMethod,
  recipient: string | null,
): Result<"ordered"> {
  if (status !== "draft") return err("invalid_state", "作成中の発注だけを確定できます");
  if (lineCount === 0) return err("validation", "明細を1行以上入力してください");
  if (sendMethod === "email") {
    const to = (recipient ?? "").trim();
    if (to === "")
      return err("validation", "メールで送る場合は宛先を入力してください", {
        fields: [{ field: "recipient", message: "宛先のメールアドレスを入力してください" }],
      });
    if (!isValidEmail(to))
      return err("validation", "宛先のメールアドレスの形式が正しくありません", {
        fields: [{ field: "recipient", message: "メールアドレスの形式が正しくありません" }],
      });
  }
  return ok("ordered");
}

/** 取消（作成中・発注済み → 取消）。入荷が1件もない（取り消した入荷は数えない）。理由が必須 */
export function cancelOrder(
  status: PurchaseOrderStatus,
  receiptCount: number,
  reason: string,
): Result<"cancelled"> {
  if (status !== "draft" && status !== "ordered")
    return err("invalid_state", "入荷前の発注だけを取り消せます");
  if (receiptCount > 0) return err("invalid_state", "入荷が記録された発注は取り消せません");
  if (reason.trim() === "")
    return err("validation", "取消の理由を入力してください", {
      fields: [{ field: "reason", message: "取消の理由を入力してください" }],
    });
  return ok("cancelled");
}

/**
 * 明細の単価の検証。単価は必須（マスタの仕入価格が初期値）。
 * 「発注時に仕入価格を入力する」商品は、0 より大きい単価を入力しなければならない（相場で変わる商品など）。
 */
export function orderLinePriceError(
  inputPriceOnOrder: boolean,
  unitPriceCenti: number | null,
): string | undefined {
  if (unitPriceCenti === null) return "単価を入力してください";
  if (inputPriceOnOrder && unitPriceCenti <= 0)
    return "この商品は発注時に仕入価格を入力してください";
  return undefined;
}

/** 取引日時点の税率（税区分ごと）。どちらかの税率が税率表になければ undefined */
export function ratesOn(
  rates: readonly TaxRateEntry[],
  date: string,
): Readonly<Record<TaxCategory, number>> | undefined {
  const standard = rateOn(rates, "standard", date);
  const reduced = rateOn(rates, "reduced", date);
  return standard === undefined || reduced === undefined ? undefined : { standard, reduced };
}

export interface PricedLine {
  /** 数量（仕入単位） */
  readonly quantity: number;
  /** 単価（仕入単位あたり、税抜、centi-yen） */
  readonly unitPriceCenti: number;
  readonly taxCategory: TaxCategory;
}

/**
 * 発注の金額。明細の金額（単価 × 数量）の1円未満は明細ごとに、消費税は発注書1枚ごとに税率ごとに1回丸める。
 * amounts は lines と同じ順の明細の金額（円）。
 */
export function orderAmounts(
  lines: readonly PricedLine[],
  rates: Readonly<Record<TaxCategory, number>>,
  mode: RoundingMode,
): { amounts: number[]; summary: TaxSummary } {
  const amounts = lines.map((l) => lineAmount(l.unitPriceCenti, l.quantity, mode));
  const summary = summarizeTax(
    lines.map((l, i) => ({ amount: amounts[i] ?? 0, taxCategory: l.taxCategory })),
    rates,
    mode,
  );
  return { amounts, summary };
}

/** 取消の操作を出してよい状態か（入荷の有無は cancelOrder で確かめる） */
export function canCancelOrder(status: PurchaseOrderStatus): boolean {
  return status === "draft" || status === "ordered";
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
    const remaining = remainingQuantity(line);
    if (accepted + returned > remaining) {
      return err("validation", "受入数と返品数の合計が残りの数を超えています");
    }
    // すでに残りのない明細の「打ち切り」は何もしない
    const closes = input.closeRemaining && remaining - accepted - returned > 0;
    if (accepted + returned > 0 || closes) touched = true;
    next.push({
      ...line,
      receivedQuantity: line.receivedQuantity + accepted + returned,
      closed: line.closed || closes,
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

/** 入荷1件の明細（取消のときに発注の明細へ戻す値） */
export interface RecordedReceiptLine {
  readonly purchaseOrderLineId: string;
  readonly accepted: number;
  readonly returned: number;
  /** この入荷で残りを打ち切ったか */
  readonly closedRemaining: boolean;
}

/**
 * 入荷の取消で、発注の明細の入荷済みの数と打ち切りを戻す。
 * 戻した結果がマイナスになるなら、記録が崩れているので invalid_state。
 */
export function revertReceipt(
  lines: readonly PurchaseOrderLineState[],
  receiptLines: readonly RecordedReceiptLine[],
): Result<PurchaseOrderLineState[]> {
  const byLine = new Map<string, RecordedReceiptLine[]>();
  for (const r of receiptLines) {
    if (!lines.some((l) => l.id === r.purchaseOrderLineId))
      return err("invalid_state", "発注にない明細の入荷です");
    byLine.set(r.purchaseOrderLineId, [...(byLine.get(r.purchaseOrderLineId) ?? []), r]);
  }
  const next: PurchaseOrderLineState[] = [];
  for (const line of lines) {
    const rs = byLine.get(line.id) ?? [];
    const back = rs.reduce((s, r) => s + r.accepted + r.returned, 0);
    const receivedQuantity = line.receivedQuantity - back;
    if (receivedQuantity < 0) return err("invalid_state", "入荷済みの数が0未満になります");
    next.push({
      ...line,
      receivedQuantity,
      closed: rs.some((r) => r.closedRemaining) ? false : line.closed,
    });
  }
  return ok(next);
}

/** 在庫に入る数（販売単位）= 受入数 × 入数 */
export function stockQuantity(acceptedPurchaseUnits: number, unitsPerPurchaseUnit: number): number {
  return acceptedPurchaseUnits * unitsPerPurchaseUnit;
}

// ---- 仕入返品（入荷後に見つかった不良品など） ---------------------------------------

/** 仕入返品できる発注明細の状態 */
export interface ReturnableLine {
  readonly id: string;
  /** 単価（仕入単位あたり、税抜、centi-yen） */
  readonly unitPriceCenti: number;
  readonly unitsPerPurchaseUnit: number;
  readonly taxCategory: TaxCategory;
  /** 取り消していない入荷の受入数の合計（仕入単位） */
  readonly acceptedQuantity: number;
  /** これまでの仕入返品の数の合計（販売単位） */
  readonly returnedUnits: number;
}

/** 仕入返品できる残りの数（販売単位）= 受入数 × 入数 − これまでの仕入返品 */
export function returnableUnits(line: ReturnableLine): number {
  return Math.max(
    0,
    stockQuantity(line.acceptedQuantity, line.unitsPerPurchaseUnit) - line.returnedUnits,
  );
}

/**
 * 仕入返品の金額（税抜・円）。単価は仕入単位あたりなので、販売単位の数 × 単価 ÷ 入数 を明細ごとに丸める。
 * 金額は正の数で持ち、仕入先請求書の計算で差し引く。
 */
export function purchaseReturnAmount(
  unitPriceCenti: number,
  unitsPerPurchaseUnit: number,
  units: number,
  mode: RoundingMode,
): number {
  return roundRatio(unitPriceCenti * units, 100 * unitsPerPurchaseUnit, mode);
}

export interface PurchaseReturnInput {
  readonly lineId: string;
  /** 返品する数（販売単位）。0 の行は無視する */
  readonly units: number;
}

export interface PurchaseReturnLineResult {
  readonly lineId: string;
  readonly units: number;
  readonly amount: number;
  readonly taxCategory: TaxCategory;
  readonly unitPriceCenti: number;
}

/**
 * 仕入返品の検証と金額。入荷のある発注（発注済み・入荷済み・支払済み）だけが対象で、
 * 明細ごとに「受入数 × 入数 − これまでの仕入返品」を超えて返品できない。
 */
export function recordPurchaseReturn(
  status: PurchaseOrderStatus,
  lines: readonly ReturnableLine[],
  inputs: readonly PurchaseReturnInput[],
  mode: RoundingMode,
): Result<PurchaseReturnLineResult[]> {
  if (status !== "ordered" && status !== "received" && status !== "paid")
    return err("invalid_state", "入荷のある発注だけ仕入返品を記録できます");
  const seen = new Set<string>();
  const out: PurchaseReturnLineResult[] = [];
  for (const input of inputs) {
    if (seen.has(input.lineId)) return err("validation", "同じ明細が複数あります");
    seen.add(input.lineId);
    const line = lines.find((l) => l.id === input.lineId);
    if (!line) return err("validation", "発注にない明細が含まれています");
    if (!Number.isInteger(input.units) || input.units < 0)
      return err("validation", "返品数は0以上の整数で入力してください");
    if (input.units === 0) continue;
    if (input.units > returnableUnits(line))
      return err("validation", "返品数が入荷した数（これまでの返品を除く）を超えています");
    out.push({
      lineId: line.id,
      units: input.units,
      amount: purchaseReturnAmount(
        line.unitPriceCenti,
        line.unitsPerPurchaseUnit,
        input.units,
        mode,
      ),
      taxCategory: line.taxCategory,
      unitPriceCenti: line.unitPriceCenti,
    });
  }
  if (out.length === 0) return err("validation", "返品する数を1つ以上入力してください");
  return ok(out);
}

/**
 * 入荷を取り消すと、その明細の受入数が減る。仕入返品した数を下回るなら取り消せない。
 * acceptedAfter は取り消した後の受入数の合計（仕入単位）。
 */
export function receiptCancelBlockedByReturns(
  lines: readonly { acceptedAfter: number; unitsPerPurchaseUnit: number; returnedUnits: number }[],
): Result<true> {
  if (lines.some((l) => stockQuantity(l.acceptedAfter, l.unitsPerPurchaseUnit) < l.returnedUnits))
    return err("invalid_state", "仕入返品を記録した商品の入荷は取り消せません");
  return ok(true);
}

// ---- 仕入先請求書と支払 ------------------------------------------------------

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

/**
 * システムの計算額（税込・円）= （受入数 × 単価 − 仕入返品）の税率ごとの合計に消費税を加えたもの + 送料。
 * 明細の金額は入荷・返品の記録で丸め済み（税抜）。消費税は請求書1枚ごとに税率ごとに1回丸める。
 * 送料は請求書に書かれた額（税込）をそのまま加える。
 */
export function supplierInvoiceAmount(
  receiptLines: readonly AmountLine[],
  returnLines: readonly AmountLine[],
  shippingFee: number,
  rates: Readonly<Record<TaxCategory, number>>,
  mode: RoundingMode,
): { summary: TaxSummary; computedAmount: number } {
  const summary = summarizeTax(
    [
      ...receiptLines,
      ...returnLines.map((l) => ({ amount: -l.amount, taxCategory: l.taxCategory })),
    ],
    rates,
    mode,
  );
  return { summary, computedAmount: summary.total + shippingFee };
}

/** 仕入先請求書の登録。入荷を1件以上結びつける */
export function registerSupplierInvoice(receiptCount: number): Result<"unpaid"> {
  if (receiptCount === 0)
    return err("validation", "請求の対象の入荷を1件以上選んでください", {
      fields: [{ field: "receiptIds", message: "入荷を1件以上選んでください" }],
    });
  return ok("unpaid");
}

/** 支払（未払い → 支払済み）。支払額は1円以上 */
export function paySupplierInvoice(status: SupplierInvoiceStatus, amount: number): Result<"paid"> {
  if (status !== "unpaid") return err("invalid_state", "未払いの請求書だけを支払えます");
  if (!Number.isInteger(amount) || amount <= 0)
    return err("validation", "支払額は1円以上の整数で入力してください", {
      fields: [{ field: "amount", message: "支払額は1円以上で入力してください" }],
    });
  return ok("paid");
}

/** 支払の取消（支払済み → 未払い）。理由が必須 */
export function cancelSupplierPayment(
  status: SupplierInvoiceStatus,
  reason: string,
): Result<"unpaid"> {
  if (status !== "paid") return err("invalid_state", "支払済みの請求書だけ支払を取り消せます");
  if (reason.trim() === "")
    return err("validation", "支払の取消の理由を入力してください", {
      fields: [{ field: "reason", message: "取消の理由を入力してください" }],
    });
  return ok("unpaid");
}

/** 仕入先請求書の取消（未払い → 取消）。支払済みなら先に支払を取り消す。理由が必須 */
export function cancelSupplierInvoice(
  status: SupplierInvoiceStatus,
  reason: string,
): Result<"cancelled"> {
  if (status === "paid")
    return err("invalid_state", "支払済みの請求書は取り消せません。先に支払を取り消してください");
  if (status !== "unpaid") return err("invalid_state", "すでに取り消されています");
  if (reason.trim() === "")
    return err("validation", "取消の理由を入力してください", {
      fields: [{ field: "reason", message: "取消の理由を入力してください" }],
    });
  return ok("cancelled");
}

/**
 * 請求書を支払ったときの発注の状態（入荷済み → 支払済み）。
 * 発注の入荷（取り消したものを除く）がすべて支払済みの請求書に入ったときだけ支払済みにする。
 * 分納の途中（発注済み）なら変えない。
 */
export function orderStatusAfterInvoicePaid(
  status: PurchaseOrderStatus,
  allReceiptsPaid: boolean,
): PurchaseOrderStatus {
  return status === "received" && allReceiptsPaid ? "paid" : status;
}

/** 支払を取り消したときの発注の状態（支払済み → 入荷済み） */
export function orderStatusAfterPaymentCancelled(status: PurchaseOrderStatus): PurchaseOrderStatus {
  return status === "paid" ? "received" : status;
}
