import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { unwrapErr } from "../../tests/support/result";
import {
  allocationDelta,
  applyMovements,
  available,
  balanceKey,
  isBelowReorderPoint,
  netMovements,
  parseShortages,
  stockOperationMovements,
  type StockBalance,
  type StockMovement,
} from "./stock";

const zero: StockBalance = { onHand: 0, allocated: 0 };

describe("applyMovements", () => {
  it("増減を合算して適用する", () => {
    const r = applyMovements(
      [
        { itemId: "i1", locationId: "l1", quantity: 5 },
        { itemId: "i1", locationId: "l1", quantity: -2 },
      ],
      () => ({ onHand: 1, allocated: 0 }),
    );
    expect(r).toEqual({ ok: true, value: [{ itemId: "i1", locationId: "l1", onHand: 4 }] });
  });
  it("マイナスになるなら不足を返す", () => {
    const r = applyMovements([{ itemId: "i1", locationId: "l1", quantity: -3 }], () => ({
      onHand: 1,
      allocated: 0,
    }));
    const error = unwrapErr(r);
    expect(error.code).toBe("insufficient_stock");
    expect(parseShortages(error.details)).toEqual([{ itemId: "i1", locationId: "l1", shortBy: 2 }]);
  });
  it("整数以外は例外", () => {
    expect(() => netMovements([{ itemId: "i", locationId: "l", quantity: 0.5 }])).toThrow(
      RangeError,
    );
  });
  it("台帳の合計と集計が一致する（性質）", () => {
    const move = fc.record({
      itemId: fc.constantFrom("a", "b"),
      locationId: fc.constantFrom("x", "y"),
      quantity: fc.integer({ min: -5, max: 10 }),
    });
    fc.assert(
      fc.property(fc.array(fc.array(move, { maxLength: 5 }), { maxLength: 20 }), (batches) => {
        const balances = new Map<string, number>();
        const ledger: StockMovement[] = [];
        for (const batch of batches) {
          const r = applyMovements(batch, (i, l) => ({
            onHand: balances.get(balanceKey(i, l)) ?? 0,
            allocated: 0,
          }));
          if (!r.ok) continue; // 不足するバッチは記録されない
          for (const b of r.value) balances.set(balanceKey(b.itemId, b.locationId), b.onHand);
          ledger.push(...batch);
        }
        for (const m of netMovements(ledger)) {
          expect(balances.get(balanceKey(m.itemId, m.locationId))).toBe(m.quantity);
        }
        for (const v of balances.values()) expect(v).toBeGreaterThanOrEqual(0);
      }),
    );
  });
});

describe("allocation", () => {
  it("引当の差分（メーカー直は除く）", () => {
    expect(
      allocationDelta(
        [
          { itemId: "a", locationId: "x", quantity: 5 },
          { itemId: "b", locationId: null, quantity: 1 },
        ],
        [
          { itemId: "a", locationId: "x", quantity: 3 },
          { itemId: "c", locationId: "x", quantity: 2 },
        ],
      ),
    ).toEqual([
      { itemId: "a", locationId: "x", quantity: -2 },
      { itemId: "c", locationId: "x", quantity: 2 },
    ]);
  });
  it("出荷可能数と発注点", () => {
    expect(available({ onHand: 10, allocated: 4 })).toBe(6);
    expect(available(zero)).toBe(0);
    expect(isBelowReorderPoint(3, 1, 5)).toBe(true);
    expect(isBelowReorderPoint(3, 2, 5)).toBe(false);
  });
});

describe("stockOperationMovements", () => {
  it("移動は2行", () => {
    const r = stockOperationMovements({
      kind: "transfer",
      fromLocationId: "x",
      toLocationId: "y",
      lines: [{ itemId: "a", quantity: 2 }],
    });
    expect(r).toEqual({
      ok: true,
      value: [
        { itemId: "a", locationId: "x", quantity: -2, reason: "transfer_out" },
        { itemId: "a", locationId: "y", quantity: 2, reason: "transfer_in" },
      ],
    });
  });
  it("同じ場所への移動・0以下はエラー", () => {
    expect(
      stockOperationMovements({
        kind: "transfer",
        fromLocationId: "x",
        toLocationId: "x",
        lines: [{ itemId: "a", quantity: 1 }],
      }).ok,
    ).toBe(false);
    expect(
      stockOperationMovements({
        kind: "transfer",
        fromLocationId: "x",
        toLocationId: "y",
        lines: [{ itemId: "a", quantity: 0 }],
      }).ok,
    ).toBe(false);
  });
  it("調整・払い出し・棚卸", () => {
    expect(
      stockOperationMovements({
        kind: "adjustment",
        locationId: "x",
        reason: "sample",
        lines: [{ itemId: "a", quantity: -1 }],
      }),
    ).toEqual({
      ok: true,
      value: [{ itemId: "a", locationId: "x", quantity: -1, reason: "sample" }],
    });
    expect(
      stockOperationMovements({
        kind: "adjustment",
        locationId: "x",
        reason: "initial",
        lines: [{ itemId: "a", quantity: 0 }],
      }).ok,
    ).toBe(false);
    expect(
      stockOperationMovements({
        kind: "store_transfer",
        locationId: "x",
        lines: [{ itemId: "a", quantity: 3 }],
      }),
    ).toEqual({
      ok: true,
      value: [{ itemId: "a", locationId: "x", quantity: -3, reason: "store_transfer" }],
    });
    expect(
      stockOperationMovements({
        kind: "store_transfer",
        locationId: "x",
        lines: [{ itemId: "a", quantity: -3 }],
      }).ok,
    ).toBe(false);
    expect(
      stockOperationMovements({
        kind: "stocktake",
        locationId: "x",
        lines: [
          { itemId: "a", quantity: 7 },
          { itemId: "b", quantity: 2 },
        ],
        currentOnHand: (id) => (id === "a" ? 10 : 2),
      }),
    ).toEqual({
      ok: true,
      value: [{ itemId: "a", locationId: "x", quantity: -3, reason: "stocktake" }],
    });
    expect(
      stockOperationMovements({
        kind: "stocktake",
        locationId: "x",
        lines: [{ itemId: "a", quantity: -1 }],
        currentOnHand: () => 0,
      }).ok,
    ).toBe(false);
  });
  it("明細なし・重複・小数はエラー", () => {
    expect(stockOperationMovements({ kind: "store_transfer", locationId: "x", lines: [] }).ok).toBe(
      false,
    );
    expect(
      stockOperationMovements({
        kind: "store_transfer",
        locationId: "x",
        lines: [
          { itemId: "a", quantity: 1 },
          { itemId: "a", quantity: 1 },
        ],
      }).ok,
    ).toBe(false);
    expect(
      stockOperationMovements({
        kind: "store_transfer",
        locationId: "x",
        lines: [{ itemId: "a", quantity: 1.5 }],
      }).ok,
    ).toBe(false);
  });
});
