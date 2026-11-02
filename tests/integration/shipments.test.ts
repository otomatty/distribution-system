/**
 * 発送・発送の取消・納品書（要件定義書 3.9・3.10、4章 受注の状態遷移）。
 * 在庫と引当の正しさ、帳票の発行と取消、請求書に載った発送の扱いを確かめる。
 */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import * as schema from "../../src/infra/db/schema";
import { deliveryNoteSnapshotSchema } from "../../src/usecases/sales/snapshots";
import { as, createEmployee, newKey, systemCommand, systemQuery } from "./helpers";
import {
  documentRow,
  pendingJobIds,
  readDb,
  runJobs,
  systemCommandResult,
} from "./platform-helpers";
import { createOrder, getOrder, level, salesSetup, today } from "./sales-fixtures";

async function orderWithStock(stock: { a?: number; b?: number } = {}) {
  const setup = await salesSetup(stock);
  const order = await createOrder({
    customerId: setup.customer.id,
    locationId: setup.locationId,
    customerContactName: "佐藤",
    lines: [
      { itemId: setup.a.id, quantity: 3, unitPriceCenti: 15_050 },
      { itemId: setup.b.id, quantity: 6, unitPriceCenti: 10_000 },
    ],
    charges: [{ description: "送料", quantity: 1, unitAmount: 800 }],
  });
  const view = await getOrder(order.id);
  return { ...setup, order, version: view.order.version };
}

function shipForm(version: number, shippedOn = today()) {
  return { _key: newKey(), version: String(version), shippedOn };
}

async function shipmentsOf(orderId: string) {
  return readDb((db) =>
    db.select().from(schema.shipments).where(eq(schema.shipments.salesOrderId, orderId)).all(),
  );
}

describe("個別の発送", () => {
  it("引当を外して在庫を減らし、納品書を採番・発行する（内容は発送日の税率で計算）", async () => {
    const user = await createEmployee(["sales"]);
    const { a, b, locationId, customer, order, version } = await orderWithStock({ a: 10, b: 12 });
    const before = await pendingJobIds("render_document");
    const res = await as(user).hx(`/sales-orders/${order.id}/ship`, shipForm(version));
    const html = await res.text();
    expect(html).toContain('id="so-detail"');
    expect(html).toContain("発送しました");
    expect(html).toMatch(/DN-\d{4}-\d{6}/);
    expect(html).not.toContain(">発送する</button>");

    expect(await level(a.id, locationId)).toEqual({ onHand: 7, allocated: 0, available: 7 });
    expect(await level(b.id, locationId)).toEqual({ onHand: 6, allocated: 0, available: 6 });
    const view = await getOrder(order.id);
    expect(view.order.status).toBe("shipped");
    const [shipment] = await shipmentsOf(order.id);
    expect(shipment).toMatchObject({ cancelled: false, invoiceId: null, shippedOn: today() });
    expect(shipment?.deliveryNoteNumber).toMatch(/^DN-\d{4}-\d{6}$/);

    // 納品書：番号・取引先・取引年月日・税込の金額、スナップショットはスキーマどおり
    const note = view.shipments[0]?.deliveryNote;
    expect(note?.cancelled).toBe(false);
    const doc = await documentRow(note!.documentId);
    expect(doc).toMatchObject({
      documentType: "delivery_note",
      number: shipment?.deliveryNoteNumber,
      entityId: shipment?.id,
      partnerId: customer.id,
      transactionDate: today(),
      amount: 2027,
    });
    const snapshot = deliveryNoteSnapshotSchema.parse(JSON.parse(doc!.snapshotJson));
    expect(snapshot.customer).toMatchObject({
      name: customer.name,
      honorific: "御中",
      contactName: "佐藤",
    });
    expect(snapshot.lines.map((l) => [l.quantity, l.amount, l.reduced])).toEqual([
      [3, 451, true],
      [6, 600, false],
    ]);
    expect(snapshot.taxGroups).toEqual([
      { category: "standard", rateBps: 1000, subtotal: 1400, tax: 140 },
      { category: "reduced", rateBps: 800, subtotal: 451, tax: 36 },
    ]);

    // PDF 化（テストでは HTML）の処理が予約され、納品書のテンプレートで描ける
    const jobs = (await pendingJobIds("render_document")).filter((id) => !before.includes(id));
    expect(jobs).toHaveLength(1);
    await runJobs(jobs);
    expect((await documentRow(note!.documentId))?.status).toBe("ready");
    const file = await (await as(user).get(`/documents/${note!.documentId}/download`)).text();
    expect(file).toContain("納品書");
    expect(file).toContain(shipment!.deliveryNoteNumber);
    expect(file).toContain("※は軽減税率（8%）の対象です");

    const detail = await (await as(user).get(`/sales-orders/${order.id}`)).text();
    expect(detail).toContain(`/documents/${note!.documentId}`);
    expect(detail).toContain("発送を取り消す");
  });

  it("在庫が足りなければ発送せず、足りない商品と数を表示する", async () => {
    const user = await createEmployee(["sales"]);
    const { a, b, locationId, order, version } = await orderWithStock({ a: 2, b: 12 });
    const res = await as(user).hx(`/sales-orders/${order.id}/ship`, shipForm(version));
    const html = await res.text();
    expect(html).toContain("在庫が足りないため記録できませんでした");
    expect(html).toContain(a.name);
    expect(html).not.toContain("\u0000");
    expect((await getOrder(order.id)).order.status).toBe("received");
    expect(await level(a.id, locationId)).toEqual({ onHand: 2, allocated: 3, available: -1 });
    expect((await level(b.id, locationId)).onHand).toBe(12);
    expect(await shipmentsOf(order.id)).toHaveLength(0);
  });

  it("発送後は編集・取消・もう一度の発送ができない", async () => {
    const { a, customer, locationId, order, version } = await orderWithStock();
    await systemCommand("shipments.ship", { id: order.id, version, shippedOn: today() });
    const fields = {
      customerId: customer.id,
      orderedOn: today(),
      locationId,
      lines: [{ itemId: a.id, quantity: 1, unitPriceCenti: 15_050 }],
    };
    expect(
      await systemCommandResult("salesOrders.update", {
        id: order.id,
        version: version + 1,
        fields,
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    expect(
      await systemCommandResult("salesOrders.cancel", {
        id: order.id,
        version: version + 1,
        reason: "理由",
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    expect(
      await systemCommandResult("shipments.ship", {
        id: order.id,
        version: version + 1,
        shippedOn: today(),
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    const user = await createEmployee(["sales"]);
    const page = await as(user).get(`/sales-orders/${order.id}/edit`);
    expect(page.status).toBe(409);
    expect(await shipmentsOf(order.id)).toHaveLength(1);
  });

  it("同じ受付番号で2回送信しても1回だけ発送する。古い版番号・今日より後の発送日はエラー", async () => {
    const user = await createEmployee(["admin"]);
    const { a, locationId, order, version } = await orderWithStock({ a: 10, b: 12 });
    const future = await as(user).hx(`/sales-orders/${order.id}/ship`, {
      ...shipForm(version, "2099-01-01"),
    });
    expect(await future.text()).toContain("今日より後の日付では発送できません");
    const stale = await as(user).hx(`/sales-orders/${order.id}/ship`, shipForm(version + 5));
    expect(await stale.text()).toContain("ほかの人が先に更新しました");
    const form = shipForm(version);
    const first = await as(user).hx(`/sales-orders/${order.id}/ship`, form);
    const second = await as(user).hx(`/sales-orders/${order.id}/ship`, form);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.text()).toContain("発送しました");
    expect((await level(a.id, locationId)).onHand).toBe(7);
    expect(await shipmentsOf(order.id)).toHaveLength(1);
  });

  it("仕入担当・経理担当は発送できず、発送のボタンも出ない（権限）", async () => {
    const { a, locationId, order, version } = await orderWithStock();
    for (const role of ["purchasing", "accounting"] as const) {
      const user = await createEmployee([role]);
      const detail = await (await as(user).get(`/sales-orders/${order.id}`)).text();
      expect(detail).not.toContain(">発送する</button>");
      const res = await as(user).hx(`/sales-orders/${order.id}/ship`, shipForm(version));
      expect(await res.text()).toContain("この操作を行う権限がありません");
    }
    expect((await level(a.id, locationId)).onHand).toBe(10);
  });

  it("メーカー直の受注は在庫を動かさずに発送済みにし、納品書は発行する", async () => {
    const { a, locationId, customer } = await salesSetup({ a: 0, b: 0 });
    const order = await createOrder({
      customerId: customer.id,
      makerDirect: true,
      lines: [{ itemId: a.id, quantity: 30, unitPriceCenti: 15_050 }],
    });
    const view = await getOrder(order.id);
    const shipped = await systemCommand("shipments.ship", {
      id: order.id,
      version: view.order.version,
      shippedOn: today(),
    });
    expect(shipped.deliveryNoteNumber).toMatch(/^DN-/);
    expect(await level(a.id, locationId)).toEqual({ onHand: 0, allocated: 0, available: 0 });
    // 取り消しても在庫は動かない
    const [s] = await shipmentsOf(order.id);
    await systemCommand("shipments.cancel", {
      shipmentId: s!.id,
      version: s!.version,
      reason: "誤り",
    });
    expect(await level(a.id, locationId)).toEqual({ onHand: 0, allocated: 0, available: 0 });
    expect((await getOrder(order.id)).order.status).toBe("received");
  });
});

describe("発送の取消", () => {
  it("在庫を打ち消しの行で戻し、引当も戻して受注済みにする。納品書は取消済みになり、もう一度発送できる", async () => {
    const user = await createEmployee(["sales"]);
    const { a, b, locationId, order, version } = await orderWithStock({ a: 10, b: 12 });
    const first = await systemCommand("shipments.ship", {
      id: order.id,
      version,
      shippedOn: today(),
    });
    const [s] = await shipmentsOf(order.id);
    const noReason = await as(user).hx(`/shipments/${s!.id}/cancel`, {
      _key: newKey(),
      version: String(s!.version),
      reason: "",
      orderId: order.id,
    });
    expect(await noReason.text()).toContain("取り消す理由：入力してください");
    const res = await as(user).hx(`/shipments/${s!.id}/cancel`, {
      _key: newKey(),
      version: String(s!.version),
      reason: "数量の誤り",
      orderId: order.id,
    });
    const html = await res.text();
    expect(html).toContain("発送を取り消しました");
    expect(html).toContain("数量の誤り");
    expect(await level(a.id, locationId)).toEqual({ onHand: 10, allocated: 3, available: 7 });
    expect(await level(b.id, locationId)).toEqual({ onHand: 12, allocated: 6, available: 6 });
    const view = await getOrder(order.id);
    expect(view.order.status).toBe("received");
    expect(view.shipments[0]).toMatchObject({ cancelled: true, cancelReason: "数量の誤り" });
    expect((await documentRow(first.documentId))?.cancelled).toBe(true);
    // 台帳には打ち消しの行が残る（行を消さない）
    const ledger = await systemQuery("stock.ledger", { itemId: a.id, locationId });
    expect(ledger.rows.rows.filter((r) => r.reason === "shipment")).toHaveLength(2);

    // 2回目の取消はできない
    expect(
      await systemCommandResult("shipments.cancel", {
        shipmentId: s!.id,
        version: s!.version + 1,
        reason: "もう一度",
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_state" } });

    // もう一度発送すると、新しい納品書番号で発行する
    const again = await systemCommand("shipments.ship", {
      id: order.id,
      version: view.order.version,
      shippedOn: today(),
    });
    expect(again.deliveryNoteNumber).not.toBe(first.deliveryNoteNumber);
    expect(await level(a.id, locationId)).toEqual({ onHand: 7, allocated: 0, available: 7 });
  });

  it("請求書に載った発送は取り消せず、取消のボタンも出ない", async () => {
    const user = await createEmployee(["sales"]);
    const { a, locationId, order, version } = await orderWithStock();
    await systemCommand("shipments.ship", { id: order.id, version, shippedOn: today() });
    const [s] = await shipmentsOf(order.id);
    await readDb((db) =>
      db
        .update(schema.shipments)
        .set({ invoiceId: "invoice-test" })
        .where(eq(schema.shipments.id, s!.id))
        .run(),
    );
    const detail = await (await as(user).get(`/sales-orders/${order.id}`)).text();
    expect(detail).toContain("請求書に記載済み");
    expect(detail).not.toContain(">発送を取り消す</button>");
    const res = await as(user).hx(`/shipments/${s!.id}/cancel`, {
      _key: newKey(),
      version: String(s!.version),
      reason: "取り消したい",
      orderId: order.id,
    });
    expect(await res.text()).toContain("請求書が発行されています");
    expect((await level(a.id, locationId)).onHand).toBe(7);
    expect((await getOrder(order.id)).order.status).toBe("shipped");
    // 未請求の発送の一覧（請求の区分が使う）にも出ない
    const unbilled = await systemQuery("shipments.unbilled", { limit: 2000 });
    expect(unbilled.some((u) => u.shipmentId === s!.id)).toBe(false);
  });

  it("古い版番号は競合。仕入担当は取り消せない", async () => {
    const { order, version } = await orderWithStock();
    await systemCommand("shipments.ship", { id: order.id, version, shippedOn: today() });
    const [s] = await shipmentsOf(order.id);
    expect(
      await systemCommandResult("shipments.cancel", {
        shipmentId: s!.id,
        version: s!.version + 3,
        reason: "理由",
      }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    const purchasing = await createEmployee(["purchasing"]);
    const res = await as(purchasing).post(`/shipments/${s!.id}/cancel`, {
      _key: newKey(),
      version: String(s!.version),
      reason: "理由",
    });
    expect(await res.text()).toContain("この操作を行う権限がありません");
  });
});

describe("未請求の発送（請求の区分が使う）", () => {
  it("取り消していない未請求の発送と、受注明細・送料を返す", async () => {
    const { a, b, customer, order, version } = await orderWithStock();
    const shipped = await systemCommand("shipments.ship", {
      id: order.id,
      version,
      shippedOn: today(),
    });
    const rows = await systemQuery("shipments.unbilled", { customerId: customer.id });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      shipmentId: shipped.shipmentId,
      salesOrderId: order.id,
      salesOrderNumber: order.number,
      customerId: customer.id,
      deliveryNoteNumber: shipped.deliveryNoteNumber,
      shippedOn: today(),
    });
    expect(row.lines.map((l) => [l.itemId, l.quantity, l.unitPriceCenti, l.taxCategory])).toEqual([
      [a.id, 3, 15_050, "reduced"],
      [b.id, 6, 10_000, "standard"],
    ]);
    expect(row.charges.map((c) => [c.description, c.unitAmount])).toEqual([["送料", 800]]);
    expect(
      await systemQuery("shipments.unbilled", { customerId: customer.id, shippedTo: "2000-01-01" }),
    ).toEqual([]);
  });
});
