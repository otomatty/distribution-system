/**
 * 売上・仕入の集計（要件定義書 3.13 の Should、5章 /reports）の決まり。
 *
 * 集計の基準（画面にも同じ内容を出す）：
 * - 売上 = 発送日の月に、取り消していない発送の受注明細の金額（税抜。単価 × 数量を明細ごとに端数処理）と送料など
 *          − 返品日の月に、取り消していない返品伝票の金額（税抜）
 * - 仕入 = 入荷日の月に、取り消していない入荷の受入数 × 単価（税抜。入荷の明細の金額）
 *          − 返品日の月に、取り消していない仕入返品の金額（税抜）
 * - 送料などは商品に割り振れないので、商品別・仕入先別の売上には含めない（販売先別と月ごとの合計には含める）
 * - 仕入先請求書の送料と差額は含めない（入荷の明細の金額で集計する）
 */
import { addMonths, isMonth, monthOf, monthRange, monthsBetween } from "./dates";
import type { RoundingMode } from "./money";
import { err, ok, type Result } from "./result";

export const REPORT_VIEWS = [
  "sales_customer",
  "sales_item",
  "sales_supplier",
  "purchases_supplier",
  "purchases_item",
] as const;
export type ReportView = (typeof REPORT_VIEWS)[number];
export type ReportMeasure = "sales" | "purchases";
export type ReportAxis = "customer" | "supplier" | "item";

export const REPORT_VIEW_LABELS: Readonly<Record<ReportView, string>> = {
  sales_customer: "売上（販売先別）",
  sales_item: "売上（商品別）",
  sales_supplier: "売上（仕入先別：商品の仕入先）",
  purchases_supplier: "仕入（仕入先別）",
  purchases_item: "仕入（商品別）",
};

export const REPORT_MEASURE_LABELS: Readonly<Record<ReportMeasure, string>> = {
  sales: "売上",
  purchases: "仕入",
};

export const REPORT_AXIS_LABELS: Readonly<Record<ReportAxis, string>> = {
  customer: "販売先",
  supplier: "仕入先",
  item: "商品",
};

const VIEW_PARTS: Readonly<Record<ReportView, { measure: ReportMeasure; axis: ReportAxis }>> = {
  sales_customer: { measure: "sales", axis: "customer" },
  sales_item: { measure: "sales", axis: "item" },
  sales_supplier: { measure: "sales", axis: "supplier" },
  purchases_supplier: { measure: "purchases", axis: "supplier" },
  purchases_item: { measure: "purchases", axis: "item" },
};

export function reportViewParts(view: ReportView): { measure: ReportMeasure; axis: ReportAxis } {
  return VIEW_PARTS[view];
}

/** 送料などを含めるか（商品に割り振れないので、販売先別だけ） */
export function includesCharges(view: ReportView): boolean {
  return view === "sales_customer";
}

// ---- 期間 -----------------------------------------------------------------------

/** 集計できる期間の長さ（月数） */
export const REPORT_MAX_MONTHS = 36;
/** 期間を指定しないときの長さ（今月を含めて12か月） */
export const REPORT_DEFAULT_MONTHS = 12;

export interface ReportPeriod {
  /** YYYY-MM */
  readonly from: string;
  readonly to: string;
  readonly months: readonly string[];
  /** 業務日の範囲（from の月の1日 〜 to の月の末日） */
  readonly dateFrom: string;
  readonly dateTo: string;
}

/**
 * 集計の期間。指定がなければ今月までの12か月。始まりだけなら12か月分、終わりだけならそこまでの12か月。
 * 始まりが終わりより後、36か月を超える、月の形式でない場合は validation。
 */
export function reportPeriod(
  from: string | null,
  to: string | null,
  today: string,
): Result<ReportPeriod> {
  if (from !== null && !isMonth(from))
    return err("validation", "期間（から）は年と月で指定してください", {
      fields: [{ field: "from", message: "年と月で指定してください" }],
    });
  if (to !== null && !isMonth(to))
    return err("validation", "期間（まで）は年と月で指定してください", {
      fields: [{ field: "to", message: "年と月で指定してください" }],
    });
  const span = REPORT_DEFAULT_MONTHS - 1;
  const end = to ?? (from === null ? monthOf(today) : addMonths(from, span));
  const start = from ?? addMonths(end, -span);
  if (start > end)
    return err("validation", "期間（まで）は期間（から）と同じか後の月にしてください", {
      fields: [{ field: "to", message: "期間（から）と同じか後の月にしてください" }],
    });
  const months = monthsBetween(start, end, REPORT_MAX_MONTHS + 1);
  if (months.length > REPORT_MAX_MONTHS)
    return err("validation", `期間は${REPORT_MAX_MONTHS}か月以内で指定してください`, {
      fields: [{ field: "to", message: `${REPORT_MAX_MONTHS}か月以内にしてください` }],
    });
  return ok({
    from: start,
    to: end,
    months,
    dateFrom: monthRange(start).from,
    dateTo: monthRange(end).to,
  });
}

// ---- 金額 -----------------------------------------------------------------------

/**
 * 明細の金額（単価 × 数量を明細ごとに端数処理）の合計を、明細を1行ずつ読まずに求めるための集計値。
 * DB で明細をまとめて足した値（すべて加算できる）から、sumLineAmounts で明細ごとに丸めた合計と同じ値を出す。
 * 単価（centi-yen）と数量はどちらも 0 以上（受注明細の入力の検証で決まる）。
 */
export interface LineAmountAggregate {
  /** Σ 単価 × 数量（centi-yen） */
  readonly centi: number;
  /** Σ (単価 × 数量 の 100 で割った余り) */
  readonly remainder: number;
  /** 余りが 0 でない明細の数 */
  readonly fractional: number;
  /** 余りが 50 以上の明細の数 */
  readonly halfOrMore: number;
}

export const EMPTY_LINE_AGGREGATE: LineAmountAggregate = {
  centi: 0,
  remainder: 0,
  fractional: 0,
  halfOrMore: 0,
};

/** 明細の一覧から集計値を作る（DB の集計と同じ式。テストと、少ない明細の計算に使う） */
export function aggregateLines(
  lines: readonly { readonly unitPriceCenti: number; readonly quantity: number }[],
): LineAmountAggregate {
  return lines.reduce<LineAmountAggregate>((a, l) => {
    const centi = l.unitPriceCenti * l.quantity;
    const r = centi % 100;
    return {
      centi: a.centi + centi,
      remainder: a.remainder + r,
      fractional: a.fractional + (r > 0 ? 1 : 0),
      halfOrMore: a.halfOrMore + (r >= 50 ? 1 : 0),
    };
  }, EMPTY_LINE_AGGREGATE);
}

export function addLineAggregates(
  a: LineAmountAggregate,
  b: LineAmountAggregate,
): LineAmountAggregate {
  return {
    centi: a.centi + b.centi,
    remainder: a.remainder + b.remainder,
    fractional: a.fractional + b.fractional,
    halfOrMore: a.halfOrMore + b.halfOrMore,
  };
}

/**
 * 明細ごとに lineAmount で丸めた金額の合計（円）。
 * 切り捨て = (Σ − Σ余り) / 100、切り上げはそれに余りのある明細の数を、四捨五入は余りが 50 以上の明細の数を足す。
 */
export function sumLineAmounts(agg: LineAmountAggregate, mode: RoundingMode): number {
  const floor = (agg.centi - agg.remainder) / 100;
  if (mode === "ceil") return floor + agg.fractional;
  if (mode === "round") return floor + agg.halfOrMore;
  return floor;
}

/** 売上 = 明細の金額 + 送料など − 返品 */
export function netSales(
  parts: {
    readonly lines: LineAmountAggregate;
    readonly charges: number;
    readonly returns: number;
  },
  mode: RoundingMode,
): number {
  return sumLineAmounts(parts.lines, mode) + parts.charges - parts.returns;
}

/** 仕入 = 入荷の受入数 × 単価 − 仕入返品 */
export function netPurchases(parts: {
  readonly receipts: number;
  readonly returns: number;
}): number {
  return parts.receipts - parts.returns;
}

// ---- 表 ------------------------------------------------------------------------

export interface ReportEntry {
  /** 販売先・仕入先・商品の ID */
  readonly key: string;
  /** YYYY-MM */
  readonly month: string;
  readonly amount: number;
}

export interface ReportRow {
  readonly key: string;
  /** months と同じ順の、月ごとの金額 */
  readonly amounts: readonly number[];
  readonly total: number;
}

export interface MonthlyTable {
  readonly months: readonly string[];
  /** 期間の合計の大きい順（同じなら sortKey の順）。金額がすべて 0 の行は含めない */
  readonly rows: readonly ReportRow[];
  /** 月ごとの合計（すべての行の合計） */
  readonly totals: readonly number[];
  readonly grandTotal: number;
}

/**
 * 月 × 行（販売先・仕入先・商品）の表を作る。同じ key・月の金額は足す。期間の外の月は無視する。
 * sortKey は合計が同じ行の並び（コードや名前）。
 */
export function buildMonthlyTable(
  months: readonly string[],
  entries: readonly ReportEntry[],
  sortKey: (key: string) => string,
): MonthlyTable {
  const index = new Map(months.map((m, i) => [m, i]));
  const byKey = new Map<string, number[]>();
  for (const e of entries) {
    const i = index.get(e.month);
    if (i === undefined) continue;
    const amounts = byKey.get(e.key) ?? months.map(() => 0);
    amounts[i] = (amounts[i] ?? 0) + e.amount;
    byKey.set(e.key, amounts);
  }
  const rows = [...byKey.entries()]
    .filter(([, amounts]) => amounts.some((a) => a !== 0))
    .map(([key, amounts]): ReportRow => ({
      key,
      amounts,
      total: amounts.reduce((s, a) => s + a, 0),
    }))
    .toSorted((a, b) => b.total - a.total || sortKey(a.key).localeCompare(sortKey(b.key), "ja"));
  const totals = months.map((_, i) => rows.reduce((s, r) => s + (r.amounts[i] ?? 0), 0));
  return { months, rows, totals, grandTotal: totals.reduce((s, t) => s + t, 0) };
}

/** 月ごとの合計（行を分けない）。months と同じ順 */
export function monthlyTotals(
  months: readonly string[],
  entries: readonly ReportEntry[],
): number[] {
  const index = new Map(months.map((m, i) => [m, i]));
  const totals = months.map(() => 0);
  for (const e of entries) {
    const i = index.get(e.month);
    if (i !== undefined) totals[i] = (totals[i] ?? 0) + e.amount;
  }
  return totals;
}
