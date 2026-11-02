/**
 * 販売先廃棄（要件定義書 3.12）のユースケース。在庫・請求に影響しないこと、出荷した商品の候補、廃棄率の集計。
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { addDays } from "../../src/domain/dates";
import type { Result } from "../../src/domain/result";
import { businessDb } from "../../src/infra/do/client";
import type { CommandInput, CommandName } from "../../src/usecases/registry";
import { billingSetup, shipOrder } from "./billing-fixtures";
import { createEmployee, newKey, systemCommand, systemQuery } from "./helpers";
import { systemCommandResult } from "./platform-helpers";
import { createSalesItem, level, today } from "./sales-fixtures";

async function as<N extends CommandName>(
  email: string,
  name: N,
  input: CommandInput<N>,
  key: string | null = null,
): Promise<Result<unknown>> {
  return businessDb(env).command(name, input, { kind: "dev", email }, key);
}

describe("販売先廃棄", () => {
  it("1つの販売先・廃棄日に複数の商品を登録する。在庫と請求には影響しない", async () => {
    const setup = await billingSetup();
    await shipOrder(setup);
    const before = await level(setup.a.id, setup.locationId);
    const input = {
      customerId: setup.customer.id,
      disposedOn: today(),
      contactName: "店長",
      lines: [
        { itemId: setup.a.id, quantity: 2, reason: "expired" as const },
        { itemId: setup.a.id, quantity: 1, reason: "damaged" as const },
        { itemId: setup.b.id, quantity: 1 },
      ],
    };
    const accounting = await createEmployee(["accounting"]);
    expect(await as(accounting, "disposals.create", input)).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    const sales = await createEmployee(["sales"]);
    const key = newKey();
    const r = await as(sales, "disposals.create", input, key);
    expect(await as(sales, "disposals.create", input, key)).toEqual(r);
    const created = (r.ok ? r.value : null) as { id: string; number: string };
    expect(created.number).toMatch(/^DS-\d{4}-\d{6}$/);
    const view = await systemQuery("disposals.get", { id: created.id });
    expect(view).toMatchObject({ customerName: setup.customer.name, contactName: "店長" });
    expect(view?.lines.map((l) => [l.itemName, l.quantity, l.reason])).toEqual([
      [setup.a.name, 2, "expired"],
      [setup.a.name, 1, "damaged"],
      [setup.b.name, 1, null],
    ]);
    expect(await level(setup.a.id, setup.locationId)).toEqual(before);
    expect((await systemQuery("invoices.unbilled", { customerId: setup.customer.id })).total).toBe(
      1,
    );
    const list = await systemQuery("disposals.list", { customerId: setup.customer.id });
    expect(list.rows.map((d) => [d.number, d.lineCount, d.totalQuantity])).toEqual([
      [created.number, 3, 4],
    ]);
    expect(
      (
        await systemQuery("disposals.list", {
          customerId: setup.customer.id,
          from: addDays(today(), 1),
        })
      ).total,
    ).toBe(0);
    expect(await systemQuery("disposals.get", { id: "missing" })).toBeNull();
  });

  it("明細なし・数量0・同じ商品と理由の重複・今日より後・登録のない商品は登録しない", async () => {
    const setup = await billingSetup();
    const base = { customerId: setup.customer.id, disposedOn: today() };
    expect(await systemCommandResult("disposals.create", { ...base, lines: [] })).toMatchObject({
      ok: false,
      error: { code: "validation" },
    });
    expect(
      await systemCommandResult("disposals.create", {
        ...base,
        lines: [{ itemId: setup.a.id, quantity: 0 }],
      }),
    ).toMatchObject({ ok: false, error: { fields: [{ field: "lines.0.quantity" }] } });
    expect(
      await systemCommandResult("disposals.create", {
        ...base,
        lines: [
          { itemId: setup.a.id, quantity: 1, reason: "other" },
          { itemId: setup.a.id, quantity: 1, reason: "other" },
        ],
      }),
    ).toMatchObject({ ok: false, error: { fields: [{ field: "lines.1.itemId" }] } });
    expect(
      await systemCommandResult("disposals.create", {
        ...base,
        disposedOn: addDays(today(), 1),
        lines: [{ itemId: setup.a.id, quantity: 1 }],
      }),
    ).toMatchObject({ ok: false, error: { fields: [{ field: "disposedOn" }] } });
    expect(
      await systemCommandResult("disposals.create", {
        ...base,
        lines: [{ itemId: "missing", quantity: 1 }],
      }),
    ).toMatchObject({ ok: false, error: { fields: [{ field: "lines.0.itemId" }] } });
    expect(
      await systemCommandResult("disposals.create", {
        ...base,
        customerId: setup.supplierId,
        lines: [{ itemId: setup.a.id, quantity: 1 }],
      }),
    ).toMatchObject({ ok: false, error: { fields: [{ field: "customerId" }] } });
  });

  it("出荷したことのある商品を最後に出荷した日の新しい順に返し、廃棄率を期間・販売先・商品ごとに集計する", async () => {
    const setup = await billingSetup();
    const extra = await createSalesItem(setup.supplierId, { name: "テスト一度も出荷しない菓子" });
    await shipOrder(setup, {
      shippedOn: addDays(today(), -5),
      lines: [{ itemId: setup.a.id, quantity: 8, unitPriceCenti: 15_050 }],
    });
    await shipOrder(setup, {
      lines: [
        { itemId: setup.a.id, quantity: 2, unitPriceCenti: 15_050 },
        { itemId: setup.b.id, quantity: 6, unitPriceCenti: 10_000 },
      ],
    });
    const items = await systemQuery("disposals.shippedItems", { customerId: setup.customer.id });
    expect(items.map((i) => i.itemId).toSorted()).toEqual([setup.a.id, setup.b.id].toSorted());
    expect(items.every((i) => i.lastShippedOn === today())).toBe(true);
    expect(items.some((i) => i.itemId === extra.id)).toBe(false);

    await systemCommand("disposals.create", {
      customerId: setup.customer.id,
      disposedOn: today(),
      lines: [
        { itemId: setup.a.id, quantity: 1, reason: "expired" },
        { itemId: setup.a.id, quantity: 1, reason: "damaged" },
        { itemId: extra.id, quantity: 3 },
      ],
    });
    const range = { from: addDays(today(), -30), to: today(), customerId: setup.customer.id };
    const rates = await systemQuery("disposals.rates", range);
    // 商品コードの順（後から登録した商品はコードが大きい）
    expect(rates.rows.map((r) => [r.itemName, r.disposed, r.shipped, r.rateBps])).toEqual([
      [setup.a.name, 2, 10, 2000],
      [extra.name, 3, 0, null],
    ]);
    const all = await systemQuery("disposals.rates", { ...range, onlyDisposed: false });
    expect(all.total).toBe(3);
    const byCustomer = await systemQuery("disposals.rates", { ...range, groupBy: "customer" });
    expect(byCustomer.rows).toEqual([
      expect.objectContaining({ itemId: null, disposed: 5, shipped: 16, rateBps: 3125 }),
    ]);
    const byItem = await systemQuery("disposals.rates", {
      ...range,
      groupBy: "item",
      itemId: setup.a.id,
    });
    expect(byItem.rows).toEqual([
      expect.objectContaining({ customerId: null, itemId: setup.a.id, disposed: 2, shipped: 10 }),
    ]);
    // 期間の外の出荷は数えない
    const recent = await systemQuery("disposals.rates", { ...range, from: addDays(today(), -1) });
    expect(recent.rows.find((r) => r.itemId === setup.a.id)).toMatchObject({
      shipped: 2,
      rateBps: 10_000,
    });
  });
});
