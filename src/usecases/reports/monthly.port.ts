import type { LineAmountAggregate, ReportAxis } from "../../domain/reports";

/** 業務日の範囲（両端を含む） */
export interface ReportRange {
  readonly from: string;
  readonly to: string;
}

/** 受注明細の金額の集計値（月 × 行）。key は販売先・仕入先・商品の ID（行に分けないときは null） */
export interface LineAggregateRow extends LineAmountAggregate {
  readonly month: string;
  readonly key: string | null;
}

/** 金額（円）の合計（月 × 行） */
export interface AmountRow {
  readonly month: string;
  readonly key: string | null;
  readonly amount: number;
}

export interface ReportLabel {
  readonly key: string;
  /** 商品コード（取引先は null） */
  readonly code: string | null;
  readonly name: string;
}

/**
 * 売上・仕入の集計の読み出し（domain/reports の集計の基準に合わせる）。
 * どれも取り消したものを含めず、月は業務日の YYYY-MM。axis が null なら月ごとの合計だけ。
 */
export interface ReportStore {
  /** 発送（発送日の月）した受注明細の、単価 × 数量の集計値（金額は domain の sumLineAmounts で丸める） */
  shippedLines(range: ReportRange, axis: ReportAxis | null): LineAggregateRow[];
  /** 発送した受注の送料など（数量 × 金額、税抜）。byCustomer なら販売先ごと */
  shippedCharges(range: ReportRange, byCustomer: boolean): AmountRow[];
  /** 返品伝票の金額（返品日の月、税抜） */
  salesReturns(range: ReportRange, axis: ReportAxis | null): AmountRow[];
  /** 入荷の明細の金額（入荷日の月、受入数 × 単価、税抜） */
  receipts(range: ReportRange, axis: Exclude<ReportAxis, "customer"> | null): AmountRow[];
  /** 仕入返品の金額（返品日の月、税抜） */
  purchaseReturns(range: ReportRange, axis: Exclude<ReportAxis, "customer"> | null): AmountRow[];
  /** 行の名前（販売先・仕入先は取引先の名前、商品はコードと名前） */
  labels(axis: ReportAxis, keys: readonly string[]): ReportLabel[];
}
