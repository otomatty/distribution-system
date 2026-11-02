/**
 * メーカー直の受注からの発注（要件定義書 3.8 Should）。受注の明細を仕入先ごとにまとめて発注を作り、
 * 納入先は受注の販売先、数量は仕入単位に換算する。受注と発注の両方の詳細に相手を表示する。
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { Result } from "../../src/domain/result";
import { businessDb } from "../../src/infra/do/client";
import type { CommandInput, CommandName } from "../../src/usecases/registry";
import { unwrap, unwrapErr } from "../support/result";
import { createItem, createLocation, createSupplier } from "./fixtures";
import { as, createEmployee, newKey, systemCommand, systemQuery } from "./helpers";
import { systemCommandResult } from "./platform-helpers";
import { orderView } from "./purchasing-fixtures";
import { createCustomer, createOrder, createSalesItem, getOrder, today } from "./sales-fixtures";

function commandAs<N extends CommandName>(
  email: string,
  name: N,
  input: CommandInput<N>,
  key: string = crypto.randomUUID(),
): Promise<Result<unknown>> {
  return businessDb(env).command(name, input, { kind: "dev", email }, key);
}

/** 2つの仕入先の商品を含むメーカー直の受注（入数12。商品 a は 25個、b は 24個、c は 3個） */
async function makerDirectOrder() {
  const s1 = await createSupplier();
  const s2 = await createSupplier();
  const a = await createSalesItem(s1);
  const b = await createSalesItem(s1);
  const c = await createSalesItem(s2);
  const customer = await createCustomer();
  const so = await createOrder({
    customerId: customer.id,
    makerDirect: true,
    locationId: null,
    deliveryRequestedOn: "2026-12-10",
    shipPlannedOn: "2026-12-10",
    lines: [
      { itemId: a.id, quantity: 25, unitPriceCenti: 15_050 },
      { itemId: c.id, quantity: 3, unitPriceCenti: 15_050 },
      { itemId: b.id, quantity: 24, unitPriceCenti: 15_050 },
    ],
  });
  return { s1, s2, a, b, c, customer, so };
}

function linkedInput(
  setup: Awaited<ReturnType<typeof makerDirectOrder>>,
  overrides: Partial<CommandInput<"purchaseOrders.create">> = {},
): CommandInput<"purchaseOrders.create"> {
  return {
    supplierId: setup.s1,
    orderedOn: "2026-11-01",
    destinationKind: "customer",
    destinationCustomerId: setup.customer.id,
    deliveryRequestedOn: "2026-12-10",
    salesOrderId: setup.so.id,
    lines: [
      { itemId: setup.a.id, quantity: 3, unitPriceCenti: 120_000, memo: "" },
      { itemId: setup.b.id, quantity: 2, unitPriceCenti: 120_000, memo: "" },
    ],
    ...overrides,
  };
}

describe("メーカー直の受注からの発注（ユースケース）", () => {
  it("仕入先ごとの初期値：選んだ仕入先の商品だけを、仕入単位に換算した数量（端数は切り上げ）で返す", async () => {
    const setup = await makerDirectOrder();
    const plan = await systemQuery("purchaseOrders.makerDirectPlan", { salesOrderId: setup.so.id });
    expect(plan?.suppliers.map((s) => [s.supplierId, s.lineCount])).toEqual([
      [setup.s1, 2],
      [setup.s2, 1],
    ]);
    expect(plan?.canCreate).toBe(true);
    const r = await systemQuery("purchaseOrders.makerDirectDraft", {
      salesOrderId: setup.so.id,
      supplierId: setup.s1,
    });
    expect(r.error).toBeNull();
    expect(r.draft?.customerId).toBe(setup.customer.id);
    expect(r.draft?.deliveryRequestedOn).toBe("2026-12-10");
    expect(
      r.draft?.lines.map((l) => [
        l.itemId,
        l.salesQuantity,
        l.quantity,
        l.orderedUnits,
        l.surplusUnits,
        l.unitPriceCenti,
      ]),
    ).toEqual([
      [setup.a.id, 25, 3, 36, 11, 120_000],
      [setup.b.id, 24, 2, 24, 0, 120_000],
    ]);
  });

  it("「発注時に仕入価格を入力する」商品は単価を空にする。仕入先ごとの明細は受注の明細の順", async () => {
    const supplierId = await createSupplier();
    const market = await systemCommand("items.create", {
      name: "相場の菓子",
      supplierId,
      taxCategory: "reduced",
      purchaseUnitName: "箱",
      salesUnitName: "個",
      unitsPerPurchaseUnit: 10,
      purchasePriceCenti: 50_000,
      salesPriceCenti: 8_000,
      inputPriceOnOrder: true,
    });
    const fixed = await createSalesItem(supplierId);
    const customer = await createCustomer();
    const so = await createOrder({
      customerId: customer.id,
      makerDirect: true,
      locationId: null,
      lines: [
        { itemId: market.id, quantity: 5, unitPriceCenti: 8_000 },
        { itemId: fixed.id, quantity: 13, unitPriceCenti: 15_050 },
      ],
    });
    const r = await systemQuery("purchaseOrders.makerDirectDraft", {
      salesOrderId: so.id,
      supplierId,
    });
    expect(r.draft?.deliveryRequestedOn).toBeNull();
    expect(
      r.draft?.lines.map((l) => [l.itemName, l.quantity, l.surplusUnits, l.unitPriceCenti]),
    ).toEqual([
      ["相場の菓子", 1, 5, null],
      [fixed.name, 2, 11, 120_000],
    ]);
    expect(r.draft?.supplierName).toContain("テスト仕入先");
  });

  it("作った発注は受注を覚え、受注の欄に出る。同じ仕入先の2枚目は作れず、取り消すと作り直せる", async () => {
    const setup = await makerDirectOrder();
    const po = await systemCommand("purchaseOrders.create", linkedInput(setup));
    const view = await orderView(po.id);
    expect(view.order.salesOrderId).toBe(setup.so.id);
    expect(view.order.salesOrderNumber).toBe(setup.so.number);

    const plan = await systemQuery("purchaseOrders.makerDirectPlan", { salesOrderId: setup.so.id });
    expect(plan?.orders.map((o) => o.id)).toEqual([po.id]);
    expect(plan?.suppliers.find((s) => s.supplierId === setup.s1)?.activeOrder?.number).toBe(
      po.number,
    );
    expect(plan?.suppliers.find((s) => s.supplierId === setup.s2)?.activeOrder).toBeNull();

    const dup = unwrapErr(await systemCommandResult("purchaseOrders.create", linkedInput(setup)));
    expect(dup.code).toBe("duplicate");
    expect(dup.message).toContain(po.number);
    const draft = await systemQuery("purchaseOrders.makerDirectDraft", {
      salesOrderId: setup.so.id,
      supplierId: setup.s1,
    });
    expect(draft.error).toContain(po.number);

    await systemCommand("purchaseOrders.cancel", { id: po.id, version: 1, reason: "数量の誤り" });
    const again = await systemCommand("purchaseOrders.create", linkedInput(setup));
    const after = await systemQuery("purchaseOrders.makerDirectPlan", {
      salesOrderId: setup.so.id,
    });
    expect(after?.orders.map((o) => o.id).toSorted()).toEqual([po.id, again.id].toSorted());
    // 別の仕入先の発注は作れる
    const other = await systemCommand(
      "purchaseOrders.create",
      linkedInput(setup, {
        supplierId: setup.s2,
        lines: [{ itemId: setup.c.id, quantity: 1, unitPriceCenti: 120_000, memo: "" }],
      }),
    );
    expect((await orderView(other.id)).order.salesOrderId).toBe(setup.so.id);
  });

  it("メーカー直でない・取り消した受注、明細にない仕入先、販売先でない納入先はエラー", async () => {
    const setup = await makerDirectOrder();
    const notInLines = await createSupplier();
    const item = await createItem(notInLines);
    const supplierErr = unwrapErr(
      await systemCommandResult(
        "purchaseOrders.create",
        linkedInput(setup, {
          supplierId: notInLines,
          lines: [{ itemId: item.id, quantity: 1, unitPriceCenti: 100, memo: "" }],
        }),
      ),
    );
    expect(supplierErr.fields?.[0]?.field).toBe("supplierId");
    const locationId = await createLocation();
    const destErr = unwrapErr(
      await systemCommandResult(
        "purchaseOrders.create",
        linkedInput(setup, {
          destinationKind: "location",
          destinationLocationId: locationId,
          destinationCustomerId: null,
        }),
      ),
    );
    expect(destErr.fields?.[0]?.field).toBe("destinationCustomerId");
    const otherCustomer = await createCustomer();
    expect(
      unwrapErr(
        await systemCommandResult(
          "purchaseOrders.create",
          linkedInput(setup, { destinationCustomerId: otherCustomer.id }),
        ),
      ).code,
    ).toBe("validation");
    expect(
      unwrapErr(
        await systemCommandResult(
          "purchaseOrders.create",
          linkedInput(setup, { salesOrderId: "01ZZZZZZZZZZZZZZZZZZZZZZZZ" }),
        ),
      ).code,
    ).toBe("not_found");

    // メーカー直でない受注
    const stocked = await createOrder({
      customerId: setup.customer.id,
      locationId: await createLocation(),
      lines: [{ itemId: setup.a.id, quantity: 1, unitPriceCenti: 15_050 }],
    });
    const notDirect = unwrapErr(
      await systemCommandResult(
        "purchaseOrders.create",
        linkedInput(setup, { salesOrderId: stocked.id }),
      ),
    );
    expect(notDirect.code).toBe("invalid_state");
    const plan = await systemQuery("purchaseOrders.makerDirectPlan", { salesOrderId: stocked.id });
    expect(plan?.canCreate).toBe(false);
    expect(plan?.blockedReason).toContain("メーカー直");

    // 取り消した受注
    await systemCommand("salesOrders.cancel", {
      id: setup.so.id,
      version: (await getOrder(setup.so.id)).order.version,
      reason: "先方の都合",
    });
    expect(
      unwrapErr(await systemCommandResult("purchaseOrders.create", linkedInput(setup))).message,
    ).toContain("取り消した受注");
    expect(
      (
        await systemQuery("purchaseOrders.makerDirectDraft", {
          salesOrderId: setup.so.id,
          supplierId: setup.s1,
        })
      ).draft,
    ).toBeNull();
    expect(
      (
        await systemQuery("purchaseOrders.makerDirectDraft", {
          salesOrderId: "01ZZZZZZZZZZZZZZZZZZZZZZZZ",
          supplierId: setup.s1,
        })
      ).error,
    ).toBe("受注が見つかりません");
    expect(
      await systemQuery("purchaseOrders.makerDirectPlan", {
        salesOrderId: "01ZZZZZZZZZZZZZZZZZZZZZZZZ",
      }),
    ).toBeNull();
  });

  it("作成中の編集では受注は変わらず、納入先は受注の販売先のまま。版番号が古ければ保存しない", async () => {
    const setup = await makerDirectOrder();
    const po = await systemCommand("purchaseOrders.create", linkedInput(setup));
    const stocked = await createOrder({
      customerId: setup.customer.id,
      makerDirect: true,
      locationId: null,
      lines: [{ itemId: setup.a.id, quantity: 1, unitPriceCenti: 15_050 }],
    });
    // 受注を付け替える入力は無視する
    await systemCommand("purchaseOrders.update", {
      id: po.id,
      version: 1,
      fields: { ...linkedInput(setup), salesOrderId: stocked.id, memo: "編集" },
    });
    const view = await orderView(po.id);
    expect(view.order.salesOrderId).toBe(setup.so.id);
    expect(view.order.memo).toBe("編集");
    const locationId = await createLocation();
    const dest = unwrapErr(
      await systemCommandResult("purchaseOrders.update", {
        id: po.id,
        version: 2,
        fields: linkedInput(setup, {
          destinationKind: "location",
          destinationLocationId: locationId,
          destinationCustomerId: null,
        }),
      }),
    );
    expect(dest.fields?.[0]?.field).toBe("destinationCustomerId");
    const stale = unwrapErr(
      await systemCommandResult("purchaseOrders.update", {
        id: po.id,
        version: 1,
        fields: linkedInput(setup),
      }),
    );
    expect(stale.code).toBe("conflict");
  });

  it("発注を作れるのは仕入担当と管理者。同じ受付番号で2回送っても1枚だけ", async () => {
    const setup = await makerDirectOrder();
    const sales = await createEmployee(["sales"]);
    const denied = unwrapErr(await commandAs(sales, "purchaseOrders.create", linkedInput(setup)));
    expect(denied.code).toBe("forbidden");
    const plan = unwrap(
      await businessDb(env).query(
        "purchaseOrders.makerDirectPlan",
        { salesOrderId: setup.so.id },
        { kind: "dev", email: sales },
      ),
    );
    expect(plan).toMatchObject({ canCreate: false, blockedReason: null });
    const draftDenied = unwrapErr(
      await businessDb(env).query(
        "purchaseOrders.makerDirectDraft",
        { salesOrderId: setup.so.id, supplierId: setup.s1 },
        { kind: "dev", email: sales },
      ),
    );
    expect(draftDenied.code).toBe("forbidden");

    const purchasing = await createEmployee(["purchasing"]);
    const key = newKey();
    const first = unwrap(
      await commandAs(purchasing, "purchaseOrders.create", linkedInput(setup), key),
    );
    const second = unwrap(
      await commandAs(purchasing, "purchaseOrders.create", linkedInput(setup), key),
    );
    expect(second).toEqual(first);
    const after = await systemQuery("purchaseOrders.makerDirectPlan", {
      salesOrderId: setup.so.id,
    });
    expect(after?.orders).toHaveLength(1);
  });
});

describe("メーカー直の受注からの発注（画面）", () => {
  it("受注詳細から仕入先を選んで、初期値の入った発注の作成画面を開き、作った発注と受注を相互にリンクする", async () => {
    const setup = await makerDirectOrder();
    const user = await createEmployee(["purchasing"]);
    const soPage = await (await as(user).get(`/sales-orders/${setup.so.id}`)).text();
    expect(soPage).toContain("メーカー直の発注");
    const newHref = `/purchase-orders/new?salesOrderId=${setup.so.id}&amp;supplierId=${setup.s1}`;
    expect(soPage).toContain(`href="${newHref}"`);

    // 仕入先が2つなので、仕入先を選ぶ画面になる
    const choice = await (
      await as(user).get(`/purchase-orders/new?salesOrderId=${setup.so.id}`)
    ).text();
    expect(choice).toContain("複数の仕入先にまたがっています");
    expect(choice).toContain(`href="${newHref}"`);

    const form = await (await as(user).get(newHref.replaceAll("&amp;", "&"))).text();
    expect(form).toContain(`name="salesOrderId" value="${setup.so.id}"`);
    expect(form).toContain(`data-line-item="${setup.a.id}"`);
    expect(form).toContain(`data-line-item="${setup.b.id}"`);
    expect(form).not.toContain(`data-line-item="${setup.c.id}"`);
    expect(form).toContain('name="destinationKind" value="customer" checked');
    expect(form).toMatch(new RegExp(`<option value="${setup.customer.id}" selected`));
    expect(form).toContain('name="deliveryRequestedOn" type="date" value="2026-12-10"');
    expect(form).toContain("受注 25個 → 発注 3ケース（36個）");
    expect(form).toContain("11個多い");
    expect(form).toMatch(/id="qty-[0-9A-Z]+" name="lineQuantity" type="number"[^>]*value="3"/);

    const res = await as(user).hx("/purchase-orders/new", {
      _key: newKey(),
      supplierId: setup.s1,
      salesOrderId: setup.so.id,
      orderedOn: today(),
      supplierContactName: "",
      destinationKind: "customer",
      destinationLocationId: "",
      destinationCustomerId: setup.customer.id,
      destinationAddress: "",
      employeeId: "",
      deliveryRequestedOn: "2026-12-10",
      paymentDueOn: "",
      memo: "",
      lineItemId: [setup.a.id, setup.b.id],
      lineQuantity: ["3", "2"],
      linePrice: ["1200", "1200"],
      lineMemo: ["", ""],
    });
    expect(res.status).toBe(204);
    const location = res.headers.get("HX-Redirect") ?? "";
    const poId = /^\/purchase-orders\/([0-9A-Z]{26})/.exec(location)?.[1] ?? "";
    const poPage = await (await as(user).get(`/purchase-orders/${poId}`)).text();
    expect(poPage).toContain("受注（メーカー直）");
    expect(poPage).toContain(`<a href="/sales-orders/${setup.so.id}">${setup.so.number}</a>`);

    const soAfter = await (await as(user).get(`/sales-orders/${setup.so.id}`)).text();
    expect(soAfter).toContain(`href="/purchase-orders/${poId}"`);
    expect(soAfter).toContain("発注済み");
    // 同じ仕入先は2枚目を作れないので、作成画面は理由を示す
    const blocked = await (await as(user).get(newHref.replaceAll("&amp;", "&"))).text();
    expect(blocked).toContain("すでにあります");
  });

  it("仕入先が1つなら仕入先を選ばずに作成画面を開く。受注・出荷担当には作るボタンを出さない", async () => {
    const supplierId = await createSupplier();
    const item = await createSalesItem(supplierId);
    const customer = await createCustomer();
    const so = await createOrder({
      customerId: customer.id,
      makerDirect: true,
      locationId: null,
      lines: [{ itemId: item.id, quantity: 12, unitPriceCenti: 15_050 }],
    });
    const user = await createEmployee(["purchasing"]);
    const form = await (await as(user).get(`/purchase-orders/new?salesOrderId=${so.id}`)).text();
    expect(form).toContain(`name="salesOrderId" value="${so.id}"`);
    expect(form).toContain("受注 12個 → 発注 1ケース（12個）");

    const sales = await createEmployee(["sales"]);
    const soPage = await (await as(sales).get(`/sales-orders/${so.id}`)).text();
    expect(soPage).toContain("メーカー直の発注");
    expect(soPage).not.toContain("への発注を作る");
    const salesForm = await (
      await as(sales).get(`/purchase-orders/new?salesOrderId=${so.id}`)
    ).text();
    expect(salesForm).toContain("発注を作成する権限がありません");

    // メーカー直でない受注の詳細には欄を出さない
    const stocked = await createOrder({
      customerId: customer.id,
      locationId: await createLocation(),
      lines: [{ itemId: item.id, quantity: 1, unitPriceCenti: 15_050 }],
    });
    expect(await (await as(user).get(`/sales-orders/${stocked.id}`)).text()).not.toContain(
      "メーカー直の発注",
    );
    expect(
      (await as(user).get("/purchase-orders/new?salesOrderId=01ZZZZZZZZZZZZZZZZZZZZZZZZ")).status,
    ).toBe(404);
  });
});

/** メーカー直の受注と、そこから作った発注（s1 は作成中のまま、s2 は取り消した発注） */
async function linkedOrders() {
  const setup = await makerDirectOrder();
  const po = await systemCommand("purchaseOrders.create", linkedInput(setup));
  const other = await systemCommand(
    "purchaseOrders.create",
    linkedInput(setup, {
      supplierId: setup.s2,
      lines: [{ itemId: setup.c.id, quantity: 1, unitPriceCenti: 120_000, memo: "" }],
    }),
  );
  await systemCommand("purchaseOrders.cancel", {
    id: other.id,
    version: (await orderView(other.id)).order.version,
    reason: "仕入先を変える",
  });
  const fields = (version: number) => ({
    id: setup.so.id,
    version,
    fields: {
      customerId: setup.customer.id,
      orderedOn: today(),
      makerDirect: true,
      locationId: null,
      deliveryRequestedOn: "2026-12-10",
      shipPlannedOn: "2026-12-10",
      lines: [
        { itemId: setup.a.id, quantity: 30, unitPriceCenti: 15_050 },
        { itemId: setup.c.id, quantity: 3, unitPriceCenti: 15_050 },
        { itemId: setup.b.id, quantity: 24, unitPriceCenti: 15_050 },
      ],
    },
  });
  return { ...setup, po, other, fields };
}

describe("受注の取消・編集・分割と、受注から作った発注", () => {
  it("受注詳細と結果に、取り消していない発注だけを返す（発注は自動では取り消さない）", async () => {
    const d = await linkedOrders();
    const view = await getOrder(d.so.id);
    expect(view.linkedPurchaseOrders).toEqual([
      { id: d.po.id, number: d.po.number, status: "draft" },
    ]);
    expect(
      await systemQuery("salesOrders.linkedPurchaseOrders", { salesOrderId: d.so.id }),
    ).toEqual({
      salesOrderId: d.so.id,
      salesOrderNumber: d.so.number,
      orders: [{ id: d.po.id, number: d.po.number, status: "draft" }],
    });
    expect(
      await systemQuery("salesOrders.linkedPurchaseOrders", {
        salesOrderId: "01ZZZZZZZZZZZZZZZZZZZZZZZZ",
      }),
    ).toBeNull();

    // 編集：結果に発注を返し、発注はそのまま
    const updated = await systemCommand("salesOrders.update", d.fields(view.order.version));
    expect(updated.linkedPurchaseOrders.map((o) => o.number)).toEqual([d.po.number]);
    expect((await orderView(d.po.id)).order.status).toBe("draft");

    // 分割：発注は元の受注に結びついたまま。結果に元の受注の発注を返す
    const lineA = (await getOrder(d.so.id)).order.lines.find((l) => l.itemId === d.a.id)!;
    const split = await systemCommand("salesOrders.split", {
      id: d.so.id,
      version: (await getOrder(d.so.id)).order.version,
      moves: [{ lineId: lineA.id, quantity: 10 }],
    });
    expect(split.linkedPurchaseOrders.map((o) => o.id)).toEqual([d.po.id]);
    expect((await getOrder(split.id)).linkedPurchaseOrders).toEqual([]);
    expect((await orderView(d.po.id)).order.salesOrderId).toBe(d.so.id);

    // 取消：発注は取り消さない
    const cancelled = await systemCommand("salesOrders.cancel", {
      id: d.so.id,
      version: (await getOrder(d.so.id)).order.version,
      reason: "先方の都合",
    });
    expect(cancelled.linkedPurchaseOrders).toEqual([
      { id: d.po.id, number: d.po.number, status: "draft" },
    ]);
    expect((await orderView(d.po.id)).order.status).toBe("draft");
    // 発注のない受注の結果は空
    const plain = await createOrder({
      customerId: d.customer.id,
      makerDirect: true,
      locationId: null,
      lines: [{ itemId: d.a.id, quantity: 1, unitPriceCenti: 15_050 }],
    });
    const plainCancel = await systemCommand("salesOrders.cancel", {
      id: plain.id,
      version: (await getOrder(plain.id)).order.version,
      reason: "誤り",
    });
    expect(plainCancel.linkedPurchaseOrders).toEqual([]);
  });

  it("取消の欄・編集・分割の画面で知らせ、操作の後の受注詳細にも同じ知らせを出す", async () => {
    const user = await createEmployee(["sales"]);
    const d = await linkedOrders();
    const notice = `この受注から作った発注が1件あります（`;
    const detail = await (await as(user).get(`/sales-orders/${d.so.id}`)).text();
    expect(detail).toContain(notice);
    expect(detail).toContain(`href="/purchase-orders/${d.po.id}"`);
    expect(detail).toContain("必要なら発注も取り消してください");
    expect(detail).not.toContain(d.other.number + "</a>）");
    expect(detail).toContain(`この受注から作った発注 1 件（${d.po.number}）は取り消しません`);
    const edit = await (await as(user).get(`/sales-orders/${d.so.id}/edit`)).text();
    expect(edit).toContain(notice);
    const splitPage = await (await as(user).get(`/sales-orders/${d.so.id}/split`)).text();
    expect(splitPage).toContain(notice);

    // 編集の後：受注詳細へ移り、知らせを出す
    const view = await getOrder(d.so.id);
    const lines = view.order.lines;
    const saved = await as(user).post(`/sales-orders/${d.so.id}/edit`, {
      _key: newKey(),
      version: String(view.order.version),
      customerId: d.customer.id,
      orderedOn: today(),
      makerDirect: "1",
      deliveryRequestedOn: "2026-12-10",
      shipPlannedOn: "2026-12-10",
      lineItemId: lines.map((l) => l.itemId),
      lineQuantity: lines.map((l) => String(l.quantity + 1)),
      linePrice: lines.map(() => "150.50"),
      linePriceReason: lines.map(() => ""),
    });
    const to = saved.headers.get("Location") ?? "";
    expect(to).toBe(`/sales-orders/${d.so.id}?notice=updated&linked=${d.so.id}`);
    const afterEdit = await (await as(user).get(to)).text();
    expect(afterEdit).toContain("受注を保存しました");
    expect(afterEdit).toContain(notice);

    // 分割の後：分割した受注の詳細で、分割元の受注の発注を知らせる
    const current = await getOrder(d.so.id);
    const split = await as(user).post(`/sales-orders/${d.so.id}/split`, {
      _key: newKey(),
      version: String(current.order.version),
      lineId: current.order.lines.map((l) => l.id),
      moveQuantity: current.order.lines.map((_, i) => (i === 0 ? "1" : "0")),
    });
    const splitTo = split.headers.get("Location") ?? "";
    expect(splitTo).toContain(`notice=split&linked=${d.so.id}`);
    const afterSplit = await (await as(user).get(splitTo)).text();
    expect(afterSplit).toContain(
      `分割元の受注 <a href="/sales-orders/${d.so.id}">${d.so.number}</a> から`,
    );
    expect(afterSplit).toContain("作った発注が1件あります");

    // 取消の後（htmx）：詳細の部分に知らせを出す
    const cancelled = await as(user).hx(`/sales-orders/${d.so.id}/cancel`, {
      _key: newKey(),
      version: String((await getOrder(d.so.id)).order.version),
      reason: "先方の都合",
    });
    const html = await cancelled.text();
    expect(html).toContain("受注を取り消しました");
    expect(html).toContain(notice);
    expect((await orderView(d.po.id)).order.status).toBe("draft");

    // 発注のない受注には出さない
    const plain = await createOrder({
      customerId: d.customer.id,
      makerDirect: true,
      locationId: null,
      lines: [{ itemId: d.a.id, quantity: 1, unitPriceCenti: 15_050 }],
    });
    const plainPage = await (await as(user).get(`/sales-orders/${plain.id}`)).text();
    expect(plainPage).not.toContain("から作った発注が");
    const plainCancel = await as(user).post(`/sales-orders/${plain.id}/cancel`, {
      _key: newKey(),
      version: String((await getOrder(plain.id)).order.version),
      reason: "誤り",
    });
    expect(plainCancel.headers.get("Location")).toBe(`/sales-orders/${plain.id}?notice=cancelled`);
  });
});
