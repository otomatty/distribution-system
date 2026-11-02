import { describe, expect, it } from "vitest";

import { createItem, createLocation, createSupplier, uniqueName } from "./fixtures";
import { as, createEmployee, newKey, systemCommand, systemQuery } from "./helpers";
import { documentRow, readDb, sendRows, systemCommandResult } from "./platform-helpers";
import {
  createConfirmedOrder,
  createCustomer,
  createOrder,
  createSupplierWithTerms,
  orderView,
  purchasingSetup,
  receive,
} from "./purchasing-fixtures";

function orderForm(
  supplierId: string,
  locationId: string,
  lines: { itemId: string; quantity: string; price: string; memo?: string }[],
  overrides: Record<string, string> = {},
) {
  return {
    _key: newKey(),
    supplierId,
    orderedOn: "2026-10-01",
    supplierContactName: "",
    destinationKind: "location",
    destinationLocationId: locationId,
    destinationCustomerId: "",
    destinationAddress: "",
    employeeId: "",
    deliveryRequestedOn: "",
    paymentDueOn: "",
    memo: "",
    lineItemId: lines.map((l) => l.itemId),
    lineQuantity: lines.map((l) => l.quantity),
    linePrice: lines.map((l) => l.price),
    lineMemo: lines.map((l) => l.memo ?? ""),
    ...overrides,
  };
}

function idFrom(location: string): string {
  const m = /^\/purchase-orders\/([0-9A-Z]{26})/.exec(location);
  if (!m?.[1]) throw new Error(`発注の URL ではありません: ${location}`);
  return m[1];
}

describe("発注の作成・編集", () => {
  it("仕入担当は仕入先を選んで発注を作成でき、金額は明細ごと・税は税率ごとに計算する", async () => {
    const user = await createEmployee(["purchasing"]);
    const supplierId = await createSupplierWithTerms();
    const locationId = await createLocation();
    const a = await createItem(supplierId);
    const step1 = await (await as(user).get("/purchase-orders/new")).text();
    expect(step1).toContain("発注書は仕入先ごとに1枚です");
    const page = await (await as(user).get(`/purchase-orders/new?supplierId=${supplierId}`)).text();
    expect(page).toContain('id="po-picker"');
    expect(page).toContain(`name="supplierId" value="${supplierId}"`);
    expect(page).toContain("取引条件から自動で計算します");

    const res = await as(user).hx(
      "/purchase-orders/new",
      orderForm(supplierId, locationId, [{ itemId: a.id, quantity: "3", price: "1,234.56" }], {
        deliveryRequestedOn: "2026-10-20",
      }),
    );
    expect(res.status).toBe(204);
    const location = res.headers.get("HX-Redirect") ?? "";
    const view = await orderView(idFrom(location));
    expect(view.order.number).toMatch(/^PO-2026-\d{6}$/);
    expect(view.order.status).toBe("draft");
    // 1,234.56 × 3 = 3,703.68 → 3,703（切り捨て）、軽減税率 8% → 296
    expect(view.order.subtotal).toBe(3703);
    expect(view.order.tax).toBe(296);
    expect(view.order.total).toBe(3999);
    // 入数と税区分を明細に写す
    expect(view.order.lines[0]?.unitsPerPurchaseUnit).toBe(12);
    expect(view.order.lines[0]?.taxCategory).toBe("reduced");
    // 月末締め翌月末払い：納品希望日 10/20 → 11/30
    expect(view.order.paymentDueOn).toBe("2026-11-30");
    const html = await (await as(user).get(location)).text();
    expect(html).toContain("作成中");
    expect(html).toContain("¥3,999");
    expect(html).toContain("確定して送付する");
  });

  it("同じ受付番号で2回送っても発注は1件だけ", async () => {
    const user = await createEmployee(["purchasing"]);
    const { supplierId, locationId, a } = await purchasingSetup();
    const form = orderForm(supplierId, locationId, [{ itemId: a.id, quantity: "1", price: "100" }]);
    const first = await as(user).hx("/purchase-orders/new", form);
    const second = await as(user).hx("/purchase-orders/new", form);
    expect(second.headers.get("HX-Redirect")).toBe(first.headers.get("HX-Redirect"));
    const list = await systemQuery("purchaseOrders.list", { supplierId });
    expect(list.total).toBe(1);
  });

  it("受注・出荷担当と経理担当は発注を作成できない（権限）", async () => {
    const { supplierId, locationId, a } = await purchasingSetup();
    for (const role of ["sales", "accounting"] as const) {
      const user = await createEmployee([role]);
      const page = await (
        await as(user).get(`/purchase-orders/new?supplierId=${supplierId}`)
      ).text();
      expect(page).toContain("発注を作成する権限がありません");
      const res = await as(user).hx(
        "/purchase-orders/new",
        orderForm(supplierId, locationId, [{ itemId: a.id, quantity: "1", price: "100" }]),
      );
      expect(await res.text()).toContain("この操作を行う権限がありません");
    }
    expect((await systemQuery("purchaseOrders.list", { supplierId })).total).toBe(0);
  });

  it("ほかの仕入先の商品・取扱終了の商品・単価の未入力・発注時に仕入価格を入力する商品の 0 円はエラー", async () => {
    const user = await createEmployee(["purchasing"]);
    const { supplierId, locationId, a } = await purchasingSetup();
    const other = await createItem(await createSupplier());
    const wrong = await as(user).hx(
      "/purchase-orders/new",
      orderForm(supplierId, locationId, [{ itemId: other.id, quantity: "1", price: "100" }]),
    );
    const wrongHtml = await wrong.text();
    expect(wrongHtml).toContain("この仕入先の取扱商品ではありません");
    const market = await systemCommand("items.create", {
      name: uniqueName("相場の商品"),
      supplierId,
      taxCategory: "reduced",
      purchaseUnitName: "箱",
      salesUnitName: "個",
      unitsPerPurchaseUnit: 10,
      purchasePriceCenti: 0,
      salesPriceCenti: 10_000,
      inputPriceOnOrder: true,
    });
    const noPrice = await as(user).hx(
      "/purchase-orders/new",
      orderForm(supplierId, locationId, [
        { itemId: market.id, quantity: "1", price: "0" },
        { itemId: a.id, quantity: "2", price: "" },
      ]),
    );
    const html = await noPrice.text();
    expect(html).toContain("この商品は発注時に仕入価格を入力してください");
    // 入力した行は残る
    expect(html).toContain(`value="${market.id}"`);
    expect(html).toContain(`value="${a.id}"`);
    const badQty = await as(user).hx(
      "/purchase-orders/new",
      orderForm(supplierId, locationId, [{ itemId: a.id, quantity: "0", price: "100" }]),
    );
    expect(await badQty.text()).toContain("数量は1以上で入力してください");
    await systemCommand("items.discontinue", { id: a.id, version: 1, discontinued: true });
    const discontinued = await as(user).hx(
      "/purchase-orders/new",
      orderForm(supplierId, locationId, [{ itemId: a.id, quantity: "1", price: "100" }]),
    );
    expect(await discontinued.text()).toContain("取扱終了の商品です");
    const noDestination = await as(user).hx("/purchase-orders/new", orderForm(supplierId, "", []));
    expect(await noDestination.text()).toContain("保管場所を選んでください");
    const other2 = await as(user).hx(
      "/purchase-orders/new",
      orderForm(supplierId, "", [], { destinationKind: "other" }),
    );
    expect(await other2.text()).toContain("届け先の名前と住所を入力してください");
  });

  it("メーカー直（販売先）とその他の届け先を納入先にできる", async () => {
    const { supplierId, a } = await purchasingSetup();
    const customerId = await createCustomer();
    const direct = await createOrder({
      supplierId,
      customerId,
      lines: [{ itemId: a.id, quantity: 1 }],
    });
    const view = await orderView(direct.id);
    expect(view.order.destinationKind).toBe("customer");
    expect(view.order.destinationLocationId).toBeNull();
    const other = await systemCommand("purchaseOrders.create", {
      supplierId,
      orderedOn: "2026-10-01",
      destinationKind: "other",
      destinationAddress: "イベント会場\n岩手県大船渡市",
      // 選ばれていない納入先の値は保存しない
      destinationLocationId: "ignored",
      lines: [],
    });
    const otherView = await orderView(other.id);
    expect(otherView.order.destinationAddress).toBe("イベント会場\n岩手県大船渡市");
    expect(otherView.order.destinationLocationId).toBeNull();
  });

  it("商品選択ダイアログの行の追加・数量の変更・行を外すと、金額と合計を計算し直して返す", async () => {
    const user = await createEmployee(["purchasing"]);
    const { supplierId, locationId, a, b } = await purchasingSetup();
    const other = await createItem(await createSupplier());
    const added = await as(user).hx("/purchase-orders/lines", {
      supplierId,
      orderedOn: "2026-10-01",
      lineItemId: [a.id],
      lineQuantity: ["1"],
      linePrice: ["1200"],
      lineMemo: [""],
      itemIds: [a.id, b.id, other.id],
    });
    const html = await added.text();
    // すでにある商品とほかの仕入先の商品は追加しない
    expect(html).toContain(`data-line-item="${b.id}"`);
    expect(html).not.toContain(`data-line-item="${a.id}"`);
    expect(html).not.toContain(other.id);
    // 新しい行は仕入価格が初期値。合計は既存の行も含める（1,200 + 1,200 = 2,400、税 192）
    expect(html).toContain('value="1200"');
    expect(html).toContain('id="po-totals"');
    expect(html).toContain("¥2,592");

    const recalc = await as(user).hx("/purchase-orders/lines/recalc", {
      changed: a.id,
      orderedOn: "2026-10-01",
      lineItemId: [a.id, b.id],
      lineQuantity: ["3", "1"],
      linePrice: ["1200", "abc"],
      lineMemo: ["", ""],
    });
    const r = await recalc.text();
    expect(r).toContain(`id="po-amount-${a.id}"`);
    expect(r).toContain("¥3,600");
    // 不正な単価の行は合計に含めない（3,600 + 税 288）
    expect(r).toContain("¥3,888");
    const removed = await as(user).hx("/purchase-orders/lines/recalc", {
      removed: a.id,
      orderedOn: "2026-10-01",
      lineItemId: [a.id, b.id],
      lineQuantity: ["3", "2"],
      linePrice: ["1200", "1000"],
      lineMemo: ["", ""],
    });
    const rem = await removed.text();
    expect(rem).not.toContain(`po-amount-${a.id}`);
    // 2,000 + 税 160
    expect(rem).toContain("¥2,160");
    const empty = await as(user).hx("/purchase-orders/lines", { supplierId, orderedOn: "x" });
    expect(await empty.text()).toBe("");
    void locationId;
  });

  it("作成中の発注は編集でき、古い版での保存と確定後の編集はエラー", async () => {
    const user = await createEmployee(["purchasing"]);
    const { supplierId, locationId, a, b } = await purchasingSetup();
    const po = await createOrder({
      supplierId,
      locationId,
      lines: [{ itemId: a.id, quantity: 1 }],
    });
    const edit = await (await as(user).get(`/purchase-orders/${po.id}/edit`)).text();
    expect(edit).toContain(`data-line-item="${a.id}"`);
    const form = orderForm(supplierId, locationId, [
      { itemId: a.id, quantity: "2", price: "1200" },
      { itemId: b.id, quantity: "1", price: "600", memo: "急ぎ" },
    ]);
    const saved = await as(user).hx(`/purchase-orders/${po.id}/edit`, { ...form, version: "1" });
    expect(saved.status).toBe(204);
    const view = await orderView(po.id);
    expect(view.order.lines.map((l) => l.quantity)).toEqual([2, 1]);
    expect(view.order.lines[1]?.memo).toBe("急ぎ");
    expect(view.order.subtotal).toBe(3000);
    const stale = await as(user).hx(`/purchase-orders/${po.id}/edit`, {
      ...form,
      _key: newKey(),
      version: "1",
    });
    expect(await stale.text()).toContain("ほかの人が先に更新しました");
    await systemCommand("purchaseOrders.confirm", {
      id: po.id,
      version: 2,
      sendMethod: "none",
      recipient: null,
    });
    const after = await as(user).hx(`/purchase-orders/${po.id}/edit`, {
      ...form,
      _key: newKey(),
      version: "3",
    });
    expect(await after.text()).toContain("作成中の発注だけを編集できます");
    // 確定後は編集の画面に入れない
    const editPage = await as(user).get(`/purchase-orders/${po.id}/edit`);
    expect(editPage.status).toBe(303);
  });
});

describe("確定と送付", () => {
  it("送付しないで確定すると、発注書を発行して発注済みになる（明細がなければエラー）", async () => {
    const user = await createEmployee(["purchasing"]);
    const { supplierId, locationId, a } = await purchasingSetup();
    const empty = await createOrder({ supplierId, locationId, lines: [] });
    const noLines = await as(user).hx(`/purchase-orders/${empty.id}/confirm`, {
      _key: newKey(),
      version: "1",
      sendMethod: "none",
      recipient: "",
    });
    expect(await noLines.text()).toContain("明細を1行以上入力してください");

    const po = await createOrder({
      supplierId,
      locationId,
      lines: [{ itemId: a.id, quantity: 2 }],
      memo: "午前着でお願いします",
    });
    const res = await as(user).hx(`/purchase-orders/${po.id}/confirm`, {
      _key: newKey(),
      version: "1",
      sendMethod: "none",
      recipient: "",
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("HX-Redirect")).toContain("notice=confirmed");
    const view = await orderView(po.id);
    expect(view.order.status).toBe("ordered");
    expect(view.order.confirmedAt).not.toBeNull();
    expect(view.documents).toHaveLength(1);
    expect(view.sends).toHaveLength(0);
    const doc = await documentRow(view.documents[0]?.id ?? "");
    expect(doc?.documentType).toBe("purchase_order");
    expect(doc?.number).toBe(po.number);
    expect(doc?.amount).toBe(view.order.total);
    const snapshot = JSON.parse(doc?.snapshotJson ?? "{}");
    expect(snapshot.lines[0].amount).toBe(2400);
    expect(snapshot.memo).toBe("午前着でお願いします");
    expect(snapshot.taxGroups).toEqual([
      { category: "reduced", rateBps: 800, subtotal: 2400, tax: 192 },
    ]);
    const html = await (await as(user).get(`/purchase-orders/${po.id}`)).text();
    expect(html).toContain("発注書と送付履歴");
    expect(html).toContain("手動で送付した");
    expect(html).not.toContain("確定して送付する");
    // 確定済みの発注は確定し直せない
    const again = await systemCommandResult("purchaseOrders.confirm", {
      id: po.id,
      version: 2,
      sendMethod: "none",
      recipient: null,
    });
    expect(again.ok).toBe(false);
  });

  it("メールで送る確定は宛先が必要で、送付履歴に登録される", async () => {
    const user = await createEmployee(["admin"]);
    const { supplierId, locationId, a } = await purchasingSetup();
    const po = await createOrder({
      supplierId,
      locationId,
      lines: [{ itemId: a.id, quantity: 1 }],
    });
    const noTo = await as(user).hx(`/purchase-orders/${po.id}/confirm`, {
      _key: newKey(),
      version: "1",
      sendMethod: "email",
      recipient: "",
    });
    expect(await noTo.text()).toContain("メールで送る場合は宛先を入力してください");
    const bad = await as(user).hx(`/purchase-orders/${po.id}/confirm`, {
      _key: newKey(),
      version: "1",
      sendMethod: "email",
      recipient: "not-an-email",
    });
    expect(await bad.text()).toContain("メールアドレスの形式が正しくありません");
    expect((await orderView(po.id)).order.status).toBe("draft");
    const form = {
      _key: newKey(),
      version: "1",
      sendMethod: "email",
      recipient: "Order@Example.com",
    };
    const res = await as(user).hx(`/purchase-orders/${po.id}/confirm`, form);
    expect(res.headers.get("HX-Redirect")).toContain("notice=sent");
    // 二重送信でも発行と送付は1回だけ
    await as(user).hx(`/purchase-orders/${po.id}/confirm`, form);
    const view = await orderView(po.id);
    expect(view.documents).toHaveLength(1);
    const sends = await sendRows(view.documents[0]?.id ?? "");
    expect(sends).toHaveLength(1);
    expect(sends[0]?.recipient).toBe("order@example.com");
    expect(sends[0]?.status).toBe("pending");
    const html = await (await as(user).get(`/purchase-orders/${po.id}`)).text();
    expect(html).toContain("order@example.com");
    expect(html).toContain("送信中");
  });
});

describe("取消とメモ", () => {
  it("取消は理由が必要で、入荷前だけできる。発注書も取消済みになる", async () => {
    const user = await createEmployee(["purchasing"]);
    const { supplierId, locationId, a } = await purchasingSetup();
    const po = await createConfirmedOrder({
      supplierId,
      locationId,
      lines: [{ itemId: a.id, quantity: 1 }],
    });
    const noReason = await as(user).hx(`/purchase-orders/${po.id}/cancel`, {
      _key: newKey(),
      version: "2",
      reason: " ",
    });
    expect(await noReason.text()).toContain("入力してください");
    const res = await as(user).hx(`/purchase-orders/${po.id}/cancel`, {
      _key: newKey(),
      version: "2",
      reason: "数量の誤り",
    });
    expect(res.headers.get("HX-Redirect")).toContain("notice=cancelled");
    const view = await orderView(po.id);
    expect(view.order.status).toBe("cancelled");
    expect(view.order.cancelReason).toBe("数量の誤り");
    expect(view.documents[0]?.cancelled).toBe(true);

    const received = await createConfirmedOrder({
      supplierId,
      locationId,
      lines: [{ itemId: a.id, quantity: 5 }],
    });
    await receive(received.id, [1]);
    const v = await orderView(received.id);
    expect(v.actions.cancel).toBe(false);
    const after = await as(user).hx(`/purchase-orders/${received.id}/cancel`, {
      _key: newKey(),
      version: String(v.order.version),
      reason: "不要",
    });
    expect(await after.text()).toContain("入荷が記録された発注は取り消せません");
  });

  it("メモは状態に関係なく編集でき、メモの欄だけを返す", async () => {
    const user = await createEmployee(["purchasing"]);
    const { supplierId, locationId, a } = await purchasingSetup();
    const po = await createConfirmedOrder({
      supplierId,
      locationId,
      lines: [{ itemId: a.id, quantity: 1 }],
    });
    const res = await as(user).hx(`/purchase-orders/${po.id}/memo`, {
      _key: newKey(),
      version: "2",
      memo: "電話で納期を確認済み",
    });
    const html = await res.text();
    expect(html.startsWith('<section class="card" id="po-memo">')).toBe(true);
    expect(html).toContain("メモを保存しました");
    expect(html).toContain('name="version" value="3"');
    expect((await orderView(po.id)).order.memo).toBe("電話で納期を確認済み");
    const stale = await as(user).hx(`/purchase-orders/${po.id}/memo`, {
      _key: newKey(),
      version: "2",
      memo: "古い画面から",
    });
    expect(await stale.text()).toContain("ほかの人が先に更新しました");
    const audit = await readDb((db) =>
      db.query.auditLogs.findMany({ where: (l, { eq }) => eq(l.entityId, po.id) }),
    );
    expect(audit.map((l) => l.action)).toEqual(
      expect.arrayContaining(["create", "confirm", "update_memo"]),
    );
    const sales = await createEmployee(["sales"]);
    const page = await (await as(sales).get(`/purchase-orders/${po.id}`)).text();
    expect(page).not.toContain("メモを保存");
    expect(page).toContain("電話で納期を確認済み");
  });
});

describe("発注一覧", () => {
  it("状態・仕入先・期間・メモの有無・キーワード・納品希望日の超過で絞り込み、CSV も同じ条件", async () => {
    const user = await createEmployee(["accounting"]);
    const { supplierId, locationId, a } = await purchasingSetup();
    const draft = await createOrder({
      supplierId,
      locationId,
      lines: [{ itemId: a.id, quantity: 1 }],
      orderedOn: "2026-09-01",
      memo: "要確認",
    });
    const ordered = await createConfirmedOrder({
      supplierId,
      locationId,
      lines: [{ itemId: a.id, quantity: 1 }],
      orderedOn: "2026-10-05",
      deliveryRequestedOn: "2026-10-06",
    });
    const base = `/purchase-orders?supplierId=${supplierId}`;
    const all = await (await as(user).get(base)).text();
    expect(all).toContain(draft.number);
    expect(all).toContain(ordered.number);
    const drafts = await (await as(user).get(`${base}&status=draft`)).text();
    expect(drafts).toContain(draft.number);
    expect(drafts).not.toContain(ordered.number);
    const memo = await (await as(user).get(`${base}&memo=1`)).text();
    expect(memo).toContain(draft.number);
    expect(memo).not.toContain(ordered.number);
    const period = await (await as(user).get(`${base}&from=2026-10-01&to=2026-10-31`)).text();
    expect(period).not.toContain(draft.number);
    expect(period).toContain(ordered.number);
    const keyword = await (await as(user).get(`${base}&q=${encodeURIComponent(a.name)}`)).text();
    expect(keyword).toContain(draft.number);
    const overdue = await (await as(user).get(`${base}&overdue=1`)).text();
    expect(overdue).toContain(ordered.number);
    expect(overdue).not.toContain(draft.number);
    // 経理担当は閲覧はできるが作成のボタンは出ない
    expect(all).not.toContain("発注を作成");

    const csv = await as(user).post("/purchase-orders/csv", {
      _key: newKey(),
      supplierId,
      status: "ordered",
    });
    expect(csv.headers.get("Content-Type")).toContain("text/csv");
    const text = await csv.text();
    expect(text.replace(/^\uFEFF/, "").startsWith("発注番号,状態,発注日")).toBe(true);
    expect(text).toContain(ordered.number);
    expect(text).not.toContain(draft.number);
  });
});

describe("ダッシュボード", () => {
  it("仕入の欄に作成中・送付失敗・入荷予定日超過の件数を出し、支払の欄は経理に出す", async () => {
    const { supplierId, locationId, a } = await purchasingSetup();
    await createOrder({ supplierId, locationId, lines: [{ itemId: a.id, quantity: 1 }] });
    await createConfirmedOrder({
      supplierId,
      locationId,
      lines: [{ itemId: a.id, quantity: 1 }],
      deliveryRequestedOn: "2026-01-05",
    });
    const summary = await systemQuery("purchasing.dashboard", {});
    expect(summary.draftOrders).toBeGreaterThanOrEqual(1);
    expect(summary.overdueReceipts).toBeGreaterThanOrEqual(1);
    expect(summary.payablesThisWeek.from <= summary.today).toBe(true);
    const purchasing = await createEmployee(["purchasing"]);
    const html = await (await as(purchasing).get("/")).text();
    expect(html).toContain("作成中のままの発注");
    expect(html).toContain("/purchase-orders?status=draft");
    expect(html).toContain("入荷予定日を過ぎた未入荷の発注");
    expect(html).toContain("送付に失敗した発注書");
    expect(html).not.toContain("今週の支払予定");
    const accounting = await createEmployee(["accounting"]);
    const acc = await (await as(accounting).get("/")).text();
    expect(acc).toContain("今週の支払予定");
    expect(acc).not.toContain("作成中のままの発注");
    const failed = await readDb((db) => db.query.documents.findMany());
    void failed;
  });
});
