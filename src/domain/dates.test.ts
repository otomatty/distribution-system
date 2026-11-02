import { describe, expect, it } from "vitest";

import {
  addDays,
  closingPeriod,
  formatJapaneseDate,
  isBusinessDate,
  paymentDueDate,
  plannedShipDate,
  toBusinessDate,
  validateClosingTerms,
  yearOf,
} from "./dates";

describe("dates", () => {
  it("日本時間の業務日", () => {
    expect(toBusinessDate(new Date("2026-11-01T15:30:00Z"))).toBe("2026-11-02");
    expect(toBusinessDate(new Date("2026-11-01T14:59:59Z"))).toBe("2026-11-01");
  });
  it("日付の検証と加算", () => {
    expect(isBusinessDate("2026-02-29")).toBe(false);
    expect(isBusinessDate("2028-02-29")).toBe(true);
    expect(isBusinessDate("2026/01/01")).toBe(false);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(yearOf("2026-05-01")).toBe(2026);
    expect(() => addDays("bad", 1)).toThrow(RangeError);
  });
  it("締め期間（月末締め）", () => {
    expect(closingPeriod("2026-02-10", 31)).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(closingPeriod("2026-03-31", 31)).toEqual({ from: "2026-03-01", to: "2026-03-31" });
  });
  it("締め期間（20日締め）", () => {
    expect(closingPeriod("2026-03-20", 20)).toEqual({ from: "2026-02-21", to: "2026-03-20" });
    expect(closingPeriod("2026-03-21", 20)).toEqual({ from: "2026-03-21", to: "2026-04-20" });
    expect(closingPeriod("2026-12-25", 20)).toEqual({ from: "2026-12-21", to: "2027-01-20" });
  });
  it("支払期日（月末締め翌月末払い、20日締め翌々月10日払い）", () => {
    expect(
      paymentDueDate("2026-01-15", { closingDay: 31, paymentMonthOffset: 1, paymentDay: 31 }),
    ).toBe("2026-02-28");
    expect(
      paymentDueDate("2026-03-21", { closingDay: 20, paymentMonthOffset: 2, paymentDay: 10 }),
    ).toBe("2026-06-10");
    expect(
      paymentDueDate("2026-11-30", { closingDay: 31, paymentMonthOffset: 0, paymentDay: 31 }),
    ).toBe("2026-11-30");
  });
  it("取引条件の検証", () => {
    expect(
      validateClosingTerms({ closingDay: 31, paymentMonthOffset: 1, paymentDay: 31 }),
    ).toBeUndefined();
    expect(
      validateClosingTerms({ closingDay: 29, paymentMonthOffset: 1, paymentDay: 31 }),
    ).toBeDefined();
    expect(
      validateClosingTerms({ closingDay: 20, paymentMonthOffset: 3, paymentDay: 10 }),
    ).toBeDefined();
    expect(
      validateClosingTerms({ closingDay: 20, paymentMonthOffset: 1, paymentDay: 0 }),
    ).toBeDefined();
  });
  it("出荷予定日と表記", () => {
    expect(plannedShipDate("2026-11-05", 2)).toBe("2026-11-03");
    expect(plannedShipDate("2026-11-05", -1)).toBe("2026-11-05");
    expect(formatJapaneseDate("2026-11-02")).toBe("2026年11月2日");
  });
});
