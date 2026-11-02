import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { unwrap, unwrapErr } from "../../tests/support/result";
import {
  applyAllocation,
  buildInvoiceLines,
  cancelPayment,
  cancelSalesReturn,
  canRecordReturn,
  closingDueDate,
  closingTarget,
  creditNoteIssuable,
  creditNoteObligation,
  disposalRateBps,
  invoiceOutstanding,
  isOpenInvoice,
  isOverdue,
  issuedInvoiceStatus,
  paymentUnallocated,
  planAllocations,
  planInvoice,
  ratesForDates,
  receivable,
  releaseAllocation,
  returnableQuantity,
  returnLineAmount,
  summarizeDisposalRates,
  validateClosing,
  validateDisposalLines,
  validateIssueDates,
  validateReturnLines,
  type InvoiceReturnSource,
  type InvoiceShipmentSource,
} from "./billing";
import { lineAmount, summarizeTax, taxAmount, type RoundingMode, type TaxRateEntry } from "./money";
import type { Result } from "./result";
import type { InvoiceStatus } from "./sales";

const RATES: TaxRateEntry[] = [
  { category: "standard", rateBps: 1000, effectiveFrom: "2019-10-01" },
  { category: "reduced", rateBps: 800, effectiveFrom: "2019-10-01" },
];

const SEED = 20261102;

/** 失敗の最初の項目エラーの項目名 */
function firstField<T>(r: Result<T>): string | undefined {
  return unwrapErr(r).fields?.[0]?.field;
}

function shipment(
  id: string,
  shippedOn: string,
  lines: { quantity: number; unitPriceCenti: number; taxCategory: "standard" | "reduced" }[],
  charges: { quantity: number; unitAmount: number; taxCategory: "standard" | "reduced" }[] = [],
): InvoiceShipmentSource {
  return {
    shipmentId: id,
    shippedOn,
    lines: lines.map((l, i) => ({
      salesOrderLineId: `${id}-l${i}`,
      itemName: `商品${i}`,
      unitName: "個",
      ...l,
    })),
    charges: charges.map((c, i) => ({
      salesChargeId: `${id}-c${i}`,
      description: "送料",
      ...c,
    })),
  };
}

function returned(
  id: string,
  returnedOn: string,
  lines: { quantity: number; unitPriceCenti: number; taxCategory: "standard" | "reduced" }[],
  mode: RoundingMode = "floor",
): InvoiceReturnSource {
  return {
    salesReturnId: id,
    returnedOn,
    lines: lines.map((l, i) => ({
      salesReturnLineId: `${id}-r${i}`,
      itemName: `商品${i}`,
      unitName: "個",
      amount: returnLineAmount(l.unitPriceCenti, l.quantity, mode),
      ...l,
    })),
  };
}

describe("請求書の明細と金額", () => {
  it("発送の明細・送料・返品（マイナス）を順に明細にし、税は税率ごとに1回だけ丸める", () => {
    const s = shipment(
      "s1",
      "2026-10-05",
      [
        { quantity: 3, unitPriceCenti: 15_050, taxCategory: "reduced" },
        { quantity: 6, unitPriceCenti: 10_000, taxCategory: "standard" },
      ],
      [{ quantity: 1, unitAmount: 800, taxCategory: "standard" }],
    );
    const r = returned("r1", "2026-10-10", [
      { quantity: 1, unitPriceCenti: 15_050, taxCategory: "reduced" },
    ]);
    const plan = unwrap(
      planInvoice({ shipments: [s], returns: [r], taxRates: RATES, mode: "floor" }),
    );
    expect(plan.lines.map((l) => [l.lineNo, l.sourceType, l.quantity, l.amount])).toEqual([
      [1, "shipment_line", 3, 451],
      [2, "shipment_line", 6, 600],
      [3, "charge", 1, 800],
      [4, "return_line", -1, -150],
    ]);
    expect(plan.lines[2]).toMatchObject({ unitPriceCenti: 80_000, unitName: null });
    expect(plan.lines[3]).toMatchObject({
      description: "返品 商品0",
      transactionDate: "2026-10-10",
      sourceId: "r1-r0",
    });
    expect(plan.summary.groups).toEqual([
      { category: "standard", rateBps: 1000, subtotal: 1400, tax: 140 },
      { category: "reduced", rateBps: 800, subtotal: 301, tax: 24 },
    ]);
    expect(plan.summary.total).toBe(1865);
    expect(plan.lastTransactionDate).toBe("2026-10-10");
    // 最後の取引日は、渡した順ではなく日付で決まる
    const earlier = returned("r0", "2026-10-01", [
      { quantity: 1, unitPriceCenti: 100, taxCategory: "standard" },
    ]);
    expect(
      unwrap(planInvoice({ shipments: [s], returns: [earlier], taxRates: RATES, mode: "floor" }))
        .lastTransactionDate,
    ).toBe("2026-10-05");
  });

  it("発送がない・合計がマイナス・税率がない・税率が変わる日をまたぐ請求書は作らない", () => {
    expect(
      unwrapErr(planInvoice({ shipments: [], returns: [], taxRates: RATES, mode: "floor" }))
        .message,
    ).toContain("発送を1件以上");
    const s = shipment("s1", "2026-10-05", [
      { quantity: 1, unitPriceCenti: 10_000, taxCategory: "standard" },
    ]);
    const big = returned("r1", "2026-10-06", [
      { quantity: 5, unitPriceCenti: 10_000, taxCategory: "standard" },
    ]);
    expect(
      unwrapErr(planInvoice({ shipments: [s], returns: [big], taxRates: RATES, mode: "floor" }))
        .message,
    ).toContain("マイナス");
    expect(
      unwrapErr(planInvoice({ shipments: [s], returns: [], taxRates: [], mode: "floor" })).code,
    ).toBe("invalid_state");
    const changed: TaxRateEntry[] = [
      ...RATES,
      { category: "standard", rateBps: 1200, effectiveFrom: "2026-10-06" },
    ];
    const later = shipment("s2", "2026-10-07", [
      { quantity: 1, unitPriceCenti: 10_000, taxCategory: "standard" },
    ]);
    expect(
      unwrapErr(
        planInvoice({ shipments: [s, later], returns: [], taxRates: changed, mode: "floor" }),
      ).message,
    ).toContain("税率が変わる日");
    expect(unwrapErr(ratesForDates(RATES, [])).code).toBe("validation");
    expect(unwrap(ratesForDates(RATES, ["2026-10-01", "2026-10-02"]))).toEqual({
      standard: 1000,
      reduced: 800,
    });
  });

  it("合計が 0 円の請求書は作れて、発行時に入金済みになる", () => {
    const s = shipment("s1", "2026-10-05", [
      { quantity: 2, unitPriceCenti: 10_000, taxCategory: "standard" },
    ]);
    const all = returned("r1", "2026-10-06", [
      { quantity: 2, unitPriceCenti: 10_000, taxCategory: "standard" },
    ]);
    const plan = unwrap(
      planInvoice({ shipments: [s], returns: [all], taxRates: RATES, mode: "floor" }),
    );
    expect(plan.summary.total).toBe(0);
    expect(issuedInvoiceStatus(plan.summary.total)).toBe("paid");
    expect(issuedInvoiceStatus(1)).toBe("unpaid");
  });

  it("明細の金額は明細ごとに、税は税率ごとに1回丸める（性質）", () => {
    const line = fc.record({
      quantity: fc.integer({ min: 1, max: 500 }),
      unitPriceCenti: fc.integer({ min: 0, max: 5_000_000 }),
      taxCategory: fc.constantFrom("standard" as const, "reduced" as const),
    });
    fc.assert(
      fc.property(
        fc.array(fc.array(line, { minLength: 1, maxLength: 5 }), { minLength: 1, maxLength: 4 }),
        fc.array(line, { maxLength: 3 }),
        fc.constantFrom<RoundingMode>("floor", "round", "ceil"),
        (shipments, returnLines, mode) => {
          const sources = shipments.map((lines, i) => shipment(`s${i}`, "2026-10-05", lines));
          const returns = [returned("r", "2026-10-06", returnLines, mode)];
          const lines = buildInvoiceLines(sources, returns, mode);
          // 明細の金額は明細ごとに丸めた単価 × 数量（返品は符号が逆）
          for (const l of lines) {
            const expected = lineAmount(l.unitPriceCenti, Math.abs(l.quantity), mode);
            expect(l.amount).toBe(l.quantity < 0 ? -expected : expected);
          }
          const r = planInvoice({ shipments: sources, returns, taxRates: RATES, mode });
          const net = lines.reduce((s, l) => s + l.amount, 0);
          // 返品を差し引いた税込の合計がマイナスになる請求書だけを作らない
          const expected = summarizeTax(lines, { standard: 1000, reduced: 800 }, mode);
          expect(r.ok).toBe(expected.total >= 0);
          if (!r.ok) return;
          const { summary } = r.value;
          expect(summary.subtotal).toBe(net);
          for (const g of summary.groups) {
            const subtotal = lines
              .filter((l) => l.taxCategory === g.category)
              .reduce((s, l) => s + l.amount, 0);
            expect(g.subtotal).toBe(subtotal);
            expect(g.tax).toBe(taxAmount(subtotal, g.rateBps, mode));
          }
          expect(summary.total).toBe(summary.subtotal + summary.tax);
          expect(summary.total).toBeGreaterThanOrEqual(0);
        },
      ),
      { seed: SEED },
    );
  });

  it("発行日は最後の取引日以降・今日まで、支払期限は発行日以降", () => {
    expect(
      validateIssueDates({
        issuedOn: "2026-10-31",
        dueOn: "2026-11-30",
        lastTransactionDate: "2026-10-31",
        today: "2026-11-02",
      }).ok,
    ).toBe(true);
    expect(
      unwrapErr(
        validateIssueDates({
          issuedOn: "2026-10-30",
          dueOn: null,
          lastTransactionDate: "2026-10-31",
          today: "2026-11-02",
        }),
      ).fields?.[0]?.field,
    ).toBe("issuedOn");
    expect(
      unwrapErr(
        validateIssueDates({
          issuedOn: "2026-10-31",
          dueOn: "2026-10-01",
          lastTransactionDate: "2026-10-01",
          today: "2026-11-02",
        }),
      ).fields?.[0]?.field,
    ).toBe("dueOn");
    expect(
      unwrapErr(
        validateIssueDates({
          issuedOn: "2026-11-03",
          dueOn: null,
          lastTransactionDate: "2026-10-01",
          today: "2026-11-02",
        }),
      ).message,
    ).toBe("発行日は今日より後にできません");
  });
});

describe("締め処理", () => {
  it("最も古い未請求の発送の締め期間を締める。締め日を迎えたら締められる", () => {
    expect(closingTarget("2026-10-05", 31, "2026-11-02")).toEqual({
      from: "2026-10-01",
      to: "2026-10-31",
      ready: true,
    });
    expect(closingTarget("2026-10-21", 20, "2026-11-02")).toEqual({
      from: "2026-10-21",
      to: "2026-11-20",
      ready: false,
    });
    expect(closingTarget("2026-10-20", 20, "2026-10-20").ready).toBe(true);
    expect(
      closingDueDate("2026-10-31", { closingDay: 31, paymentMonthOffset: 1, paymentDay: 31 }),
    ).toBe("2026-11-30");
    expect(
      closingDueDate("2026-10-20", { closingDay: 20, paymentMonthOffset: 1, paymentDay: 10 }),
    ).toBe("2026-11-10");
  });

  it("期間・締め日・取引日の確認", () => {
    const base = {
      closingDay: 31,
      periodFrom: "2026-10-01",
      periodTo: "2026-10-31",
      today: "2026-11-02",
      shippedOn: ["2026-10-01", "2026-10-31"],
      returnedOn: ["2026-09-15", "2026-10-31"],
    };
    expect(validateClosing(base).ok).toBe(true);
    expect(validateClosing({ ...base, periodFrom: "2026-10-02" }).ok).toBe(false);
    expect(unwrapErr(validateClosing({ ...base, today: "2026-10-30" })).code).toBe("invalid_state");
    expect(validateClosing({ ...base, shippedOn: ["2026-11-01"] }).ok).toBe(false);
    expect(validateClosing({ ...base, shippedOn: ["2026-09-30"] }).ok).toBe(false);
    expect(validateClosing({ ...base, returnedOn: ["2026-11-01"] }).ok).toBe(false);
  });
});

describe("請求書の状態と消込", () => {
  it("消込で一部入金・入金済みになり、取消で戻る", () => {
    const inv = { status: "unpaid" as InvoiceStatus, total: 1000, allocated: 0 };
    expect(unwrap(applyAllocation(inv, 400))).toEqual({ allocated: 400, status: "partial" });
    expect(unwrap(applyAllocation({ ...inv, status: "partial", allocated: 400 }, 600))).toEqual({
      allocated: 1000,
      status: "paid",
    });
    expect(applyAllocation(inv, 1001).ok).toBe(false);
    expect(applyAllocation(inv, 0).ok).toBe(false);
    expect(applyAllocation({ ...inv, status: "paid", allocated: 1000 }, 1).ok).toBe(false);
    expect(applyAllocation({ ...inv, status: "cancelled" }, 1).ok).toBe(false);

    const paid = { status: "paid" as InvoiceStatus, total: 1000, allocated: 1000 };
    expect(unwrap(releaseAllocation(paid, 300))).toEqual({ allocated: 700, status: "partial" });
    expect(unwrap(releaseAllocation(paid, 1000))).toEqual({ allocated: 0, status: "unpaid" });
    expect(releaseAllocation(paid, 1001).ok).toBe(false);
    expect(releaseAllocation({ ...paid, status: "cancelled" }, 1).ok).toBe(false);
  });

  it("消込してから取り消すと元の残高と状態に戻る（性質）", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000_000 }),
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 1, max: 100 }),
        (total, startPct, deltaPct) => {
          const allocated = Math.floor((total * startPct) / 100);
          const status: InvoiceStatus =
            allocated === 0 ? "unpaid" : allocated >= total ? "paid" : "partial";
          const delta = Math.max(1, Math.floor(((total - allocated) * deltaPct) / 100));
          const applied = applyAllocation({ status, total, allocated }, delta);
          expect(applied.ok).toBe(allocated + delta <= total && status !== "paid");
          if (!applied.ok) return;
          const a = unwrap(applied);
          expect(a.allocated).toBeLessThanOrEqual(total);
          expect(invoiceOutstanding({ total, allocated: a.allocated })).toBeGreaterThanOrEqual(0);
          const back = unwrap(releaseAllocation({ total, ...a }, delta));
          expect(back).toEqual({ allocated, status });
        },
      ),
      { seed: SEED },
    );
  });

  it("未入金・一部入金だけを消し込める。期限超過は消し込める請求書で支払期限が今日より前", () => {
    expect(isOpenInvoice("unpaid")).toBe(true);
    expect(isOpenInvoice("partial")).toBe(true);
    expect(isOpenInvoice("paid")).toBe(false);
    expect(isOverdue({ status: "unpaid", dueOn: "2026-11-01" }, "2026-11-02")).toBe(true);
    expect(isOverdue({ status: "unpaid", dueOn: "2026-11-02" }, "2026-11-02")).toBe(false);
    expect(isOverdue({ status: "paid", dueOn: "2026-11-01" }, "2026-11-02")).toBe(false);
    expect(isOverdue({ status: "partial", dueOn: null }, "2026-11-02")).toBe(false);
  });

  it("消込の計画：空の行を除き、差額の区分・重複・請求残高・入金額を確かめる", () => {
    const outstanding = new Map([
      ["a", 1000],
      ["b", 500],
    ]);
    const plan = unwrap(
      planAllocations(
        1500,
        0,
        [
          { invoiceId: "a", amount: 560, adjustment: 440, adjustmentKind: "bank_fee" },
          { invoiceId: "b", amount: 0, adjustment: 0, adjustmentKind: "other" },
          { invoiceId: "b", amount: 500, adjustment: 0, adjustmentKind: "discount" },
        ],
        outstanding,
      ),
    );
    expect(plan.remaining).toBe(440);
    expect(plan.allocations.map((a) => [a.invoiceId, a.index, a.adjustmentKind])).toEqual([
      ["a", 0, "bank_fee"],
      ["b", 2, null],
    ]);
    expect(
      firstField(
        planAllocations(
          1000,
          0,
          [{ invoiceId: "a", amount: 900, adjustment: 100, adjustmentKind: null }],
          outstanding,
        ),
      ),
    ).toBe("allocations.0.adjustmentKind");
    expect(
      firstField(
        planAllocations(
          1000,
          0,
          [
            { invoiceId: "a", amount: 1, adjustment: 0, adjustmentKind: null },
            { invoiceId: "a", amount: 1, adjustment: 0, adjustmentKind: null },
          ],
          outstanding,
        ),
      ),
    ).toBe("allocations.1.invoiceId");
    expect(
      firstField(
        planAllocations(
          5000,
          0,
          [{ invoiceId: "a", amount: 1001, adjustment: 0, adjustmentKind: null }],
          outstanding,
        ),
      ),
    ).toBe("allocations.0.amount");
    expect(
      firstField(
        planAllocations(
          5000,
          0,
          [{ invoiceId: "x", amount: 1, adjustment: 0, adjustmentKind: null }],
          outstanding,
        ),
      ),
    ).toBe("allocations.0.invoiceId");
    expect(
      firstField(
        planAllocations(
          5000,
          0,
          [{ invoiceId: "a", amount: -1, adjustment: 0, adjustmentKind: null }],
          outstanding,
        ),
      ),
    ).toBe("allocations.0.amount");
    expect(
      firstField(
        planAllocations(
          5000,
          0,
          [{ invoiceId: "a", amount: 1, adjustment: 1.5, adjustmentKind: "other" }],
          outstanding,
        ),
      ),
    ).toBe("allocations.0.adjustment");
    // 入金額を超えて充てられない（すでに消し込んだ分を引く）
    expect(
      unwrapErr(
        planAllocations(
          1000,
          600,
          [{ invoiceId: "a", amount: 500, adjustment: 0, adjustmentKind: null }],
          outstanding,
        ),
      ).message,
    ).toContain("入金額を超えて");
    expect(unwrap(planAllocations(1000, 0, [], outstanding)).remaining).toBe(1000);
  });

  it("消込の計画は入金額も請求残高も超えない（性質）", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.array(
          fc.record({
            outstanding: fc.integer({ min: 0, max: 500_000 }),
            amount: fc.integer({ min: 0, max: 500_000 }),
            adjustment: fc.integer({ min: 0, max: 2_000 }),
          }),
          { maxLength: 6 },
        ),
        (payment, already, rows) => {
          const outstanding = new Map(rows.map((r, i) => [`i${i}`, r.outstanding]));
          const r = planAllocations(
            payment,
            already,
            rows.map((x, i) => ({
              invoiceId: `i${i}`,
              amount: x.amount,
              adjustment: x.adjustment,
              adjustmentKind: "bank_fee" as const,
            })),
            outstanding,
          );
          if (!r.ok) return;
          const used = r.value.allocations.reduce((s, a) => s + a.amount, 0);
          expect(r.value.remaining).toBe(payment - already - used);
          expect(r.value.remaining).toBeGreaterThanOrEqual(0);
          for (const a of r.value.allocations) {
            expect(a.amount + a.adjustment).toBeLessThanOrEqual(outstanding.get(a.invoiceId) ?? 0);
            expect(a.amount + a.adjustment).toBeGreaterThan(0);
          }
        },
      ),
      { seed: SEED },
    );
  });

  it("入金の未消込残高と取消、売掛残高", () => {
    expect(paymentUnallocated(10_000, [3000, 2000])).toBe(5000);
    expect(cancelPayment({ cancelled: false }).ok).toBe(true);
    expect(cancelPayment({ cancelled: true }).ok).toBe(false);
    expect(
      receivable({
        openTotal: 30_000,
        openAllocated: 5000,
        overdueTotal: 10_000,
        overdueAllocated: 2000,
        paymentTotal: 9000,
        paymentAllocated: 5000,
      }),
    ).toEqual({ billed: 25_000, overdue: 8000, unallocated: 4000, balance: 21_000 });
  });
});

describe("返品伝票と返還請求書", () => {
  const returnable = new Map([
    ["l1", { shipped: 10, returned: 3 }],
    ["l2", { shipped: 2, returned: 0 }],
  ]);

  it("返品数は発送した数 − 返品済みの数まで。在庫に戻すなら保管場所が必要", () => {
    expect(canRecordReturn("shipped").ok).toBe(true);
    expect(canRecordReturn("received").ok).toBe(false);
    expect(returnableQuantity({ shipped: 10, returned: 3 })).toBe(7);
    expect(returnableQuantity({ shipped: 1, returned: 3 })).toBe(0);
    const ok = unwrap(
      validateReturnLines(
        [
          { salesOrderLineId: "l1", quantity: 7, restock: true, locationId: "loc" },
          { salesOrderLineId: "l2", quantity: 0, restock: true, locationId: null },
          { salesOrderLineId: "l2", quantity: 1, restock: false, locationId: "loc" },
        ],
        returnable,
      ),
    );
    expect(ok.map((l) => [l.salesOrderLineId, l.index, l.locationId])).toEqual([
      ["l1", 0, "loc"],
      ["l2", 2, null],
    ]);
    expect(
      firstField(
        validateReturnLines(
          [{ salesOrderLineId: "l1", quantity: 8, restock: false, locationId: null }],
          returnable,
        ),
      ),
    ).toBe("lines.0.quantity");
    expect(
      firstField(
        validateReturnLines(
          [{ salesOrderLineId: "l1", quantity: 1, restock: true, locationId: null }],
          returnable,
        ),
      ),
    ).toBe("lines.0.locationId");
    expect(
      firstField(
        validateReturnLines(
          [{ salesOrderLineId: "zz", quantity: 1, restock: false, locationId: null }],
          returnable,
        ),
      ),
    ).toBe("lines.0.salesOrderLineId");
    expect(
      firstField(
        validateReturnLines(
          [{ salesOrderLineId: "l1", quantity: -1, restock: false, locationId: null }],
          returnable,
        ),
      ),
    ).toBe("lines.0.quantity");
    expect(
      unwrapErr(
        validateReturnLines(
          [{ salesOrderLineId: "l1", quantity: 0, restock: false, locationId: null }],
          returnable,
        ),
      ).message,
    ).toBe("返品する数量を入力してください");
  });

  it("何回返品しても、返品数の合計は発送した数を超えない（性質）", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }),
        fc.array(fc.integer({ min: 0, max: 30 }), { maxLength: 8 }),
        (shipped, attempts) => {
          let done = 0;
          for (const q of attempts) {
            const r = validateReturnLines(
              [{ salesOrderLineId: "l", quantity: q, restock: false, locationId: null }],
              new Map([["l", { shipped, returned: done }]]),
            );
            if (r.ok) done += q;
            expect(done).toBeLessThanOrEqual(shipped);
          }
        },
      ),
      { seed: SEED },
    );
  });

  it("返品伝票の取消と、返還請求書の発行の条件", () => {
    const base = { cancelled: false, invoiceId: null, creditNoteNumber: null };
    expect(cancelSalesReturn(base).ok).toBe(true);
    expect(cancelSalesReturn({ ...base, cancelled: true }).ok).toBe(false);
    expect(unwrapErr(cancelSalesReturn({ ...base, invoiceId: "inv" })).message).toContain(
      "先に請求書を",
    );
    expect(cancelSalesReturn({ ...base, creditNoteNumber: "CN-1" }).ok).toBe(false);

    const ret = {
      cancelled: false,
      invoiceStatus: "unpaid" as InvoiceStatus,
      creditNoteNumber: null,
    };
    expect(creditNoteIssuable(ret).ok).toBe(true);
    expect(creditNoteIssuable({ ...ret, invoiceStatus: null }).ok).toBe(false);
    expect(creditNoteIssuable({ ...ret, invoiceStatus: "cancelled" }).ok).toBe(false);
    expect(creditNoteIssuable({ ...ret, creditNoteNumber: "CN-1" }).ok).toBe(false);
    expect(creditNoteIssuable({ ...ret, cancelled: true }).ok).toBe(false);
    expect(creditNoteObligation(9999)).toBe("optional");
    expect(creditNoteObligation(10_000)).toBe("required");
  });
});

describe("販売先廃棄", () => {
  it("明細は1行以上、数量は1以上、同じ商品・理由は1行", () => {
    expect(validateDisposalLines([{ itemId: "a", quantity: 1, reason: null }]).ok).toBe(true);
    expect(
      validateDisposalLines([
        { itemId: "a", quantity: 1, reason: "expired" },
        { itemId: "a", quantity: 2, reason: "damaged" },
      ]).ok,
    ).toBe(true);
    expect(validateDisposalLines([]).ok).toBe(false);
    const dup = unwrapErr(
      validateDisposalLines([
        { itemId: "a", quantity: 1, reason: "expired" },
        { itemId: "a", quantity: 0, reason: "expired" },
      ]),
    );
    expect(dup.fields?.map((f) => f.field)).toEqual(["lines.1.quantity", "lines.1.itemId"]);
  });

  it("廃棄率は廃棄数 ÷ 出荷数（出荷がなければ表示しない）。キーごとに合計する", () => {
    expect(disposalRateBps(1, 8)).toBe(1250);
    expect(disposalRateBps(0, 8)).toBe(0);
    expect(disposalRateBps(1, 3)).toBe(3333);
    expect(disposalRateBps(3, 0)).toBeNull();
    const rows = [
      { customer: "A", item: "x", disposed: 1, shipped: 10 },
      { customer: "A", item: "y", disposed: 1, shipped: 10 },
      { customer: "B", item: "x", disposed: 0, shipped: 5 },
    ];
    expect(
      summarizeDisposalRates(rows, (r) => r.customer).map((g) => [
        g.row.customer,
        g.disposed,
        g.shipped,
        g.rateBps,
      ]),
    ).toEqual([
      ["A", 2, 20, 1000],
      ["B", 0, 5, 0],
    ]);
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 1, max: 10_000 }),
        (d, s) => {
          const rate = disposalRateBps(d, s) ?? -1;
          expect(rate).toBeGreaterThanOrEqual(0);
          // 出荷が1万以下なら、1つでも廃棄があれば 0% にはならない（0.005% 以上は四捨五入で 0.01%）
          expect(rate === 0).toBe(d === 0);
        },
      ),
      { seed: SEED },
    );
  });
});
