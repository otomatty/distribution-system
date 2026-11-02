/** 仕入返品の返品日：返品する商品を受け入れた入荷の入荷日より前にはできない（業務エラー、返品日の欄に出す） */
import { describe, expect, it } from "vitest";

import { createItem, createLocation, createSupplier } from "./fixtures";
import { as, createEmployee, newKey, systemCommand } from "./helpers";
import { systemCommandResult } from "./platform-helpers";
import { createConfirmedOrder, orderView, receive } from "./purchasing-fixtures";

async function setup() {
  const supplierId = await createSupplier();
  const locationId = await createLocation();
  const a = await createItem(supplierId);
  const b = await createItem(supplierId);
  const po = await createConfirmedOrder({
    supplierId,
    locationId,
    orderedOn: "2026-10-01",
    lines: [
      { itemId: a.id, quantity: 2 },
      { itemId: b.id, quantity: 2 },
    ],
  });
  // 商品 a は 10/10、商品 b は 10/15 に受け入れた
  await receive(po.id, [2, 0], { receivedOn: "2026-10-10" });
  await receive(po.id, [0, 2], { receivedOn: "2026-10-15" });
  const lines = (await orderView(po.id)).order.lines;
  return { po, locationId, lineA: lines[0]?.id ?? "", lineB: lines[1]?.id ?? "" };
}

describe("仕入返品の返品日", () => {
  it("返品する商品の入荷日より前の返品日は、返品日の欄のエラーで受け付けない", async () => {
    const { po, locationId, lineA, lineB } = await setup();
    const base = { purchaseOrderId: po.id, locationId };
    expect(
      await systemCommandResult("purchaseReturns.create", {
        ...base,
        returnedOn: "2026-10-09",
        lines: [{ lineId: lineA, units: 1 }],
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "validation",
        fields: [
          {
            field: "returnedOn",
            message: "返品日は、返品する商品の入荷日（2026-10-10）以降にしてください",
          },
        ],
      },
    });
    // 商品 a だけなら 10/12 に返品できるが、10/15 に受け入れた商品 b も返すなら 10/15 以降
    const both = await systemCommandResult("purchaseReturns.create", {
      ...base,
      returnedOn: "2026-10-12",
      lines: [
        { lineId: lineA, units: 1 },
        { lineId: lineB, units: 1 },
      ],
    });
    expect(both).toMatchObject({
      ok: false,
      error: { message: "返品日は、返品する商品の入荷日（2026-10-15）以降にしてください" },
    });
    // 返品しない（数が 0 の）明細の入荷日は見ない
    const onlyA = await systemCommand("purchaseReturns.create", {
      ...base,
      returnedOn: "2026-10-12",
      lines: [
        { lineId: lineA, units: 1 },
        { lineId: lineB, units: 0 },
      ],
    });
    expect(onlyA.number).toMatch(/^PR-\d{4}-\d{6}$/);
    await systemCommand("purchaseReturns.create", {
      ...base,
      returnedOn: "2026-10-15",
      lines: [{ lineId: lineB, units: 1 }],
    });
  });

  it("画面：返品日の欄にエラーを出す", async () => {
    const { po, locationId, lineA, lineB } = await setup();
    const buyer = await createEmployee(["purchasing"]);
    const res = await as(buyer).hx(`/purchase-orders/${po.id}/returns/new`, {
      _key: newKey(),
      returnedOn: "2026-10-01",
      locationId,
      memo: "",
      lineId: [lineA, lineB],
      units: ["1", "0"],
    });
    const html = await res.text();
    expect(html).toContain("返品日は、返品する商品の入荷日（2026-10-10）以降にしてください");
    expect(html).toContain('id="e-returnedOn"');
  });
});
