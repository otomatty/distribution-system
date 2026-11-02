/**
 * 納品書の発行日（要件定義書 3.10「発行日は発行の操作で決める（初期値は当日、月締めなら締め日）」）。
 * 発送の操作で決め、納品書の内容（スナップショット）に残す。取引年月日（帳票の索引）は発送日のまま。
 */
import { describe, expect, it } from "vitest";

import { addDays, monthOf, monthRange } from "../../src/domain/dates";
import { deliveryNoteSnapshotSchema } from "../../src/usecases/sales/snapshots";
import { createClosingCustomer, lastMonth } from "./billing-fixtures";
import { as, createEmployee, newKey, systemCommand, systemQuery } from "./helpers";
import { documentRow, systemCommandResult } from "./platform-helpers";
import { createCustomer, createOrder, getOrder, salesSetup, today } from "./sales-fixtures";

async function orderFor(setup: Awaited<ReturnType<typeof salesSetup>>, customerId: string) {
  return createOrder({
    customerId,
    locationId: setup.locationId,
    lines: [{ itemId: setup.a.id, quantity: 1, unitPriceCenti: 15_050 }],
  });
}

/** 受注の最新の発送の納品書（索引の行とスナップショット） */
async function deliveryNoteOf(orderId: string) {
  const view = await getOrder(orderId);
  const note = view.shipments[0]?.deliveryNote;
  const doc = await documentRow(note?.documentId ?? "");
  return {
    doc,
    snapshot: deliveryNoteSnapshotSchema.parse(JSON.parse(doc?.snapshotJson ?? "null")),
  };
}

describe("納品書の発行日", () => {
  it("締め日のない販売先は当日が初期値で、受注詳細の発送で変えられる（発送日より前はエラー）", async () => {
    const user = await createEmployee(["sales"]);
    const setup = await salesSetup({ a: 20 });
    const order = await orderFor(setup, setup.customer.id);
    const page = await (await as(user).get(`/sales-orders/${order.id}`)).text();
    expect(page).toContain("納品書の発行日");
    expect(page).toContain(`name="deliveryNoteIssuedOn" type="date" value="${today()}"`);
    // 発送日を変えると、初期値を計算し直す（締め日のない販売先は当日のまま）
    const partial = await (
      await as(user).hx(`/sales-orders/${order.id}/ship/delivery-note-date`, {
        shippedOn: addDays(today(), -3),
        deliveryNoteIssuedOn: today(),
      })
    ).text();
    expect(partial).toContain(`value="${today()}"`);

    const version = String((await getOrder(order.id)).order.version);
    const shippedOn = addDays(today(), -3);
    const early = await as(user).hx(`/sales-orders/${order.id}/ship`, {
      _key: newKey(),
      version,
      shippedOn,
      deliveryNoteIssuedOn: addDays(shippedOn, -1),
    });
    expect(await early.text()).toContain(
      `納品書の発行日：納品書の発行日は発送日（${shippedOn}）以降にしてください`,
    );
    expect((await getOrder(order.id)).order.status).toBe("received");
    const res = await as(user).hx(`/sales-orders/${order.id}/ship`, {
      _key: newKey(),
      version,
      shippedOn,
      deliveryNoteIssuedOn: addDays(shippedOn, 1),
    });
    expect(await res.text()).toContain("発送しました");
    const { doc, snapshot } = await deliveryNoteOf(order.id);
    expect(snapshot).toMatchObject({ version: 2, shippedOn, issuedOn: addDays(shippedOn, 1) });
    // 帳票の索引の取引年月日は発送日
    expect(doc?.transactionDate).toBe(shippedOn);
  });

  it("月締めの販売先は、発送日を含む締め期間の締め日が初期値。指定がなければ初期値にする", async () => {
    const user = await createEmployee(["sales"]);
    const setup = await salesSetup({ a: 20 });
    const customer = await createClosingCustomer();
    const order = await orderFor(setup, customer.id);
    const monthEnd = monthRange(monthOf(today())).to;
    const page = await (await as(user).get(`/sales-orders/${order.id}`)).text();
    expect(page).toContain(`name="deliveryNoteIssuedOn" type="date" value="${monthEnd}"`);
    const period = lastMonth();
    const partial = await (
      await as(user).hx(`/sales-orders/${order.id}/ship/delivery-note-date`, {
        shippedOn: period.from,
      })
    ).text();
    expect(partial).toContain(`value="${period.to}"`);
    expect(
      await systemQuery("shipments.deliveryNoteDate", {
        salesOrderId: "missing",
        shippedOn: today(),
      }),
    ).toBeNull();

    // 発行日を空で送ると初期値（締め日）
    await systemCommand("shipments.ship", {
      id: order.id,
      version: (await getOrder(order.id)).order.version,
      shippedOn: period.from,
      deliveryNoteIssuedOn: "",
    });
    const { snapshot } = await deliveryNoteOf(order.id);
    expect(snapshot.issuedOn).toBe(period.to);

    // 締め日より後は指定できない
    const next = await orderFor(setup, customer.id);
    const late = await systemCommandResult("shipments.ship", {
      id: next.id,
      version: (await getOrder(next.id)).order.version,
      shippedOn: today(),
      deliveryNoteIssuedOn: addDays(monthEnd, 1),
    });
    expect(late).toMatchObject({
      ok: false,
      error: { fields: [{ field: "deliveryNoteIssuedOn" }] },
    });
  });

  it("一括発送は、販売先ごとの初期値（当日・締め日）を発行日にする", async () => {
    const setup = await salesSetup({ a: 20 });
    const closing = await createClosingCustomer();
    const plain = await createCustomer();
    const a = await orderFor(setup, closing.id);
    const b = await orderFor(setup, plain.id);
    const r = await systemCommand("shipments.bulkShip", {
      orders: [
        { id: a.id, version: (await getOrder(a.id)).order.version },
        { id: b.id, version: (await getOrder(b.id)).order.version },
      ],
      shippedOn: today(),
    });
    expect(r.shipped).toHaveLength(2);
    expect((await deliveryNoteOf(a.id)).snapshot.issuedOn).toBe(monthRange(monthOf(today())).to);
    expect((await deliveryNoteOf(b.id)).snapshot.issuedOn).toBe(today());
  });
});
