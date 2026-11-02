import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { unwrap, unwrapErr } from "../../tests/support/result";
import {
  canOrderFromSalesOrder,
  checkMakerDirectLink,
  groupBySupplier,
  isActiveLinkedOrder,
  purchaseQuantityFor,
  type MakerDirectLinkCheck,
} from "./maker-direct";

describe("purchaseQuantityFor", () => {
  it("販売単位の数量を入数で割り、端数は切り上げる", () => {
    expect(purchaseQuantityFor(24, 12)).toEqual({ quantity: 2, surplusUnits: 0 });
    expect(purchaseQuantityFor(25, 12)).toEqual({ quantity: 3, surplusUnits: 11 });
    expect(purchaseQuantityFor(5, 1)).toEqual({ quantity: 5, surplusUnits: 0 });
    expect(purchaseQuantityFor(1, 24)).toEqual({ quantity: 1, surplusUnits: 23 });
  });

  it("受注の数を下回らない最小の仕入単位の数になる", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 9_999_999 }),
        fc.integer({ min: 1, max: 99_999 }),
        (sales, units) => {
          const { quantity, surplusUnits } = purchaseQuantityFor(sales, units);
          expect(quantity * units).toBeGreaterThanOrEqual(sales);
          expect((quantity - 1) * units).toBeLessThan(sales);
          expect(surplusUnits).toBe(quantity * units - sales);
          expect(surplusUnits).toBeLessThan(units);
        },
      ),
    );
  });

  it("0以下・小数は受け付けない", () => {
    expect(() => purchaseQuantityFor(0, 12)).toThrow(RangeError);
    expect(() => purchaseQuantityFor(1.5, 12)).toThrow(RangeError);
    expect(() => purchaseQuantityFor(3, 0)).toThrow(RangeError);
  });
});

describe("groupBySupplier", () => {
  it("仕入先ごとにまとめ、仕入先は最初に出てきた順、明細は元の順にする", () => {
    const lines = [
      { id: "1", supplierId: "s2" },
      { id: "2", supplierId: "s1" },
      { id: "3", supplierId: "s2" },
    ];
    expect(groupBySupplier(lines)).toEqual([
      { supplierId: "s2", lines: [lines[0], lines[2]] },
      { supplierId: "s1", lines: [lines[1]] },
    ]);
    expect(groupBySupplier([])).toEqual([]);
  });

  it("明細はどれか1つのまとまりにだけ入る", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom("a", "b", "c"), { maxLength: 30 }), (suppliers) => {
        const lines = suppliers.map((supplierId, i) => ({ i, supplierId }));
        const groups = groupBySupplier(lines);
        expect(groups.flatMap((g) => g.lines).toSorted((x, y) => x.i - y.i)).toEqual(lines);
        expect(new Set(groups.map((g) => g.supplierId)).size).toBe(groups.length);
        for (const g of groups)
          expect(g.lines.every((l) => l.supplierId === g.supplierId)).toBe(true);
      }),
    );
  });
});

describe("メーカー直の発注の検証", () => {
  const base: MakerDirectLinkCheck = {
    salesOrder: { makerDirect: true, status: "received", customerId: "c1" },
    supplierId: "s1",
    lineSupplierIds: ["s1", "s2"],
    destinationKind: "customer",
    destinationCustomerId: "c1",
    otherActiveOrders: [],
  };

  it("メーカー直で取り消していない受注の、明細にある仕入先・受注の販売先への発注なら作れる", () => {
    expect(unwrap(checkMakerDirectLink(base))).toBe(true);
    expect(
      unwrap(
        checkMakerDirectLink({ ...base, salesOrder: { ...base.salesOrder, status: "shipped" } }),
      ),
    ).toBe(true);
  });

  it("メーカー直でない・取り消した受注からは作れない", () => {
    expect(
      unwrapErr(
        checkMakerDirectLink({ ...base, salesOrder: { ...base.salesOrder, makerDirect: false } }),
      ).code,
    ).toBe("invalid_state");
    expect(
      unwrapErr(
        checkMakerDirectLink({ ...base, salesOrder: { ...base.salesOrder, status: "cancelled" } }),
      ).message,
    ).toContain("取り消した受注");
    expect(unwrap(canOrderFromSalesOrder({ makerDirect: true, status: "received" }))).toBe(true);
  });

  it("明細にない仕入先、受注の販売先でない納入先はエラー", () => {
    const supplier = unwrapErr(checkMakerDirectLink({ ...base, supplierId: "s9" }));
    expect(supplier.fields?.[0]?.field).toBe("supplierId");
    const location = unwrapErr(
      checkMakerDirectLink({ ...base, destinationKind: "location", destinationCustomerId: null }),
    );
    expect(location.fields?.[0]?.field).toBe("destinationCustomerId");
    expect(unwrapErr(checkMakerDirectLink({ ...base, destinationCustomerId: "c2" })).code).toBe(
      "validation",
    );
  });

  it("同じ受注・同じ仕入先の、取り消していない発注があれば作れない（二重に発注しない）", () => {
    const e = unwrapErr(checkMakerDirectLink({ ...base, otherActiveOrders: ["PO-2026-000001"] }));
    expect(e.code).toBe("duplicate");
    expect(e.message).toContain("PO-2026-000001");
    expect(isActiveLinkedOrder("cancelled")).toBe(false);
    expect(isActiveLinkedOrder("draft")).toBe(true);
    expect(isActiveLinkedOrder("paid")).toBe(true);
  });
});
