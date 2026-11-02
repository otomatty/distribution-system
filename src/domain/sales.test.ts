import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  availableForOrder,
  cancelInvoice,
  cancelSalesOrder,
  cancelShipment,
  canEditSalesOrder,
  chargeAmount,
  creditNoteRequired,
  defaultDeliveryNoteDate,
  deliveryNoteIssueDate,
  invoiceStatus,
  isPriceOverridden,
  isShipmentOverdue,
  lotWarnings,
  orderAmounts,
  planBulkShipment,
  priceReasonRequired,
  salesLineWarnings,
  shippingMatrix,
  shipSalesOrder,
  validateAllocations,
  validateOrderLines,
  validateShippedOn,
  validateSplit,
} from "./sales";

describe("sales order", () => {
  it("納品書の発行日の初期値：当日、月締めの販売先は発送日を含む締め期間の締め日", () => {
    const base = { shippedOn: "2026-10-15", today: "2026-11-02" };
    expect(defaultDeliveryNoteDate({ ...base, closingDay: null })).toBe("2026-11-02");
    expect(defaultDeliveryNoteDate({ ...base, closingDay: 31 })).toBe("2026-10-31");
    expect(defaultDeliveryNoteDate({ ...base, closingDay: 20 })).toBe("2026-10-20");
    expect(defaultDeliveryNoteDate({ ...base, shippedOn: "2026-10-21", closingDay: 20 })).toBe(
      "2026-11-20",
    );
  });
  it("納品書の発行日の指定：発送日以降で、初期値と今日の遅いほうまで", () => {
    const plain = { shippedOn: "2026-10-30", today: "2026-11-02", closingDay: null };
    expect(deliveryNoteIssueDate({ ...plain, requested: null })).toEqual({
      ok: true,
      value: "2026-11-02",
    });
    expect(deliveryNoteIssueDate({ ...plain, requested: "2026-10-30" }).ok).toBe(true);
    const early = deliveryNoteIssueDate({ ...plain, requested: "2026-10-29" });
    expect(early.ok ? null : early.error.fields?.[0]).toEqual({
      field: "deliveryNoteIssuedOn",
      message: "納品書の発行日は発送日（2026-10-30）以降にしてください",
    });
    expect(deliveryNoteIssueDate({ ...plain, requested: "2026-11-03" })).toMatchObject({
      ok: false,
      error: { message: "納品書の発行日は今日より後にできません" },
    });
    // 月締め：締め日（今日より後）までは指定できる
    const closing = { shippedOn: "2026-11-02", today: "2026-11-02", closingDay: 31 };
    expect(deliveryNoteIssueDate({ ...closing, requested: null })).toEqual({
      ok: true,
      value: "2026-11-30",
    });
    expect(deliveryNoteIssueDate({ ...closing, requested: "2026-11-02" }).ok).toBe(true);
    expect(deliveryNoteIssueDate({ ...closing, requested: "2026-12-01" })).toMatchObject({
      ok: false,
      error: { message: "納品書の発行日は締め日（2026-11-30）より後にできません" },
    });
    // 締め日を過ぎた期間の発送（さかのぼって記録）は、今日まで指定できる
    const past = { shippedOn: "2026-10-10", today: "2026-11-02", closingDay: 31 };
    expect(deliveryNoteIssueDate({ ...past, requested: "2026-11-02" }).ok).toBe(true);
  });
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
    expect(cancelShipment("shipped", false, true).ok).toBe(false);
  });
  it("分割", () => {
    const lines = [
      { id: "a", quantity: 10 },
      { id: "b", quantity: 2 },
    ];
    expect(validateSplit(lines, new Map([["a", 4]]))).toEqual({
      ok: true,
      value: [
        { line: lines[0], keep: 6, move: 4 },
        { line: lines[1], keep: 2, move: 0 },
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

describe("受注の明細", () => {
  it("出荷可能数は自分の引当を足し戻して比べる", () => {
    expect(availableForOrder(-3, 5)).toBe(2);
    expect(salesLineWarnings({ quantity: 5, minLot: 1, availableForOrder: 2 })).toEqual([
      "出荷可能数（2）を超えています",
    ]);
    expect(salesLineWarnings({ quantity: 2, minLot: 1, availableForOrder: 2 })).toEqual([]);
    // 出荷可能数がマイナスでも、表示は0から
    expect(salesLineWarnings({ quantity: 1, minLot: 1, availableForOrder: -4 })).toEqual([
      "出荷可能数（0）を超えています",
    ]);
    // メーカー直・保管場所が未選択なら出荷可能数は比べない
    expect(salesLineWarnings({ quantity: 100, minLot: 1, availableForOrder: null })).toEqual([]);
    expect(salesLineWarnings({ quantity: 7, minLot: 6, availableForOrder: null })).toEqual([
      "最低ロット（6）の倍数ではありません",
    ]);
    expect(salesLineWarnings({ quantity: 5, minLot: 6, availableForOrder: 1 })).toHaveLength(3);
  });
  it("単価の修正には理由が必要（保存済みの単価のままなら不要）", () => {
    expect(isPriceOverridden(100, 100)).toBe(false);
    expect(isPriceOverridden(90, 100)).toBe(true);
    const base = { listPriceCenti: 10000, previousPriceCenti: null, reason: null };
    expect(priceReasonRequired({ ...base, unitPriceCenti: 10000 })).toBe(false);
    expect(priceReasonRequired({ ...base, unitPriceCenti: 9000 })).toBe(true);
    expect(priceReasonRequired({ ...base, unitPriceCenti: 9000, reason: "  " })).toBe(true);
    expect(priceReasonRequired({ ...base, unitPriceCenti: 9000, reason: "特売" })).toBe(false);
    expect(priceReasonRequired({ ...base, unitPriceCenti: 9000, previousPriceCenti: 9000 })).toBe(
      false,
    );
    expect(priceReasonRequired({ ...base, unitPriceCenti: 8000, previousPriceCenti: 9000 })).toBe(
      true,
    );
  });
  it("明細は1行以上で、同じ商品は1行", () => {
    expect(validateOrderLines([{ itemId: "a" }, { itemId: "b" }]).ok).toBe(true);
    expect(validateOrderLines([]).ok).toBe(false);
    expect(validateOrderLines([{ itemId: "a" }, { itemId: "a" }]).ok).toBe(false);
  });
});

describe("受注の金額", () => {
  it("明細ごとに丸め、税率ごとに1回だけ消費税を計算する", () => {
    const r = orderAmounts(
      [
        // 150.50円 × 3 = 451.5円 → 切り捨てで451円
        { unitPriceCenti: 15050, quantity: 3, taxCategory: "reduced" },
        { unitPriceCenti: 10001, quantity: 1, taxCategory: "reduced" },
        { unitPriceCenti: 99999, quantity: 1, taxCategory: "standard" },
      ],
      [{ unitAmount: 800, quantity: 1, taxCategory: "standard" }],
      { standard: 1000, reduced: 800 },
      "floor",
    );
    expect(r.lines.map((l) => l.amount)).toEqual([451, 100, 999]);
    expect(r.charges.map((c) => c.amount)).toEqual([800]);
    // 明細の項目はそのまま返す
    expect(r.lines[0]).toMatchObject({ unitPriceCenti: 15050, quantity: 3 });
    expect(r.summary.groups).toEqual([
      { category: "standard", rateBps: 1000, subtotal: 1799, tax: 179 },
      { category: "reduced", rateBps: 800, subtotal: 551, tax: 44 },
    ]);
    expect(r.summary.total).toBe(1799 + 179 + 551 + 44);
  });
  it("送料の金額は単価 × 数量", () => {
    expect(chargeAmount({ unitAmount: 500, quantity: 2, taxCategory: "standard" })).toBe(1000);
  });
  it("明細がなければ合計は0", () => {
    const r = orderAmounts([], [], { standard: 1000, reduced: 800 }, "round");
    expect(r.summary).toEqual({ groups: [], subtotal: 0, tax: 0, total: 0 });
  });
});

describe("一括発送の計画", () => {
  it("順に在庫から引き、足りない受注は外して後の受注に回す", () => {
    const plan = planBulkShipment(
      [
        { id: "o1", lines: [{ itemId: "a", quantity: 4 }] },
        {
          id: "o2",
          lines: [
            { itemId: "a", quantity: 3 },
            { itemId: "b", quantity: 1 },
          ],
        },
        { id: "o3", lines: [{ itemId: "a", quantity: 1 }] },
        { id: "o4", lines: [{ itemId: "c", quantity: 1 }] },
      ],
      new Map([
        ["a", 5],
        ["b", 1],
      ]),
    );
    expect(plan.shippable.map((o) => o.id)).toEqual(["o1", "o3"]);
    expect(
      plan.short.map((s) => ({
        orderId: s.order.id,
        shortages: s.shortages.map((x) => ({ itemId: x.line.itemId, shortBy: x.shortBy })),
      })),
    ).toEqual([
      { orderId: "o2", shortages: [{ itemId: "a", shortBy: 2 }] },
      { orderId: "o4", shortages: [{ itemId: "c", shortBy: 1 }] },
    ]);
  });
  it("同じ商品の行はまとめて判定する", () => {
    const plan = planBulkShipment(
      [
        {
          id: "o1",
          lines: [
            { itemId: "a", quantity: 2 },
            { itemId: "a", quantity: 2 },
          ],
        },
      ],
      new Map([["a", 3]]),
    );
    expect(plan.short).toHaveLength(1);
    expect(plan.short[0]?.shortages).toEqual([{ line: { itemId: "a", quantity: 2 }, shortBy: 1 }]);
  });
  it("発送する数は現在庫を超えず、外した受注はその時点で本当に足りない（性質）", () => {
    const items = ["a", "b", "c"];
    fc.assert(
      fc.property(
        fc.array(
          fc.array(
            fc.record({
              itemId: fc.constantFrom(...items),
              quantity: fc.integer({ min: 1, max: 6 }),
            }),
            { minLength: 1, maxLength: 3 },
          ),
          { maxLength: 8 },
        ),
        fc.tuple(
          fc.integer({ min: -2, max: 12 }),
          fc.integer({ min: -2, max: 12 }),
          fc.integer({ min: -2, max: 12 }),
        ),
        (orderLines, stock) => {
          const orders = orderLines.map((lines, i) => ({ id: `o${i}`, lines }));
          const onHand = new Map(items.map((id, i) => [id, stock[i] ?? 0]));
          const plan = planBulkShipment(orders, onHand);
          const shippableIds = plan.shippable.map((o) => o.id);
          // すべての受注がどちらか一方に入り、順番は渡した順
          const shortIds = plan.short.map((s) => s.order.id);
          expect([...shippableIds, ...shortIds].toSorted()).toEqual(
            orders.map((o) => o.id).toSorted(),
          );
          expect(shippableIds).toEqual(
            orders.map((o) => o.id).filter((id) => shippableIds.includes(id)),
          );
          // 順にたどって、発送する受注は足り、外す受注は足りないことを確かめる
          const left = new Map(onHand);
          for (const o of orders) {
            const need = new Map<string, number>();
            for (const l of o.lines) need.set(l.itemId, (need.get(l.itemId) ?? 0) + l.quantity);
            const fits = [...need].every(([id, q]) => q <= (left.get(id) ?? 0));
            expect(shippableIds.includes(o.id)).toBe(fits);
            if (fits) for (const [id, q] of need) left.set(id, (left.get(id) ?? 0) - q);
          }
          // 発送後の在庫は、もとがマイナスでなければマイナスにならない
          const negatives = items.filter(
            (id) => (onHand.get(id) ?? 0) >= 0 && (left.get(id) ?? 0) < 0,
          );
          expect(negatives).toEqual([]);
        },
      ),
    );
  });
});

describe("発送日と発送リストの遅れ", () => {
  it("発送日は受注日より前にできない（同じ日はできる）", () => {
    expect(validateShippedOn("2026-11-02", "2026-11-02").ok).toBe(true);
    expect(validateShippedOn("2026-11-03", "2026-11-02").ok).toBe(true);
    const r = validateShippedOn("2026-11-01", "2026-11-02");
    expect(r).toEqual({
      ok: false,
      error: {
        code: "validation",
        message: "発送日は受注日（2026-11-02）以降にしてください",
        fields: [{ field: "shippedOn", message: "発送日は受注日（2026-11-02）以降にしてください" }],
      },
    });
  });

  it("出荷予定日が表示する日より前の受注が遅れ（同じ日は遅れでない）", () => {
    expect(isShipmentOverdue("2026-10-30", "2026-11-02")).toBe(true);
    expect(isShipmentOverdue("2026-11-02", "2026-11-02")).toBe(false);
    expect(isShipmentOverdue("2026-11-03", "2026-11-02")).toBe(false);
  });
});

describe("発送リストの表", () => {
  it("行が商品、列が販売先で、合計を持つ", () => {
    const m = shippingMatrix(
      [
        {
          customerId: "c1",
          lines: [
            { itemId: "a", quantity: 2 },
            { itemId: "b", quantity: 1 },
          ],
        },
        { customerId: "c2", lines: [{ itemId: "a", quantity: 5 }] },
        // 同じ販売先の別の受注は足し合わせる
        { customerId: "c1", lines: [{ itemId: "a", quantity: 1 }] },
        // 列にない販売先・行にない商品は数えない
        { customerId: "zz", lines: [{ itemId: "a", quantity: 9 }] },
        { customerId: "c2", lines: [{ itemId: "zz", quantity: 9 }] },
      ],
      ["a", "b"],
      ["c1", "c2"],
    );
    expect(m.quantities).toEqual([
      [3, 5],
      [1, 0],
    ]);
    expect(m.rowTotals).toEqual([8, 1]);
    expect(m.columnTotals).toEqual([4, 5]);
    expect(m.grandTotal).toBe(9);
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
