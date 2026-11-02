import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { describe, expect, it } from "vitest";

import * as schema from "../../src/infra/db/schema";
import type { BusinessDb } from "../../src/infra/do/business-db";
import { businessDb } from "../../src/infra/do/client";
import {
  addInitialStock,
  createGenre,
  createItem,
  createLocation,
  createRetailStore,
  createSupplier,
  uniqueName,
} from "./fixtures";
import { as, createEmployee, newKey, systemCommand, systemQuery } from "./helpers";

async function setup() {
  const supplierId = await createSupplier();
  const a = await createItem(supplierId);
  const b = await createItem(supplierId);
  const main = await createLocation();
  const sub = await createLocation();
  return { supplierId, a, b, main, sub };
}

function opForm(fields: Record<string, string | string[]>) {
  return { operationDate: "2026-10-15", memo: "", _key: newKey(), ...fields };
}

async function onHand(itemId: string, locationId: string): Promise<number> {
  const levels = await systemQuery("stock.levels", { itemIds: [itemId], locationId });
  return levels[0]?.onHand ?? 0;
}

describe("在庫操作の画面", () => {
  // 発注点を管理する商品を作る前に確かめる（このファイルの最初のテスト）
  it("発注点割れの商品がなければ、発注点割れで絞り込んだ一覧と CSV は空", async () => {
    const user = await createEmployee(["purchasing"]);
    const html = await (await as(user).get("/stock?reorder=1")).text();
    expect(html).toContain("条件に合う在庫はありません");
    const csv = await (await as(user).post("/stock/csv", { _key: newKey(), reorder: "1" })).text();
    expect(csv.split("\r\n").filter((l) => l !== "")).toHaveLength(1);
  });

  it("初期在庫を調整で入れると、伝票・台帳・在庫一覧に反映される", async () => {
    const user = await createEmployee(["sales"]);
    const { a, b, main } = await setup();
    const page = await (await as(user).get("/stock/operations/new")).text();
    expect(page).toContain('class="touch"');
    expect(page).toContain('id="op-picker"');
    const res = await as(user).hx(
      "/stock/operations/new",
      opForm({
        kind: "adjustment",
        reason: "initial",
        locationId: main,
        lineItemId: [a.id, b.id],
        lineQuantity: ["10", "5"],
      }),
    );
    expect(res.status).toBe(204);
    const location = res.headers.get("HX-Redirect") ?? "";
    expect(location).toMatch(/^\/stock\/operations\/[0-9A-Z]{26}\?notice=created$/);
    const detail = await (await as(user).get(location)).text();
    expect(detail).toMatch(/SOP-2026-\d{6}/);
    expect(detail).toContain("初期在庫");
    expect(detail).toContain("+10");
    expect(await onHand(a.id, main)).toBe(10);
    expect(await onHand(b.id, main)).toBe(5);

    const list = await (await as(user).get(`/stock?locationId=${main}`)).text();
    expect(list).toContain(a.name);
    expect(list).toContain(b.name);
    const ledger = await (await as(user).get(`/stock/${a.id}?locationId=${main}`)).text();
    expect(ledger).toContain("初期在庫");
    expect(ledger).toContain("SOP-2026-");
    const ops = await (await as(user).get("/stock/operations?kind=adjustment")).text();
    expect(ops).toContain("初期在庫");
  });

  it("経理担当は在庫を操作できない（権限）", async () => {
    const user = await createEmployee(["accounting"]);
    const { a, main } = await setup();
    const page = await (await as(user).get("/stock/operations/new")).text();
    expect(page).toContain("権限がありません");
    const res = await as(user).hx(
      "/stock/operations/new",
      opForm({
        kind: "adjustment",
        reason: "initial",
        locationId: main,
        lineItemId: a.id,
        lineQuantity: "3",
      }),
    );
    expect(await res.text()).toContain("この操作を行う権限がありません");
    expect(await onHand(a.id, main)).toBe(0);
  });

  it("同じ受付番号で2回送信しても1回分だけ記録される", async () => {
    const user = await createEmployee(["sales"]);
    const { a, main } = await setup();
    const form = opForm({
      kind: "adjustment",
      reason: "initial",
      locationId: main,
      lineItemId: a.id,
      lineQuantity: "7",
    });
    const first = await as(user).hx("/stock/operations/new", form);
    const second = await as(user).hx("/stock/operations/new", form);
    expect(second.headers.get("HX-Redirect")).toBe(first.headers.get("HX-Redirect"));
    expect(await onHand(a.id, main)).toBe(7);
  });

  it("移動は移動元を減らして移動先に加える。同じ場所・0以下・在庫不足はエラー", async () => {
    const user = await createEmployee(["sales"]);
    const { a, b, main, sub } = await setup();
    await addInitialStock(main, [
      { itemId: a.id, quantity: 4 },
      { itemId: b.id, quantity: 1 },
    ]);
    const same = await as(user).hx(
      "/stock/operations/new",
      opForm({
        kind: "transfer",
        locationId: main,
        toLocationId: main,
        lineItemId: a.id,
        lineQuantity: "1",
      }),
    );
    expect(await same.text()).toContain("移動元と移動先に同じ保管場所は指定できません");
    const zero = await as(user).hx(
      "/stock/operations/new",
      opForm({
        kind: "transfer",
        locationId: main,
        toLocationId: sub,
        lineItemId: a.id,
        lineQuantity: "0",
      }),
    );
    expect(await zero.text()).toContain("移動する数量は1以上で入力してください");
    const short = await as(user).hx(
      "/stock/operations/new",
      opForm({
        kind: "transfer",
        locationId: main,
        toLocationId: sub,
        lineItemId: [a.id, b.id],
        lineQuantity: ["3", "2"],
      }),
    );
    const html = await short.text();
    expect(html).toContain("在庫が足りないため記録できませんでした");
    expect(html).toContain(b.name);
    expect(html).not.toContain("\u0000");
    // 入力した内容は残る
    expect(html).toContain(`value="${a.id}"`);
    expect(await onHand(a.id, main)).toBe(4);

    const ok = await as(user).hx(
      "/stock/operations/new",
      opForm({
        kind: "transfer",
        locationId: main,
        toLocationId: sub,
        lineItemId: a.id,
        lineQuantity: "3",
      }),
    );
    expect(ok.status).toBe(204);
    expect(await onHand(a.id, main)).toBe(1);
    expect(await onHand(a.id, sub)).toBe(3);
    const ops = await (await as(user).get(`/stock/operations?locationId=${sub}`)).text();
    expect(ops).toContain("→");
  });

  it("店舗払い出しは在庫から外し、払い出し先店舗が必要", async () => {
    const user = await createEmployee(["admin"]);
    const { a, main } = await setup();
    const storeId = await createRetailStore();
    await addInitialStock(main, [{ itemId: a.id, quantity: 6 }]);
    const noStore = await as(user).hx(
      "/stock/operations/new",
      opForm({ kind: "store_transfer", locationId: main, lineItemId: a.id, lineQuantity: "2" }),
    );
    expect(await noStore.text()).toContain("選択してください");
    const res = await as(user).hx(
      "/stock/operations/new",
      opForm({
        kind: "store_transfer",
        locationId: main,
        storeId,
        lineItemId: a.id,
        lineQuantity: "2",
      }),
    );
    expect(res.status).toBe(204);
    expect(await onHand(a.id, main)).toBe(4);
    const detail = await (await as(user).get(res.headers.get("HX-Redirect") ?? "")).text();
    expect(detail).toContain("店舗払い出し");
    expect(detail).toContain("（店舗）");
    const archivedStore = await createRetailStore();
    await systemCommand("retailStores.archive", { id: archivedStore, version: 1, archived: true });
    const archived = await as(user).hx(
      "/stock/operations/new",
      opForm({
        kind: "store_transfer",
        locationId: main,
        storeId: archivedStore,
        lineItemId: a.id,
        lineQuantity: "1",
      }),
    );
    expect(await archived.text()).toContain("払い出し先店舗を選んでください");
  });

  it("入力の誤りは項目ごと・行ごとに示す", async () => {
    const user = await createEmployee(["sales"]);
    const { a, main } = await setup();
    const noReason = await as(user).hx(
      "/stock/operations/new",
      opForm({
        kind: "adjustment",
        reason: "",
        locationId: main,
        lineItemId: a.id,
        lineQuantity: "x",
      }),
    );
    const html = await noReason.text();
    expect(html).toContain("理由を選んでください");
    expect(html).toContain("数量は数字で入力してください");
    const noLines = await as(user).hx(
      "/stock/operations/new",
      opForm({ kind: "adjustment", reason: "adjustment", locationId: main }),
    );
    expect(await noLines.text()).toContain("商品を1つ以上追加してください");
    const sample = await as(user).hx(
      "/stock/operations/new",
      opForm({
        kind: "adjustment",
        reason: "sample",
        locationId: main,
        lineItemId: a.id,
        lineQuantity: "2",
      }),
    );
    expect(await sample.text()).toContain("サンプル・処分は減らす数をマイナスで入力してください");
    const future = await as(user).hx(
      "/stock/operations/new",
      opForm({
        kind: "adjustment",
        reason: "initial",
        operationDate: "2999-01-01",
        locationId: main,
        lineItemId: a.id,
        lineQuantity: "1",
      }),
    );
    expect(await future.text()).toContain("今日より後の日付は指定できません");
    const unknownItem = await as(user).hx(
      "/stock/operations/new",
      opForm({
        kind: "adjustment",
        reason: "initial",
        locationId: main,
        lineItemId: "NOPE",
        lineQuantity: "1",
      }),
    );
    expect(await unknownItem.text()).toContain("登録されていない商品が含まれています");
    const archivedLocation = await createLocation();
    await systemCommand("locations.archive", { id: archivedLocation, version: 1, archived: true });
    const archived = await as(user).hx(
      "/stock/operations/new",
      opForm({
        kind: "transfer",
        locationId: main,
        toLocationId: archivedLocation,
        lineItemId: a.id,
        lineQuantity: "1",
      }),
    );
    expect(await archived.text()).toContain("取引終了の保管場所は選べません");
    const noLocation = await as(user).hx(
      "/stock/operations/new",
      opForm({
        kind: "adjustment",
        reason: "initial",
        locationId: "NOPE",
        lineItemId: a.id,
        lineQuantity: "1",
      }),
    );
    expect(await noLocation.text()).toContain("保管場所を選んでください");
  });

  it("商品選択ダイアログで選んだ商品を明細の行にして返す（すでにある商品は除く）", async () => {
    const user = await createEmployee(["sales"]);
    const { a, b, main } = await setup();
    await addInitialStock(main, [{ itemId: a.id, quantity: 9 }]);
    const res = await as(user).hx("/stock/operations/lines", {
      kind: "transfer",
      locationId: main,
      lineItemId: b.id,
      itemIds: [a.id, b.id],
    });
    const html = await res.text();
    expect(html).toContain(`data-line-item="${a.id}"`);
    expect(html).not.toContain(`data-line-item="${b.id}"`);
    expect(html).toContain('name="lineQuantity"');
    expect(html).toContain(">9<");
    const none = await as(user).hx("/stock/operations/lines", { kind: "adjustment" });
    expect((await none.text()).trim()).toBe("");
    const noLocation = await (
      await as(user).hx("/stock/operations/lines", { kind: "adjustment", itemIds: a.id })
    ).text();
    expect(noLocation).toContain("—");
  });

  it("在庫操作の詳細と一覧（存在しない伝票は 404）", async () => {
    const user = await createEmployee(["purchasing"]);
    expect((await as(user).get("/stock/operations/NOPE")).status).toBe(404);
    const list = await (
      await as(user).get("/stock/operations?from=2026-01-01&to=2026-12-31")
    ).text();
    expect(list).toContain("在庫操作の一覧");
  });
});

describe("在庫一覧・在庫明細", () => {
  it("絞り込み・発注点割れ・入荷予定数を表示し、CSV を BOM 付き UTF-8 で出す", async () => {
    const user = await createEmployee(["purchasing"]);
    const supplierId = await createSupplier();
    const genreId = await createGenre();
    const tag = uniqueName("一覧");
    const low = await createItem(supplierId, {
      name: `${tag}発注点割れ`,
      genreId,
      reorderEnabled: true,
      reorderPoint: 10,
    });
    const enough = await createItem(supplierId, {
      name: `${tag}十分`,
      reorderEnabled: true,
      reorderPoint: 2,
    });
    const main = await createLocation();
    const emptyLocation = await createLocation();
    await addInitialStock(main, [
      { itemId: low.id, quantity: 3 },
      { itemId: enough.id, quantity: 5 },
    ]);
    // 発注済みで未入荷の発注明細（入荷予定数）。発注の画面はほかの区分が作るので、ここでは直接作る
    await runInDurableObject(businessDb(env), (_i: BusinessDb, state) => {
      const db = drizzle(state.storage, { schema });
      const meta = {
        createdAt: "2026-10-01T00:00:00Z",
        createdBy: "system",
        updatedAt: "2026-10-01T00:00:00Z",
        updatedBy: "system",
        version: 1,
      };
      db.insert(schema.purchaseOrders)
        .values({
          id: `po-${tag}`,
          number: `PO-TEST-${tag}`,
          supplierId,
          status: "ordered",
          orderedOn: "2026-10-01",
          destinationKind: "location",
          destinationLocationId: main,
          ...meta,
        })
        .run();
      const line = {
        purchaseOrderId: `po-${tag}`,
        unitPriceCenti: 100,
        unitsPerPurchaseUnit: 12,
        taxCategory: "reduced" as const,
      };
      db.insert(schema.purchaseOrderLines)
        .values([
          {
            id: `pol-${tag}`,
            lineNo: 1,
            itemId: low.id,
            quantity: 2,
            receivedQuantity: 1,
            ...line,
          },
          // 全数がそろった明細は入荷予定に入らない
          {
            id: `pol2-${tag}`,
            lineNo: 2,
            itemId: enough.id,
            quantity: 3,
            receivedQuantity: 3,
            ...line,
          },
        ])
        .run();
      // 在庫の記録がない保管場所への入荷予定
      db.insert(schema.purchaseOrders)
        .values({
          id: `po2-${tag}`,
          number: `PO-TEST2-${tag}`,
          supplierId,
          status: "ordered",
          orderedOn: "2026-10-01",
          destinationKind: "location",
          destinationLocationId: emptyLocation,
          ...meta,
        })
        .run();
      db.insert(schema.purchaseOrderLines)
        .values({
          id: `pol3-${tag}`,
          lineNo: 1,
          itemId: enough.id,
          quantity: 1,
          receivedQuantity: 0,
          ...line,
          purchaseOrderId: `po2-${tag}`,
        })
        .run();
    });
    const enoughStock = await systemQuery("stock.item", { itemId: enough.id });
    expect(enoughStock?.locations).toEqual([
      expect.objectContaining({ locationId: main, onHand: 5, incoming: 0 }),
      expect.objectContaining({ locationId: emptyLocation, onHand: 0, incoming: 12 }),
    ]);

    const all = await (await as(user).get(`/stock?q=${encodeURIComponent(tag)}`)).text();
    expect(all).toContain(low.name);
    expect(all).toContain(enough.name);
    // 入荷予定 = 残り1ケース × 入数12 = 12、出荷可能数 3 + 12 ≥ 10 なので発注点割れではない
    expect(all).toContain(">12<");
    const alerts = await systemQuery("stock.reorderAlerts", {});
    expect(alerts.some((x) => x.itemId === low.id)).toBe(false);

    // 引当を増やすと出荷可能数が減り、発注点割れになる
    await runInDurableObject(businessDb(env), (_i: BusinessDb, state) => {
      const db = drizzle(state.storage, { schema });
      db.update(schema.stockBalances)
        .set({ allocated: 8 })
        .where(
          and(eq(schema.stockBalances.itemId, low.id), eq(schema.stockBalances.locationId, main)),
        )
        .run();
    });
    const below = await (
      await as(user).get(`/stock?q=${encodeURIComponent(tag)}&reorder=1`)
    ).text();
    expect(below).toContain(low.name);
    expect(below).not.toContain(enough.name);
    expect(below).toContain("発注点割れ");
    const byGenre = await (await as(user).get(`/stock?genreId=${genreId}`)).text();
    expect(byGenre).toContain(low.name);
    expect(byGenre).not.toContain(enough.name);
    const alertsAfter = await systemQuery("stock.reorderAlerts", {});
    const alert = alertsAfter.find((x) => x.itemId === low.id);
    expect(alert).toMatchObject({ available: -5, incoming: 12, reorderPoint: 10 });

    const csv = await as(user).post("/stock/csv", { _key: newKey(), q: tag });
    expect(csv.headers.get("Content-Type")).toContain("text/csv");
    expect(csv.headers.get("Content-Disposition")).toContain("filename*=UTF-8''");
    const bytes = new Uint8Array(await csv.arrayBuffer());
    expect(Array.from(bytes.subarray(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain(
      "商品コード,JAN,商品名,ジャンル,保管場所,販売単位,現在庫,引当数,出荷可能数,入荷予定数",
    );
    expect(text).toContain(`${low.code},,${low.name}`);
    expect(text).toContain(",3,8,-5,12,10,発注点割れ,");
    expect(text).toContain("\r\n");

    const none = await (
      await as(user).post("/stock/csv", { _key: newKey(), q: tag, reorder: "1", genreId: "NOPE" })
    ).text();
    expect(none.split("\r\n").filter((l) => l !== "")).toHaveLength(1);
  });

  it("在庫明細は期間・保管場所・理由で絞り込み、各行の後の残高を出す", async () => {
    const user = await createEmployee(["sales"]);
    const { a, main, sub } = await setup();
    await addInitialStock(main, [{ itemId: a.id, quantity: 10 }], "2026-09-01");
    await systemCommand("stockOperations.create", {
      kind: "adjustment",
      reason: "disposal",
      operationDate: "2026-10-05",
      locationId: main,
      lines: [{ itemId: a.id, quantity: -2 }],
      memo: "破損",
    });
    await systemCommand("stockOperations.create", {
      kind: "transfer",
      operationDate: "2026-10-10",
      locationId: main,
      toLocationId: sub,
      lines: [{ itemId: a.id, quantity: 3 }],
    });

    const html = await (
      await as(user).get(`/stock/${a.id}?from=2026-10-01&to=2026-10-31&locationId=${main}`)
    ).text();
    expect(html).toContain("期間の前の残高");
    expect(html).toContain(">10<");
    expect(html).toContain("処分");
    expect(html).toContain("−2");
    expect(html).toContain(">8<");
    expect(html).toContain("移動（出）");
    expect(html).toContain(">5<");
    expect(html).toContain("破損");

    const byReason = await (await as(user).get(`/stock/${a.id}?from=&reason=transfer_in`)).text();
    expect(byReason).toContain("移動（入）");
    // 処分（−2）と移動（出）の行は出さない
    expect(byReason).not.toContain("−2");
    expect(byReason).not.toContain("−3");
    expect(byReason).toContain("すべての保管場所の合計");
    // 全保管場所の残高：10 → 8 → (出 5, 入 8)
    expect(byReason).toContain(">8<");

    const summary = await systemQuery("stock.item", { itemId: a.id });
    expect(summary?.locations.map((l) => l.onHand)).toEqual([5, 3]);
    expect((await as(user).get("/stock/01ARZ3NDEKTSV4RRFFQ69G5FAV")).status).toBe(404);
    expect(await systemQuery("stock.item", { itemId: "NOPE" })).toBeNull();
  });

  it("在庫不足の内容を商品名・保管場所名つきで返す（ほかの区分の画面用）", async () => {
    const { a, main } = await setup();
    await addInitialStock(main, [{ itemId: a.id, quantity: 2 }]);
    const r = await businessDb(env).internalCommand(
      "stockOperations.create",
      {
        kind: "adjustment",
        reason: "disposal",
        operationDate: "2026-10-20",
        locationId: main,
        lines: [{ itemId: a.id, quantity: -5 }],
      },
      { kind: "system" },
    );
    expect(r.ok).toBe(false);
    const details = r.ok ? [] : [...(r.error.details ?? [])];
    const shortages = await systemQuery("stock.shortages", { details });
    expect(shortages).toEqual([
      expect.objectContaining({
        itemId: a.id,
        itemName: a.name,
        locationId: main,
        shortBy: 3,
        onHand: 2,
        salesUnitName: "個",
      }),
    ]);
    const unknown = await systemQuery("stock.shortages", { details: ["x\u0000y\u00001"] });
    expect(unknown[0]?.itemName).toBe("（不明な商品）");
  });
});

describe("棚卸", () => {
  it("保管場所の商品の実際の数を一括で入力し、差を棚卸差異として記録する", async () => {
    const user = await createEmployee(["sales"]);
    const { a, b, main } = await setup();
    await addInitialStock(main, [
      { itemId: a.id, quantity: 10 },
      { itemId: b.id, quantity: 4 },
    ]);
    const page = await (await as(user).get(`/stock/stocktaking?locationId=${main}`)).text();
    expect(page).toContain(a.name);
    expect(page).toContain(b.name);
    expect(page).toContain('name="lineExpected" value="10"');

    const res = await as(user).hx("/stock/stocktaking", {
      locationId: main,
      operationDate: "2026-10-31",
      memo: "月末棚卸",
      lineItemId: [a.id, b.id],
      lineExpected: ["10", "4"],
      lineCounted: ["8", ""],
      _key: newKey(),
    });
    expect(res.status).toBe(204);
    expect(await onHand(a.id, main)).toBe(8);
    expect(await onHand(b.id, main)).toBe(4);
    const detail = await (await as(user).get(res.headers.get("HX-Redirect") ?? "")).text();
    expect(detail).toContain("棚卸の結果");
    expect(detail).toContain("−2");
    const ledger = await (await as(user).get(`/stock/${a.id}?from=&reason=stocktake`)).text();
    expect(ledger).toContain("棚卸差異");
  });

  it("入力中に在庫が動いた商品があれば登録を止め、帳簿在庫を最新にする", async () => {
    const user = await createEmployee(["sales"]);
    const { a, main } = await setup();
    await addInitialStock(main, [{ itemId: a.id, quantity: 10 }]);
    const res = await as(user).hx("/stock/stocktaking", {
      locationId: main,
      operationDate: "2026-10-31",
      lineItemId: a.id,
      lineExpected: "7",
      lineCounted: "9",
      _key: newKey(),
    });
    const html = await res.text();
    expect(html).toContain("入力中に在庫が動いた商品があります");
    expect(html).toContain('name="lineExpected" value="10"');
    expect(html).toContain('value="9"');
    expect(await onHand(a.id, main)).toBe(10);
  });

  it("数えた商品がない・数が不正・権限がない場合はエラー", async () => {
    const sales = await createEmployee(["sales"]);
    const purchasing = await createEmployee(["purchasing"]);
    const { a, main } = await setup();
    const empty = await as(sales).hx("/stock/stocktaking", {
      locationId: main,
      operationDate: "2026-10-31",
      lineItemId: a.id,
      lineExpected: "0",
      lineCounted: "",
      _key: newKey(),
    });
    expect(await empty.text()).toContain("実際の数を1つ以上入力してください");
    const bad = await as(sales).hx("/stock/stocktaking", {
      locationId: main,
      operationDate: "2026-10-31",
      lineItemId: a.id,
      lineExpected: "0",
      lineCounted: "-1",
      _key: newKey(),
    });
    expect(await bad.text()).toContain("実際の数は数字で入力してください");
    const denied = await as(purchasing).hx("/stock/stocktaking", {
      locationId: main,
      operationDate: "2026-10-31",
      lineItemId: a.id,
      lineExpected: "0",
      lineCounted: "1",
      _key: newKey(),
    });
    expect(await denied.text()).toContain("この操作を行う権限がありません");
    expect(await (await as(purchasing).get("/stock/stocktaking")).text()).toContain(
      "権限がありません",
    );
    const choose = await (await as(sales).get("/stock/stocktaking")).text();
    expect(choose).toContain("棚卸をする保管場所を選んでください");
  });

  it("保管場所が見つからない・同じ商品が2行あるときはエラー。取扱終了で在庫0の商品は表に出さない", async () => {
    const user = await createEmployee(["sales"]);
    const { a, b, main } = await setup();
    const unknown = await as(user).hx("/stock/stocktaking", {
      locationId: "NOPE",
      operationDate: "2026-10-31",
      lineItemId: a.id,
      lineExpected: "0",
      lineCounted: "1",
      _key: newKey(),
    });
    expect(await unknown.text()).toContain("保管場所を選んでください");
    const twice = await as(user).hx("/stock/stocktaking", {
      locationId: main,
      operationDate: "2026-10-31",
      lineItemId: [a.id, a.id],
      lineExpected: ["0", "0"],
      lineCounted: ["1", "2"],
      _key: newKey(),
    });
    expect(await twice.text()).toContain("同じ商品が複数の行にあります");

    await addInitialStock(main, [
      { itemId: a.id, quantity: 1 },
      { itemId: b.id, quantity: 1 },
    ]);
    await systemCommand("stockOperations.create", {
      kind: "adjustment",
      reason: "disposal",
      operationDate: "2026-10-20",
      locationId: main,
      lines: [{ itemId: b.id, quantity: -1 }],
    });
    await systemCommand("items.discontinue", { id: b.id, version: 1, discontinued: true });
    const sheet = await systemQuery("stocktakes.sheet", { locationId: main });
    expect(sheet.map((r) => r.item.id)).toEqual([a.id]);
  });

  it("表にない商品を帳簿在庫つきで追加できる", async () => {
    const user = await createEmployee(["sales"]);
    const { a, b, main } = await setup();
    await addInitialStock(main, [{ itemId: b.id, quantity: 2 }]);
    const html = await (
      await as(user).hx("/stock/stocktaking/lines", {
        locationId: main,
        lineItemId: a.id,
        itemIds: [a.id, b.id],
      })
    ).text();
    expect(html).toContain(`data-line-item="${b.id}"`);
    expect(html).not.toContain(`data-line-item="${a.id}"`);
    expect(html).toContain('name="lineExpected" value="2"');
    const none = await as(user).hx("/stock/stocktaking/lines", { locationId: "", itemIds: a.id });
    expect((await none.text()).trim()).toBe("");
  });
});
