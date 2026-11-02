import { describe, expect, it } from "vitest";

import { unwrap } from "../../tests/support/result";
import {
  cancelOrder,
  cancelReceipt,
  canEditOrder,
  confirmOrder,
  invoiceDifference,
  recordReceipt,
  remainingQuantity,
  stockQuantity,
} from "./purchasing";

const lines = [
  { id: "l1", quantity: 10, receivedQuantity: 0, closed: false },
  { id: "l2", quantity: 5, receivedQuantity: 0, closed: false },
];

describe("purchase order", () => {
  it("確定と取消", () => {
    expect(canEditOrder("draft")).toBe(true);
    expect(canEditOrder("ordered")).toBe(false);
    expect(confirmOrder("draft", 1)).toEqual({ ok: true, value: "ordered" });
    expect(confirmOrder("draft", 0).ok).toBe(false);
    expect(confirmOrder("ordered", 1).ok).toBe(false);
    expect(cancelOrder("ordered", 0)).toEqual({ ok: true, value: "cancelled" });
    expect(cancelOrder("ordered", 1).ok).toBe(false);
    expect(cancelOrder("received", 0).ok).toBe(false);
  });
  it("分納：一部だけ入荷すると発注済みのまま", () => {
    const r = recordReceipt("ordered", lines, [
      { lineId: "l1", accepted: 4, returned: 1, closeRemaining: false },
    ]);
    const value = unwrap(r);
    expect(value.status).toBe("ordered");
    expect(remainingQuantity(value.lines[0]!)).toBe(5);
  });
  it("全数入荷または打ち切りで入荷済み", () => {
    const r = recordReceipt("ordered", lines, [
      { lineId: "l1", accepted: 10, returned: 0, closeRemaining: false },
      { lineId: "l2", accepted: 2, returned: 0, closeRemaining: true },
    ]);
    expect(r.ok && r.value.status).toBe("received");
  });
  it("残りを超える入荷・負の数・何もしない入力はエラー", () => {
    expect(
      recordReceipt("ordered", lines, [
        { lineId: "l2", accepted: 6, returned: 0, closeRemaining: false },
      ]).ok,
    ).toBe(false);
    expect(
      recordReceipt("ordered", lines, [
        { lineId: "l2", accepted: -1, returned: 0, closeRemaining: false },
      ]).ok,
    ).toBe(false);
    expect(
      recordReceipt("ordered", lines, [
        { lineId: "l2", accepted: 0, returned: 0, closeRemaining: false },
      ]).ok,
    ).toBe(false);
    expect(
      recordReceipt("ordered", lines, [
        { lineId: "x", accepted: 1, returned: 0, closeRemaining: false },
      ]).ok,
    ).toBe(false);
    expect(
      recordReceipt("ordered", lines, [
        { lineId: "l1", accepted: 1, returned: 0, closeRemaining: false },
        { lineId: "l1", accepted: 1, returned: 0, closeRemaining: false },
      ]).ok,
    ).toBe(false);
    expect(
      recordReceipt("draft", lines, [
        { lineId: "l1", accepted: 1, returned: 0, closeRemaining: false },
      ]).ok,
    ).toBe(false);
  });
  it("入荷の取消", () => {
    expect(cancelReceipt("received", false)).toEqual({ ok: true, value: "ordered" });
    expect(cancelReceipt("received", true).ok).toBe(false);
    expect(cancelReceipt("paid", false).ok).toBe(false);
  });
  it("在庫数への換算と差額", () => {
    expect(stockQuantity(3, 24)).toBe(72);
    expect(invoiceDifference(1000, 1000, "")).toEqual({ ok: true, value: 0 });
    expect(invoiceDifference(1010, 1000, "").ok).toBe(false);
    expect(invoiceDifference(1010, 1000, "端数")).toEqual({ ok: true, value: 10 });
  });
});
