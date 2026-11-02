/**
 * 売上・仕入の集計（要件定義書 3.13 の Should、/reports）。
 * 売上 = 発送日の月の受注明細（明細ごとに端数処理）+ 送料など − 返品日の月の返品伝票、
 * 仕入 = 入荷日の月の受入の金額 − 返品日の月の仕入返品。取り消したものは含めない。
 */
import { beforeAll, describe, expect, it } from "vitest";

import { monthOf, toBusinessDate } from "../../src/domain/dates";
import type { ReportView } from "../../src/domain/reports";
import { recordReturn } from "./billing-fixtures";
import { addInitialStock, createLocation, createSupplier } from "./fixtures";
import { as, createEmployee, newKey, systemCommand, systemQuery } from "./helpers";
import { createConfirmedOrder, receive } from "./purchasing-fixtures";
import { createCustomer, createSalesItem } from "./sales-fixtures";

interface Data {
  supplier: { id: string; name: string };
  a: { id: string; code: string; name: string };
  b: { id: string; code: string; name: string };
  c1: { id: string; name: string };
  c2: { id: string; name: string };
}

let data: Data;

async function ship(id: string, shippedOn: string): Promise<string> {
  const r = await systemCommand("shipments.ship", { id, version: 1, shippedOn });
  return r.shipmentId;
}

/**
 * 9月・10月の取引：
 * - 仕入：9/10 に a 2ケース（2,400円）・b 2ケース（1,000.50円 × 2 = 2,001円）、10/5 に a 1ケース（1,200円）、
 *   10/8 にメーカー直の a 1ケース（1,200円）、10/6 に a を3個の仕入返品（300円）、10/7 の b の入荷は取消
 * - 売上：9/15 に販売先1へ a 3個（150.50円 × 3 = 451円）・b 6個（600円）・送料 800円、
 *   10/3 に販売先2へ a 1個の受注を2件（150円 × 2。明細ごとに丸めるので 301円にならない）、
 *   10/4 の販売先1への発送は取消、10/10 に販売先1の返品伝票 a 1個 150円（10/11 の a 2個の返品伝票は取消なので含めない）
 */
beforeAll(async () => {
  const supplierName = `集計テスト仕入先${Date.now().toString(36)}`;
  const supplierId = await createSupplier(supplierName);
  const a = await createSalesItem(supplierId, { name: "集計テスト商品A", salesPriceCenti: 15_050 });
  const b = await createSalesItem(supplierId, {
    name: "集計テスト商品B",
    salesPriceCenti: 10_000,
    taxCategory: "standard",
  });
  const locationId = await createLocation();
  const c1 = await createCustomer({ name: "集計テスト販売先1" });
  const c2 = await createCustomer({ name: "集計テスト販売先2" });
  data = { supplier: { id: supplierId, name: supplierName }, a, b, c1, c2 };

  const po1 = await createConfirmedOrder({
    supplierId,
    locationId,
    orderedOn: "2026-09-01",
    lines: [
      { itemId: a.id, quantity: 3, unitPriceCenti: 120_000 },
      { itemId: b.id, quantity: 2, unitPriceCenti: 100_050 },
    ],
  });
  await receive(po1.id, [2, 2], { receivedOn: "2026-09-10" });
  await receive(po1.id, [1, 0], { receivedOn: "2026-10-05" });
  const lines = (await systemQuery("purchaseOrders.get", { id: po1.id }))?.order.lines ?? [];
  await systemCommand("purchaseReturns.create", {
    purchaseOrderId: po1.id,
    returnedOn: "2026-10-06",
    locationId,
    lines: [{ lineId: lines[0]?.id ?? "", units: 3 }],
  });
  const po2 = await createConfirmedOrder({
    supplierId,
    locationId,
    orderedOn: "2026-10-01",
    lines: [{ itemId: b.id, quantity: 1, unitPriceCenti: 100_050 }],
  });
  const cancelled = await receive(po2.id, [1], { receivedOn: "2026-10-07" });
  await systemCommand("receipts.cancel", { id: cancelled.id, version: 1, reason: "テスト" });
  const direct = await createConfirmedOrder({
    supplierId,
    customerId: c2.id,
    orderedOn: "2026-10-01",
    lines: [{ itemId: a.id, quantity: 1, unitPriceCenti: 120_000 }],
  });
  await receive(direct.id, [1], { receivedOn: "2026-10-08" });

  await addInitialStock(
    locationId,
    [
      { itemId: a.id, quantity: 20 },
      { itemId: b.id, quantity: 20 },
    ],
    "2026-09-01",
  );
  const order = (
    customerId: string,
    items: { itemId: string; quantity: number; price: number }[],
    charges = 0,
  ) =>
    systemCommand("salesOrders.create", {
      customerId,
      orderedOn: "2026-09-01",
      shipPlannedOn: "2026-09-01",
      locationId,
      lines: items.map((i) => ({
        itemId: i.itemId,
        quantity: i.quantity,
        unitPriceCenti: i.price,
      })),
      charges:
        charges > 0
          ? [{ description: "送料", quantity: 1, unitAmount: charges, taxCategory: "standard" }]
          : [],
    });
  const so1 = await order(
    c1.id,
    [
      { itemId: a.id, quantity: 3, price: 15_050 },
      { itemId: b.id, quantity: 6, price: 10_000 },
    ],
    800,
  );
  await ship(so1.id, "2026-09-15");
  for (let i = 0; i < 2; i += 1) {
    const so = await order(c2.id, [{ itemId: a.id, quantity: 1, price: 15_050 }]);
    await ship(so.id, "2026-10-03");
  }
  const so4 = await order(c1.id, [{ itemId: b.id, quantity: 1, price: 10_000 }]);
  const shipmentId = await ship(so4.id, "2026-10-04");
  await systemCommand("shipments.cancel", { shipmentId, version: 1, reason: "テスト" });
  await recordReturn(so1.id, { quantity: 1, returnedOn: "2026-10-10" });
  const cancelledReturn = await recordReturn(so1.id, { quantity: 2, returnedOn: "2026-10-11" });
  await systemCommand("salesReturns.cancel", {
    id: cancelledReturn.id,
    version: 1,
    reason: "テスト",
  });
});

async function report(view: ReportView, from = "2026-09", to = "2026-10") {
  const r = await systemQuery("reports.monthly", { view, from, to, page: 1, pageSize: 50 });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

function rowsOf(r: Awaited<ReturnType<typeof report>>) {
  return r.rows.rows.map((x) => ({ name: x.name, amounts: x.amounts, total: x.total }));
}

describe("集計の基準", () => {
  it("月ごとの売上（送料を含む、返品を引く）と仕入（仕入返品を引く）。取り消したものは含めない", async () => {
    const r = await report("sales_customer");
    expect(r.period.months).toEqual(["2026-09", "2026-10"]);
    expect(r.summary.months).toEqual([
      { month: "2026-09", sales: 451 + 600 + 800, purchases: 2_400 + 2_001 },
      { month: "2026-10", sales: 150 + 150 - 150, purchases: 1_200 + 1_200 - 300 },
    ]);
    expect(r.summary.sales).toBe(2_001);
    expect(r.summary.purchases).toBe(6_501);
  });

  it("販売先別の売上は送料を含み、金額の大きい順。月ごとの合計は表の行の合計", async () => {
    const r = await report("sales_customer");
    expect(r.includesCharges).toBe(true);
    expect(rowsOf(r)).toEqual([
      { name: "集計テスト販売先1", amounts: [1_851, -150], total: 1_701 },
      { name: "集計テスト販売先2", amounts: [0, 300], total: 300 },
    ]);
    expect(r.totals).toEqual([1_851, 150]);
    expect(r.grandTotal).toBe(r.summary.sales);
  });

  it("商品別・仕入先別の売上は送料を含めない（明細は明細ごとに端数処理）", async () => {
    const byItem = await report("sales_item");
    expect(byItem.includesCharges).toBe(false);
    expect(byItem.rows.rows.map((x) => [x.code, x.name, x.amounts])).toEqual([
      [data.a.code, "集計テスト商品A", [451, 150]],
      [data.b.code, "集計テスト商品B", [600, 0]],
    ]);
    expect(byItem.grandTotal).toBe(1_201);
    expect(byItem.summary.sales).toBe(2_001);
    const bySupplier = await report("sales_supplier");
    expect(rowsOf(bySupplier)).toEqual([
      { name: data.supplier.name, amounts: [1_051, 150], total: 1_201 },
    ]);
  });

  it("仕入先別・商品別の仕入（メーカー直の入荷を含む）", async () => {
    const bySupplier = await report("purchases_supplier");
    expect(rowsOf(bySupplier)).toEqual([
      { name: data.supplier.name, amounts: [4_401, 2_100], total: 6_501 },
    ]);
    const byItem = await report("purchases_item");
    expect(rowsOf(byItem)).toEqual([
      { name: "集計テスト商品A", amounts: [2_400, 2_100], total: 4_500 },
      { name: "集計テスト商品B", amounts: [2_001, 0], total: 2_001 },
    ]);
    expect(byItem.summary.purchases).toBe(6_501);
  });

  it("行の名前・コードで絞り込める（合計は絞り込んだ行の合計。月ごとの売上と仕入は絞り込まない）", async () => {
    const r = await systemQuery("reports.monthly", {
      view: "sales_customer",
      from: "2026-09",
      to: "2026-10",
      q: "販売先2",
      page: 1,
      pageSize: 50,
    });
    expect(r.ok && rowsOf(r.value)).toEqual([
      { name: "集計テスト販売先2", amounts: [0, 300], total: 300 },
    ]);
    expect(r.ok && [r.value.grandTotal, r.value.summary.sales]).toEqual([300, 2_001]);
    const byCode = await systemQuery("reports.monthly", {
      view: "purchases_item",
      from: "2026-09",
      to: "2026-10",
      q: data.b.code.toLowerCase(),
      page: 1,
      pageSize: 50,
    });
    expect(byCode.ok && byCode.value.rows.rows.map((x) => x.name)).toEqual(["集計テスト商品B"]);
  });

  it("期間の外の取引は含めない。期間を指定しなければ今月までの12か月", async () => {
    const sep = await report("sales_customer", "2026-09", "2026-09");
    expect(sep.summary.sales).toBe(1_851);
    expect(sep.rows.total).toBe(1);
    const r = await systemQuery("reports.monthly", { page: 1, pageSize: 50 });
    expect(r.ok && r.value.period.months).toHaveLength(12);
    expect(r.ok && r.value.period.to).toBe(monthOf(toBusinessDate(new Date())));
  });

  it("期間の誤りは validation の結果として返す（画面に表示する）", async () => {
    const r = await systemQuery("reports.monthly", {
      from: "2026-10",
      to: "2026-09",
      page: 1,
      pageSize: 50,
    });
    expect(r).toEqual({ ok: false, error: expect.objectContaining({ code: "validation" }) });
  });

  it("CSV 用には行 × 月を表の順に縦に並べ、行の単位でページに分けて返す", async () => {
    const first = await systemQuery("reports.cells", {
      view: "purchases_item",
      from: "2026-09",
      to: "2026-10",
      page: 1,
      pageSize: 1,
    });
    expect(first.total).toBe(4);
    expect(first.rows.map((c) => [c.name, c.month, c.amount])).toEqual([
      ["集計テスト商品A", "2026-09", 2_400],
      ["集計テスト商品A", "2026-10", 2_100],
    ]);
    const second = await systemQuery("reports.cells", {
      view: "purchases_item",
      from: "2026-09",
      to: "2026-10",
      page: 2,
      pageSize: 1,
    });
    expect(second.rows.map((c) => [c.measure, c.axis, c.code, c.month, c.amount])).toEqual([
      ["purchases", "item", data.b.code, "2026-09", 2_001],
      ["purchases", "item", data.b.code, "2026-10", 0],
    ]);
    const third = await systemQuery("reports.cells", {
      view: "purchases_item",
      from: "2026-09",
      to: "2026-10",
      page: 3,
      pageSize: 1,
    });
    expect(third.rows).toEqual([]);
    const invalid = await systemQuery("reports.cells", { from: "x", page: 1, pageSize: 3 });
    expect(invalid).toEqual({ rows: [], total: 0, page: 1, pageSize: 3 });
  });

  it("明細の端数処理は自社設定に従う（切り上げなら 150.50円 → 151円）", async () => {
    const settings = await systemQuery("settings.get", {});
    await systemCommand("settings.updateCompany", {
      ...settings.company,
      version: settings.company.version,
      roundingMode: "ceil",
    });
    const r = await report("sales_item");
    expect(r.rows.rows[0]?.amounts).toEqual([452, 151 + 151 - 150]);
    await systemCommand("settings.updateCompany", {
      ...settings.company,
      version: settings.company.version + 1,
      roundingMode: "floor",
    });
  });
});

describe("集計の画面", () => {
  it.each([["purchasing"], ["sales"], ["accounting"]] as const)(
    "%s の担当者も見られる（閲覧は全員）",
    async (role) => {
      const user = await createEmployee([role]);
      const res = await as(user).get("/reports?from=2026-09&to=2026-10");
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("売上・仕入の集計");
      expect(html).toContain("集計の基準");
      expect(html).toContain("2026年9月");
      expect(html).toContain("集計テスト販売先1");
      expect(html).toContain("1,851");
    },
  );

  it("表示を切り替えると、表の部分に商品別の仕入を出す。条件は CSV のフォームにも入る", async () => {
    const user = await createEmployee(["sales"]);
    const res = await as(user).get("/reports?view=purchases_item&from=2026-09&to=2026-10", {
      "HX-Request": "true",
    });
    const html = await res.text();
    const results = html.slice(html.indexOf('<section id="results">'));
    expect(results).toContain("仕入（商品別）");
    expect(results).toContain(data.a.code);
    expect(results).toContain("4,500");
    expect(results).toContain('name="view" value="purchases_item"');
  });

  it("販売先の行から同じ期間の請求書・廃棄率へ、商品の行から廃棄率へ移れる（仕入には出さない）", async () => {
    const user = await createEmployee(["sales"]);
    const customers = await (await as(user).get("/reports?from=2026-09&to=2026-10")).text();
    expect(customers).toContain(
      `/invoices?customerId=${data.c1.id}&amp;issuedFrom=2026-09-01&amp;issuedTo=2026-10-31`,
    );
    expect(customers).toContain(
      `/disposals/rates?from=2026-09-01&amp;to=2026-10-31&amp;customerId=${data.c1.id}&amp;groupBy=customer`,
    );
    expect(customers).toContain('href="/receivables"');
    const items = await (
      await as(user).get("/reports?view=sales_item&from=2026-09&to=2026-10")
    ).text();
    expect(items).toContain(`itemId=${data.a.id}&amp;groupBy=item`);
    expect(items).not.toContain("/invoices?customerId=");
    const purchases = await (
      await as(user).get("/reports?view=purchases_supplier&from=2026-09&to=2026-10")
    ).text();
    expect(purchases).not.toContain("groupBy=");
  });

  it("期間の誤りは表の部分にメッセージを出す", async () => {
    const user = await createEmployee(["sales"]);
    const html = await (await as(user).get("/reports?from=2026-10&to=2026-09")).text();
    expect(html).toMatch(
      /<section id="results">.*期間（まで）は期間（から）と同じか後の月にしてください/s,
    );
  });

  it("CSV は BOM 付きの UTF-8 で、行 × 月を日本語の列名で出す", async () => {
    const user = await createEmployee(["accounting"]);
    const res = await as(user).post("/reports/csv", {
      view: "sales_customer",
      from: "2026-09",
      to: "2026-10",
      _key: newKey(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes.subarray(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    const lines = new TextDecoder().decode(bytes).split("\r\n");
    expect(lines[0]).toBe("集計,区分,コード,名前,月,金額（税抜）");
    expect(lines.slice(1, 5)).toEqual([
      "売上,販売先,,集計テスト販売先1,2026-09,1851",
      "売上,販売先,,集計テスト販売先1,2026-10,-150",
      "売上,販売先,,集計テスト販売先2,2026-09,0",
      "売上,販売先,,集計テスト販売先2,2026-10,300",
    ]);
  });
});
