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

/** 受注（発送日は受注日より前にできないので、過去の日に発送する受注は受注日もその日以前にする） */
async function orderFor(
  setup: Awaited<ReturnType<typeof salesSetup>>,
  customerId: string,
  orderedOn = today(),
) {
  return createOrder({
    customerId,
    locationId: setup.locationId,
    orderedOn,
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
    const order = await orderFor(setup, setup.customer.id, addDays(today(), -3));
    const page = await (await as(user).get(`/sales-orders/${order.id}`)).text();
    expect(page).toContain("納品書の発行日");
    // 入力欄は空（空なら初期値）。初期値は案内に出す
    expect(page).toContain(`name="deliveryNoteIssuedOn" type="date" value=""`);
    expect(page).toContain(`空なら初期値（${today()}）にします`);
    // 発送日を変えると、初期値を計算し直す（締め日のない販売先は当日のまま）。入力中の値は残す
    const partial = await (
      await as(user).hx(`/sales-orders/${order.id}/ship/delivery-note-date`, {
        shippedOn: addDays(today(), -3),
        deliveryNoteIssuedOn: addDays(today(), -1),
      })
    ).text();
    expect(partial).toContain(`空なら初期値（${today()}）にします`);
    expect(partial).toContain(`value="${addDays(today(), -1)}"`);
    const broken = await (
      await as(user).hx(`/sales-orders/${order.id}/ship/delivery-note-date`, { shippedOn: "x" })
    ).text();
    expect(broken).toContain("空なら初期値にします");

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
    const period = lastMonth();
    const order = await orderFor(setup, customer.id, period.from);
    const monthEnd = monthRange(monthOf(today())).to;
    const page = await (await as(user).get(`/sales-orders/${order.id}`)).text();
    expect(page).toContain(`空なら初期値（${monthEnd}）にします`);
    const partial = await (
      await as(user).hx(`/sales-orders/${order.id}/ship/delivery-note-date`, {
        shippedOn: period.from,
      })
    ).text();
    expect(partial).toContain(`空なら初期値（${period.to}）にします`);
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
