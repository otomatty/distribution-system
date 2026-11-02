import { describe, expect, it } from "vitest";

import {
  cancelInvoice,
  cancelSalesOrder,
  cancelShipment,
  canEditSalesOrder,
  creditNoteRequired,
  invoiceStatus,
  lotWarnings,
  shipSalesOrder,
  validateAllocations,
  validateSplit,
} from "./sales";

describe("sales order", () => {
  it("状態遷移", () => {
    expect(canEditSalesOrder("received")).toBe(true);
    expect(canEditSalesOrder("shipped")).toBe(false);
    expect(shipSalesOrder("received")).toEqual({ ok: true, value: "shipped" });
    expect(shipSalesOrder("shipped").ok).toBe(false);
    expect(cancelSalesOrder("received").ok).toBe(true);
    expect(cancelSalesOrder("shipped").ok).toBe(false);
    expect(cancelShipment("shipped", false)).toEqual({ ok: true, value: "received" });
    expect(cancelShipment("shipped", true).ok).toBe(false);
    expect(cancelShipment("received", false).ok).toBe(false);
  });
  it("分割", () => {
    const lines = [
      { id: "a", quantity: 10 },
      { id: "b", quantity: 2 },
    ];
    expect(validateSplit(lines, new Map([["a", 4]]))).toEqual({
      ok: true,
      value: [
        { id: "a", keep: 6, move: 4 },
        { id: "b", keep: 2, move: 0 },
      ],
    });
    expect(validateSplit(lines, new Map()).ok).toBe(false);
    expect(
      validateSplit(
        lines,
        new Map([
          ["a", 10],
          ["b", 2],
        ]),
      ).ok,
    ).toBe(false);
    expect(validateSplit(lines, new Map([["a", 11]])).ok).toBe(false);
  });
  it("最低ロットの警告", () => {
    expect(lotWarnings(5, 1)).toEqual([]);
    expect(lotWarnings(5, 6)).toHaveLength(2);
    expect(lotWarnings(12, 6)).toEqual([]);
    expect(lotWarnings(13, 6)).toHaveLength(1);
  });
});

describe("invoice", () => {
  it("状態と取消", () => {
    expect(invoiceStatus(1000, 0, false)).toBe("unpaid");
    expect(invoiceStatus(1000, 400, false)).toBe("partial");
    expect(invoiceStatus(1000, 1000, false)).toBe("paid");
    expect(invoiceStatus(1000, 0, true)).toBe("cancelled");
    expect(cancelInvoice("unpaid", 0).ok).toBe(true);
    expect(cancelInvoice("partial", 100).ok).toBe(false);
    expect(cancelInvoice("cancelled", 0).ok).toBe(false);
  });
  it("消込の検証", () => {
    const outstanding = new Map([
      ["i1", 1000],
      ["i2", 500],
    ]);
    expect(
      validateAllocations(
        1500,
        0,
        [
          { invoiceId: "i1", amount: 1000, adjustment: 0 },
          { invoiceId: "i2", amount: 440, adjustment: 60 },
        ],
        outstanding,
      ),
    ).toEqual({ ok: true, value: 60 });
    expect(
      validateAllocations(500, 0, [{ invoiceId: "i1", amount: 600, adjustment: 0 }], outstanding)
        .ok,
    ).toBe(false);
    expect(
      validateAllocations(5000, 0, [{ invoiceId: "i2", amount: 501, adjustment: 0 }], outstanding)
        .ok,
    ).toBe(false);
    expect(
      validateAllocations(5000, 0, [{ invoiceId: "zz", amount: 1, adjustment: 0 }], outstanding).ok,
    ).toBe(false);
    expect(
      validateAllocations(5000, 0, [{ invoiceId: "i1", amount: -1, adjustment: 0 }], outstanding)
        .ok,
    ).toBe(false);
  });
  it("返還請求書の交付義務", () => {
    expect(creditNoteRequired(-9999)).toBe(false);
    expect(creditNoteRequired(-10000)).toBe(true);
  });
});
