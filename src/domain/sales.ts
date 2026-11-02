/** 受注・発送・請求書・入金のルール（要件定義書 3.8〜3.11、4章）。 */
import {
  lineAmount,
  summarizeTax,
  type RoundingMode,
  type TaxCategory,
  type TaxSummary,
} from "./money";
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
export function validateSplit<L extends { readonly id: string; readonly quantity: number }>(
  lines: readonly L[],
  splitQuantities: ReadonlyMap<string, number>,
): Result<{ line: L; keep: number; move: number }[]> {
  const result: { line: L; keep: number; move: number }[] = [];
  for (const l of lines) {
    const move = splitQuantities.get(l.id) ?? 0;
    if (!Number.isInteger(move) || move < 0 || move > l.quantity) {
      return err("validation", "分割する数量は0から元の数量までの整数で入力してください");
    }
    result.push({ line: l, keep: l.quantity - move, move });
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

/**
 * 受注の明細の出荷可能数：保管場所の出荷可能数に、この受注自身の引当を足し戻した数。
 * 編集中の受注は、自分の引当を除いた残りと比べる（自分の分で「足りない」と出さないため）。
 */
export function availableForOrder(available: number, ownAllocated: number): number {
  return available + ownAllocated;
}

/**
 * 明細ごとの警告（登録はできる：要件定義書 3.8）。
 * availableForOrder が null のとき（メーカー直、保管場所が未選択）は出荷可能数を比べない。
 */
export function salesLineWarnings(line: {
  readonly quantity: number;
  readonly minLot: number;
  readonly availableForOrder: number | null;
}): string[] {
  const warnings: string[] = [];
  if (line.availableForOrder !== null && line.quantity > line.availableForOrder) {
    warnings.push(`出荷可能数（${Math.max(0, line.availableForOrder)}）を超えています`);
  }
  return [...warnings, ...lotWarnings(line.quantity, line.minLot)];
}

/** 卸単価と違う単価か（明細の単価は例外だけ修正する） */
export function isPriceOverridden(unitPriceCenti: number, listPriceCenti: number): boolean {
  return unitPriceCenti !== listPriceCenti;
}

/**
 * 単価を修正した理由が必要か。卸単価と違い、かつ前に保存した単価からも変えた場合に必要。
 * 保存済みの単価をそのまま使う明細は、後で商品の卸単価が変わっても理由を求めない。
 */
export function priceReasonRequired(line: {
  readonly unitPriceCenti: number;
  readonly listPriceCenti: number;
  readonly previousPriceCenti: number | null;
  readonly reason: string | null;
}): boolean {
  if (!isPriceOverridden(line.unitPriceCenti, line.listPriceCenti)) return false;
  if (line.previousPriceCenti === line.unitPriceCenti) return false;
  return line.reason === null || line.reason.trim() === "";
}

/** 受注の明細は1行以上で、同じ商品は1行にまとめる */
export function validateOrderLines(lines: readonly { readonly itemId: string }[]): Result<void> {
  if (lines.length === 0) return err("validation", "商品を1つ以上追加してください");
  const seen = new Set<string>();
  for (const l of lines) {
    if (seen.has(l.itemId)) return err("validation", "同じ商品が複数の行にあります");
    seen.add(l.itemId);
  }
  return ok(undefined);
}

export interface PricedLine {
  readonly unitPriceCenti: number;
  readonly quantity: number;
  readonly taxCategory: TaxCategory;
}

/** 送料など（金額は税抜・円の単価 × 数量） */
export interface ChargeLine {
  readonly unitAmount: number;
  readonly quantity: number;
  readonly taxCategory: TaxCategory;
}

export interface OrderAmounts<L extends PricedLine, C extends ChargeLine> {
  /** 明細（渡した順）と、その金額（単価 × 数量を明細ごとに丸めた円） */
  readonly lines: readonly (L & { readonly amount: number })[];
  readonly charges: readonly (C & { readonly amount: number })[];
  /** 税率ごとの合計と消費税額（伝票1枚ごとに税率ごとに1回丸める） */
  readonly summary: TaxSummary;
}

export function chargeAmount(charge: ChargeLine): number {
  return charge.unitAmount * charge.quantity;
}

/**
 * 受注・納品書の金額。明細の金額は明細ごとに、消費税は税率ごとに1回、どちらも設定の端数処理で丸める
 * （AGENTS.md 4章）。rates は取引日時点の税率（money の ratesOn）。
 */
export function orderAmounts<L extends PricedLine, C extends ChargeLine>(
  lines: readonly L[],
  charges: readonly C[],
  rates: Readonly<Record<TaxCategory, number>>,
  mode: RoundingMode,
): OrderAmounts<L, C> {
  const priced = lines.map((l) => ({
    ...l,
    amount: lineAmount(l.unitPriceCenti, l.quantity, mode),
  }));
  const pricedCharges = charges.map((c) => ({ ...c, amount: chargeAmount(c) }));
  const summary = summarizeTax([...priced, ...pricedCharges], rates, mode);
  return { lines: priced, charges: pricedCharges, summary };
}

export interface BulkShipmentLine {
  readonly itemId: string;
  readonly quantity: number;
}

/** 一括発送の対象の受注（明細があればよい。ほかの項目はそのまま計画の結果に戻す） */
export interface BulkShipmentOrder {
  readonly lines: readonly BulkShipmentLine[];
}

export interface BulkShipmentPlan<O extends BulkShipmentOrder> {
  /** 発送できる受注（渡した順） */
  readonly shippable: readonly O[];
  /** 在庫が足りない受注と、その時点で足りない商品（その商品の最初の明細）と数 */
  readonly short: readonly {
    readonly order: O;
    readonly shortages: readonly { readonly line: O["lines"][number]; readonly shortBy: number }[];
  }[];
}

/**
 * 一括発送の計画（要件定義書 3.9）。受注を渡した順に、1つの保管場所の現在庫から引いていき、
 * どれかの商品が足りない受注は発送しない（その受注の分は在庫を使わず、後の受注に回す）。
 * onHand は商品ごとの現在庫（ない商品は 0）。同じ商品の明細はまとめて判定する。
 */
export function planBulkShipment<O extends BulkShipmentOrder>(
  orders: readonly O[],
  onHand: ReadonlyMap<string, number>,
): BulkShipmentPlan<O> {
  type L = O["lines"][number];
  const remaining = new Map(onHand);
  const shippable: O[] = [];
  const short: { order: O; shortages: { line: L; shortBy: number }[] }[] = [];
  for (const order of orders) {
    const need = new Map<string, { line: L; quantity: number }>();
    for (const l of order.lines) {
      const prev = need.get(l.itemId);
      need.set(
        l.itemId,
        prev
          ? { line: prev.line, quantity: prev.quantity + l.quantity }
          : { line: l, quantity: l.quantity },
      );
    }
    const demand = [...need.values()].map((n) => ({
      line: n.line,
      quantity: n.quantity,
      left: remaining.get(n.line.itemId) ?? 0,
    }));
    const shortages = demand
      .filter((d) => d.quantity > d.left)
      .map((d) => ({ line: d.line, shortBy: d.quantity - Math.max(0, d.left) }));
    if (shortages.length > 0) {
      short.push({ order, shortages });
      continue;
    }
    for (const d of demand) remaining.set(d.line.itemId, d.left - d.quantity);
    shippable.push(order);
  }
  return { shippable, short };
}

export interface ShippingMatrix {
  /** quantities[商品の行][販売先の列] */
  readonly quantities: readonly (readonly number[])[];
  /** 商品ごとの合計（右端の列） */
  readonly rowTotals: readonly number[];
  /** 販売先ごとの合計（最下行） */
  readonly columnTotals: readonly number[];
  readonly grandTotal: number;
}

function cell(itemId: string, customerId: string): string {
  return `${itemId}\u0000${customerId}`;
}

function sum(ns: readonly number[]): number {
  return ns.reduce((s, n) => s + n, 0);
}

/**
 * 発送リストの表（行が商品、列が販売先、右端が合計）。列は販売先の ID で管理する。
 * itemIds・customerIds の並びがそのまま行と列の順になり、そこにない商品・販売先の明細は数えない。
 */
export function shippingMatrix(
  orders: readonly {
    readonly customerId: string;
    readonly lines: readonly { readonly itemId: string; readonly quantity: number }[];
  }[],
  itemIds: readonly string[],
  customerIds: readonly string[],
): ShippingMatrix {
  const counts = new Map<string, number>();
  for (const o of orders) {
    for (const l of o.lines) {
      const key = cell(l.itemId, o.customerId);
      counts.set(key, (counts.get(key) ?? 0) + l.quantity);
    }
  }
  const quantities = itemIds.map((itemId) =>
    customerIds.map((customerId) => counts.get(cell(itemId, customerId)) ?? 0),
  );
  const rowTotals = quantities.map(sum);
  const columnTotals = customerIds.map((customerId) =>
    sum(itemIds.map((itemId) => counts.get(cell(itemId, customerId)) ?? 0)),
  );
  return { quantities, rowTotals, columnTotals, grandTotal: sum(rowTotals) };
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
