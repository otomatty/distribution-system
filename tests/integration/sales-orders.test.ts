/** 受注の登録・編集・取消・分割（要件定義書 3.8）。画面のルートとユースケース、引当の正しさを確かめる */
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import * as schema from "../../src/infra/db/schema";
import { addInitialStock, createLocation } from "./fixtures";
import { as, createEmployee, newKey, systemCommand, systemQuery } from "./helpers";
import { readDb, systemCommandResult } from "./platform-helpers";
import {
  createCustomer,
  createOrder,
  createSalesItem,
  getOrder,
  level,
  salesSetup,
  today,
} from "./sales-fixtures";

/** 受注の作成・編集のフォームの値 */
function orderForm(fields: {
  customerId: string;
  locationId?: string;
  makerDirect?: boolean;
  lines: { itemId: string; quantity: string; price: string; reason?: string }[];
  charges?: { description: string; quantity: string; unitAmount: string; tax?: string }[];
  shipPlannedOn?: string;
  deliveryRequestedOn?: string;
  extra?: Record<string, string | string[]>;
}): Record<string, string | string[]> {
  return {
    _key: newKey(),
    customerId: fields.customerId,
    orderedOn: today(),
    customerContactName: "山田",
    locationId: fields.locationId ?? "",
    ...(fields.makerDirect ? { makerDirect: "on" } : {}),
    employeeId: "",
    deliveryRequestedOn: fields.deliveryRequestedOn ?? "",
    shipPlannedOn: fields.shipPlannedOn ?? today(),
    memo: "",
    lineItemId: fields.lines.map((l) => l.itemId),
    lineQuantity: fields.lines.map((l) => l.quantity),
    linePrice: fields.lines.map((l) => l.price),
    linePriceReason: fields.lines.map((l) => l.reason ?? ""),
    chargeKey: (fields.charges ?? []).map((_, i) => `k${i}`),
    chargeDescription: (fields.charges ?? []).map((c) => c.description),
    chargeQuantity: (fields.charges ?? []).map((c) => c.quantity),
    chargeUnitAmount: (fields.charges ?? []).map((c) => c.unitAmount),
    chargeTaxCategory: (fields.charges ?? []).map((c) => c.tax ?? "standard"),
    ...fields.extra,
  };
}

function orderIdFrom(location: string | null): string {
  const m = /^\/sales-orders\/([0-9A-Z]{26})\?notice=/.exec(location ?? "");
  if (!m?.[1]) throw new Error(`unexpected redirect: ${location ?? "(none)"}`);
  return m[1];
}

describe("受注の登録", () => {
  it("登録すると番号を採番して引き当て、詳細・一覧に出る（金額は明細ごと・税率ごとに丸める）", async () => {
    const user = await createEmployee(["sales"]);
    const { a, b, locationId, customer } = await salesSetup({ a: 10, b: 12 });
    const page = await (await as(user).get("/sales-orders/new")).text();
    expect(page).toContain('id="so-picker"');
    expect(page).toContain(customer.name);

    const res = await as(user).hx(
      "/sales-orders/new",
      orderForm({
        customerId: customer.id,
        locationId,
        lines: [
          { itemId: a.id, quantity: "3", price: "150.50" },
          { itemId: b.id, quantity: "6", price: "100" },
        ],
        charges: [{ description: "送料", quantity: "1", unitAmount: "800" }],
      }),
    );
    expect(res.status).toBe(204);
    const id = orderIdFrom(res.headers.get("HX-Redirect"));
    expect(await level(a.id, locationId)).toEqual({ onHand: 10, allocated: 3, available: 7 });
    expect(await level(b.id, locationId)).toEqual({ onHand: 12, allocated: 6, available: 6 });

    const view = await getOrder(id);
    expect(view.order.number).toMatch(/^SO-\d{4}-\d{6}$/);
    expect(view.order.status).toBe("received");
    expect(view.order.lines.map((l) => [l.itemId, l.quantity, l.taxCategory])).toEqual([
      [a.id, 3, "reduced"],
      [b.id, 6, "standard"],
    ]);
    // 150.50 × 3 = 451.5 → 451（切り捨て）、100 × 6 = 600、送料 800（標準）
    expect(view.evaluation.lines.map((l) => l.amount)).toEqual([451, 600]);
    expect(view.evaluation.summary?.groups).toEqual([
      { category: "standard", rateBps: 1000, subtotal: 1400, tax: 140 },
      { category: "reduced", rateBps: 800, subtotal: 451, tax: 36 },
    ]);
    expect(view.evaluation.summary?.total).toBe(2027);

    const detail = await (await as(user).get(`/sales-orders/${id}?notice=created`)).text();
    expect(detail).toContain("受注を登録しました");
    expect(detail).toContain(view.order.number);
    expect(detail).toContain(a.name);
    expect(detail).toContain("¥2,027");
    expect(detail).toContain("発送する");

    const list = await (
      await as(user).get(`/sales-orders?customerId=${customer.id}&status=received`)
    ).text();
    expect(list).toContain(view.order.number);
    expect(list).toContain("¥2,027");
    const byKeyword = await (
      await as(user).get(`/sales-orders?q=${encodeURIComponent(a.name)}`, { "HX-Request": "true" })
    ).text();
    expect(byKeyword).toContain(view.order.number);
    const otherLocation = await (
      await as(user).get(`/sales-orders?locationId=${await createLocation()}`)
    ).text();
    expect(otherLocation).not.toContain(view.order.number);
    const cancelled = await (
      await as(user).get(`/sales-orders?customerId=${customer.id}&status=cancelled`)
    ).text();
    expect(cancelled).toContain("条件に合う受注はありません");
  });

  it("出荷可能数を超える数量・最低ロットに合わない数量は警告だけで登録でき、在庫不足の一覧に出る", async () => {
    const user = await createEmployee(["sales"]);
    const { a, b, locationId, customer } = await salesSetup({ a: 2, b: 12 });
    const res = await as(user).hx(
      "/sales-orders/new",
      orderForm({
        customerId: customer.id,
        locationId,
        lines: [
          { itemId: a.id, quantity: "5", price: "150.50" },
          { itemId: b.id, quantity: "4", price: "100" },
        ],
      }),
    );
    const id = orderIdFrom(res.headers.get("HX-Redirect"));
    expect(await level(a.id, locationId)).toEqual({ onHand: 2, allocated: 5, available: -3 });
    const detail = await (await as(user).get(`/sales-orders/${id}`)).text();
    expect(detail).toContain("出荷可能数（2）を超えています");
    expect(detail).toContain("最低ロット（6）未満です");
    const view = await getOrder(id);
    const shortage = await (
      await as(user).get(`/sales-orders?shortage=1&customerId=${customer.id}`)
    ).text();
    expect(shortage).toContain(view.order.number);
    expect(shortage).toContain("在庫不足");
    const dashboard = await systemQuery("sales.dashboard", {});
    expect(dashboard.shortage).toBeGreaterThanOrEqual(1);
  });

  it("経理担当・仕入担当は受注を登録できず、登録のボタンも出ない（権限）", async () => {
    const { a, locationId, customer } = await salesSetup();
    for (const roles of [["accounting"], ["purchasing"]] as const) {
      const user = await createEmployee([...roles]);
      const list = await (await as(user).get("/sales-orders")).text();
      expect(list).not.toContain("受注を登録");
      expect(await (await as(user).get("/sales-orders/new")).text()).toContain(
        "受注を登録・編集する権限がありません",
      );
      const res = await as(user).hx(
        "/sales-orders/new",
        orderForm({
          customerId: customer.id,
          locationId,
          lines: [{ itemId: a.id, quantity: "1", price: "150.50" }],
        }),
      );
      expect(await res.text()).toContain("この操作を行う権限がありません");
    }
    expect((await level(a.id, locationId)).allocated).toBe(0);
  });

  it("同じ受付番号で2回送信しても1件だけ登録し、引当も1回分", async () => {
    const user = await createEmployee(["admin"]);
    const { a, locationId, customer } = await salesSetup();
    const form = orderForm({
      customerId: customer.id,
      locationId,
      lines: [{ itemId: a.id, quantity: "4", price: "150.50" }],
    });
    const first = await as(user).hx("/sales-orders/new", form);
    const second = await as(user).hx("/sales-orders/new", form);
    expect(second.headers.get("HX-Redirect")).toBe(first.headers.get("HX-Redirect"));
    expect((await level(a.id, locationId)).allocated).toBe(4);
  });

  it("入力の誤り：販売先・保管場所・明細なし・数量・単価の理由・取扱終了の商品", async () => {
    const user = await createEmployee(["sales"]);
    const { supplierId, a, locationId, customer } = await salesSetup();
    const post = async (form: Record<string, string | string[]>) =>
      (await as(user).hx("/sales-orders/new", form)).text();

    expect(
      await post(
        orderForm({
          customerId: "",
          locationId,
          lines: [{ itemId: a.id, quantity: "1", price: "150.50" }],
        }),
      ),
    ).toContain("販売先を選んでください");
    expect(
      await post(
        orderForm({
          customerId: customer.id,
          lines: [{ itemId: a.id, quantity: "1", price: "150.50" }],
        }),
      ),
    ).toContain("出荷元の保管場所を選んでください");
    expect(await post(orderForm({ customerId: customer.id, locationId, lines: [] }))).toContain(
      "商品を1つ以上追加してください",
    );
    const badQty = await post(
      orderForm({
        customerId: customer.id,
        locationId,
        lines: [{ itemId: a.id, quantity: "x", price: "150.50" }],
      }),
    );
    expect(badQty).toContain("数量は数字で入力してください");
    // 入力した内容は残る
    expect(badQty).toContain(`value="${a.id}"`);
    const zero = await post(
      orderForm({
        customerId: customer.id,
        locationId,
        lines: [{ itemId: a.id, quantity: "0", price: "150.50" }],
      }),
    );
    expect(zero).toContain("1以上で入力してください");
    const noReason = await post(
      orderForm({
        customerId: customer.id,
        locationId,
        lines: [{ itemId: a.id, quantity: "1", price: "140" }],
      }),
    );
    expect(noReason).toContain("単価を卸単価から変えた理由を入力してください");

    const old = await createSalesItem(supplierId);
    const view = await systemQuery("items.get", { id: old.id });
    await systemCommand("items.discontinue", {
      id: old.id,
      version: view!.version,
      discontinued: true,
    });
    expect(
      await post(
        orderForm({
          customerId: customer.id,
          locationId,
          lines: [{ itemId: old.id, quantity: "1", price: "150.50" }],
        }),
      ),
    ).toContain("取扱終了の商品です");
    const otherSupplierOnly = await systemCommandResult("salesOrders.create", {
      customerId: supplierId,
      orderedOn: today(),
      locationId,
      lines: [{ itemId: a.id, quantity: 1, unitPriceCenti: 15_050 }],
    });
    expect(otherSupplierOnly.ok).toBe(false);
    expect((await level(a.id, locationId)).allocated).toBe(0);
  });

  it("単価を変えたときは理由を残す。卸単価のままなら理由は残さない", async () => {
    const user = await createEmployee(["sales"]);
    const { a, b, locationId, customer } = await salesSetup();
    const res = await as(user).hx(
      "/sales-orders/new",
      orderForm({
        customerId: customer.id,
        locationId,
        lines: [
          { itemId: a.id, quantity: "2", price: "120", reason: "長年の取引のため特別単価" },
          { itemId: b.id, quantity: "6", price: "100", reason: "不要な理由" },
        ],
      }),
    );
    const id = orderIdFrom(res.headers.get("HX-Redirect"));
    const view = await getOrder(id);
    expect(view.order.lines.map((l) => [l.unitPriceCenti, l.priceOverrideReason])).toEqual([
      [12_000, "長年の取引のため特別単価"],
      [10_000, null],
    ]);
    const detail = await (await as(user).get(`/sales-orders/${id}`)).text();
    expect(detail).toContain("長年の取引のため特別単価");
    expect(detail).toContain("卸単価 ¥150.50");
  });

  it("メーカー直は保管場所なしで登録でき、引き当てない", async () => {
    const { a, locationId, customer } = await salesSetup();
    const order = await createOrder({
      customerId: customer.id,
      makerDirect: true,
      locationId,
      lines: [{ itemId: a.id, quantity: 50, unitPriceCenti: 15_050 }],
    });
    const view = await getOrder(order.id);
    expect(view.order.makerDirect).toBe(true);
    expect(view.order.locationId).toBeNull();
    expect(view.evaluation.lines[0]?.available).toBeNull();
    expect((await level(a.id, locationId)).allocated).toBe(0);
    const list = await (
      await as(await createEmployee(["accounting"])).get(
        `/sales-orders?locationId=maker&customerId=${customer.id}`,
      )
    ).text();
    expect(list).toContain(order.number);
    expect(list).toContain("メーカー直");
  });

  it("出荷予定日を入力しなければ「納品希望日 − 販売先の配送日数」にする", async () => {
    const { a, locationId } = await salesSetup();
    const customer = await createCustomer({ deliveryDays: 2 });
    const order = await systemCommand("salesOrders.create", {
      customerId: customer.id,
      orderedOn: "2026-11-02",
      deliveryRequestedOn: "2026-11-10",
      locationId,
      lines: [{ itemId: a.id, quantity: 1, unitPriceCenti: 15_050 }],
    });
    expect((await getOrder(order.id)).order.shipPlannedOn).toBe("2026-11-08");
    const noRequest = await systemCommand("salesOrders.create", {
      customerId: customer.id,
      orderedOn: "2026-11-02",
      locationId,
      lines: [{ itemId: a.id, quantity: 1, unitPriceCenti: 15_050 }],
    });
    expect((await getOrder(noRequest.id)).order.shipPlannedOn).toBe("2026-11-02");
  });
});

describe("受注の作成・編集の画面（部分 HTML）", () => {
  it("商品選択ダイアログで選んだ商品を、卸単価・最低ロットを初期値にした行で返す（すでにある商品は除く）", async () => {
    const user = await createEmployee(["sales"]);
    const { a, b, locationId, customer } = await salesSetup({ a: 10, b: 3 });
    const res = await as(user).hx("/sales-orders/form/lines", {
      ...orderForm({
        customerId: customer.id,
        locationId,
        lines: [{ itemId: a.id, quantity: "2", price: "150.50" }],
      }),
      itemIds: [a.id, b.id],
    });
    const html = await res.text();
    expect(html).toContain(`id="so-line-${b.id}"`);
    expect(html).not.toContain(`id="so-line-${a.id}"`);
    expect(html).toContain('value="6"');
    expect(html).toContain('value="100"');
    // 出荷可能数（3）を超えている
    expect(html).toContain("出荷可能数（3）を超えています");
    // 合計欄も差し替える（a 2個 301円（軽減）+ b 6個 600円（標準））
    expect(html).toContain('id="so-totals" hx-swap-oob="true"');
    expect(html).toContain("¥901");
    const empty = await as(user).hx("/sales-orders/form/lines", { itemIds: [], lineItemId: [] });
    expect(await empty.text()).toBe("");
  });

  it("行を変えるとその行と合計欄だけを返し、外すと合計欄だけを返す", async () => {
    const user = await createEmployee(["sales"]);
    const { a, b, locationId, customer } = await salesSetup({ a: 10, b: 12 });
    const base = orderForm({
      customerId: customer.id,
      locationId,
      lines: [
        { itemId: a.id, quantity: "4", price: "150.50" },
        { itemId: b.id, quantity: "6", price: "90" },
      ],
      charges: [{ description: "送料", quantity: "1", unitAmount: "500" }],
    });
    const row = await (
      await as(user).hx("/sales-orders/form/recalc", { ...base, row: a.id })
    ).text();
    expect(row).toContain(`id="so-line-${a.id}"`);
    expect(row).not.toContain(`id="so-line-${b.id}"`);
    expect(row).toContain("¥602");
    expect(row).toContain('id="so-totals"');
    const changed = await (
      await as(user).hx("/sales-orders/form/recalc", { ...base, row: b.id })
    ).text();
    // 単価を変えた行は理由の欄を出す
    expect(changed).toContain(`id="reason-${b.id}"`);
    expect(changed).toContain("登録には理由が必要です");
    const removed = await (
      await as(user).hx("/sales-orders/form/recalc", { ...base, remove: b.id })
    ).text();
    expect(removed).not.toContain("<tr id=");
    expect(removed).toContain('id="so-totals"');
    const charge = await (
      await as(user).hx("/sales-orders/form/recalc", { ...base, charge: "k0" })
    ).text();
    expect(charge).toContain('id="so-charge-k0"');
    expect(charge).toContain("¥500");
    const removeCharge = await (
      await as(user).hx("/sales-orders/form/recalc", { ...base, removeCharge: "k0" })
    ).text();
    expect(removeCharge).not.toContain("¥500");
    const lines = await (
      await as(user).hx("/sales-orders/form/recalc", {
        ...base,
        scope: "lines",
        makerDirect: "on",
      })
    ).text();
    expect(lines).toContain(`id="so-line-${a.id}"`);
    expect(lines).toContain(`id="so-line-${b.id}"`);
    // メーカー直なら出荷可能数を出さない
    expect(lines).not.toContain("現在庫");
    const newCharge = await (await as(user).hx("/sales-orders/form/charge", {})).text();
    expect(newCharge).toContain('name="chargeDescription"');
    expect(newCharge).toContain('value="送料"');
  });

  it("販売先・納品希望日から出荷予定日の初期値を返す", async () => {
    const user = await createEmployee(["sales"]);
    const customer = await createCustomer({ deliveryDays: 3 });
    const html = await (
      await as(user).hx("/sales-orders/form/ship-date", {
        customerId: customer.id,
        deliveryRequestedOn: "2026-12-10",
        orderedOn: "2026-12-01",
      })
    ).text();
    expect(html).toContain('value="2026-12-07"');
    const bad = await (
      await as(user).hx("/sales-orders/form/ship-date", {
        customerId: customer.id,
        deliveryRequestedOn: "2026-13-40",
        shipPlannedOn: "2026-12-01",
      })
    ).text();
    expect(bad).toContain("日付を正しく入力してください");
  });
});

describe("受注の編集", () => {
  it("明細・数量・保管場所を変えると、引当を差分で更新する", async () => {
    const user = await createEmployee(["sales"]);
    const { supplierId, a, b, locationId, customer } = await salesSetup({ a: 10, b: 12 });
    const c2 = await createSalesItem(supplierId);
    const other = await createLocation();
    await addInitialStock(other, [{ itemId: a.id, quantity: 20 }]);
    const order = await createOrder({
      customerId: customer.id,
      locationId,
      lines: [
        { itemId: a.id, quantity: 3, unitPriceCenti: 15_050 },
        { itemId: b.id, quantity: 6, unitPriceCenti: 10_000 },
      ],
    });
    const before = await getOrder(order.id);
    const lineA = before.order.lines.find((l) => l.itemId === a.id);

    const editPage = await (await as(user).get(`/sales-orders/${order.id}/edit`)).text();
    expect(editPage).toContain(`id="so-line-${a.id}"`);
    expect(editPage).toContain('value="150.50"');

    // 同じ保管場所で数量を変え、商品を足し、1つ外す
    const res = await as(user).hx(
      `/sales-orders/${order.id}/edit`,
      orderForm({
        customerId: customer.id,
        locationId,
        lines: [
          { itemId: a.id, quantity: "5", price: "150.50" },
          { itemId: c2.id, quantity: "2", price: "150.50" },
        ],
        extra: { version: String(before.order.version), orderId: order.id },
      }),
    );
    expect(res.headers.get("HX-Redirect")).toBe(`/sales-orders/${order.id}?notice=updated`);
    expect((await level(a.id, locationId)).allocated).toBe(5);
    expect((await level(b.id, locationId)).allocated).toBe(0);
    expect((await level(c2.id, locationId)).allocated).toBe(2);
    const after = await getOrder(order.id);
    // 同じ商品の明細は ID を引き継ぐ
    expect(after.order.lines.find((l) => l.itemId === a.id)?.id).toBe(lineA?.id);

    // 保管場所を変えると、旧保管場所の引当を外して新しい保管場所に引き当てる
    const moved = await as(user).hx(
      `/sales-orders/${order.id}/edit`,
      orderForm({
        customerId: customer.id,
        locationId: other,
        lines: [{ itemId: a.id, quantity: "5", price: "150.50" }],
        extra: { version: String(after.order.version) },
      }),
    );
    expect(moved.status).toBe(204);
    expect((await level(a.id, locationId)).allocated).toBe(0);
    expect((await level(c2.id, locationId)).allocated).toBe(0);
    expect((await level(a.id, other)).allocated).toBe(5);

    // メーカー直に変えると引当を外す
    const maker = await getOrder(order.id);
    await systemCommand("salesOrders.update", {
      id: order.id,
      version: maker.order.version,
      fields: {
        customerId: customer.id,
        orderedOn: today(),
        makerDirect: true,
        lines: [{ itemId: a.id, quantity: 5, unitPriceCenti: 15_050 }],
      },
    });
    expect((await level(a.id, other)).allocated).toBe(0);
  });

  it("古い画面からの保存（版番号の不一致）は競合になり、引当は変わらない", async () => {
    const user = await createEmployee(["sales"]);
    const { a, locationId, customer } = await salesSetup();
    const order = await createOrder({
      customerId: customer.id,
      locationId,
      lines: [{ itemId: a.id, quantity: 3, unitPriceCenti: 15_050 }],
    });
    const v = (await getOrder(order.id)).order.version;
    await systemCommand("salesOrders.update", {
      id: order.id,
      version: v,
      fields: {
        customerId: customer.id,
        orderedOn: today(),
        locationId,
        lines: [{ itemId: a.id, quantity: 4, unitPriceCenti: 15_050 }],
      },
    });
    const stale = await as(user).hx(
      `/sales-orders/${order.id}/edit`,
      orderForm({
        customerId: customer.id,
        locationId,
        lines: [{ itemId: a.id, quantity: "9", price: "150.50" }],
        extra: { version: String(v) },
      }),
    );
    expect(await stale.text()).toContain("ほかの人が先に更新しました");
    expect((await level(a.id, locationId)).allocated).toBe(4);
  });
});

describe("受注の取消", () => {
  it("理由が必要で、取り消すと引当を解除する。取消後は編集・発送できない", async () => {
    const user = await createEmployee(["sales"]);
    const { a, locationId, customer } = await salesSetup();
    const order = await createOrder({
      customerId: customer.id,
      locationId,
      lines: [{ itemId: a.id, quantity: 3, unitPriceCenti: 15_050 }],
    });
    const v = (await getOrder(order.id)).order.version;
    const noReason = await as(user).hx(`/sales-orders/${order.id}/cancel`, {
      _key: newKey(),
      version: String(v),
      reason: "",
    });
    expect(await noReason.text()).toContain("入力してください");
    const key = newKey();
    const ok = await as(user).hx(`/sales-orders/${order.id}/cancel`, {
      _key: key,
      version: String(v),
      reason: "先方の都合で取りやめ",
    });
    const html = await ok.text();
    expect(html).toContain('id="so-detail"');
    expect(html).toContain("受注を取り消しました");
    expect(html).toContain("先方の都合で取りやめ");
    expect(html).not.toContain("発送する");
    // 二重送信でも引当は二重に外さない
    const again = await as(user).hx(`/sales-orders/${order.id}/cancel`, {
      _key: key,
      version: String(v),
      reason: "先方の都合で取りやめ",
    });
    expect(again.status).toBe(200);
    expect((await level(a.id, locationId)).allocated).toBe(0);
    expect((await getOrder(order.id)).order.status).toBe("cancelled");

    const cancelAgain = await systemCommandResult("salesOrders.cancel", {
      id: order.id,
      version: v + 1,
      reason: "もう一度",
    });
    expect(cancelAgain).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    const edit = await as(user).get(`/sales-orders/${order.id}/edit`);
    expect(edit.status).toBe(409);
    const ship = await systemCommandResult("shipments.ship", {
      id: order.id,
      version: v + 1,
      shippedOn: today(),
    });
    expect(ship).toMatchObject({ ok: false, error: { code: "invalid_state" } });
  });

  it("古い版番号の取消は競合になる。仕入担当は取り消せない", async () => {
    const { a, locationId, customer } = await salesSetup();
    const order = await createOrder({
      customerId: customer.id,
      locationId,
      lines: [{ itemId: a.id, quantity: 2, unitPriceCenti: 15_050 }],
    });
    const stale = await systemCommandResult("salesOrders.cancel", {
      id: order.id,
      version: 99,
      reason: "理由",
    });
    expect(stale).toMatchObject({ ok: false, error: { code: "conflict" } });
    const purchasing = await createEmployee(["purchasing"]);
    const detail = await (await as(purchasing).get(`/sales-orders/${order.id}`)).text();
    expect(detail).not.toContain("受注を取り消す");
    expect(detail).not.toContain("発送する");
    const res = await as(purchasing).post(`/sales-orders/${order.id}/cancel`, {
      _key: newKey(),
      version: "1",
      reason: "理由",
    });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("この操作を行う権限がありません");
    expect((await level(a.id, locationId)).allocated).toBe(2);
  });
});

describe("受注の分割", () => {
  it("指定した数量を新しい受注に移す。引当の合計は変わらず、送料は元の受注に残る", async () => {
    const user = await createEmployee(["sales"]);
    const { a, b, locationId, customer } = await salesSetup({ a: 10, b: 12 });
    const order = await createOrder({
      customerId: customer.id,
      locationId,
      lines: [
        { itemId: a.id, quantity: 5, unitPriceCenti: 15_050 },
        { itemId: b.id, quantity: 6, unitPriceCenti: 10_000 },
      ],
      charges: [{ description: "送料", quantity: 1, unitAmount: 800 }],
    });
    const before = await getOrder(order.id);
    const page = await (await as(user).get(`/sales-orders/${order.id}/split`)).text();
    expect(page).toContain("新しい受注に移す数");
    const [lineA, lineB] = before.order.lines;
    const res = await as(user).hx(`/sales-orders/${order.id}/split`, {
      _key: newKey(),
      version: String(before.order.version),
      lineId: [lineA!.id, lineB!.id],
      moveQuantity: ["2", "6"],
      shipPlannedOn: "2026-12-24",
    });
    const location = res.headers.get("HX-Redirect") ?? "";
    expect(location).toMatch(/\?notice=split$/);
    const newId = orderIdFrom(location);
    const original = await getOrder(order.id);
    const split = await getOrder(newId);
    expect(original.order.lines.map((l) => [l.itemId, l.quantity])).toEqual([[a.id, 3]]);
    expect(original.order.charges).toHaveLength(1);
    expect(split.order.splitFromId).toBe(order.id);
    expect(split.order.shipPlannedOn).toBe("2026-12-24");
    expect(split.order.lines.map((l) => [l.itemId, l.quantity])).toEqual([
      [a.id, 2],
      [b.id, 6],
    ]);
    expect(split.order.charges).toHaveLength(0);
    expect((await level(a.id, locationId)).allocated).toBe(5);
    expect((await level(b.id, locationId)).allocated).toBe(6);
    const detail = await (await as(user).get(`/sales-orders/${order.id}`)).text();
    expect(detail).toContain(split.order.number);
    const splitDetail = await (await as(user).get(`/sales-orders/${newId}?notice=split`)).text();
    expect(splitDetail).toContain(order.number);

    // すべて移す・何も移さない・数量を超える分割はできない
    const v = original.order.version;
    const lineA2 = original.order.lines[0]!;
    for (const quantity of ["3", "0", "4"]) {
      const bad = await as(user).hx(`/sales-orders/${order.id}/split`, {
        _key: newKey(),
        version: String(v),
        lineId: [lineA2.id],
        moveQuantity: [quantity],
      });
      expect(await bad.text()).toMatch(/分割/);
    }
    expect((await getOrder(order.id)).order.lines[0]?.quantity).toBe(3);
  });

  it("古い版番号・発送後の受注は分割できない", async () => {
    const { a, locationId, customer } = await salesSetup();
    const order = await createOrder({
      customerId: customer.id,
      locationId,
      lines: [{ itemId: a.id, quantity: 4, unitPriceCenti: 15_050 }],
    });
    const view = await getOrder(order.id);
    const lineId = view.order.lines[0]!.id;
    expect(
      await systemCommandResult("salesOrders.split", {
        id: order.id,
        version: 99,
        moves: [{ lineId, quantity: 1 }],
      }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    await systemCommand("shipments.ship", {
      id: order.id,
      version: view.order.version,
      shippedOn: today(),
    });
    expect(
      await systemCommandResult("salesOrders.split", {
        id: order.id,
        version: view.order.version + 1,
        moves: [{ lineId, quantity: 1 }],
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_state" } });
  });
});

describe("受注一覧の CSV", () => {
  it("一覧と同じ絞り込みで、日本語の列名の CSV を返す", async () => {
    const user = await createEmployee(["accounting"]);
    const { a, locationId, customer } = await salesSetup();
    const order = await createOrder({
      customerId: customer.id,
      locationId,
      lines: [{ itemId: a.id, quantity: 2, unitPriceCenti: 15_050 }],
    });
    const res = await as(user).post("/sales-orders/csv", {
      _key: newKey(),
      customerId: customer.id,
      status: "received",
    });
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    const csv = await res.text();
    const rows = csv
      .replace(/^﻿/, "")
      .split("\r\n")
      .filter((l) => l !== "");
    expect(rows[0]).toContain("受注番号,状態");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain(order.number);
    expect(rows[1]).toContain("受注済み");
    // 150.50 × 2 = 301（軽減 8%：24）→ 325
    expect(rows[1]).toContain(",301,325,");
  });
});

describe("受注の業務エラーと境界", () => {
  const BOGUS = "01ZZZZZZZZZZZZZZZZZZZZZZZZ";
  const notFound = { ok: false, error: { code: "not_found" } };

  it("存在しない受注・発送は見つからない", async () => {
    const user = await createEmployee(["sales"]);
    expect((await as(user).get(`/sales-orders/${BOGUS}`)).status).toBe(404);
    expect((await as(user).get(`/sales-orders/${BOGUS}/edit`)).status).toBe(404);
    expect((await as(user).get(`/sales-orders/${BOGUS}/split`)).status).toBe(404);
    const fields = { customerId: BOGUS, orderedOn: today(), lines: [] };
    expect(
      await systemCommandResult("salesOrders.update", { id: BOGUS, version: 1, fields }),
    ).toMatchObject(notFound);
    expect(
      await systemCommandResult("salesOrders.cancel", { id: BOGUS, version: 1, reason: "理由" }),
    ).toMatchObject(notFound);
    expect(
      await systemCommandResult("salesOrders.split", { id: BOGUS, version: 1, moves: [] }),
    ).toMatchObject(notFound);
    expect(
      await systemCommandResult("shipments.ship", { id: BOGUS, version: 1, shippedOn: today() }),
    ).toMatchObject(notFound);
    expect(
      await systemCommandResult("shipments.cancel", {
        shipmentId: BOGUS,
        version: 1,
        reason: "理由",
      }),
    ).toMatchObject(notFound);
  });

  it("取引終了の販売先・保管場所は新しく選べないが、登録済みの受注はそのまま編集できる", async () => {
    const { a, locationId, customer } = await salesSetup();
    const order = await createOrder({
      customerId: customer.id,
      locationId,
      lines: [{ itemId: a.id, quantity: 1, unitPriceCenti: 15_050 }],
    });
    const partner = await systemQuery("partners.get", { id: customer.id });
    await systemCommand("partners.archive", {
      id: customer.id,
      version: partner!.version,
      archived: true,
    });
    const location = await systemQuery("locations.get", { id: locationId });
    await systemCommand("locations.archive", {
      id: locationId,
      version: location!.version,
      archived: true,
    });
    const input = {
      customerId: customer.id,
      orderedOn: today(),
      locationId,
      lines: [{ itemId: a.id, quantity: 2, unitPriceCenti: 15_050 }],
    };
    expect(await systemCommandResult("salesOrders.create", input)).toMatchObject({
      ok: false,
      error: { message: "取引終了の販売先は選べません" },
    });
    const otherCustomer = await createCustomer();
    expect(
      await systemCommandResult("salesOrders.create", { ...input, customerId: otherCustomer.id }),
    ).toMatchObject({ ok: false, error: { message: "取引終了の保管場所は選べません" } });
    const v = (await getOrder(order.id)).order.version;
    expect(
      await systemCommandResult("salesOrders.update", { id: order.id, version: v, fields: input }),
    ).toMatchObject({ ok: true });
    expect((await level(a.id, locationId)).allocated).toBe(2);
  });

  it("存在しない保管場所・担当者・商品は選べない。担当者を選べば記録する", async () => {
    const { a, locationId, customer } = await salesSetup();
    const input = {
      customerId: customer.id,
      orderedOn: today(),
      locationId,
      lines: [{ itemId: a.id, quantity: 1, unitPriceCenti: 15_050 }],
    };
    expect(
      await systemCommandResult("salesOrders.create", { ...input, locationId: BOGUS }),
    ).toMatchObject({ ok: false, error: { message: "保管場所を選んでください" } });
    expect(
      await systemCommandResult("salesOrders.create", { ...input, employeeId: BOGUS }),
    ).toMatchObject({ ok: false, error: { message: "担当者を選んでください" } });
    expect(
      await systemCommandResult("salesOrders.create", {
        ...input,
        lines: [{ itemId: BOGUS, quantity: 1, unitPriceCenti: 100 }],
      }),
    ).toMatchObject({ ok: false, error: { message: "登録されていない商品が含まれています" } });
    const email = await createEmployee(["sales"], "受注担当");
    const employee = (await systemQuery("employees.list", {})).find((e) => e.email === email);
    const order = await createOrder({ ...input, employeeId: employee!.id });
    expect((await getOrder(order.id)).order.employeeName).toBe("受注担当");
  });

  it("入力途中の計算：知らない商品は除き、未入力の明細・送料は合計に含めず、税率のない日は合計を出さない", async () => {
    const { a, b, customer, locationId } = await salesSetup();
    const preview = await systemQuery("salesOrders.preview", {
      orderedOn: "不正な日付",
      locationId,
      lines: [
        { itemId: a.id, quantity: 2, unitPriceCenti: null, priceOverrideReason: null },
        { itemId: b.id, quantity: 6, unitPriceCenti: 10_000, priceOverrideReason: null },
        { itemId: BOGUS, quantity: 1, unitPriceCenti: 1, priceOverrideReason: null },
      ],
      charges: [
        { description: "送料", quantity: 1, unitAmount: null },
        { description: "代引手数料", quantity: 1, unitAmount: 330 },
      ],
    });
    expect(preview.lines.map((l) => [l.itemId, l.amount])).toEqual([
      [a.id, null],
      [b.id, 600],
    ]);
    expect(preview.chargeAmounts).toEqual([null, 330]);
    expect(preview.incomplete).toBe(true);
    expect(preview.summary?.subtotal).toBe(930);

    const old = await systemQuery("salesOrders.preview", {
      orderedOn: "2018-01-01",
      locationId,
      lines: [{ itemId: a.id, quantity: 1, unitPriceCenti: 15_050, priceOverrideReason: null }],
    });
    expect(old.summary).toBeNull();
    expect(old.lines[0]?.amount).toBe(150);

    // 税率のない日の受注は、一覧の合計を出さず、詳細で知らせる
    const order = await createOrder({
      customerId: customer.id,
      orderedOn: "2018-01-01",
      locationId,
      lines: [{ itemId: a.id, quantity: 1, unitPriceCenti: 15_050 }],
    });
    const list = await systemQuery("salesOrders.list", {
      customerId: customer.id,
      q: order.number,
    });
    expect(list.rows[0]?.total).toBeNull();
    const user = await createEmployee(["sales"]);
    const detail = await (await as(user).get(`/sales-orders/${order.id}`)).text();
    expect(detail).toContain("受注日の税率が設定されていないため");
    // 発送日の税率もなければ発送できない（納品書の金額を決められない）
    expect(
      await systemCommandResult("shipments.ship", {
        id: order.id,
        version: (await getOrder(order.id)).order.version,
        shippedOn: "2018-01-02",
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_state" } });
  });

  it("出荷予定日の初期値：納品希望日がなければ受注日（それもなければ今日）、販売先がなければ配送日数0日", async () => {
    expect(await systemQuery("salesOrders.defaultShipDate", {})).toBe(today());
    expect(await systemQuery("salesOrders.defaultShipDate", { orderedOn: "2026-12-01" })).toBe(
      "2026-12-01",
    );
    expect(
      await systemQuery("salesOrders.defaultShipDate", { deliveryRequestedOn: "2026-12-10" }),
    ).toBe("2026-12-10");
    expect(
      await systemQuery("salesOrders.defaultShipDate", {
        customerId: BOGUS,
        deliveryRequestedOn: "2026-12-10",
      }),
    ).toBe("2026-12-10");
  });

  it("引当と受注が食い違っていれば（引当数が0未満になるなら）、編集・取消・発送をしない", async () => {
    const { a, locationId, customer } = await salesSetup();
    const order = await createOrder({
      customerId: customer.id,
      locationId,
      lines: [{ itemId: a.id, quantity: 3, unitPriceCenti: 15_050 }],
    });
    // 何かの誤りで集計表の引当数が0になった
    await readDb((db) =>
      db
        .update(schema.stockBalances)
        .set({ allocated: 0 })
        .where(
          and(
            eq(schema.stockBalances.itemId, a.id),
            eq(schema.stockBalances.locationId, locationId),
          ),
        )
        .run(),
    );
    const v = (await getOrder(order.id)).order.version;
    const fields = {
      customerId: customer.id,
      orderedOn: today(),
      locationId,
      lines: [{ itemId: a.id, quantity: 1, unitPriceCenti: 15_050 }],
    };
    const invalid = { ok: false, error: { code: "invalid_state" } };
    expect(
      await systemCommandResult("salesOrders.update", { id: order.id, version: v, fields }),
    ).toMatchObject(invalid);
    expect(
      await systemCommandResult("salesOrders.cancel", { id: order.id, version: v, reason: "理由" }),
    ).toMatchObject(invalid);
    expect(
      await systemCommandResult("shipments.ship", { id: order.id, version: v, shippedOn: today() }),
    ).toMatchObject(invalid);
    expect((await getOrder(order.id)).order.status).toBe("received");
  });

  it("分割で出荷予定日を入れなければ元の受注と同じ日。移さない明細は元の受注に残る", async () => {
    const { a, b, locationId, customer } = await salesSetup();
    const order = await createOrder({
      customerId: customer.id,
      locationId,
      shipPlannedOn: "2026-11-30",
      lines: [
        { itemId: a.id, quantity: 4, unitPriceCenti: 15_050 },
        { itemId: b.id, quantity: 6, unitPriceCenti: 10_000 },
      ],
    });
    const view = await getOrder(order.id);
    const [lineA, lineB] = view.order.lines;
    const split = await systemCommand("salesOrders.split", {
      id: order.id,
      version: view.order.version,
      moves: [
        { lineId: lineA!.id, quantity: 1 },
        { lineId: lineB!.id, quantity: 0 },
      ],
    });
    const created = await getOrder(split.id);
    expect(created.order.shipPlannedOn).toBe("2026-11-30");
    expect(created.order.lines.map((l) => [l.itemId, l.quantity])).toEqual([[a.id, 1]]);
    expect((await getOrder(order.id)).order.lines.map((l) => [l.itemId, l.quantity])).toEqual([
      [a.id, 3],
      [b.id, 6],
    ]);
  });
});
