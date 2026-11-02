import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { unwrap, unwrapErr } from "../../tests/support/result";
import {
  cancelOrder,
  cancelReceipt,
  cancelSupplierInvoice,
  cancelSupplierPayment,
  canCancelOrder,
  canEditOrder,
  confirmOrder,
  invoiceDifference,
  orderAmounts,
  orderLinePrice,
  orderStatusAfterInvoicePaid,
  orderStatusAfterPaymentCancelled,
  paySupplierInvoice,
  purchaseReturnAmount,
  ratesOn,
  receiptCancelBlockedByReturns,
  recordPurchaseReturn,
  recordReceipt,
  registerSupplierInvoice,
  remainingQuantity,
  returnableUnits,
  revertReceipt,
  stockQuantity,
  supplierInvoiceAmount,
  type PurchaseOrderLineState,
} from "./purchasing";

const lines = [
  { id: "l1", quantity: 10, receivedQuantity: 0, closed: false },
  { id: "l2", quantity: 5, receivedQuantity: 0, closed: false },
];

const RATES = { standard: 1000, reduced: 800 } as const;

describe("purchase order", () => {
  it("確定と取消", () => {
    expect(canEditOrder("draft")).toBe(true);
    expect(canEditOrder("ordered")).toBe(false);
    expect(confirmOrder("draft", 1, "none", null)).toEqual({ ok: true, value: "ordered" });
    expect(confirmOrder("draft", 0, "none", null).ok).toBe(false);
    expect(confirmOrder("ordered", 1, "none", null).ok).toBe(false);
    expect(cancelOrder("ordered", 0, "数量の誤り")).toEqual({ ok: true, value: "cancelled" });
    expect(cancelOrder("draft", 0, "不要")).toEqual({ ok: true, value: "cancelled" });
    expect(cancelOrder("ordered", 1, "数量の誤り").ok).toBe(false);
    expect(cancelOrder("received", 0, "数量の誤り").ok).toBe(false);
    expect(unwrapErr(cancelOrder("ordered", 0, "  ")).fields?.[0]?.field).toBe("reason");
    expect(canCancelOrder("draft")).toBe(true);
    expect(canCancelOrder("ordered")).toBe(true);
    expect(canCancelOrder("received")).toBe(false);
  });
  it("メールで送る確定には宛先が必要", () => {
    expect(unwrapErr(confirmOrder("draft", 1, "email", null)).fields?.[0]?.field).toBe("recipient");
    expect(unwrapErr(confirmOrder("draft", 1, "email", "x@")).message).toContain("形式");
    expect(confirmOrder("draft", 1, "email", "order@example.co.jp").ok).toBe(true);
  });
  it("単価の検証（発注時に仕入価格を入力する商品）", () => {
    expect(unwrapErr(orderLinePrice(false, null)).message).toBe("単価を入力してください");
    expect(orderLinePrice(false, 0)).toEqual({ ok: true, value: 0 });
    expect(unwrapErr(orderLinePrice(true, 0)).message).toContain("発注時に仕入価格を入力");
    expect(orderLinePrice(true, 100)).toEqual({ ok: true, value: 100 });
  });
  it("発注の金額は明細ごとに丸め、税は税率ごとに1回", () => {
    const r = orderAmounts(
      [
        { quantity: 3, unitPriceCenti: 33_333, taxCategory: "reduced" },
        { quantity: 1, unitPriceCenti: 50, taxCategory: "reduced" },
        { quantity: 2, unitPriceCenti: 10_000, taxCategory: "standard" },
      ],
      RATES,
      "floor",
    );
    // 999.99 → 999、0.5 → 0、200
    expect(r.lines.map((l) => l.amount)).toEqual([999, 0, 200]);
    expect(r.summary.groups).toEqual([
      { category: "standard", rateBps: 1000, subtotal: 200, tax: 20 },
      { category: "reduced", rateBps: 800, subtotal: 999, tax: 79 },
    ]);
    expect(r.summary.total).toBe(1298);
  });
  it("取引日時点の税率", () => {
    const table = [
      { category: "standard", rateBps: 800, effectiveFrom: "2014-04-01" },
      { category: "standard", rateBps: 1000, effectiveFrom: "2019-10-01" },
      { category: "reduced", rateBps: 800, effectiveFrom: "2019-10-01" },
    ] as const;
    expect(ratesOn(table, "2026-11-02")).toEqual({ standard: 1000, reduced: 800 });
    expect(ratesOn(table, "2018-01-01")).toBeUndefined();
  });
});

describe("入荷", () => {
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
    expect(r.ok && r.value.lines[1]?.closed).toBe(true);
  });
  it("残りのない明細の打ち切りは何もしない", () => {
    const done = [{ id: "l1", quantity: 2, receivedQuantity: 2, closed: false }, lines[1]!];
    expect(
      recordReceipt("ordered", done, [
        { lineId: "l1", accepted: 0, returned: 0, closeRemaining: true },
      ]).ok,
    ).toBe(false);
    const all = unwrap(
      recordReceipt("ordered", lines, [
        { lineId: "l2", accepted: 5, returned: 0, closeRemaining: true },
      ]),
    );
    expect(all.lines[1]?.closed).toBe(false);
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
    expect(cancelReceipt("ordered", false)).toEqual({ ok: true, value: "ordered" });
    expect(cancelReceipt("received", true).ok).toBe(false);
    expect(cancelReceipt("paid", false).ok).toBe(false);
  });
  it("入荷の取消で明細の入荷済みの数と打ち切りを戻す", () => {
    const after = unwrap(
      recordReceipt("ordered", lines, [
        { lineId: "l1", accepted: 3, returned: 1, closeRemaining: true },
      ]),
    ).lines;
    const back = unwrap(
      revertReceipt(after, [
        { purchaseOrderLineId: "l1", accepted: 3, returned: 1, closedRemaining: true },
      ]),
    );
    expect(back).toEqual(lines);
    expect(
      revertReceipt(lines, [
        { purchaseOrderLineId: "l1", accepted: 1, returned: 0, closedRemaining: false },
      ]).ok,
    ).toBe(false);
    expect(
      revertReceipt(lines, [
        { purchaseOrderLineId: "zz", accepted: 1, returned: 0, closedRemaining: false },
      ]).ok,
    ).toBe(false);
  });
  it("入荷して取り消すと、元の明細に戻る（性質）", () => {
    const lineArb = fc
      .record({
        quantity: fc.integer({ min: 1, max: 50 }),
        received: fc.integer({ min: 0, max: 50 }),
      })
      .map(({ quantity, received }, i = 0) => ({
        id: `l${i}`,
        quantity,
        receivedQuantity: Math.min(quantity, received),
        closed: false,
      }));
    fc.assert(
      fc.property(
        fc.array(lineArb, { minLength: 1, maxLength: 4 }),
        fc.array(fc.tuple(fc.nat(60), fc.nat(60), fc.boolean()), { minLength: 4, maxLength: 4 }),
        (raw, picks) => {
          const ls: PurchaseOrderLineState[] = raw.map((l, i) => ({ ...l, id: `l${i}` }));
          const inputs = ls.map((l, i) => {
            const [a, r, close] = picks[i] ?? [0, 0, false];
            const rem = remainingQuantity(l);
            const accepted = rem === 0 ? 0 : a % (rem + 1);
            const returned = rem - accepted === 0 ? 0 : r % (rem - accepted + 1);
            return { lineId: l.id, accepted, returned, closeRemaining: close };
          });
          const recorded = recordReceipt("ordered", ls, inputs);
          if (!recorded.ok) return;
          const back = unwrap(
            revertReceipt(
              recorded.value.lines,
              recorded.value.changes.map((c) => ({
                purchaseOrderLineId: c.line.id,
                accepted: c.accepted,
                returned: c.returned,
                closedRemaining: c.closedNow,
              })),
            ),
          );
          expect(back).toEqual(ls);
          for (const l of recorded.value.lines)
            expect(remainingQuantity(l)).toBeGreaterThanOrEqual(0);
        },
      ),
      { seed: 20261102, numRuns: 200 },
    );
  });
});

describe("仕入返品", () => {
  const returnable = [
    {
      id: "l1",
      unitPriceCenti: 120_000,
      unitsPerPurchaseUnit: 12,
      taxCategory: "reduced" as const,
      acceptedQuantity: 2,
      returnedUnits: 5,
    },
  ];
  it("返品できる数は受入数 × 入数 − これまでの返品", () => {
    expect(returnableUnits(returnable[0]!)).toBe(19);
    expect(returnableUnits({ ...returnable[0]!, returnedUnits: 30 })).toBe(0);
  });
  it("金額は販売単位の数 × 単価 ÷ 入数を明細ごとに丸める", () => {
    // 1,200円/12個 × 5個 = 500円
    expect(purchaseReturnAmount(120_000, 12, 5, "floor")).toBe(500);
    // 1,000円/3個 × 1個 = 333.33 → 333 / 334
    expect(purchaseReturnAmount(100_000, 3, 1, "floor")).toBe(333);
    expect(purchaseReturnAmount(100_000, 3, 1, "ceil")).toBe(334);
  });
  it("記録の検証", () => {
    expect(
      unwrap(recordPurchaseReturn("received", returnable, [{ lineId: "l1", units: 3 }], "floor")),
    ).toEqual([{ line: returnable[0], units: 3, amount: 300 }]);
    expect(
      recordPurchaseReturn("paid", returnable, [{ lineId: "l1", units: 19 }], "floor").ok,
    ).toBe(true);
    expect(
      recordPurchaseReturn("received", returnable, [{ lineId: "l1", units: 20 }], "floor").ok,
    ).toBe(false);
    expect(
      recordPurchaseReturn("received", returnable, [{ lineId: "l1", units: 0 }], "floor").ok,
    ).toBe(false);
    expect(
      recordPurchaseReturn("received", returnable, [{ lineId: "l1", units: -1 }], "floor").ok,
    ).toBe(false);
    expect(
      recordPurchaseReturn("received", returnable, [{ lineId: "x", units: 1 }], "floor").ok,
    ).toBe(false);
    expect(
      recordPurchaseReturn(
        "received",
        returnable,
        [
          { lineId: "l1", units: 1 },
          { lineId: "l1", units: 1 },
        ],
        "floor",
      ).ok,
    ).toBe(false);
    expect(
      recordPurchaseReturn("draft", returnable, [{ lineId: "l1", units: 1 }], "floor").ok,
    ).toBe(false);
  });
  it("仕入返品した数を下回る入荷の取消はできない", () => {
    expect(
      receiptCancelBlockedByReturns([
        { acceptedAfter: 0, unitsPerPurchaseUnit: 12, returnedUnits: 1 },
      ]).ok,
    ).toBe(false);
    expect(
      receiptCancelBlockedByReturns([
        { acceptedAfter: 1, unitsPerPurchaseUnit: 12, returnedUnits: 12 },
      ]).ok,
    ).toBe(true);
  });
});

describe("仕入先請求書と支払", () => {
  it("在庫数への換算と差額", () => {
    expect(stockQuantity(3, 24)).toBe(72);
    expect(invoiceDifference(1000, 1000, "")).toEqual({ ok: true, value: 0 });
    expect(invoiceDifference(1010, 1000, "").ok).toBe(false);
    expect(invoiceDifference(1010, 1000, "端数")).toEqual({ ok: true, value: 10 });
  });
  it("計算額は（入荷 − 返品）に税を加え、送料を足す", () => {
    const r = supplierInvoiceAmount(
      [
        { amount: 2400, taxCategory: "reduced" },
        { amount: 1000, taxCategory: "standard" },
      ],
      [{ amount: 400, taxCategory: "reduced" }],
      550,
      RATES,
      "floor",
    );
    expect(r.summary.groups).toEqual([
      { category: "standard", rateBps: 1000, subtotal: 1000, tax: 100 },
      { category: "reduced", rateBps: 800, subtotal: 2000, tax: 160 },
    ]);
    expect(r.computedAmount).toBe(1000 + 100 + 2000 + 160 + 550);
  });
  it("登録・支払・取消の遷移", () => {
    expect(registerSupplierInvoice(1)).toEqual({ ok: true, value: "unpaid" });
    expect(registerSupplierInvoice(0).ok).toBe(false);
    expect(paySupplierInvoice("unpaid", 100)).toEqual({ ok: true, value: "paid" });
    expect(paySupplierInvoice("paid", 100).ok).toBe(false);
    expect(paySupplierInvoice("unpaid", 0).ok).toBe(false);
    expect(cancelSupplierPayment("paid", "二重払い")).toEqual({ ok: true, value: "unpaid" });
    expect(cancelSupplierPayment("unpaid", "二重払い").ok).toBe(false);
    expect(cancelSupplierPayment("paid", "").ok).toBe(false);
    expect(cancelSupplierInvoice("unpaid", "請求書の誤り")).toEqual({
      ok: true,
      value: "cancelled",
    });
    expect(unwrapErr(cancelSupplierInvoice("paid", "x")).message).toContain("先に支払を取り消し");
    expect(cancelSupplierInvoice("cancelled", "x").ok).toBe(false);
    expect(cancelSupplierInvoice("unpaid", " ").ok).toBe(false);
  });
  it("支払で発注が支払済みになるのは、入荷済みで全部の入荷が支払済みのとき", () => {
    expect(orderStatusAfterInvoicePaid("received", true)).toBe("paid");
    expect(orderStatusAfterInvoicePaid("received", false)).toBe("received");
    expect(orderStatusAfterInvoicePaid("ordered", true)).toBe("ordered");
    expect(orderStatusAfterPaymentCancelled("paid")).toBe("received");
    expect(orderStatusAfterPaymentCancelled("ordered")).toBe("ordered");
  });
});
