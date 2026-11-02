/**
 * 請求書・締め処理・返品伝票・返還請求書・入金と消込・売掛残高・販売先廃棄のルール
 * （要件定義書 3.10〜3.12、4章 請求書の状態遷移と遷移の条件）。
 *
 * - 請求書の明細の金額は明細ごとに、消費税は請求書1枚ごとに税率ごとに1回、どちらも設定の端数処理で丸める
 * - 未請求の返品伝票はマイナスの明細として次の請求書に載せる（返品額は返品伝票に保存した額を使う）
 * - 請求書の allocated は、消し込んだ入金額と差額（振込手数料・値引き・その他）の合計。残高 = 合計 − allocated
 */
import { closingPeriod, paymentDueDate, type ClosingTerms } from "./dates";
import {
  lineAmount,
  ratesOn,
  roundRatio,
  summarizeTax,
  type RoundingMode,
  type TaxCategory,
  type TaxRateEntry,
  type TaxSummary,
} from "./money";
import { err, ok, type FieldError, type Result } from "./result";
import {
  chargeAmount,
  creditNoteRequired,
  invoiceStatus,
  validateAllocations,
  type AllocationAdjustmentKind,
  type InvoiceStatus,
} from "./sales";

// ---- 請求書の明細と金額 ----------------------------------------------------------

/** 請求書に載せる発送（受注明細と送料） */
export interface InvoiceShipmentSource {
  readonly shipmentId: string;
  readonly shippedOn: string;
  readonly lines: readonly {
    readonly salesOrderLineId: string;
    readonly itemName: string;
    readonly unitName: string;
    readonly quantity: number;
    readonly unitPriceCenti: number;
    readonly taxCategory: TaxCategory;
  }[];
  readonly charges: readonly {
    readonly salesChargeId: string;
    readonly description: string;
    readonly quantity: number;
    /** 税抜・円 */
    readonly unitAmount: number;
    readonly taxCategory: TaxCategory;
  }[];
}

/** 請求書にマイナスの明細として載せる返品伝票 */
export interface InvoiceReturnSource {
  readonly salesReturnId: string;
  readonly returnedOn: string;
  readonly lines: readonly {
    readonly salesReturnLineId: string;
    readonly itemName: string;
    readonly unitName: string;
    /** 返品数（正の数） */
    readonly quantity: number;
    readonly unitPriceCenti: number;
    /** 返品額（税抜・円、正の数。返品伝票に保存した額） */
    readonly amount: number;
    readonly taxCategory: TaxCategory;
  }[];
}

export type InvoiceLineSourceType = "shipment_line" | "charge" | "return_line";

/** 請求書の明細の写し（invoice_lines の1行）。返品の明細は数量と金額がマイナス */
export interface InvoiceLineDraft {
  readonly lineNo: number;
  readonly sourceType: InvoiceLineSourceType;
  /** 受注明細・送料・返品伝票の明細の ID */
  readonly sourceId: string;
  readonly transactionDate: string;
  readonly description: string;
  readonly quantity: number;
  readonly unitName: string | null;
  /** 単価（税抜、100分の1円単位）。送料は円 × 100 */
  readonly unitPriceCenti: number;
  /** 金額（税抜・円）。明細ごとに丸め済み */
  readonly amount: number;
  readonly taxCategory: TaxCategory;
}

/** 発送の明細・送料、返品伝票の明細を、渡した順に請求書の明細にする */
export function buildInvoiceLines(
  shipments: readonly InvoiceShipmentSource[],
  returns: readonly InvoiceReturnSource[],
  mode: RoundingMode,
): InvoiceLineDraft[] {
  const out: InvoiceLineDraft[] = [];
  const push = (line: Omit<InvoiceLineDraft, "lineNo">) =>
    out.push({ lineNo: out.length + 1, ...line });
  for (const s of shipments) {
    for (const l of s.lines) {
      push({
        sourceType: "shipment_line",
        sourceId: l.salesOrderLineId,
        transactionDate: s.shippedOn,
        description: l.itemName,
        quantity: l.quantity,
        unitName: l.unitName,
        unitPriceCenti: l.unitPriceCenti,
        amount: lineAmount(l.unitPriceCenti, l.quantity, mode),
        taxCategory: l.taxCategory,
      });
    }
    for (const c of s.charges) {
      push({
        sourceType: "charge",
        sourceId: c.salesChargeId,
        transactionDate: s.shippedOn,
        description: c.description,
        quantity: c.quantity,
        unitName: null,
        unitPriceCenti: c.unitAmount * 100,
        amount: chargeAmount(c),
        taxCategory: c.taxCategory,
      });
    }
  }
  for (const r of returns) {
    for (const l of r.lines) {
      push({
        sourceType: "return_line",
        sourceId: l.salesReturnLineId,
        transactionDate: r.returnedOn,
        description: `返品 ${l.itemName}`,
        quantity: -l.quantity,
        unitName: l.unitName,
        unitPriceCenti: l.unitPriceCenti,
        amount: -l.amount,
        taxCategory: l.taxCategory,
      });
    }
  }
  return out;
}

/**
 * 取引日ごとの税率が1つにそろうか。税率が変わる日をまたぐ取引は、税率ごとの合計を1つにできないので
 * 1枚の請求書にまとめない（期間を分けて発行する）。
 */
export function ratesForDates(
  taxRates: readonly TaxRateEntry[],
  dates: readonly string[],
): Result<Readonly<Record<TaxCategory, number>>> {
  let found: Readonly<Record<TaxCategory, number>> | undefined;
  for (const date of new Set(dates)) {
    const rates = ratesOn(taxRates, date);
    if (!rates)
      return err(
        "invalid_state",
        `取引日（${date}）の税率が設定されていません（管理者に連絡してください）`,
      );
    if (found && (found.standard !== rates.standard || found.reduced !== rates.reduced)) {
      return err(
        "validation",
        "税率が変わる日をまたぐ取引は1枚の請求書にまとめられません。期間を分けて発行してください",
      );
    }
    found = rates;
  }
  if (!found) return err("validation", "請求書に載せる取引がありません");
  return ok(found);
}

export interface InvoicePlan {
  readonly lines: readonly InvoiceLineDraft[];
  /** 税率ごとの合計と消費税額（請求書1枚ごとに税率ごとに1回丸める） */
  readonly summary: TaxSummary;
  /** 最も遅い取引日（発行日はこの日より前にできない） */
  readonly lastTransactionDate: string;
}

/**
 * 請求書の明細と金額。発送が1件以上必要で、返品を差し引いた合計がマイナスになる請求書は作らない
 * （返品を外し、請求済みの返品なら返還請求書で扱う）。
 */
export function planInvoice(input: {
  readonly shipments: readonly InvoiceShipmentSource[];
  readonly returns: readonly InvoiceReturnSource[];
  readonly taxRates: readonly TaxRateEntry[];
  readonly mode: RoundingMode;
}): Result<InvoicePlan> {
  if (input.shipments.length === 0)
    return err("validation", "請求書には発送を1件以上含めてください");
  const dates = [
    ...input.shipments.map((s) => s.shippedOn),
    ...input.returns.map((r) => r.returnedOn),
  ];
  const rates = ratesForDates(input.taxRates, dates);
  if (!rates.ok) return rates;
  const lines = buildInvoiceLines(input.shipments, input.returns, input.mode);
  const summary = summarizeTax(lines, rates.value, input.mode);
  if (summary.total < 0) {
    return err(
      "validation",
      "返品の金額が発送の金額を上回るため、請求額がマイナスになります。返品を外してください",
    );
  }
  const lastTransactionDate = dates.reduce((a, b) => (a > b ? a : b));
  return ok({ lines, summary, lastTransactionDate });
}

/**
 * 発行日と支払期限の確認。発行日は最後の取引日より前にも、今日より後にもできず、
 * 支払期限は発行日より前にできない
 */
export function validateIssueDates(input: {
  readonly issuedOn: string;
  readonly dueOn: string | null;
  readonly lastTransactionDate: string;
  readonly today: string;
}): Result<void> {
  if (input.issuedOn > input.today) {
    const message = "発行日は今日より後にできません";
    return err("validation", message, { fields: [{ field: "issuedOn", message }] });
  }
  if (input.issuedOn < input.lastTransactionDate) {
    const message = `発行日は最後の取引日（${input.lastTransactionDate}）以降にしてください`;
    return err("validation", message, { fields: [{ field: "issuedOn", message }] });
  }
  if (input.dueOn !== null && input.dueOn < input.issuedOn) {
    const message = "支払期限は発行日以降にしてください";
    return err("validation", message, { fields: [{ field: "dueOn", message }] });
  }
  return ok(undefined);
}

// ---- 締め処理 -------------------------------------------------------------------

export interface ClosingTarget {
  readonly from: string;
  readonly to: string;
  /** 締め日を迎えた（締め日当日を含む）。締め処理はこの期間だけ行える */
  readonly ready: boolean;
}

/**
 * 月締めの販売先の、次に締める期間。最も古い未請求の発送が属する締め期間にする
 * （締め処理を忘れた期間があれば、その期間から順に締める）。繰越は載せない。
 */
export function closingTarget(
  oldestUnbilledOn: string,
  closingDay: number,
  today: string,
): ClosingTarget {
  const period = closingPeriod(oldestUnbilledOn, closingDay);
  return { ...period, ready: period.to <= today };
}

/**
 * 締め処理の対象の確認：期間が締め日の設定どおりで、締め日を迎えていて、
 * 発送はすべて期間内、返品は締め日までのものであること。
 */
export function validateClosing(input: {
  readonly closingDay: number;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly today: string;
  readonly shippedOn: readonly string[];
  readonly returnedOn: readonly string[];
}): Result<void> {
  const period = closingPeriod(input.periodTo, input.closingDay);
  if (period.from !== input.periodFrom || period.to !== input.periodTo)
    return err("validation", "締め期間が販売先の締め日と合いません。画面を開き直してください");
  if (input.periodTo > input.today)
    return err("invalid_state", `締め日（${input.periodTo}）を迎える前は締め処理できません`);
  if (input.shippedOn.some((d) => d < input.periodFrom || d > input.periodTo))
    return err("validation", "締め期間の外の発送が含まれています");
  if (input.returnedOn.some((d) => d > input.periodTo))
    return err("validation", "締め日より後の返品が含まれています");
  return ok(undefined);
}

/**
 * 締め処理の請求書の支払期限（締め日から取引条件の支払月・支払日）。
 * 締め日は締め期間の最後の日なので、paymentDueDate に締め日を渡せば同じ期間の支払日になる
 */
export function closingDueDate(periodTo: string, terms: ClosingTerms): string {
  return paymentDueDate(periodTo, terms);
}

// ---- 請求書の状態 -----------------------------------------------------------------

/** 発行したときの状態。合計が 0 円の請求書は受け取るものがないので入金済みにする */
export function issuedInvoiceStatus(total: number): InvoiceStatus {
  return total === 0 ? "paid" : "unpaid";
}

/** 請求残高（合計 − 消し込んだ入金と差額） */
export function invoiceOutstanding(invoice: {
  readonly total: number;
  readonly allocated: number;
}): number {
  return invoice.total - invoice.allocated;
}

/** 入金を消し込める状態（未入金・一部入金） */
export function isOpenInvoice(status: InvoiceStatus): boolean {
  return status === "unpaid" || status === "partial";
}

/** 支払期限を過ぎた未入金・一部入金の請求書 */
export function isOverdue(
  invoice: { readonly status: InvoiceStatus; readonly dueOn: string | null },
  today: string,
): boolean {
  return isOpenInvoice(invoice.status) && invoice.dueOn !== null && invoice.dueOn < today;
}

interface InvoiceBalance {
  readonly status: InvoiceStatus;
  readonly total: number;
  readonly allocated: number;
}

/** 消込（入金額 + 差額 = delta）を請求書に反映した後の allocated と状態 */
export function applyAllocation(
  invoice: InvoiceBalance,
  delta: number,
): Result<{ allocated: number; status: InvoiceStatus }> {
  if (!isOpenInvoice(invoice.status))
    return err("invalid_state", "入金済み・取消済みの請求書には消し込めません");
  if (!Number.isSafeInteger(delta) || delta <= 0)
    return err("validation", "消し込む金額は1円以上で入力してください");
  const allocated = invoice.allocated + delta;
  if (allocated > invoice.total) return err("validation", "請求残高を超えて消し込めません");
  return ok({ allocated, status: invoiceStatus(invoice.total, allocated, false) });
}

/** 消込の取消（入金済み → 一部入金・未入金）を反映した後の allocated と状態 */
export function releaseAllocation(
  invoice: InvoiceBalance,
  delta: number,
): Result<{ allocated: number; status: InvoiceStatus }> {
  if (invoice.status === "cancelled")
    return err("invalid_state", "取消済みの請求書の消込は取り消せません");
  if (!Number.isSafeInteger(delta) || delta <= 0 || delta > invoice.allocated)
    return err("invalid_state", "消込の金額が請求書の記録と合いません");
  const allocated = invoice.allocated - delta;
  return ok({ allocated, status: invoiceStatus(invoice.total, allocated, false) });
}

// ---- 消込 -----------------------------------------------------------------------

export interface AllocationRequest {
  readonly invoiceId: string;
  /** 入金から充てる額（円） */
  readonly amount: number;
  /** 差額として処理する額（円）。請求残高を減らすが入金は使わない */
  readonly adjustment: number;
  readonly adjustmentKind: AllocationAdjustmentKind | null;
}

export interface AllocationPlan {
  /** 消し込む行（金額も差額も 0 の行は除く）。差額のない行の区分は null */
  readonly allocations: readonly (AllocationRequest & { readonly index: number })[];
  /** 消込の後の、入金の未消込残高 */
  readonly remaining: number;
}

/** 明細の行（group.index.field）に結びつけた検証エラー */
function rowError(group: string, index: number, field: string, message: string): Result<never> {
  return err("validation", message, { fields: [{ field: `${group}.${index}.${field}`, message }] });
}

/**
 * 消込の検証（要件定義書 3.11）。1件の入金を複数の請求書に、1枚の請求書に複数の入金を当てられる。
 * - 金額も差額も 0 の行は消し込まない（入力しなかった行）
 * - 差額には区分（振込手数料・値引き・その他）が必要
 * - 1つの請求書に充てる額（入金 + 差額）は請求残高まで。入金から充てる額の合計は入金の未消込残高まで
 *   （入金が請求より多い場合、残りは入金の未消込残高として残り、後で別の請求書に消し込める）
 * outstanding は消し込める請求書の請求残高。fields の添字は requests の位置
 */
export function planAllocations(
  paymentAmount: number,
  alreadyAllocated: number,
  requests: readonly AllocationRequest[],
  outstanding: ReadonlyMap<string, number>,
): Result<AllocationPlan> {
  const rows: (AllocationRequest & { index: number })[] = [];
  const seen = new Set<string>();
  for (const [index, r] of requests.entries()) {
    if (!Number.isSafeInteger(r.amount) || r.amount < 0)
      return rowError("allocations", index, "amount", "消込額は0以上の整数で入力してください");
    if (!Number.isSafeInteger(r.adjustment) || r.adjustment < 0)
      return rowError("allocations", index, "adjustment", "差額は0以上の整数で入力してください");
    if (r.amount === 0 && r.adjustment === 0) continue;
    if (seen.has(r.invoiceId))
      return rowError("allocations", index, "invoiceId", "同じ請求書が複数の行にあります");
    seen.add(r.invoiceId);
    if (r.adjustment > 0 && r.adjustmentKind === null)
      return rowError(
        "allocations",
        index,
        "adjustmentKind",
        "差額の区分（振込手数料・値引き・その他）を選んでください",
      );
    const left = outstanding.get(r.invoiceId);
    if (left === undefined)
      return rowError("allocations", index, "invoiceId", "消し込めない請求書です");
    if (r.amount + r.adjustment > left)
      return rowError("allocations", index, "amount", "請求残高を超えて消し込めません");
    rows.push({ ...r, adjustmentKind: r.adjustment > 0 ? r.adjustmentKind : null, index });
  }
  const checked = validateAllocations(paymentAmount, alreadyAllocated, rows, outstanding);
  if (!checked.ok) return checked;
  return ok({ allocations: rows, remaining: checked.value });
}

export type PaymentMethod = "transfer" | "cash" | "offset" | "other";

export const PAYMENT_METHOD_LABELS: Readonly<Record<PaymentMethod, string>> = {
  transfer: "振込",
  cash: "現金",
  offset: "相殺",
  other: "その他",
};

/** 入金の未消込残高 = 入金額 − 有効な消込の入金額の合計 */
export function paymentUnallocated(amount: number, allocatedAmounts: readonly number[]): number {
  return amount - allocatedAmounts.reduce((s, a) => s + a, 0);
}

export function cancelPayment(payment: { readonly cancelled: boolean }): Result<"cancelled"> {
  return payment.cancelled
    ? err("invalid_state", "この入金はすでに取り消されています")
    : ok("cancelled");
}

// ---- 売掛残高 -------------------------------------------------------------------

export interface ReceivableSums {
  /** 未入金・一部入金の請求書の合計と、そこへの消込の合計 */
  readonly openTotal: number;
  readonly openAllocated: number;
  /** そのうち支払期限を過ぎたもの */
  readonly overdueTotal: number;
  readonly overdueAllocated: number;
  /** 取り消していない入金の合計と、そこからの消込（入金額）の合計 */
  readonly paymentTotal: number;
  readonly paymentAllocated: number;
}

export interface Receivable {
  /** 請求残高（未入金・一部入金の請求書の残り） */
  readonly billed: number;
  /** 支払期限を過ぎた請求残高 */
  readonly overdue: number;
  /** 入金の未消込残高（請求書に消し込んでいない入金） */
  readonly unallocated: number;
  /** 売掛残高 = 請求残高 − 入金の未消込残高 */
  readonly balance: number;
}

/** 販売先ごとの売掛残高。未請求の発送は含めない（請求書を発行してから売掛残高に入る） */
export function receivable(s: ReceivableSums): Receivable {
  const billed = s.openTotal - s.openAllocated;
  const unallocated = s.paymentTotal - s.paymentAllocated;
  return {
    billed,
    overdue: s.overdueTotal - s.overdueAllocated,
    unallocated,
    balance: billed - unallocated,
  };
}

// ---- 返品伝票 -------------------------------------------------------------------

/** 返品伝票は発送後なら何回でも記録できる */
export function canRecordReturn(orderStatus: "received" | "shipped" | "cancelled"): Result<void> {
  return orderStatus === "shipped"
    ? ok(undefined)
    : err("invalid_state", "発送済みの受注だけ返品伝票を記録できます");
}

export interface ReturnableLine {
  /** 発送した数 */
  readonly shipped: number;
  /** すでに返品した数（取り消していない返品伝票） */
  readonly returned: number;
}

export function returnableQuantity(line: ReturnableLine): number {
  return Math.max(0, line.shipped - line.returned);
}

export interface ReturnLineInput {
  readonly salesOrderLineId: string;
  readonly quantity: number;
  /** 在庫に戻す（false なら廃棄） */
  readonly restock: boolean;
  readonly locationId: string | null;
}

/**
 * 返品の明細の検証。数量 0 の行は返品しない。返品数は「発送した数 − 返品済みの数」まで。
 * 在庫に戻す行は保管場所が必要（廃棄の行は保管場所を持たない）。fields の添字は inputs の位置
 */
export function validateReturnLines(
  inputs: readonly ReturnLineInput[],
  returnable: ReadonlyMap<string, ReturnableLine>,
): Result<(ReturnLineInput & { readonly index: number })[]> {
  const out: (ReturnLineInput & { index: number })[] = [];
  const seen = new Set<string>();
  for (const [index, l] of inputs.entries()) {
    if (!Number.isSafeInteger(l.quantity) || l.quantity < 0)
      return rowError("lines", index, "quantity", "返品数は0以上の整数で入力してください");
    if (l.quantity === 0) continue;
    const line = returnable.get(l.salesOrderLineId);
    if (!line || seen.has(l.salesOrderLineId))
      return rowError("lines", index, "salesOrderLineId", "対象外の明細が含まれています");
    seen.add(l.salesOrderLineId);
    const left = returnableQuantity(line);
    if (l.quantity > left)
      return rowError("lines", index, "quantity", `返品できる数（残り${left}）を超えています`);
    if (l.restock && !l.locationId)
      return rowError("lines", index, "locationId", "在庫に戻す保管場所を選んでください");
    out.push({ ...l, locationId: l.restock ? l.locationId : null, index });
  }
  if (out.length === 0) return err("validation", "返品する数量を入力してください");
  return ok(out);
}

/** 返品額（税抜・円）。受注明細の単価 × 返品数を、明細ごとに丸める */
export function returnLineAmount(
  unitPriceCenti: number,
  quantity: number,
  mode: RoundingMode,
): number {
  return lineAmount(unitPriceCenti, quantity, mode);
}

/** 返品伝票の返品額の合計（税抜・円） */
export function returnSubtotal(lines: readonly { readonly amount: number }[]): number {
  return lines.reduce((s, l) => s + l.amount, 0);
}

/** 返品伝票の取消：請求書にも返還請求書にも載っていないものだけ（在庫は打ち消しの行で戻す） */
export function cancelSalesReturn(ret: {
  readonly cancelled: boolean;
  readonly invoiceId: string | null;
  readonly creditNoteNumber: string | null;
}): Result<"cancelled"> {
  if (ret.cancelled) return err("invalid_state", "この返品伝票はすでに取り消されています");
  if (ret.invoiceId !== null)
    return err(
      "invalid_state",
      "請求書に載せた返品伝票は取り消せません。先に請求書を取り消してください",
    );
  if (ret.creditNoteNumber !== null)
    return err("invalid_state", "返還請求書を発行した返品伝票は取り消せません");
  return ok("cancelled");
}

/**
 * 返還請求書を発行できるか：請求書（取消済みでないもの）に載せた返品伝票で、まだ発行していないもの。
 */
export function creditNoteIssuable(ret: {
  readonly cancelled: boolean;
  readonly invoiceStatus: InvoiceStatus | null;
  readonly creditNoteNumber: string | null;
}): Result<void> {
  if (ret.cancelled) return err("invalid_state", "取り消した返品伝票です");
  if (ret.creditNoteNumber !== null)
    return err("invalid_state", "返還請求書はすでに発行しています");
  if (ret.invoiceStatus === null || ret.invoiceStatus === "cancelled")
    return err(
      "invalid_state",
      "返還請求書は、請求書に載せた（請求済みの）返品伝票について発行できます",
    );
  return ok(undefined);
}

/** 返還請求書の交付：税込1万円以上は必要、1万円未満は任意（インボイス制度の少額特例） */
export function creditNoteObligation(totalWithTax: number): "required" | "optional" {
  return creditNoteRequired(totalWithTax) ? "required" : "optional";
}

// ---- 販売先廃棄 -----------------------------------------------------------------

export type DisposalReason = "expired" | "damaged" | "other";

export const DISPOSAL_REASON_LABELS: Readonly<Record<DisposalReason, string>> = {
  expired: "賞味期限切れ",
  damaged: "破損",
  other: "その他",
};

/** 廃棄伝票の明細：1行以上、数量は1以上。同じ商品は理由が違えば別の行にできる */
export function validateDisposalLines(
  lines: readonly {
    readonly itemId: string;
    readonly quantity: number;
    readonly reason: DisposalReason | null;
  }[],
): Result<void> {
  if (lines.length === 0) return err("validation", "廃棄した商品を1つ以上入力してください");
  const seen = new Set<string>();
  const fields: FieldError[] = [];
  for (const [i, l] of lines.entries()) {
    if (!Number.isSafeInteger(l.quantity) || l.quantity < 1)
      fields.push({ field: `lines.${i}.quantity`, message: "数量は1以上の整数で入力してください" });
    const key = `${l.itemId}\u0000${l.reason ?? ""}`;
    if (seen.has(key))
      fields.push({ field: `lines.${i}.itemId`, message: "同じ商品・理由の行が複数あります" });
    seen.add(key);
  }
  const first = fields[0];
  return first ? err("validation", first.message, { fields }) : ok(undefined);
}

/** 廃棄率（ベーシスポイント、1% = 100）= 廃棄数 ÷ 出荷数。出荷がなければ null */
export function disposalRateBps(disposed: number, shipped: number): number | null {
  if (shipped <= 0) return null;
  return roundRatio(disposed * 10_000, shipped, "round");
}

export interface DisposalRateRow {
  readonly disposed: number;
  readonly shipped: number;
}

/** 廃棄数と出荷数をキーごとに合計し、廃棄率を付ける（渡した順で、キーの最初の行を代表にする） */
export function summarizeDisposalRates<R extends DisposalRateRow>(
  rows: readonly R[],
  keyOf: (row: R) => string,
): {
  readonly row: R;
  readonly disposed: number;
  readonly shipped: number;
  readonly rateBps: number | null;
}[] {
  const groups = new Map<string, { row: R; disposed: number; shipped: number }>();
  for (const r of rows) {
    const key = keyOf(r);
    const g = groups.get(key);
    if (g) {
      g.disposed += r.disposed;
      g.shipped += r.shipped;
    } else groups.set(key, { row: r, disposed: r.disposed, shipped: r.shipped });
  }
  return [...groups.values()].map((g) =>
    Object.assign(g, { rateBps: disposalRateBps(g.disposed, g.shipped) }),
  );
}
