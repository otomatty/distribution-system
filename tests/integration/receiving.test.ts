import { describe, expect, it } from "vitest";

import { addInitialStock, createItem, createLocation, createSupplier } from "./fixtures";
import { as, createEmployee, newKey, systemCommand } from "./helpers";
import { readDb, systemCommandResult } from "./platform-helpers";
import {
  createConfirmedOrder,
  createCustomer,
  createSupplierWithTerms,
  onHand,
  orderView,
  purchasingSetup,
  receive,
  receiveForm,
} from "./purchasing-fixtures";

describe("入荷予定一覧", () => {
  it("発注済みで未入荷の明細を保管場所ごとに納品希望日の順で出し、メーカー直は別にまとめる", async () => {
    const user = await createEmployee(["sales"]);
    const supplierId = await createSupplier();
    const item = await createItem(supplierId);
    const locationId = await createLocation();
    const customerId = await createCustomer();
    const later = await createConfirmedOrder({
      supplierId,
      locationId,
      lines: [{ itemId: item.id, quantity: 4 }],
      deliveryRequestedOn: "2026-12-20",
    });
    const sooner = await createConfirmedOrder({
      supplierId,
      locationId,
      lines: [{ itemId: item.id, quantity: 2 }],
      deliveryRequestedOn: "2026-01-10",
    });
    const direct = await createConfirmedOrder({
      supplierId,
      customerId,
      lines: [{ itemId: item.id, quantity: 1 }],
    });
    const html = await (await as(user).get(`/receiving?locationId=${locationId}`)).text();
    expect(html).toContain('class="touch"');
    expect(html.indexOf(sooner.number)).toBeLessThan(html.indexOf(later.number));
    expect(html).toContain("予定日を過ぎています");
    expect(html).not.toContain(direct.number);
    const all = await (await as(user).get("/receiving")).text();
    expect(all).toContain("メーカー直・その他の届け先");
    expect(all).toContain(direct.number);
    expect(all.indexOf(later.number)).toBeLessThan(all.indexOf(direct.number));
    const overdue = await (
      await as(user).get(`/receiving?locationId=${locationId}&overdue=1`)
    ).text();
    expect(overdue).toContain(sooner.number);
    expect(overdue).not.toContain(later.number);
  });
});

describe("入荷日と発注日", () => {
  it("入荷日は発注日より前にできない（業務エラー、入荷確認の画面では入荷日の欄に出す）。同じ日はできる", async () => {
    const user = await createEmployee(["purchasing"]);
    const { supplierId, locationId, a } = await purchasingSetup();
    const po = await createConfirmedOrder({
      supplierId,
      locationId,
      orderedOn: "2026-10-05",
      lines: [{ itemId: a.id, quantity: 2 }],
    });
    const view = await orderView(po.id);
    const early = await systemCommandResult("receipts.record", {
      purchaseOrderId: po.id,
      version: view.order.version,
      receivedOn: "2026-10-04",
      lines: [{ lineId: view.order.lines[0]!.id, accepted: 1, returned: 0 }],
    });
    expect(early).toMatchObject({
      ok: false,
      error: {
        code: "validation",
        fields: [
          { field: "receivedOn", message: "入荷日は発注日（2026-10-05）以降にしてください" },
        ],
      },
    });
    expect(await onHand(a.id, locationId)).toBe(0);
    const page = await (await as(user).get(`/receiving/${po.id}`)).text();
    expect(page).toContain('min="2026-10-05"');
    const res = await as(user).hx(
      `/receiving/${po.id}`,
      receiveForm(
        view,
        { [view.order.lines[0]!.id]: { accepted: "1" } },
        { receivedOn: "2026-10-04" },
      ),
    );
    expect(await res.text()).toContain("入荷日は発注日（2026-10-05）以降にしてください");
    await receive(po.id, [1], { receivedOn: "2026-10-05" });
    expect(await onHand(a.id, locationId)).toBe(12);
  });
});

describe("入荷確認（分納）", () => {
  it("一部の入荷では発注済みのまま、残りの入荷で入荷済みになり、在庫は受入数 × 入数だけ増える", async () => {
    const user = await createEmployee(["sales"]);
    const { supplierId, locationId, a, b } = await purchasingSetup();
    const po = await createConfirmedOrder({
      supplierId,
      locationId,
      lines: [
        { itemId: a.id, quantity: 5 },
        { itemId: b.id, quantity: 3 },
      ],
    });
    const page = await (await as(user).get(`/receiving/${po.id}`)).text();
    expect(page).toContain('class="touch"');
    expect(page).toContain(`data-draft="receiving:${po.id}"`);
    let view = await orderView(po.id);
    const [la, lb] = view.order.lines;
    if (!la || !lb) throw new Error("明細がありません");
    const first = receiveForm(view, {
      [la.id]: { accepted: "2", returned: "1" },
      [lb.id]: { accepted: "0" },
    });
    const res = await as(user).hx(`/receiving/${po.id}`, first);
    expect(res.status).toBe(204);
    expect(res.headers.get("HX-Redirect")).toContain("notice=partial");
    // 同じ受付番号で送り直しても（通信が途切れた後の再送信）二重には入荷しない
    const retry = await as(user).hx(`/receiving/${po.id}`, first);
    expect(retry.headers.get("HX-Redirect")).toBe(res.headers.get("HX-Redirect"));
    expect(await onHand(a.id, locationId)).toBe(24);
    view = await orderView(po.id);
    expect(view.order.status).toBe("ordered");
    expect(view.lines[0]?.remaining).toBe(2);
    expect(view.receipts).toHaveLength(1);
    expect(view.receipts[0]?.number).toMatch(/^RC-2026-\d{6}$/);
    // 受入数 × 単価（1,200円 × 2）
    expect(view.receipts[0]?.lines[0]?.amount).toBe(2400);

    const done = await as(user).get(`/receiving/${po.id}?notice=partial`);
    expect(await done.text()).toContain("分納");

    const second = receiveForm(view, {
      [la.id]: { accepted: "1", close: true },
      [lb.id]: { accepted: "3" },
    });
    const res2 = await as(user).hx(`/receiving/${po.id}`, second);
    expect(res2.headers.get("HX-Redirect")).toContain("notice=done");
    view = await orderView(po.id);
    expect(view.order.status).toBe("received");
    expect(view.lines[0]?.closed).toBe(true);
    expect(view.lines[0]?.remaining).toBe(0);
    expect(await onHand(a.id, locationId)).toBe(36);
    expect(await onHand(b.id, locationId)).toBe(36);
    // 入荷が終わった発注は入荷予定に出ない
    const schedule = await (await as(user).get(`/receiving?locationId=${locationId}`)).text();
    expect(schedule).not.toContain(po.number);
    const ledger = await (await as(user).get(`/stock/${a.id}?locationId=${locationId}`)).text();
    expect(ledger).toContain("入荷");
  });

  it("残りを超える入荷・古い画面からの入荷・未来の入荷日はエラー", async () => {
    const user = await createEmployee(["purchasing"]);
    const { supplierId, locationId, a } = await purchasingSetup();
    const po = await createConfirmedOrder({
      supplierId,
      locationId,
      lines: [{ itemId: a.id, quantity: 2 }],
    });
    const view = await orderView(po.id);
    const line = view.order.lines[0];
    if (!line) throw new Error("明細がありません");
    const over = await as(user).hx(
      `/receiving/${po.id}`,
      receiveForm(view, { [line.id]: { accepted: "2", returned: "1" } }),
    );
    const html = await over.text();
    expect(html).toContain("受入数と返品数の合計が残りの数を超えています");
    // 入力した数は残る
    expect(html).toContain('value="1"');
    const nothing = await as(user).hx(`/receiving/${po.id}`, receiveForm(view, {}));
    expect(await nothing.text()).toContain("受入数・返品数・打ち切りのいずれかを入力してください");
    const future = await as(user).hx(
      `/receiving/${po.id}`,
      receiveForm(view, { [line.id]: { accepted: "1" } }, { receivedOn: "2099-01-01" }),
    );
    expect(await future.text()).toContain("今日より後の日付は指定できません");
    await receive(po.id, [1]);
    const stale = await as(user).hx(
      `/receiving/${po.id}`,
      receiveForm(view, { [line.id]: { accepted: "1" } }),
    );
    expect(await stale.text()).toContain("ほかの人が先に更新しました");
    expect(await onHand(a.id, locationId)).toBe(12);
  });

  it("メーカー直の発注は納品済みの記録だけで在庫を動かさない", async () => {
    const user = await createEmployee(["purchasing"]);
    const { supplierId, a } = await purchasingSetup();
    const customerId = await createCustomer();
    const po = await createConfirmedOrder({
      supplierId,
      customerId,
      lines: [{ itemId: a.id, quantity: 2 }],
    });
    const page = await (await as(user).get(`/receiving/${po.id}`)).text();
    expect(page).toContain("納品済みを記録する");
    const view = await orderView(po.id);
    const res = await as(user).hx(
      `/receiving/${po.id}`,
      receiveForm(view, { [view.order.lines[0]?.id ?? ""]: { accepted: "2" } }),
    );
    expect(res.status).toBe(204);
    const after = await orderView(po.id);
    expect(after.order.status).toBe("received");
    expect(after.receipts[0]?.locationId).toBeNull();
    const ledger = await readDb((db) =>
      db.query.stockLedger.findMany({ where: (l, { eq }) => eq(l.itemId, a.id) }),
    );
    expect(ledger).toHaveLength(0);
  });

  it("経理担当は入荷を記録できない（権限）。作成中の発注は入荷を記録できない", async () => {
    const user = await createEmployee(["accounting"]);
    const { supplierId, locationId, a } = await purchasingSetup();
    const po = await createConfirmedOrder({
      supplierId,
      locationId,
      lines: [{ itemId: a.id, quantity: 2 }],
    });
    const page = await (await as(user).get(`/receiving/${po.id}`)).text();
    expect(page).toContain("入荷を記録する権限がありません");
    const view = await orderView(po.id);
    const res = await as(user).hx(
      `/receiving/${po.id}`,
      receiveForm(view, { [view.order.lines[0]?.id ?? ""]: { accepted: "1" } }),
    );
    expect(await res.text()).toContain("この操作を行う権限がありません");
    const draft = await systemCommand("purchaseOrders.create", {
      supplierId,
      orderedOn: "2026-10-01",
      destinationKind: "location",
      destinationLocationId: locationId,
      lines: [{ itemId: a.id, quantity: 1, unitPriceCenti: 100 }],
    });
    const draftView = await orderView(draft.id);
    const r = await systemCommandResult("receipts.record", {
      purchaseOrderId: draft.id,
      version: 1,
      receivedOn: "2026-10-10",
      lines: [{ lineId: draftView.order.lines[0]?.id ?? "", accepted: 1, returned: 0 }],
    });
    expect(r.ok).toBe(false);
    const purchasing = await createEmployee(["purchasing"]);
    const draftPage = await (await as(purchasing).get(`/receiving/${draft.id}`)).text();
    expect(draftPage).toContain("「作成中」のため、入荷を記録できません");
  });
});

describe("入荷の取消", () => {
  it("在庫を打ち消しの行で戻し、発注を発注済みに戻す。もう出荷した在庫は戻せない", async () => {
    const user = await createEmployee(["purchasing"]);
    const { supplierId, locationId, a } = await purchasingSetup();
    const po = await createConfirmedOrder({
      supplierId,
      locationId,
      lines: [{ itemId: a.id, quantity: 2 }],
    });
    const receipt = await receive(po.id, [2]);
    expect((await orderView(po.id)).order.status).toBe("received");
    expect(await onHand(a.id, locationId)).toBe(24);
    // 入荷した在庫の一部をもう使った（在庫操作で減らす）
    await systemCommand("stockOperations.create", {
      kind: "adjustment",
      reason: "sample",
      operationDate: "2026-10-11",
      locationId,
      lines: [{ itemId: a.id, quantity: -20 }],
    });
    const html = await (await as(user).get(`/purchase-orders/${po.id}`)).text();
    expect(html).toContain(`receipt-cancel-${receipt.id}`);
    const short = await as(user).hx(`/receiving/receipts/${receipt.id}/cancel`, {
      _key: newKey(),
      version: "1",
      number: receipt.number,
      reason: "数え間違い",
    });
    const shortHtml = await short.text();
    expect(shortHtml).toContain("在庫が足りないため記録できませんでした");
    expect(shortHtml).toContain(a.name);
    expect((await orderView(po.id)).order.status).toBe("received");

    await addInitialStock(locationId, [{ itemId: a.id, quantity: 20 }], "2026-10-12");
    const noReason = await as(user).hx(`/receiving/receipts/${receipt.id}/cancel`, {
      _key: newKey(),
      version: "1",
      number: receipt.number,
      reason: "",
    });
    expect(await noReason.text()).toContain("入力内容を確認してください");
    const ok = await as(user).hx(`/receiving/receipts/${receipt.id}/cancel`, {
      _key: newKey(),
      version: "1",
      number: receipt.number,
      reason: "数え間違い",
    });
    expect(ok.headers.get("HX-Redirect")).toContain("notice=receiptCancelled");
    const view = await orderView(po.id);
    expect(view.order.status).toBe("ordered");
    expect(view.lines[0]?.remaining).toBe(2);
    expect(view.receipts[0]?.cancelled).toBe(true);
    // 24（入荷）− 20（サンプル）+ 20（調整）− 24（入荷の取消）
    expect(await onHand(a.id, locationId)).toBe(0);
    const again = await systemCommandResult("receipts.cancel", {
      id: receipt.id,
      version: 2,
      reason: "二重",
    });
    expect(again.ok).toBe(false);
    // 取り消した入荷しかない発注は取り消せる
    expect(view.actions.cancel).toBe(true);
  });

  it("打ち切りを含む入荷の取消で、打ち切りも戻る", async () => {
    const { supplierId, locationId, a } = await purchasingSetup();
    const po = await createConfirmedOrder({
      supplierId,
      locationId,
      lines: [{ itemId: a.id, quantity: 5 }],
    });
    const receipt = await receive(po.id, [2], { close: [true] });
    expect((await orderView(po.id)).order.status).toBe("received");
    await systemCommand("receipts.cancel", { id: receipt.id, version: 1, reason: "誤り" });
    const view = await orderView(po.id);
    expect(view.lines[0]?.closed).toBe(false);
    expect(view.lines[0]?.remaining).toBe(5);
  });
});

describe("仕入返品", () => {
  it("入荷した数（これまでの返品を除く）まで返品でき、在庫から減らして金額を計算する", async () => {
    const user = await createEmployee(["purchasing"]);
    const { supplierId, locationId, a } = await purchasingSetup();
    const po = await createConfirmedOrder({
      supplierId,
      locationId,
      lines: [{ itemId: a.id, quantity: 2 }],
    });
    await receive(po.id, [2]);
    const view = await orderView(po.id);
    expect(view.actions.returnGoods).toBe(true);
    const line = view.order.lines[0];
    if (!line) throw new Error("明細がありません");
    const page = await (await as(user).get(`/purchase-orders/${po.id}/returns/new`)).text();
    expect(page).toContain(`value="${locationId}" selected`);
    const over = await as(user).hx(`/purchase-orders/${po.id}/returns/new`, {
      _key: newKey(),
      returnedOn: "2026-10-12",
      locationId,
      memo: "",
      lineId: line.id,
      units: "25",
    });
    expect(await over.text()).toContain("返品数が入荷した数（これまでの返品を除く）を超えています");
    const form = {
      _key: newKey(),
      returnedOn: "2026-10-12",
      locationId,
      memo: "破損",
      lineId: line.id,
      units: "5",
    };
    const res = await as(user).hx(`/purchase-orders/${po.id}/returns/new`, form);
    expect(res.headers.get("HX-Redirect")).toContain("notice=returned");
    await as(user).hx(`/purchase-orders/${po.id}/returns/new`, form);
    expect(await onHand(a.id, locationId)).toBe(19);
    const after = await orderView(po.id);
    expect(after.returns).toHaveLength(1);
    expect(after.returns[0]?.number).toMatch(/^PR-2026-\d{6}$/);
    // 1,200円/12個 × 5個 = 500円
    expect(after.returns[0]?.lines[0]?.amount).toBe(500);
    expect(after.lines[0]?.returnableUnits).toBe(19);

    // 別の保管場所に在庫がなければ返品できない（在庫不足）
    const other = await createLocation();
    const short = await as(user).hx(`/purchase-orders/${po.id}/returns/new`, {
      ...form,
      _key: newKey(),
      locationId: other,
      units: "1",
    });
    expect(await short.text()).toContain("在庫が足りないため記録できませんでした");
    // 返品した数を下回る入荷の取消はできない
    const cancel = await systemCommandResult("receipts.cancel", {
      id: after.receipts[0]?.id ?? "",
      version: 1,
      reason: "誤り",
    });
    expect(cancel).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("仕入返品を記録した商品") },
    });
  });

  it("受注・出荷担当は仕入返品を記録できない。メーカー直の発注は返品できない", async () => {
    const sales = await createEmployee(["sales"]);
    const { supplierId, locationId, a } = await purchasingSetup();
    const po = await createConfirmedOrder({
      supplierId,
      locationId,
      lines: [{ itemId: a.id, quantity: 1 }],
    });
    await receive(po.id, [1]);
    const view = await orderView(po.id);
    const res = await as(sales).hx(`/purchase-orders/${po.id}/returns/new`, {
      _key: newKey(),
      returnedOn: "2026-10-12",
      locationId,
      lineId: view.order.lines[0]?.id ?? "",
      units: "1",
    });
    expect(await res.text()).toContain("この操作を行う権限がありません");
    const page = await (await as(sales).get(`/purchase-orders/${po.id}/returns/new`)).text();
    expect(page).toContain("記録できません");

    const customerId = await createCustomer();
    const direct = await createConfirmedOrder({
      supplierId,
      customerId,
      lines: [{ itemId: a.id, quantity: 1 }],
    });
    await receive(direct.id, [1]);
    const dv = await orderView(direct.id);
    const r = await systemCommandResult("purchaseReturns.create", {
      purchaseOrderId: direct.id,
      returnedOn: "2026-10-12",
      locationId,
      lines: [{ lineId: dv.order.lines[0]?.id ?? "", units: 1 }],
    });
    expect(r.ok).toBe(false);
    void createSupplierWithTerms;
  });
});
