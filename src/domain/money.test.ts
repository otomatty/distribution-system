import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  formatCenti,
  lineAmount,
  parseYenToCenti,
  priceWithTaxCenti,
  rateOn,
  roundRatio,
  summarizeTax,
  taxAmount,
} from "./money";

describe("roundRatio", () => {
  it("切り捨て・四捨五入・切り上げ", () => {
    expect(roundRatio(1050, 100, "floor")).toBe(10);
    expect(roundRatio(1050, 100, "round")).toBe(11);
    expect(roundRatio(1049, 100, "round")).toBe(10);
    expect(roundRatio(1001, 100, "ceil")).toBe(11);
    expect(roundRatio(1000, 100, "ceil")).toBe(10);
  });
  it("負の値は絶対値で丸めて符号を戻す", () => {
    expect(roundRatio(-1050, 100, "floor")).toBe(-10);
    expect(roundRatio(-1050, 100, "round")).toBe(-11);
    expect(roundRatio(-1001, 100, "ceil")).toBe(-11);
    expect(roundRatio(-1, 100, "floor")).toBe(0);
  });
  it("不正な入力は例外", () => {
    expect(() => roundRatio(1.5, 100, "floor")).toThrow(RangeError);
    expect(() => roundRatio(1, 0, "floor")).toThrow(RangeError);
  });
  it("丸めの誤差は1未満（性質）", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1e9, max: 1e9 }),
        fc.integer({ min: 1, max: 100000 }),
        fc.constantFrom("floor", "round", "ceil" as const),
        (n, d, mode) => {
          const r = roundRatio(n, d, mode);
          expect(Math.abs(r - n / d)).toBeLessThan(1);
          expect(Number.isInteger(r)).toBe(true);
        },
      ),
    );
  });
});

describe("lineAmount / taxAmount", () => {
  it("単価は100分の1円単位", () => {
    expect(lineAmount(12345, 3, "floor")).toBe(370); // 123.45 × 3 = 370.35
    expect(lineAmount(12345, 3, "round")).toBe(370);
    expect(lineAmount(12345, 3, "ceil")).toBe(371);
  });
  it("税額は税率（bps）で計算", () => {
    expect(taxAmount(1999, 1000, "floor")).toBe(199);
    expect(taxAmount(1999, 800, "round")).toBe(160);
    expect(priceWithTaxCenti(10000, 800, "floor")).toBe(10800);
  });
});

describe("rateOn", () => {
  const rates = [
    { category: "standard" as const, rateBps: 800, effectiveFrom: "2014-04-01" },
    { category: "standard" as const, rateBps: 1000, effectiveFrom: "2019-10-01" },
    { category: "reduced" as const, rateBps: 800, effectiveFrom: "2019-10-01" },
  ];
  it("取引日時点の税率", () => {
    expect(rateOn(rates, "standard", "2019-09-30")).toBe(800);
    expect(rateOn(rates, "standard", "2019-10-01")).toBe(1000);
    expect(rateOn(rates, "reduced", "2019-09-30")).toBeUndefined();
  });
});

describe("summarizeTax", () => {
  it("税率ごとに合計し、税額は税率ごとに1回だけ丸める", () => {
    const s = summarizeTax(
      [
        { amount: 333, taxCategory: "reduced" },
        { amount: 333, taxCategory: "reduced" },
        { amount: 1001, taxCategory: "standard" },
      ],
      { standard: 1000, reduced: 800 },
      "floor",
    );
    expect(s.groups).toEqual([
      { category: "standard", rateBps: 1000, subtotal: 1001, tax: 100 },
      { category: "reduced", rateBps: 800, subtotal: 666, tax: 53 },
    ]);
    expect(s).toMatchObject({ subtotal: 1667, tax: 153, total: 1820 });
  });
  it("明細のない税率は含めない", () => {
    const s = summarizeTax([], { standard: 1000, reduced: 800 }, "floor");
    expect(s).toEqual({ groups: [], subtotal: 0, tax: 0, total: 0 });
  });
  it("合計 = 小計 + 税額（性質）", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            amount: fc.integer({ min: -1e6, max: 1e7 }),
            taxCategory: fc.constantFrom("standard", "reduced" as const),
          }),
        ),
        (lines) => {
          const s = summarizeTax(lines, { standard: 1000, reduced: 800 }, "round");
          expect(s.total).toBe(s.subtotal + s.tax);
          expect(s.subtotal).toBe(lines.reduce((a, l) => a + l.amount, 0));
        },
      ),
    );
  });
});

describe("parseYenToCenti / formatCenti", () => {
  it("入力の変換", () => {
    expect(parseYenToCenti("1,234.5")).toBe(123450);
    expect(parseYenToCenti("12")).toBe(1200);
    expect(parseYenToCenti("0.01")).toBe(1);
    expect(parseYenToCenti("-1")).toBeUndefined();
    expect(parseYenToCenti("1.234")).toBeUndefined();
    expect(parseYenToCenti("abc")).toBeUndefined();
  });
  it("表示の変換", () => {
    expect(formatCenti(123450)).toBe("1,234.5".replace(".5", ".50"));
    expect(formatCenti(1200)).toBe("12");
    expect(formatCenti(-150)).toBe("-1.50");
  });
  it("往復しても値が変わらない（性質）", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 99_999_999_999 }), (c) => {
        expect(parseYenToCenti(formatCenti(c))).toBe(c);
      }),
    );
  });
});
