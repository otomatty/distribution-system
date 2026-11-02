import { describe, expect, it } from "vitest";

import {
  addDays,
  addMonths,
  closingPeriod,
  formatJapaneseDate,
  formatJstDateTime,
  isBusinessDate,
  isMonth,
  latestClosedPeriod,
  monthOf,
  monthRange,
  monthsBetween,
  parseJstDateTime,
  paymentDueDate,
  plannedShipDate,
  startOfBusinessDay,
  toBusinessDate,
  validateClosingTerms,
  weekRange,
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
  it("締め終わっている最も新しい締め期間", () => {
    expect(latestClosedPeriod("2026-10-31", 31)).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(latestClosedPeriod("2026-11-02", 31)).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(latestClosedPeriod("2026-11-25", 20)).toEqual({ from: "2026-10-21", to: "2026-11-20" });
    expect(latestClosedPeriod("2026-11-20", 20)).toEqual({ from: "2026-10-21", to: "2026-11-20" });
  });
  it("週（月曜〜日曜）と月", () => {
    // 2026-11-02 は月曜日
    expect(weekRange("2026-11-02")).toEqual({ from: "2026-11-02", to: "2026-11-08" });
    expect(weekRange("2026-11-08")).toEqual({ from: "2026-11-02", to: "2026-11-08" });
    expect(weekRange("2026-11-04")).toEqual({ from: "2026-11-02", to: "2026-11-08" });
    expect(monthOf("2026-11-02")).toBe("2026-11");
    expect(isMonth("2026-13")).toBe(false);
    expect(isMonth("2026-01")).toBe(true);
    expect(monthsBetween("2026-11", "2027-02")).toEqual([
      "2026-11",
      "2026-12",
      "2027-01",
      "2027-02",
    ]);
    expect(monthsBetween("2026-11", "2026-10")).toEqual([]);
    expect(monthsBetween("bad", "2026-10")).toEqual([]);
    expect(monthsBetween("2020-01", "2029-12", 3)).toHaveLength(3);
    expect(monthRange("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(addMonths("2026-11", -5)).toBe("2026-06");
    expect(addMonths("2026-03", -5)).toBe("2025-10");
    expect(addMonths("2026-11", 2)).toBe("2027-01");
  });
  it("業務日の始まりの時刻（UTC）", () => {
    expect(startOfBusinessDay("2026-11-02")).toBe("2026-11-01T15:00:00.000Z");
    expect(() => startOfBusinessDay("2026-13-01")).toThrow(RangeError);
  });
  it("日本時間の日時の読み取りと表示（秒まで）", () => {
    expect(parseJstDateTime("2026-11-02T09:15")?.toISOString()).toBe("2026-11-02T00:15:00.000Z");
    expect(parseJstDateTime(" 2026-11-02 00:00:05 ")?.toISOString()).toBe(
      "2026-11-01T15:00:05.000Z",
    );
    for (const bad of [
      "",
      "2026-11-02",
      "2026-02-30T10:00",
      "2026-11-02T24:00",
      "2026-11-02T10:60",
      "2026-11-02T10:00:60",
    ]) {
      expect(parseJstDateTime(bad)).toBeUndefined();
    }
    expect(formatJstDateTime(new Date("2026-11-01T15:00:05.900Z"))).toBe("2026-11-02 00:00:05");
  });
});
