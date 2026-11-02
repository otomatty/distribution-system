import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { unwrap, unwrapErr } from "../../tests/support/result";
import {
  cancelOrder,
  cancelPurchaseReturn,
  cancelReceipt,
  cancelSupplierInvoice,
  cancelSupplierPayment,
  canEditOrder,
  confirmOrder,
  invoiceDifference,
  isSettlementInvoice,
  orderAmounts,
  orderLinePrice,
  orderStatusAfterPaymentChange,
  payableBalances,
  paySupplierInvoice,
  purchaseReturnAmount,
  ratesOn,
  receiptCancellable,
  receiptCancelBlockedByReturns,
  recordPurchaseReturn,
  recordReceipt,
  registerSupplierInvoice,
  remainingQuantity,
  returnableUnits,
  revertReceipt,
  settledOrderStatus,
  stockQuantity,
  SUPPLIER_INVOICE_STATUS_LABELS,
  supplierInvoiceAmount,
  supplierInvoiceRemaining,
  type PurchaseOrderLineState,
} from "./purchasing";
import type { Result } from "./result";

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
    const r = recordReceipt(
      "ordered",
      lines,
      [{ lineId: "l1", accepted: 4, returned: 1, closeRemaining: false }],
      0,
    );
    const value = unwrap(r);
    expect(value.status).toBe("ordered");
    expect(remainingQuantity(value.lines[0]!)).toBe(5);
  });
  it("全数入荷または打ち切りで入荷済み", () => {
    const r = recordReceipt(
      "ordered",
      lines,
      [
        { lineId: "l1", accepted: 10, returned: 0, closeRemaining: false },
        { lineId: "l2", accepted: 2, returned: 0, closeRemaining: true },
      ],
      0,
    );
    expect(r.ok && r.value.status).toBe("received");
    expect(r.ok && r.value.lines[1]?.closed).toBe(true);
  });
  it("残りのない明細の打ち切りは何もしない", () => {
    const done = [{ id: "l1", quantity: 2, receivedQuantity: 2, closed: false }, lines[1]!];
    expect(
      recordReceipt(
        "ordered",
        done,
        [{ lineId: "l1", accepted: 0, returned: 0, closeRemaining: true }],
        0,
      ).ok,
    ).toBe(false);
    const all = unwrap(
      recordReceipt(
        "ordered",
        lines,
        [{ lineId: "l2", accepted: 5, returned: 0, closeRemaining: true }],
        0,
      ),
    );
    expect(all.lines[1]?.closed).toBe(false);
  });
  it("残りを超える入荷・負の数・何もしない入力はエラー", () => {
    expect(
      recordReceipt(
        "ordered",
        lines,
        [{ lineId: "l2", accepted: 6, returned: 0, closeRemaining: false }],
        0,
      ).ok,
    ).toBe(false);
    expect(
      recordReceipt(
        "ordered",
        lines,
        [{ lineId: "l2", accepted: -1, returned: 0, closeRemaining: false }],
        0,
      ).ok,
    ).toBe(false);
    expect(
      recordReceipt(
        "ordered",
        lines,
        [{ lineId: "l2", accepted: 0, returned: 0, closeRemaining: false }],
        0,
      ).ok,
    ).toBe(false);
    expect(
      recordReceipt(
        "ordered",
        lines,
        [{ lineId: "x", accepted: 1, returned: 0, closeRemaining: false }],
        0,
      ).ok,
    ).toBe(false);
    expect(
      recordReceipt(
        "ordered",
        lines,
        [
          { lineId: "l1", accepted: 1, returned: 0, closeRemaining: false },
          { lineId: "l1", accepted: 1, returned: 0, closeRemaining: false },
        ],
        0,
      ).ok,
    ).toBe(false);
    expect(
      recordReceipt(
        "draft",
        lines,
        [{ lineId: "l1", accepted: 1, returned: 0, closeRemaining: false }],
        0,
      ).ok,
    ).toBe(false);
  });
  it("入荷の取消：取り消した後の明細から発注の状態を決める", () => {
    const open = [{ id: "l1", quantity: 10, receivedQuantity: 6, closed: false }];
    const closed = [{ id: "l1", quantity: 10, receivedQuantity: 3, closed: true }];
    expect(cancelReceipt("received", null, open, 1)).toEqual({ ok: true, value: "ordered" });
    expect(cancelReceipt("ordered", "unpaid", open, 0)).toEqual({ ok: true, value: "ordered" });
    // ほかの入荷の打ち切りが残っていれば、入荷済みのまま
    expect(cancelReceipt("received", null, closed, 1)).toEqual({ ok: true, value: "received" });
    // 支払うものが残っていなければ支払済み
    expect(cancelReceipt("received", null, closed, 0)).toEqual({ ok: true, value: "paid" });
    expect(cancelReceipt("received", "paid", open, 0).ok).toBe(false);
    expect(cancelReceipt("paid", null, open, 0).ok).toBe(false);
    expect(receiptCancellable("ordered", null)).toEqual({ ok: true, value: true });
    expect(receiptCancellable("received", "unpaid")).toEqual({ ok: true, value: true });
    expect(unwrapErr(receiptCancellable("received", "paid")).message).toContain(
      "支払済みの請求書に含まれる入荷",
    );
    // 一部支払の請求書の入荷も、先に支払をすべて取り消すまで取り消せない
    expect(unwrapErr(receiptCancellable("received", "partial")).message).toBe(
      "一部支払の請求書に含まれる入荷は取り消せません。先に請求書の支払をすべて取り消してください",
    );
    expect(receiptCancellable("draft", null).ok).toBe(false);
  });
  it("発注の状態：残りがあれば発注済み、残りがなく未払いの入荷があれば入荷済み、なければ支払済み", () => {
    const done = [
      { id: "l1", quantity: 2, receivedQuantity: 2, closed: false },
      { id: "l2", quantity: 5, receivedQuantity: 1, closed: true },
    ];
    expect(settledOrderStatus(lines, 0)).toBe("ordered");
    expect(settledOrderStatus(done, 2)).toBe("received");
    expect(settledOrderStatus(done, 0)).toBe("paid");
  });
  it("入荷の記録：受入のない入荷で残りがなくなり、未払いの入荷もなければ支払済み", () => {
    const one = [{ id: "l1", quantity: 10, receivedQuantity: 6, closed: false }];
    const close = [{ lineId: "l1", accepted: 0, returned: 0, closeRemaining: true }];
    expect(unwrap(recordReceipt("ordered", one, close, 0)).status).toBe("paid");
    expect(unwrap(recordReceipt("ordered", one, close, 1)).status).toBe("received");
    // この入荷に受入があれば、未払いの入荷が1件増える
    const accept = [{ lineId: "l1", accepted: 4, returned: 0, closeRemaining: false }];
    expect(unwrap(recordReceipt("ordered", one, accept, 0)).status).toBe("received");
    // 全数をその場で返品した
    const back = [{ lineId: "l1", accepted: 0, returned: 4, closeRemaining: false }];
    expect(unwrap(recordReceipt("ordered", one, back, 0)).status).toBe("paid");
  });
  it("入荷の取消で明細の入荷済みの数と打ち切りを戻す", () => {
    const after = unwrap(
      recordReceipt(
        "ordered",
        lines,
        [{ lineId: "l1", accepted: 3, returned: 1, closeRemaining: true }],
        0,
      ),
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
          const recorded = recordReceipt("ordered", ls, inputs, 0);
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
  it("取消は入荷の取消と同じ条件：支払（一部を含む）を記録した請求書から差し引いたものは取り消せない。理由が必須", () => {
    expect(cancelPurchaseReturn(false, null, "数え間違い")).toEqual({ ok: true, value: true });
    expect(cancelPurchaseReturn(false, "unpaid", "数え間違い")).toEqual({ ok: true, value: true });
    expect(unwrapErr(cancelPurchaseReturn(false, "paid", "x")).message).toBe(
      "支払済みの請求書に含まれる仕入返品は取り消せません",
    );
    expect(unwrapErr(cancelPurchaseReturn(false, "partial", "x")).message).toContain(
      "先に請求書の支払をすべて取り消してください",
    );
    expect(unwrapErr(cancelPurchaseReturn(true, null, "x")).message).toBe(
      "この仕入返品はすでに取り消されています",
    );
    const blank = unwrapErr(cancelPurchaseReturn(false, null, "  "));
    expect(blank.code).toBe("validation");
    expect(blank.fields?.[0]?.field).toBe("reason");
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
    expect(paySupplierInvoice("unpaid", 100, 0, 100)).toEqual({
      ok: true,
      value: { status: "paid", paidAmount: 100 },
    });
    expect(paySupplierInvoice("paid", 100, 100, 1).ok).toBe(false);
    expect(paySupplierInvoice("cancelled", 100, 0, 100).ok).toBe(false);
    expect(paySupplierInvoice("unpaid", 100, 0, 0).ok).toBe(false);
    expect(paySupplierInvoice("unpaid", 100, 0, -100).ok).toBe(false);
    expect(paySupplierInvoice("unpaid", 100, 0, 1.5).ok).toBe(false);
    expect(cancelSupplierInvoice("unpaid", "請求書の誤り")).toEqual({
      ok: true,
      value: "cancelled",
    });
    expect(unwrapErr(cancelSupplierInvoice("paid", "x")).message).toBe(
      "支払済みの請求書は取り消せません。先に支払をすべて取り消してください",
    );
    expect(unwrapErr(cancelSupplierInvoice("partial", "x")).message).toBe(
      "一部支払の請求書は取り消せません。先に支払をすべて取り消してください",
    );
    expect(cancelSupplierInvoice("cancelled", "x").ok).toBe(false);
    expect(cancelSupplierInvoice("unpaid", " ").ok).toBe(false);
  });
  it("一部支払：残りより少ない支払は一部支払、残りが 0 になれば支払済み。残りより多い支払はできない", () => {
    expect(SUPPLIER_INVOICE_STATUS_LABELS.partial).toBe("一部支払");
    const first = unwrap(paySupplierInvoice("unpaid", 1000, 0, 400));
    expect(first).toEqual({ status: "partial", paidAmount: 400 });
    const second = unwrap(paySupplierInvoice(first.status, 1000, first.paidAmount, 500));
    expect(second).toEqual({ status: "partial", paidAmount: 900 });
    const over = unwrapErr(paySupplierInvoice("partial", 1000, 900, 101));
    expect(over.message).toBe("支払額が残りの額（100 円）を超えています");
    expect(over.fields?.[0]?.field).toBe("amount");
    expect(paySupplierInvoice("unpaid", 1000, 0, 1001).ok).toBe(false);
    expect(paySupplierInvoice("partial", 1000, 900, 100)).toEqual({
      ok: true,
      value: { status: "paid", paidAmount: 1000 },
    });
    expect(
      supplierInvoiceRemaining({ status: "partial", invoicedAmount: 1000, paidAmount: 900 }),
    ).toBe(100);
    expect(
      supplierInvoiceRemaining({ status: "paid", invoicedAmount: 1000, paidAmount: 1000 }),
    ).toBe(0);
    expect(
      supplierInvoiceRemaining({ status: "cancelled", invoicedAmount: 1000, paidAmount: 0 }),
    ).toBe(0);
    // 精算（0 円以下）の請求書の残りは、精算するまで請求額
    expect(
      supplierInvoiceRemaining({ status: "unpaid", invoicedAmount: -1296, paidAmount: 0 }),
    ).toBe(-1296);
  });
  it("支払の取消は1件ずつ。ほかの支払が残れば一部支払、残らなければ未払いに戻る。理由が必須", () => {
    const live = { amount: 400, cancelled: false };
    expect(cancelSupplierPayment("paid", 1000, live, 1, "二重払い")).toEqual({
      ok: true,
      value: { status: "partial", paidAmount: 600 },
    });
    expect(cancelSupplierPayment("partial", 400, live, 0, "二重払い")).toEqual({
      ok: true,
      value: { status: "unpaid", paidAmount: 0 },
    });
    expect(cancelSupplierPayment("paid", 1000, { amount: 1000, cancelled: false }, 0, "x")).toEqual(
      { ok: true, value: { status: "unpaid", paidAmount: 0 } },
    );
    // 精算（マイナス）の取消は未払いに戻る
    expect(
      cancelSupplierPayment("paid", -1296, { amount: -1296, cancelled: false }, 0, "x"),
    ).toEqual({ ok: true, value: { status: "unpaid", paidAmount: 0 } });
    expect(unwrapErr(cancelSupplierPayment("unpaid", 0, live, 0, "x")).message).toBe(
      "支払済み・一部支払の請求書だけ支払を取り消せます",
    );
    expect(
      unwrapErr(cancelSupplierPayment("paid", 1000, { amount: 400, cancelled: true }, 1, "x"))
        .message,
    ).toBe("この支払はすでに取り消されています");
    expect(cancelSupplierPayment("paid", 1000, live, 1, "").ok).toBe(false);
  });
  it("支払と取消を繰り返しても、支払済みの額は有効な支払の合計で、状態は額と件数から決まる", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000 }),
        fc.array(fc.oneof(fc.integer({ min: 1, max: 60_000 }), fc.constant(-1)), {
          maxLength: 30,
        }),
        (invoiced, ops) => {
          let status: "unpaid" | "partial" | "paid" = "unpaid";
          let paid = 0;
          const payments: number[] = [];
          const problems: string[] = [];
          for (const op of ops) {
            const amount = op === -1 ? payments.pop() : op;
            if (op === -1 && amount === undefined) {
              // 支払のない請求書の支払は取り消せない
              if (cancelSupplierPayment(status, paid, { amount: 1, cancelled: false }, 0, "x").ok)
                problems.push("支払のない請求書の支払を取り消せた");
              continue;
            }
            const next: Result<{ status: "unpaid" | "partial" | "paid"; paidAmount: number }> =
              op === -1
                ? cancelSupplierPayment(
                    status,
                    paid,
                    { amount: amount ?? 0, cancelled: false },
                    payments.length,
                    "x",
                  )
                : paySupplierInvoice(status, invoiced, paid, op);
            if (!next.ok) {
              // 支払えないのは、支払済みか残りより多いときだけ（取消は必ずできる）
              if (op === -1 || !(status === "paid" || op > invoiced - paid))
                problems.push(`${status} ${paid}/${invoiced} の ${op} が失敗した`);
              continue;
            }
            if (op !== -1) payments.push(op);
            status = next.value.status;
            paid = next.value.paidAmount;
            const total = payments.reduce((s, a) => s + a, 0);
            const expected =
              payments.length === 0 ? "unpaid" : paid === invoiced ? "paid" : "partial";
            if (paid !== total || paid > invoiced || status !== expected)
              problems.push(`${status}（${expected}）${paid}/${invoiced}・支払の合計 ${total}`);
          }
          expect(problems).toEqual([]);
        },
      ),
    );
  });
  it("請求額が 0 円以下の請求書は、請求額と同じ額で精算する（相殺・返金を受ける）", () => {
    expect(isSettlementInvoice(0)).toBe(true);
    expect(isSettlementInvoice(-1296)).toBe(true);
    expect(isSettlementInvoice(1)).toBe(false);
    expect(paySupplierInvoice("unpaid", -1296, 0, -1296)).toEqual({
      ok: true,
      value: { status: "paid", paidAmount: -1296 },
    });
    expect(paySupplierInvoice("unpaid", 0, 0, 0)).toEqual({
      ok: true,
      value: { status: "paid", paidAmount: 0 },
    });
    const wrong = unwrapErr(paySupplierInvoice("unpaid", -1296, 0, 0));
    expect(wrong.message).toBe(
      "請求額が -1,296 円の請求書は、請求額と同じ額（-1,296 円）で精算してください",
    );
    expect(wrong.fields?.[0]?.field).toBe("amount");
    expect(paySupplierInvoice("unpaid", -1296, 0, 1296).ok).toBe(false);
    expect(paySupplierInvoice("unpaid", 0, 0, 1).ok).toBe(false);
    expect(paySupplierInvoice("paid", 0, 0, 0).ok).toBe(false);
  });
  it("支払で発注が支払済みになるのは、入荷済みで全部の入荷が支払済みのとき。支払の取消で入荷済みに戻る", () => {
    const done = [{ id: "l1", quantity: 2, receivedQuantity: 2, closed: false }];
    expect(orderStatusAfterPaymentChange("received", done, 0)).toBe("paid");
    expect(orderStatusAfterPaymentChange("received", done, 1)).toBe("received");
    expect(orderStatusAfterPaymentChange("ordered", lines, 0)).toBe("ordered");
    expect(orderStatusAfterPaymentChange("paid", done, 1)).toBe("received");
    expect(orderStatusAfterPaymentChange("draft", lines, 0)).toBe("draft");
    expect(orderStatusAfterPaymentChange("cancelled", lines, 0)).toBe("cancelled");
  });
  it("買掛残高は前月末の残高に請求額を足し、支払額を引いて月ごとに求める", () => {
    expect(
      payableBalances(
        1000,
        ["2026-09", "2026-10", "2026-11"],
        new Map([
          ["2026-09", { invoiced: 5000, paid: 1000 }],
          ["2026-11", { invoiced: 0, paid: 5000 }],
        ]),
      ),
    ).toEqual([
      { month: "2026-09", invoiced: 5000, paid: 1000, balance: 5000 },
      { month: "2026-10", invoiced: 0, paid: 0, balance: 5000 },
      { month: "2026-11", invoiced: 0, paid: 5000, balance: 0 },
    ]);
  });
});
