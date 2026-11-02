/**
 * 発送リスト・一括発送・納品書の一括 PDF（要件定義書 3.9、5章 発送リスト）とダッシュボードの「受注・出荷」の欄。
 */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import * as schema from "../../src/infra/db/schema";
import { bulkDocumentsPayload } from "../../src/usecases/platform/job-payloads";
import { createLocation } from "./fixtures";
import { as, createEmployee, newKey, systemCommand, systemQuery } from "./helpers";
import { jobRow, readDb, systemCommandResult } from "./platform-helpers";
import {
  createCustomer,
  createOrder,
  createSalesItem,
  getOrder,
  level,
  salesSetup,
  today,
} from "./sales-fixtures";

/** 1つの保管場所に、販売先3社の受注を作る（c3 の受注は在庫が足りない） */
async function shippingDay() {
  const setup = await salesSetup({ a: 10, b: 12 });
  const { a, b, locationId } = setup;
  const c1 = setup.customer;
  const c2 = await createCustomer();
  const c3 = await createCustomer();
  const date = today();
  const o1 = await createOrder({
    customerId: c1.id,
    locationId,
    shipPlannedOn: date,
    memo: "午前中に届ける",
    lines: [
      { itemId: a.id, quantity: 4, unitPriceCenti: 15_050 },
      { itemId: b.id, quantity: 6, unitPriceCenti: 10_000 },
    ],
  });
  const o2 = await createOrder({
    customerId: c2.id,
    locationId,
    shipPlannedOn: date,
    lines: [{ itemId: a.id, quantity: 5, unitPriceCenti: 15_050 }],
  });
  // a は 4 + 5 = 9 で残り1。o3 の a 3個は足りない
  const o3 = await createOrder({
    customerId: c3.id,
    locationId,
    shipPlannedOn: date,
    lines: [
      { itemId: a.id, quantity: 3, unitPriceCenti: 15_050 },
      { itemId: b.id, quantity: 6, unitPriceCenti: 10_000 },
    ],
  });
  // 対象外：別の日・別の保管場所・メーカー直
  const otherDay = await createOrder({
    customerId: c1.id,
    locationId,
    shipPlannedOn: "2099-12-31",
    lines: [{ itemId: a.id, quantity: 1, unitPriceCenti: 15_050 }],
  });
  const maker = await createOrder({
    customerId: c2.id,
    makerDirect: true,
    shipPlannedOn: date,
    lines: [{ itemId: b.id, quantity: 100, unitPriceCenti: 10_000 }],
  });
  return { ...setup, c1, c2, c3, o1, o2, o3, otherDay, maker, date };
}

async function versions(ids: string[]): Promise<string[]> {
  return Promise.all(ids.map(async (id) => String((await getOrder(id)).order.version)));
}

describe("発送リスト", () => {
  it("行が商品、列がその日に受注がある販売先、右端が合計の表を出す（タブレット向け、商品名の列は固定）", async () => {
    const user = await createEmployee(["sales"]);
    const d = await shippingDay();
    const page = await (
      await as(user).get(`/shipping?date=${d.date}&locationId=${d.locationId}`)
    ).text();
    expect(page).toContain('class="touch"');
    expect(page).toContain('class="sticky-col"');
    expect(page).toContain(d.c1.name);
    expect(page).toContain(d.c2.name);
    expect(page).toContain(d.c3.name);
    expect(page).toContain(d.o1.number);
    expect(page).not.toContain(d.otherDay.number);
    expect(page).not.toContain(d.maker.number);
    expect(page).toContain("受注 3 件・販売先 3 件");
    // 列は販売先の ID で持つ
    expect(page).toContain(`data-customer="${d.c1.id}"`);

    const list = await systemQuery("shipping.list", { date: d.date, locationId: d.locationId });
    expect(list).not.toBeNull();
    expect(list!.items.map((i) => i.id)).toEqual(
      [d.a.id, d.b.id].toSorted((x, y) => {
        const cx = list!.items.find((i) => i.id === x)!.code;
        const cy = list!.items.find((i) => i.id === y)!.code;
        return cx < cy ? -1 : 1;
      }),
    );
    const col = (customerId: string) => list!.customers.findIndex((c) => c.id === customerId);
    const row = (itemId: string) => list!.items.findIndex((i) => i.id === itemId);
    expect(list!.matrix.quantities[row(d.a.id)]![col(d.c1.id)]).toBe(4);
    expect(list!.matrix.quantities[row(d.a.id)]![col(d.c2.id)]).toBe(5);
    expect(list!.matrix.quantities[row(d.b.id)]![col(d.c2.id)]).toBe(0);
    expect(list!.matrix.rowTotals[row(d.a.id)]).toBe(12);
    expect(list!.matrix.grandTotal).toBe(24);
    expect(list!.shortOrderIds).toEqual([d.o3.id]);

    // 保管場所が複数あれば、選ぶまで表を出さない
    const otherLocation = await createLocation();
    const none = await (await as(user).get(`/shipping?date=${d.date}`)).text();
    expect(none).toContain("保管場所を選んでください");
    const other = await (
      await as(user).get(`/shipping?date=${d.date}&locationId=${otherLocation}`)
    ).text();
    expect(other).toContain("この日に発送する受注はありません");
  });

  it("印刷用の HTML（A4 横、販売先が多ければ列を分けて複数ページ）と仕分けリスト（1販売先1枚）", async () => {
    const user = await createEmployee(["accounting"]);
    const d = await shippingDay();
    // 販売先を足して10社を超えさせる
    for (let i = 0; i < 9; i += 1) {
      const c = await createCustomer();
      await createOrder({
        customerId: c.id,
        locationId: d.locationId,
        shipPlannedOn: d.date,
        lines: [{ itemId: d.b.id, quantity: 1, unitPriceCenti: 10_000 }],
      });
    }
    // 同じ販売先の2件目の受注は同じ列に足す
    const second = await createOrder({
      customerId: d.c1.id,
      locationId: d.locationId,
      shipPlannedOn: d.date,
      lines: [{ itemId: d.b.id, quantity: 2, unitPriceCenti: 10_000 }],
    });
    const list = await systemQuery("shipping.list", { date: d.date, locationId: d.locationId });
    const c1 = list!.customers.find((c) => c.id === d.c1.id);
    expect(c1?.orders.map((o) => o.number)).toEqual([d.o1.number, second.number]);
    const col = list!.customers.findIndex((c) => c.id === d.c1.id);
    const row = list!.items.findIndex((i) => i.id === d.b.id);
    expect(list!.matrix.quantities[row]![col]).toBe(8);
    expect(
      await systemQuery("shipping.list", {
        date: d.date,
        locationId: "01ZZZZZZZZZZZZZZZZZZZZZZZZ",
      }),
    ).toBeNull();
    const missing = await (
      await as(user).get(`/shipping?date=${d.date}&locationId=01ZZZZZZZZZZZZZZZZZZZZZZZZ`)
    ).text();
    expect(missing).toContain("保管場所が見つかりません");

    const res = await as(user).get(`/shipping/print?date=${d.date}&locationId=${d.locationId}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/assets/print.css"');
    expect(html).toContain("data-print");
    expect(html).not.toMatch(/style=/);
    expect(html.match(/class="print-page"/g)).toHaveLength(2);
    expect(html).toContain("1 / 2");
    expect(html).toContain(d.c1.name);

    const sorting = await (
      await as(user).get(`/shipping/sorting?date=${d.date}&locationId=${d.locationId}`)
    ).text();
    expect(sorting.match(/class="print-page"/g)).toHaveLength(12);
    expect(sorting).toContain("仕分けリスト");
    expect(sorting).toContain(`${d.c1.name} 御中`);
    expect(sorting).toContain("午前中に届ける");
    expect((await as(user).get(`/shipping/print?date=${d.date}`)).status).toBe(400);
  });

  it("経理担当は発送リストを見られるが、一括発送はできない（権限）", async () => {
    const user = await createEmployee(["accounting"]);
    const d = await shippingDay();
    const page = await (
      await as(user).get(`/shipping?date=${d.date}&locationId=${d.locationId}`)
    ).text();
    expect(page).toContain("発送する権限がありません");
    expect(page).not.toContain('id="bulk-form"');
    const res = await as(user).hx("/shipping/bulk/ship", {
      _key: newKey(),
      date: d.date,
      locationId: d.locationId,
      orderId: [d.o1.id],
      orderVersion: ["1"],
      shippedOn: d.date,
    });
    expect(await res.text()).toContain("この操作を行う権限がありません");
    expect((await getOrder(d.o1.id)).order.status).toBe("received");
  });
});

describe("一括発送", () => {
  it("確認で件数と在庫が足りない受注を示し、「外して続ける」で残りを1つのトランザクションで発送する", async () => {
    const user = await createEmployee(["sales"]);
    const d = await shippingDay();
    const page = await (
      await as(user).get(`/shipping?date=${d.date}&locationId=${d.locationId}`)
    ).text();
    expect(page).toContain('id="bulk-form"');
    expect(page.match(/name="orderId"[^>]*checked/g)).toHaveLength(3);

    const confirm = await (
      await as(user).hx("/shipping/bulk/confirm", {
        date: d.date,
        locationId: d.locationId,
        orderId: [d.o1.id, d.o2.id, d.o3.id],
      })
    ).text();
    expect(confirm).toContain("一括発送の確認");
    expect(confirm).toContain("在庫が足りない受注が 1 件あります");
    expect(confirm).toContain(d.o3.number);
    expect(confirm).toContain(`${d.a.name} があと2個`);
    expect(confirm).toContain("在庫が足りない 1 件を外して続ける（2 件を発送）");
    expect(confirm).toContain(`name="excludeId" value="${d.o3.id}"`);
    expect(confirm).toContain("中止");

    // 外さずに実行すると在庫不足で何も発送しない（1つのトランザクション）
    const ids = [d.o1.id, d.o2.id, d.o3.id];
    const all = await as(user).hx("/shipping/bulk/ship", {
      _key: newKey(),
      date: d.date,
      locationId: d.locationId,
      orderId: ids,
      orderVersion: await versions(ids),
      shippedOn: d.date,
    });
    expect(all.status).toBe(422);
    expect(await all.text()).toContain("在庫が変わったため、発送できない受注があります");
    for (const id of ids) expect((await getOrder(id)).order.status).toBe("received");
    // 別の日の受注（a 1個）も同じ保管場所に引き当てている
    expect(await level(d.a.id, d.locationId)).toEqual({ onHand: 10, allocated: 13, available: -3 });

    // 外して続ける。同じ受付番号で2回送っても1回分
    const form = {
      _key: newKey(),
      date: d.date,
      locationId: d.locationId,
      orderId: ids,
      orderVersion: await versions(ids),
      excludeId: [d.o3.id],
      shippedOn: d.date,
    };
    const res = await as(user).hx("/shipping/bulk/ship", form);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("2 件を発送しました（在庫が足りない 1 件は外しました）");
    expect(html).toContain("発送した 2 件の納品書を一括で PDF にする");
    const again = await as(user).hx("/shipping/bulk/ship", form);
    expect(again.status).toBe(200);
    expect((await getOrder(d.o1.id)).order.status).toBe("shipped");
    expect((await getOrder(d.o2.id)).order.status).toBe("shipped");
    expect((await getOrder(d.o3.id)).order.status).toBe("received");
    // a：10 − 4 − 5 = 1、引当は o3 の 3 と別の日の 1 が残る
    expect(await level(d.a.id, d.locationId)).toEqual({ onHand: 1, allocated: 4, available: -3 });
    expect(await level(d.b.id, d.locationId)).toEqual({ onHand: 6, allocated: 6, available: 0 });

    // 発送済みは発送リストから外れ、発送済みの納品書の一括 PDF のボタンが出る
    const after = await (
      await as(user).get(`/shipping?date=${d.date}&locationId=${d.locationId}`)
    ).text();
    expect(after).toContain("受注 1 件・販売先 1 件（発送済み 2 件）");
    expect(after).toContain("発送済みの納品書を一括 PDF（2 件）");

    // 納品書の一括 PDF：発送した受注の納品書を、処理状況で作る
    const shipmentIds = [
      ...new Set(
        [...html.matchAll(/name="shipmentId" value="([0-9A-Z]{26})"/g)].map((m) => m[1] ?? ""),
      ),
    ];
    expect(shipmentIds).toHaveLength(2);
    const pdf = await as(user).hx("/shipping/delivery-notes", {
      _key: newKey(),
      name: `納品書_${d.date}`,
      shipmentId: shipmentIds,
    });
    expect(pdf.headers.get("HX-Redirect")).toBe("/jobs?notice=bulk");
    const jobs = await readDb((db) =>
      db.select().from(schema.jobs).where(eq(schema.jobs.type, "bulk_documents")).all(),
    );
    const job = jobs.at(-1)!;
    const payload = bulkDocumentsPayload.parse(JSON.parse(job.payloadJson));
    expect(payload.documentIds).toHaveLength(2);
    expect(payload.name).toBe(`納品書_${d.date}`);
    expect((await jobRow(job.id))?.total).toBe(2);
  });

  it("確認の後に受注が変わった・発送済みの受注は発送しない。選ばなければ確認しない", async () => {
    const user = await createEmployee(["sales"]);
    const d = await shippingDay();
    const v1 = (await getOrder(d.o1.id)).order.version;
    // 確認の後に編集された
    await systemCommand("salesOrders.update", {
      id: d.o1.id,
      version: v1,
      fields: {
        customerId: d.c1.id,
        orderedOn: today(),
        locationId: d.locationId,
        shipPlannedOn: d.date,
        lines: [{ itemId: d.a.id, quantity: 1, unitPriceCenti: 15_050 }],
      },
    });
    const stale = await systemCommandResult("shipments.bulkShip", {
      orders: [
        { id: d.o1.id, version: v1 },
        { id: d.o2.id, version: (await getOrder(d.o2.id)).order.version },
      ],
      shippedOn: d.date,
    });
    expect(stale).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect((await getOrder(d.o2.id)).order.status).toBe("received");

    const v2 = (await getOrder(d.o2.id)).order.version;
    await systemCommand("shipments.ship", { id: d.o2.id, version: v2, shippedOn: d.date });
    const shipped = await systemCommandResult("shipments.bulkShip", {
      orders: [{ id: d.o2.id, version: v2 + 1 }],
      shippedOn: d.date,
    });
    expect(shipped).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    const allExcluded = await systemCommandResult("shipments.bulkShip", {
      orders: [{ id: d.o1.id, version: v1 + 1 }],
      exclude: [d.o1.id],
      shippedOn: d.date,
    });
    expect(allExcluded).toMatchObject({ ok: false, error: { code: "validation" } });
    const future = await systemCommandResult("shipments.bulkShip", {
      orders: [{ id: d.o1.id, version: v1 + 1 }],
      shippedOn: "2099-01-01",
    });
    expect(future).toMatchObject({ ok: false, error: { code: "validation" } });

    const unknown = await systemCommandResult("shipments.bulkShip", {
      orders: [{ id: "01ZZZZZZZZZZZZZZZZZZZZZZZZ", version: 1 }],
      shippedOn: d.date,
    });
    expect(unknown).toMatchObject({
      ok: false,
      error: { code: "invalid_state", details: ["01ZZZZZZZZZZZZZZZZZZZZZZZZ"] },
    });

    const empty = await (
      await as(user).hx("/shipping/bulk/confirm", { date: d.date, locationId: d.locationId })
    ).text();
    expect(empty).toContain("発送する受注を選んでください");
    const ineligible = await (
      await as(user).hx("/shipping/bulk/confirm", {
        date: d.date,
        locationId: d.locationId,
        orderId: [d.o2.id, d.maker.id],
      })
    ).text();
    expect(ineligible).toContain("対象外の受注が 2 件あります");
    expect(ineligible).toContain("発送できる受注がありません");
  });

  it("名前を指定しなければ「納品書_今日の日付」で一括 PDF を作る", async () => {
    const d = await shippingDay();
    const v = (await getOrder(d.o2.id)).order.version;
    const shipped = await systemCommand("shipments.ship", {
      id: d.o2.id,
      version: v,
      shippedOn: d.date,
    });
    const r = await systemCommand("deliveryNotes.bulkPdf", { shipmentIds: [shipped.shipmentId] });
    expect(r.count).toBe(1);
    const job = await jobRow(r.jobId);
    expect(bulkDocumentsPayload.parse(JSON.parse(job!.payloadJson))).toEqual({
      documentIds: [shipped.documentId],
      name: `納品書_${today()}`,
    });
  });

  it("納品書がない発送だけなら一括 PDF は作らない", async () => {
    const user = await createEmployee(["sales"]);
    const res = await as(user).post("/shipping/delivery-notes", {
      _key: newKey(),
      shipmentId: ["01ZZZZZZZZZZZZZZZZZZZZZZZZ"],
    });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("PDF にする納品書がありません");
  });
});

describe("ダッシュボードの「受注・出荷」の欄", () => {
  it("今日の出荷予定（保管場所別）・出荷可能数が足りない受注・出荷予定日を過ぎた受注を数え、一覧へのリンクを出す", async () => {
    const before = await systemQuery("sales.dashboard", {});
    const d = await shippingDay();
    const supplierId = d.supplierId;
    const item = await createSalesItem(supplierId);
    await createOrder({
      customerId: d.c1.id,
      locationId: d.locationId,
      shipPlannedOn: "2026-01-05",
      lines: [{ itemId: item.id, quantity: 1, unitPriceCenti: 15_050 }],
    });
    const after = await systemQuery("sales.dashboard", {});
    expect(after.today).toBe(today());
    const here = after.shipPlanned.find((p) => p.locationId === d.locationId);
    expect(here?.count).toBe(3);
    const maker = (list: typeof after.shipPlanned) =>
      list.find((p) => p.locationId === null)?.count ?? 0;
    expect(maker(after.shipPlanned) - maker(before.shipPlanned)).toBe(1);
    // 商品 a の引当が現在庫を超えている受注（o1・o2・o3・別の日の受注）と、在庫のない商品の受注
    expect(after.shortage - before.shortage).toBe(5);
    expect(after.overdue - before.overdue).toBe(1);

    const user = await createEmployee(["sales"]);
    const page = await (await as(user).get("/")).text();
    expect(page).toContain("受注・出荷");
    expect(page).toContain("出荷可能数が足りない受注");
    expect(page).toContain(`/shipping?date=${after.today}&amp;locationId=${d.locationId}`);
    expect(page).toContain("/sales-orders?status=received&amp;shortage=1");
    const purchasing = await createEmployee(["purchasing"]);
    expect(await (await as(purchasing).get("/")).text()).not.toContain("受注・出荷");
  });
});
