/** 発注・入荷・仕入先請求書のルール（要件定義書 3.5〜3.7、4章）。 */
import {
  formatYen,
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
export type OrderSendMethod = "email" | "none";

export const ORDER_SEND_METHOD_LABELS: Readonly<Record<OrderSendMethod, string>> = {
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
  sendMethod: OrderSendMethod,
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
 * 正しければ単価（centi-yen）を返す。
 */
export function orderLinePrice(
  inputPriceOnOrder: boolean,
  unitPriceCenti: number | null,
): Result<number> {
  if (unitPriceCenti === null) return err("validation", "単価を入力してください");
  if (inputPriceOnOrder && unitPriceCenti <= 0)
    return err("validation", "この商品は発注時に仕入価格を入力してください");
  return ok(unitPriceCenti);
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
 * lines は渡した明細に金額（円）を足したもの（同じ順）。
 */
export function orderAmounts<L extends PricedLine>(
  lines: readonly L[],
  rates: Readonly<Record<TaxCategory, number>>,
  mode: RoundingMode,
): { lines: (L & { readonly amount: number })[]; summary: TaxSummary } {
  const priced = lines.map((l) => ({
    ...l,
    amount: lineAmount(l.unitPriceCenti, l.quantity, mode),
  }));
  return { lines: priced, summary: summarizeTax(priced, rates, mode) };
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

/** 入荷で変わった明細（入荷の明細として記録する） */
export interface ReceiptChange<L extends PurchaseOrderLineState> {
  /** 入荷の前の明細 */
  readonly line: L;
  readonly accepted: number;
  readonly returned: number;
  /** この入荷で残りを打ち切ったか */
  readonly closedNow: boolean;
}

/**
 * 入荷の進み具合と支払の状況から決まる、発注済み以降の発注の状態（入荷の記録・入荷の取消・支払・支払の取消・
 * 請求書の取消のたびに、この関数で決め直す）。
 * - どれかの明細に残りがあれば発注済み（分納の途中）
 * - 全明細の残りが 0（全数がそろったか、残りを打ち切った）なら入荷済み
 * - ただし、受入のある入荷（取り消したものを除く）のうち支払済みの請求書に入っていないものが1件もなければ、
 *   支払うものが残っていないので支払済みにする。受入のある入荷がすべて支払済みの場合と、受入のある入荷が
 *   1件もない場合（全数をその場で返品した、受入 0 で打ち切った）を含む。受入のない入荷は請求書に載せられない
 *   （仕入先請求書の対象は受入のある入荷だけ）ので、こうしないと支払済みになる手段がない
 * unpaidAcceptedReceipts は、その時点の「受入があり、支払済みの請求書に入っていない入荷」の件数
 * （一部支払の請求書の入荷は、支払済みの請求書に入っていないと数える）。
 */
export function settledOrderStatus(
  lines: readonly PurchaseOrderLineState[],
  unpaidAcceptedReceipts: number,
): "ordered" | "received" | "paid" {
  if (lines.some((l) => remainingQuantity(l) > 0)) return "ordered";
  return unpaidAcceptedReceipts > 0 ? "received" : "paid";
}

/**
 * 入荷の記録を検証し、記録後の明細の状態と発注の状態を返す。
 * 全明細の残りが 0 になれば入荷済み、そうでなければ発注済みのまま（分納）。
 * 残りが 0 になっても、支払うものが残っていなければ支払済み（settledOrderStatus）。
 * unpaidAcceptedReceipts は記録の前の「受入があり、支払済みの請求書に入っていない入荷」の件数で、
 * この入荷に受入があれば1件を足して判定する。
 * changes は受入数・返品数・打ち切りのあった明細（明細の順）。
 */
export function recordReceipt<L extends PurchaseOrderLineState>(
  status: PurchaseOrderStatus,
  lines: readonly L[],
  inputs: readonly ReceiptLineInput[],
  unpaidAcceptedReceipts: number,
): Result<{ lines: L[]; status: PurchaseOrderStatus; changes: ReceiptChange<L>[] }> {
  if (status !== "ordered") return err("invalid_state", "発注済みの発注だけに入荷を記録できます");
  const byId = new Map(inputs.map((i) => [i.lineId, i]));
  if (byId.size !== inputs.length) return err("validation", "同じ明細が複数あります");
  for (const id of byId.keys()) {
    if (!lines.some((l) => l.id === id)) return err("validation", "発注にない明細が含まれています");
  }
  const next: L[] = [];
  const changes: ReceiptChange<L>[] = [];
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
    if (accepted + returned > 0 || closes)
      changes.push({ line, accepted, returned, closedNow: closes });
    next.push({
      ...line,
      receivedQuantity: line.receivedQuantity + accepted + returned,
      closed: line.closed || closes,
    });
  }
  if (changes.length === 0)
    return err("validation", "受入数・返品数・打ち切りのいずれかを入力してください");
  const accepted = changes.some((c) => c.accepted > 0) ? 1 : 0;
  return ok({
    lines: next,
    status: settledOrderStatus(next, unpaidAcceptedReceipts + accepted),
    changes,
  });
}

/**
 * 請求書の支払の状況で、結びついた入荷・仕入返品を取り消せるか。
 * 支払（一部を含む）を記録した請求書の入荷・仕入返品は取り消せない（請求の対象が変わると、支払った額の根拠が変わるため）。
 * 一部支払の請求書は、先に支払をすべて取り消せば（未払いに戻れば）取り消せる。
 * 未払いの請求書なら取り消せ、請求書から外して計算額と差額を計算し直す（detachReceiptFromInvoice）。
 */
function invoiceAllowsCancel(
  invoiceStatus: SupplierInvoiceStatus | null,
  what: "入荷" | "仕入返品",
): Result<true> {
  if (invoiceStatus === "paid")
    return err("invalid_state", `支払済みの請求書に含まれる${what}は取り消せません`);
  if (invoiceStatus === "partial")
    return err(
      "invalid_state",
      `一部支払の請求書に含まれる${what}は取り消せません。先に請求書の支払をすべて取り消してください`,
    );
  return ok(true);
}

/**
 * 入荷を取り消せるか。支払（一部を含む）を記録した請求書に含まれる入荷と、支払済み（以降）の発注の入荷は取り消せない
 * （要件定義書 3.6「支払済みになる前なら取り消せる」）。invoiceStatus は入荷を結びつけた請求書の状態（なければ null）。
 */
export function receiptCancellable(
  status: PurchaseOrderStatus,
  invoiceStatus: SupplierInvoiceStatus | null,
): Result<true> {
  const invoice = invoiceAllowsCancel(invoiceStatus, "入荷");
  if (!invoice.ok) return invoice;
  if (status !== "ordered" && status !== "received")
    return err("invalid_state", "この発注の入荷は取り消せません");
  return ok(true);
}

/**
 * 入荷を取り消したときの発注の状態。取り消した後の明細（revertReceipt の結果）から決める
 * （settledOrderStatus）。ほかの入荷の打ち切りが残っていて全明細の残りが 0 なら入荷済みのまま
 * （発注済みに戻すと、残りが 0 のまま次の入荷を記録できなくなる）。
 * unpaidAcceptedReceiptsAfter は、取り消した後の「受入があり、支払済みの請求書に入っていない入荷」の件数。
 */
export function cancelReceipt(
  status: PurchaseOrderStatus,
  invoiceStatus: SupplierInvoiceStatus | null,
  linesAfter: readonly PurchaseOrderLineState[],
  unpaidAcceptedReceiptsAfter: number,
): Result<"ordered" | "received" | "paid"> {
  const cancellable = receiptCancellable(status, invoiceStatus);
  if (!cancellable.ok) return cancellable;
  return ok(settledOrderStatus(linesAfter, unpaidAcceptedReceiptsAfter));
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

export interface PurchaseReturnLineResult<L extends ReturnableLine> {
  readonly line: L;
  readonly units: number;
  readonly amount: number;
}

/**
 * 仕入返品の検証と金額。入荷のある発注（発注済み・入荷済み・支払済み）だけが対象で、
 * 明細ごとに「受入数 × 入数 − これまでの仕入返品」を超えて返品できない。
 */
export function recordPurchaseReturn<L extends ReturnableLine>(
  status: PurchaseOrderStatus,
  lines: readonly L[],
  inputs: readonly PurchaseReturnInput[],
  mode: RoundingMode,
): Result<PurchaseReturnLineResult<L>[]> {
  if (status !== "ordered" && status !== "received" && status !== "paid")
    return err("invalid_state", "入荷のある発注だけ仕入返品を記録できます");
  const seen = new Set<string>();
  const out: PurchaseReturnLineResult<L>[] = [];
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
      line,
      units: input.units,
      amount: purchaseReturnAmount(
        line.unitPriceCenti,
        line.unitsPerPurchaseUnit,
        input.units,
        mode,
      ),
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

/**
 * 仕入返品の取消（入荷の取消と同じ条件）。
 * - 取り消していない仕入返品だけ。理由が必須
 * - 支払（一部を含む）を記録した請求書から差し引いた仕入返品は取り消せない（invoiceAllowsCancel）
 * - 未払いの請求書から差し引いていれば、請求書から外して計算額と差額を計算し直す（ユースケースで行う）
 * - 発注の状態は問わない（仕入返品は発注の入荷済みの数を変えないので、支払済みの発注でも、請求書に入っていない
 *   仕入返品なら取り消せる）。在庫は打ち消しの行で戻す（増えるだけなので在庫不足にはならない）
 * invoiceStatus は仕入返品を差し引いた請求書の状態（なければ null）。
 */
export function cancelPurchaseReturn(
  cancelled: boolean,
  invoiceStatus: SupplierInvoiceStatus | null,
  reason: string,
): Result<true> {
  if (cancelled) return err("invalid_state", "この仕入返品はすでに取り消されています");
  const invoice = invoiceAllowsCancel(invoiceStatus, "仕入返品");
  if (!invoice.ok) return invoice;
  if (reason.trim() === "")
    return err("validation", "取消の理由を入力してください", {
      fields: [{ field: "reason", message: "取消の理由を入力してください" }],
    });
  return ok(true);
}

// ---- 仕入先請求書と支払 ------------------------------------------------------

/**
 * 仕入先請求書の状態。未払い → 一部支払（残りの額より少ない支払）→ 支払済み（残りが 0）と、取消。
 * 支払の取消で、支払済み・一部支払 → 一部支払・未払いに戻る。
 */
export type SupplierInvoiceStatus = "unpaid" | "partial" | "paid" | "cancelled";

export const SUPPLIER_INVOICE_STATUS_LABELS: Readonly<Record<SupplierInvoiceStatus, string>> = {
  unpaid: "未払い",
  partial: "一部支払",
  paid: "支払済み",
  cancelled: "取消",
};

/** 支払の残っている請求書の状態（支払予定・買掛の対象） */
export const OPEN_SUPPLIER_INVOICE_STATUSES = [
  "unpaid",
  "partial",
] as const satisfies readonly SupplierInvoiceStatus[];

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

/**
 * 請求額が 0 円以下の請求書は、お金を払うのではなく「精算」する（相殺・返金を受ける）。
 * 仕入返品が入荷より多い請求書（請求額がマイナス）や、入荷と返品が同じ額の請求書（0 円）がこれにあたる。
 */
export function isSettlementInvoice(invoicedAmount: number): boolean {
  return invoicedAmount <= 0;
}

/**
 * 請求書の残りの支払額 = 請求額 − 支払済みの額（取り消していない支払の合計）。取消の請求書は 0。
 * 請求額が 0 円以下の請求書（精算）は、精算する前は請求額（0 円・マイナス）、精算した後は 0。
 */
export function supplierInvoiceRemaining(invoice: {
  readonly status: SupplierInvoiceStatus;
  readonly invoicedAmount: number;
  readonly paidAmount: number;
}): number {
  return invoice.status === "cancelled" ? 0 : invoice.invoicedAmount - invoice.paidAmount;
}

/** 支払（または精算）の後の請求書の状態と支払済みの額 */
export interface SupplierInvoicePayment {
  readonly status: "partial" | "paid";
  readonly paidAmount: number;
}

/**
 * 支払（未払い・一部支払 → 一部支払・支払済み）。支払は1回ごとに1件の記録になる。
 * - 請求額が 1 円以上の請求書：支払額は 1 円以上で、残りの額（請求額 − 支払済みの額）まで。残りより多い支払は受け付けない。
 *   残りより少なければ一部支払、残りと同じ額なら支払済みになる。一部支払の請求書は、残りが 0 になるまで何回でも支払える
 * - 請求額が 0 円以下の請求書：支払額は請求額と同じ額でなければならない（0 円、またはマイナス = 相殺・返金を受ける額）。
 *   仕入返品が入荷より多い月の請求書は、請求額をマイナスで登録できる（3.7 の計算額 = 受入数 × 単価 + 送料 − 仕入返品）。
 *   支払額を1円以上に限ると、この請求書は未払いのまま支払予定と期限超過に残り続け、対象の発注も支払済みにならない。
 *   精算の額を請求額と同じにするのは、買掛残高（請求額 − 支払額）をちょうど 0 にするため。0 円以下の請求書の
 *   一部だけを精算する、という支払はありえないので、ほかの額は受け付けない（一部支払にはならない）
 * 一括支払いは、選んだ請求書の残りの額（0 円以下の請求書は請求額）を支払う。
 */
export function paySupplierInvoice(
  status: SupplierInvoiceStatus,
  invoicedAmount: number,
  paidAmount: number,
  amount: number,
): Result<SupplierInvoicePayment> {
  if (status !== "unpaid" && status !== "partial")
    return err("invalid_state", "未払い・一部支払の請求書だけを支払えます");
  if (isSettlementInvoice(invoicedAmount)) {
    if (amount !== invoicedAmount) {
      const message = `請求額が ${formatYen(invoicedAmount)} 円の請求書は、請求額と同じ額（${formatYen(invoicedAmount)} 円）で精算してください`;
      return err("validation", message, { fields: [{ field: "amount", message }] });
    }
    return ok({ status: "paid", paidAmount: invoicedAmount });
  }
  if (!Number.isInteger(amount) || amount <= 0)
    return err("validation", "支払額は1円以上の整数で入力してください", {
      fields: [{ field: "amount", message: "支払額は1円以上で入力してください" }],
    });
  const remaining = invoicedAmount - paidAmount;
  if (amount > remaining) {
    const message = `支払額が残りの額（${formatYen(remaining)} 円）を超えています`;
    return err("validation", message, { fields: [{ field: "amount", message }] });
  }
  const next = paidAmount + amount;
  return ok({ status: next === invoicedAmount ? "paid" : "partial", paidAmount: next });
}

/** 支払の取消の後の請求書の状態と支払済みの額 */
export interface SupplierPaymentCancellation {
  readonly status: "unpaid" | "partial";
  readonly paidAmount: number;
}

/**
 * 支払1件の取消（支払済み・一部支払 → 一部支払・未払い）。理由が必須。
 * 取り消した後に、取り消していない支払が残っていれば一部支払、1件も残らなければ未払い。
 * otherLivePayments は、この支払のほかの、取り消していない支払の件数。
 */
export function cancelSupplierPayment(
  status: SupplierInvoiceStatus,
  paidAmount: number,
  payment: { readonly amount: number; readonly cancelled: boolean },
  otherLivePayments: number,
  reason: string,
): Result<SupplierPaymentCancellation> {
  if (status !== "paid" && status !== "partial")
    return err("invalid_state", "支払済み・一部支払の請求書だけ支払を取り消せます");
  if (payment.cancelled) return err("invalid_state", "この支払はすでに取り消されています");
  if (reason.trim() === "")
    return err("validation", "支払の取消の理由を入力してください", {
      fields: [{ field: "reason", message: "取消の理由を入力してください" }],
    });
  return ok({
    status: otherLivePayments > 0 ? "partial" : "unpaid",
    paidAmount: paidAmount - payment.amount,
  });
}

/**
 * 仕入先請求書の取消（未払い → 取消）。取り消していない支払が1件でも残っていれば（一部支払・支払済み）取り消せない
 * ので、先に支払をすべて取り消す。理由が必須
 */
export function cancelSupplierInvoice(
  status: SupplierInvoiceStatus,
  reason: string,
): Result<"cancelled"> {
  if (status === "paid" || status === "partial")
    return err(
      "invalid_state",
      `${SUPPLIER_INVOICE_STATUS_LABELS[status]}の請求書は取り消せません。先に支払をすべて取り消してください`,
    );
  if (status !== "unpaid") return err("invalid_state", "すでに取り消されています");
  if (reason.trim() === "")
    return err("validation", "取消の理由を入力してください", {
      fields: [{ field: "reason", message: "取消の理由を入力してください" }],
    });
  return ok("cancelled");
}

/**
 * 請求書の支払・支払の取消・請求書の取消のあとの発注の状態（settledOrderStatus で決め直す）。
 * - 支払：入荷済みの発注は、受入のある入荷がすべて支払済み（残りが 0）の請求書に入れば支払済み。
 *   一部支払の請求書の入荷は未払いと数える（支払済みにしない）。分納の途中（発注済み）なら変えない
 * - 支払の取消：支払済みの発注は、支払済みでなくなった（一部支払・未払いに戻った）入荷があるので入荷済みに戻る
 * 作成中・取消の発注（入荷がないので、請求書に結びつかない）は変えない。
 */
export function orderStatusAfterPaymentChange(
  status: PurchaseOrderStatus,
  lines: readonly PurchaseOrderLineState[],
  unpaidAcceptedReceipts: number,
): PurchaseOrderStatus {
  if (status === "draft" || status === "cancelled") return status;
  return settledOrderStatus(lines, unpaidAcceptedReceipts);
}

export interface PayableMonth {
  readonly month: string;
  /** その月の請求額（請求日の月） */
  readonly invoiced: number;
  /** その月の支払額（支払日の月） */
  readonly paid: number;
  /** 月末の買掛残高 */
  readonly balance: number;
}

/** 月末の買掛残高 = 前月末の残高 + 当月の請求額 − 当月の支払額（仕入先ごと） */
export function payableBalances(
  opening: number,
  months: readonly string[],
  monthly: ReadonlyMap<string, { readonly invoiced: number; readonly paid: number }>,
): PayableMonth[] {
  let balance = opening;
  return months.map((month) => {
    const m = monthly.get(month) ?? { invoiced: 0, paid: 0 };
    balance += m.invoiced - m.paid;
    return { month, invoiced: m.invoiced, paid: m.paid, balance };
  });
}
