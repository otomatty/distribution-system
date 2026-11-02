/**
 * 売上・仕入の集計（要件定義書 3.13 の Should）：月別に、販売先別・仕入先別・商品別で表示する。
 * 集計の基準は domain/reports.ts の先頭のとおり。閲覧・CSV は全員ができる（権限 view）。
 */
import { z } from "zod";

import type { RoundingMode } from "../../domain/money";
import {
  buildMonthlyTable,
  includesCharges,
  monthlyTotals,
  REPORT_VIEWS,
  reportPeriod,
  reportViewParts,
  sumLineAmounts,
  type ReportAxis,
  type ReportEntry,
  type ReportMeasure,
  type ReportPeriod,
  type ReportView,
} from "../../domain/reports";
import { ok, type Result } from "../../domain/result";
import { defineQuery, type QueryContext } from "../core";
import { pageInput, type Page } from "../schemas";
import type { AmountRow, LineAggregateRow, ReportLabel, ReportRange } from "./monthly.port";

/** 形式（YYYY-MM）は domain の reportPeriod で確かめ、誤りは画面に出す */
const monthInput = z
  .string()
  .trim()
  .max(20)
  .optional()
  .nullable()
  .transform((v) => (v ? v : null));

export const reportFilterInput = {
  view: z.enum(REPORT_VIEWS).default("sales_customer"),
  from: monthInput,
  to: monthInput,
  /** 行（販売先・仕入先・商品）の名前・コードで絞り込む（月ごとの売上と仕入の合計は絞り込まない） */
  q: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((v) => v || null),
};

type Filter = z.output<z.ZodObject<typeof reportFilterInput>>;

export interface ReportRowView {
  readonly key: string;
  readonly code: string | null;
  readonly name: string;
  /** 月ごとの金額（period.months と同じ順、税抜・円） */
  readonly amounts: readonly number[];
  readonly total: number;
}

export interface MonthlyReport {
  readonly view: ReportView;
  readonly measure: ReportMeasure;
  readonly axis: ReportAxis;
  readonly period: ReportPeriod;
  /** 行の金額に送料などを含めているか（販売先別の売上だけ） */
  readonly includesCharges: boolean;
  /** 月ごとの売上と仕入（行に分けない合計。売上は送料などを含む） */
  readonly summary: {
    readonly months: readonly {
      readonly month: string;
      readonly sales: number;
      readonly purchases: number;
    }[];
    readonly sales: number;
    readonly purchases: number;
  };
  /** 行（期間の合計の大きい順のページ分） */
  readonly rows: Page<ReportRowView>;
  /** すべての行（名前で絞り込んだときは、絞り込んだ行）の月ごとの合計と、期間全体の合計 */
  readonly totals: readonly number[];
  readonly grandTotal: number;
}

/** 売上の明細の金額（明細ごとに丸めた合計）と返品（マイナス）。送料などは行の区分によって別に足す */
function salesEntries(
  lines: readonly LineAggregateRow[],
  returns: readonly AmountRow[],
  mode: RoundingMode,
): ReportEntry[] {
  return [
    ...lines.map((l) => ({ key: l.key ?? "", month: l.month, amount: sumLineAmounts(l, mode) })),
    ...returns.map((r) => ({ key: r.key ?? "", month: r.month, amount: -r.amount })),
  ];
}

function purchaseEntries(
  receipts: readonly AmountRow[],
  returns: readonly AmountRow[],
): ReportEntry[] {
  return [
    ...receipts.map((r) => ({ key: r.key ?? "", month: r.month, amount: r.amount })),
    ...returns.map((r) => ({ key: r.key ?? "", month: r.month, amount: -r.amount })),
  ];
}

interface ComputedReport extends Omit<MonthlyReport, "rows"> {
  readonly allRows: readonly ReportRowView[];
}

/** 集計を計算する（画面の表と CSV で共通） */
function compute(ctx: Pick<QueryContext, "clock" | "stores">, f: Filter): Result<ComputedReport> {
  const period = reportPeriod(f.from, f.to, ctx.clock.today());
  if (!period.ok) return period;
  const { months } = period.value;
  const range: ReportRange = { from: period.value.dateFrom, to: period.value.dateTo };
  const { measure, axis } = reportViewParts(f.view);
  const store = ctx.stores.reports;
  const mode = ctx.stores.settings.getCompany().roundingMode;

  // 表の行に使う側は行ごとに、もう一方は月ごとの合計だけを読む（同じ明細を2回読まない）
  const salesAxis = measure === "sales" ? axis : null;
  const purchaseAxis = measure === "purchases" && axis !== "customer" ? axis : null;
  const lines = store.shippedLines(range, salesAxis);
  const chargesByCustomer = salesAxis === "customer";
  const charges = store.shippedCharges(range, chargesByCustomer);
  const sales = salesEntries(lines, store.salesReturns(range, salesAxis), mode);
  const salesMonthly = monthlyTotals(months, [
    ...sales,
    ...charges.map((c) => ({ key: "", month: c.month, amount: c.amount })),
  ]);
  const purchases = purchaseEntries(
    store.receipts(range, purchaseAxis),
    store.purchaseReturns(range, purchaseAxis),
  );
  const purchasesMonthly = monthlyTotals(months, purchases);

  const tableEntries =
    measure === "sales"
      ? [
          ...sales,
          ...(chargesByCustomer
            ? charges.map((c) => ({ key: c.key ?? "", month: c.month, amount: c.amount }))
            : []),
        ]
      : purchases;
  const keys = [...new Set(tableEntries.map((e) => e.key))].filter((k) => k !== "");
  const labels = new Map<string, ReportLabel>(store.labels(axis, keys).map((l) => [l.key, l]));
  const sortKey = (key: string) => {
    const l = labels.get(key);
    return `${l?.code ?? ""}\u0000${l?.name ?? key}`;
  };
  const q = f.q?.toLowerCase() ?? null;
  const matches = (key: string) => {
    if (q === null) return true;
    const l = labels.get(key);
    return `${l?.code ?? ""} ${l?.name ?? ""}`.toLowerCase().includes(q);
  };
  const table = buildMonthlyTable(
    months,
    tableEntries.filter((e) => matches(e.key)),
    sortKey,
  );
  return ok({
    view: f.view,
    measure,
    axis,
    period: period.value,
    includesCharges: includesCharges(f.view),
    summary: {
      months: months.map((month, i) => ({
        month,
        sales: salesMonthly[i] ?? 0,
        purchases: purchasesMonthly[i] ?? 0,
      })),
      sales: salesMonthly.reduce((s, x) => s + x, 0),
      purchases: purchasesMonthly.reduce((s, x) => s + x, 0),
    },
    allRows: table.rows.map((r) => {
      const label = labels.get(r.key);
      return { ...r, code: label?.code ?? null, name: label?.name ?? "（不明）" };
    }),
    totals: table.totals,
    grandTotal: table.grandTotal,
  });
}

/** 画面の集計：月ごとの売上と仕入、行ごとの月別の金額（ページ分）と合計 */
export const monthlyReport = defineQuery({
  permission: "view",
  input: pageInput.extend(reportFilterInput),
  run(ctx, { page, pageSize, ...filter }): Result<MonthlyReport> {
    const computed = compute(ctx, filter);
    if (!computed.ok) return computed;
    const { allRows, ...rest } = computed.value;
    return ok({
      ...rest,
      rows: {
        rows: allRows.slice((page - 1) * pageSize, page * pageSize),
        total: allRows.length,
        page,
        pageSize,
      },
    });
  },
});

/** CSV の1行（行 × 月）。Excel のピボットテーブルで集計し直せるよう、縦に並べる */
export interface ReportCell {
  readonly measure: ReportMeasure;
  readonly axis: ReportAxis;
  readonly code: string | null;
  readonly name: string;
  readonly month: string;
  readonly amount: number;
}

/**
 * CSV 用：行 × 月の金額を、画面の行の順・月の順に並べて返す（金額が 0 の月も含める）。
 * ページは行（販売先・仕入先・商品）の単位で分け、1ページに pageSize 行分の「行 × 月」を返す
 * （集計はページごとに計算し直すので、CSV の行ごとに分けると計算の回数が月の数だけ増える）。
 * total は CSV の行の数（行 × 月）。期間の指定が正しくなければ、行のない結果を返す（画面で先に誤りを表示している）。
 */
export const reportCells = defineQuery({
  permission: "view",
  input: pageInput.extend(reportFilterInput),
  run(ctx, { page, pageSize, ...filter }): Page<ReportCell> {
    const computed = compute(ctx, filter);
    if (!computed.ok) return { rows: [], total: 0, page, pageSize };
    const { allRows, period, measure, axis } = computed.value;
    const rows = allRows.slice((page - 1) * pageSize, page * pageSize).flatMap((row) =>
      period.months.map((month, i): ReportCell => ({
        measure,
        axis,
        code: row.code,
        name: row.name,
        month,
        amount: row.amounts[i] ?? 0,
      })),
    );
    return { rows, total: allRows.length * period.months.length, page, pageSize };
  },
});
