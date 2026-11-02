import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { lineAmount, type RoundingMode } from "./money";
import {
  addLineAggregates,
  aggregateLines,
  buildMonthlyTable,
  EMPTY_LINE_AGGREGATE,
  includesCharges,
  monthlyTotals,
  netPurchases,
  netSales,
  REPORT_VIEWS,
  reportPeriod,
  reportViewParts,
  sumLineAmounts,
} from "./reports";

const MODES: readonly RoundingMode[] = ["floor", "round", "ceil"];

const lineArb = fc.record({
  unitPriceCenti: fc.integer({ min: 0, max: 99_999_999 }),
  quantity: fc.integer({ min: 1, max: 9_999 }),
});

describe("sumLineAmounts：明細ごとに丸めた金額の合計", () => {
  it("明細ごとに lineAmount で丸めて足した合計と、どの端数処理でも同じになる", () => {
    fc.assert(
      fc.property(
        fc.array(lineArb, { maxLength: 50 }),
        fc.constantFrom(...MODES),
        (lines, mode) => {
          const oneByOne = lines.reduce(
            (s, l) => s + lineAmount(l.unitPriceCenti, l.quantity, mode),
            0,
          );
          expect(sumLineAmounts(aggregateLines(lines), mode)).toBe(oneByOne);
        },
      ),
    );
  });

  it("集計値は足し合わせられる（月ごと・販売先ごとに分けて足しても同じ）", () => {
    fc.assert(
      fc.property(
        fc.array(lineArb, { maxLength: 30 }),
        fc.array(lineArb, { maxLength: 30 }),
        fc.constantFrom(...MODES),
        (a, b, mode) => {
          const merged = addLineAggregates(aggregateLines(a), aggregateLines(b));
          expect(merged).toEqual(aggregateLines([...a, ...b]));
          expect(sumLineAmounts(merged, mode)).toBe(
            sumLineAmounts(aggregateLines(a), mode) + sumLineAmounts(aggregateLines(b), mode),
          );
        },
      ),
    );
  });

  it("例：123.45円 × 3 = 370.35円 は、切り捨て 370・四捨五入 370・切り上げ 371", () => {
    const agg = aggregateLines([{ unitPriceCenti: 12_345, quantity: 3 }]);
    expect(agg).toEqual({ centi: 37_035, remainder: 35, fractional: 1, halfOrMore: 0 });
    expect(sumLineAmounts(agg, "floor")).toBe(370);
    expect(sumLineAmounts(agg, "round")).toBe(370);
    expect(sumLineAmounts(agg, "ceil")).toBe(371);
    expect(sumLineAmounts(aggregateLines([{ unitPriceCenti: 50, quantity: 1 }]), "round")).toBe(1);
    expect(sumLineAmounts(EMPTY_LINE_AGGREGATE, "ceil")).toBe(0);
  });
});

describe("売上・仕入の金額", () => {
  it("売上 = 明細の金額 + 送料など − 返品", () => {
    const lines = aggregateLines([
      { unitPriceCenti: 10_050, quantity: 2 },
      { unitPriceCenti: 30_000, quantity: 1 },
    ]);
    expect(netSales({ lines, charges: 800, returns: 300 }, "floor")).toBe(201 + 300 + 800 - 300);
  });

  it("仕入 = 入荷の金額 − 仕入返品", () => {
    expect(netPurchases({ receipts: 10_000, returns: 1_200 })).toBe(8_800);
  });
});

describe("集計の表示の種類", () => {
  it("売上・仕入と、販売先・仕入先・商品の組み合わせ", () => {
    expect(REPORT_VIEWS.map(reportViewParts)).toEqual([
      { measure: "sales", axis: "customer" },
      { measure: "sales", axis: "item" },
      { measure: "sales", axis: "supplier" },
      { measure: "purchases", axis: "supplier" },
      { measure: "purchases", axis: "item" },
    ]);
  });

  it("送料などは販売先別の売上にだけ含める（商品に割り振れない）", () => {
    expect(REPORT_VIEWS.filter(includesCharges)).toEqual(["sales_customer"]);
  });
});

describe("reportPeriod：集計の期間", () => {
  it("指定がなければ今月までの12か月", () => {
    const p = reportPeriod(null, null, "2026-11-02");
    expect(p).toEqual({
      ok: true,
      value: expect.objectContaining({
        from: "2025-12",
        to: "2026-11",
        dateFrom: "2025-12-01",
        dateTo: "2026-11-30",
      }),
    });
    expect(p.ok && p.value.months).toHaveLength(12);
  });

  it("始まりだけなら12か月分、終わりだけならそこまでの12か月", () => {
    expect(reportPeriod("2024-04", null, "2026-11-02")).toMatchObject({
      ok: true,
      value: { from: "2024-04", to: "2025-03" },
    });
    expect(reportPeriod(null, "2025-02", "2026-11-02")).toMatchObject({
      ok: true,
      value: { from: "2024-03", to: "2025-02", dateTo: "2025-02-28" },
    });
  });

  it("1か月だけ・36か月まで指定できる", () => {
    expect(reportPeriod("2026-02", "2026-02", "2026-11-02")).toMatchObject({
      ok: true,
      value: { months: ["2026-02"], dateFrom: "2026-02-01", dateTo: "2026-02-28" },
    });
    const max = reportPeriod("2023-12", "2026-11", "2026-11-02");
    expect(max.ok && max.value.months).toHaveLength(36);
  });

  it("形式の誤り・順序の逆転・36か月を超える期間は validation", () => {
    for (const [from, to] of [
      ["2026-13", null],
      [null, "2026/01"],
      ["2026-05", "2026-04"],
      ["2023-11", "2026-11"],
    ] as const) {
      expect(reportPeriod(from, to, "2026-11-02")).toEqual({
        ok: false,
        error: expect.objectContaining({ code: "validation", fields: [expect.anything()] }),
      });
    }
  });
});

describe("buildMonthlyTable：月 × 行の表", () => {
  const months = ["2026-09", "2026-10", "2026-11"];

  it("同じ行・月の金額を足し、行の合計の大きい順に並べ、月ごとの合計を出す", () => {
    const table = buildMonthlyTable(
      months,
      [
        { key: "a", month: "2026-09", amount: 100 },
        { key: "a", month: "2026-09", amount: 50 },
        { key: "b", month: "2026-10", amount: 500 },
        { key: "a", month: "2026-11", amount: -20 },
        { key: "c", month: "2026-11", amount: 130 },
      ],
      (k) => k,
    );
    expect(table.rows).toEqual([
      { key: "b", amounts: [0, 500, 0], total: 500 },
      { key: "a", amounts: [150, 0, -20], total: 130 },
      { key: "c", amounts: [0, 0, 130], total: 130 },
    ]);
    expect(table.totals).toEqual([150, 500, 110]);
    expect(table.grandTotal).toBe(760);
  });

  it("合計が同じ行は並びのキーの順。金額がすべて 0 の行と、期間の外の月は含めない", () => {
    const table = buildMonthlyTable(
      months,
      [
        { key: "x", month: "2026-10", amount: 10 },
        { key: "y", month: "2026-10", amount: 10 },
        { key: "z", month: "2026-10", amount: 0 },
        { key: "w", month: "2026-12", amount: 999 },
      ],
      (k) => (k === "x" ? "2" : "1"),
    );
    expect(table.rows.map((r) => r.key)).toEqual(["y", "x"]);
    expect(table.grandTotal).toBe(20);
  });

  it("monthlyTotals は行を分けずに月ごとに足す", () => {
    expect(
      monthlyTotals(months, [
        { key: "a", month: "2026-11", amount: 5 },
        { key: "b", month: "2026-11", amount: 7 },
        { key: "c", month: "2026-01", amount: 9 },
      ]),
    ).toEqual([0, 0, 12]);
  });
});
