import { describe, expect, it } from "vitest";

import { createItem, createLocation, createSupplier } from "./fixtures";
import { as, createEmployee, newKey, systemCommand, systemQuery } from "./helpers";
import { systemCommandResult } from "./platform-helpers";
import {
  createConfirmedOrder,
  createSupplierWithTerms,
  orderView,
  receive,
} from "./purchasing-fixtures";

/** 仕入先（取引条件の有無を選べる）・入荷2件（9月と10月） */
async function invoiceSetup(withTerms: boolean) {
  const supplierId = withTerms ? await createSupplierWithTerms() : await createSupplier();
  const locationId = await createLocation();
  const item = await createItem(supplierId);
  const po = await createConfirmedOrder({
    supplierId,
    locationId,
    lines: [{ itemId: item.id, quantity: 5 }],
    orderedOn: "2026-09-01",
  });
  const september = await receive(po.id, [1], { receivedOn: "2026-09-25" });
  const october = await receive(po.id, [4], { receivedOn: "2026-10-10" });
  return { supplierId, locationId, item, po, september, october };
}

function invoiceForm(
  supplierId: string,
  receiptIds: string[],
  overrides: Record<string, string | string[]> = {},
) {
  return {
    _key: newKey(),
    supplierId,
    invoiceNumber: "A-1001",
    invoiceDate: "2026-10-31",
    invoicedAmount: "",
    shippingFee: "0",
    differenceReason: "",
    paymentDueOn: "",
    memo: "",
    receiptIds,
    ...overrides,
  };
}

describe("仕入先請求書の登録", () => {
  it("締め日のある仕入先は締め期間内の入荷を選んだ状態で開き、計算額と差額をその場で計算する", async () => {
    const user = await createEmployee(["accounting"]);
    const { supplierId, september, october } = await invoiceSetup(true);
    const page = await (
      await as(user).get(`/supplier-invoices/new?supplierId=${supplierId}&invoiceDate=2026-11-02`)
    ).text();
    expect(page).toContain("締め期間（2026-10-01〜2026-10-31）");
    expect(page).toMatch(new RegExp(`value="${october.id}" checked`));
    expect(page).not.toMatch(new RegExp(`value="${september.id}" checked`));
    // 10月の入荷：1,200円 × 4 = 4,800円、軽減税率 8% → 384円、計算額 5,184円
    expect(page).toContain("¥5,184");

    const preview = await as(user).hx("/supplier-invoices/preview", {
      supplierId,
      invoiceDate: "2026-10-31",
      receiptIds: [september.id, october.id],
      shippingFee: "550",
      invoicedAmount: "7000",
    });
    const html = await preview.text();
    // 6,000 + 480 + 送料 550 = 7,030、差額 −30
    expect(html).toContain("¥7,030");
    expect(html).toContain("¥-30");
    expect(html).toContain("差額があります");
    expect(html).toContain("取引条件からの支払予定日：2026-11-30");
  });

  it("締め日のない仕入先は何も選ばない状態で開く。入荷を選ばない登録はエラー", async () => {
    const user = await createEmployee(["accounting"]);
    const { supplierId, september, october } = await invoiceSetup(false);
    const page = await (
      await as(user).get(`/supplier-invoices/new?supplierId=${supplierId}`)
    ).text();
    expect(page).toContain("締め日が未設定です");
    expect(page).not.toMatch(new RegExp(`value="${september.id}" checked`));
    expect(page).not.toMatch(new RegExp(`value="${october.id}" checked`));
    const none = await as(user).hx(
      "/supplier-invoices/new",
      invoiceForm(supplierId, [], {
        invoicedAmount: "0",
      }),
    );
    expect(await none.text()).toContain("入荷を1件以上選んでください");
  });

  it("差額があれば理由が必要。理由を入れれば登録でき、支払予定日は取引条件から計算する", async () => {
    const user = await createEmployee(["accounting"]);
    const { supplierId, po, october } = await invoiceSetup(true);
    const noReason = await as(user).hx(
      "/supplier-invoices/new",
      invoiceForm(supplierId, [october.id], { invoicedAmount: "5,200" }),
    );
    expect(await noReason.text()).toContain("差額の理由を入力してください");
    const form = invoiceForm(supplierId, [october.id], {
      invoicedAmount: "5,200",
      differenceReason: "端数の処理の違い",
    });
    const res = await as(user).hx("/supplier-invoices/new", form);
    expect(res.status).toBe(204);
    const location = res.headers.get("HX-Redirect") ?? "";
    // 同じ受付番号の二重送信でも1件
    const again = await as(user).hx("/supplier-invoices/new", form);
    expect(again.headers.get("HX-Redirect")).toBe(location);
    const id = /^\/supplier-invoices\/([0-9A-Z]{26})/.exec(location)?.[1] ?? "";
    const view = await systemQuery("supplierInvoices.get", { id });
    expect(view?.invoice.computedAmount).toBe(5184);
    expect(view?.invoice.difference).toBe(16);
    expect(view?.invoice.differenceReason).toBe("端数の処理の違い");
    expect(view?.invoice.paymentDueOn).toBe("2026-11-30");
    expect(view?.invoice.status).toBe("unpaid");
    const html = await (await as(user).get(location)).text();
    expect(html).toContain("端数の処理の違い");
    expect(html).toContain("支払済みにする");
    // 発注の詳細から請求書に移れる
    const poHtml = await (await as(user).get(`/purchase-orders/${po.id}`)).text();
    expect(poHtml).toContain(`/supplier-invoices/${id}`);
    // 同じ入荷は別の請求書に入れられない
    const dup = await systemCommandResult("supplierInvoices.create", {
      supplierId,
      invoiceDate: "2026-10-31",
      invoicedAmount: 5184,
      receiptIds: [october.id],
    });
    expect(dup.ok).toBe(false);
  });

  it("仕入担当は仕入先請求書を登録・支払できない（権限）", async () => {
    const user = await createEmployee(["purchasing"]);
    const { supplierId, october } = await invoiceSetup(false);
    const page = await (
      await as(user).get(`/supplier-invoices/new?supplierId=${supplierId}`)
    ).text();
    expect(page).toContain("仕入先請求書を登録する権限がありません");
    const res = await as(user).hx(
      "/supplier-invoices/new",
      invoiceForm(supplierId, [october.id], { invoicedAmount: "5184" }),
    );
    expect(await res.text()).toContain("この操作を行う権限がありません");
  });

  it("仕入返品を差し引いて計算する", async () => {
    const { supplierId, locationId, po, october } = await invoiceSetup(false);
    const view = await orderView(po.id);
    const ret = await systemCommand("purchaseReturns.create", {
      purchaseOrderId: po.id,
      returnedOn: "2026-10-15",
      locationId,
      lines: [{ lineId: view.order.lines[0]?.id ?? "", units: 6 }],
    });
    const candidates = await systemQuery("supplierInvoices.candidates", {
      supplierId,
      invoiceDate: "2026-10-31",
    });
    expect(candidates?.returns.map((r) => r.id)).toEqual([ret.id]);
    expect(candidates?.returns[0]?.subtotal).toBe(600);
    const preview = await systemQuery("supplierInvoices.preview", {
      supplierId,
      invoiceDate: "2026-10-31",
      receiptIds: [october.id],
      returnIds: [ret.id],
      shippingFee: 0,
      invoicedAmount: 4536,
    });
    // (4,800 − 600) × 1.08 = 4,536
    expect(preview.amounts?.computedAmount).toBe(4536);
    expect(preview.difference).toBe(0);
  });
});

describe("支払", () => {
  it("支払うと発注が支払済みになり、支払を取り消すと入荷済みに戻る。支払済みの入荷は取り消せない", async () => {
    const user = await createEmployee(["accounting"]);
    const { supplierId, po, september, october } = await invoiceSetup(false);
    expect((await orderView(po.id)).order.status).toBe("received");
    const created = await systemCommand("supplierInvoices.create", {
      supplierId,
      invoiceDate: "2026-10-31",
      invoicedAmount: 6480,
      receiptIds: [september.id, october.id],
      paymentDueOn: "2026-11-30",
    });
    const bad = await as(user).hx(`/supplier-invoices/${created.id}/pay`, {
      _key: newKey(),
      version: "1",
      paidOn: "2026-11-30",
      amount: "0",
    });
    expect(await bad.text()).toContain("支払額は1円以上で入力してください");
    const res = await as(user).hx(`/supplier-invoices/${created.id}/pay`, {
      _key: newKey(),
      version: "1",
      paidOn: "2026-11-30",
      amount: "6480",
      memo: "振込",
    });
    expect(res.headers.get("HX-Redirect")).toContain("notice=paid");
    expect((await orderView(po.id)).order.status).toBe("paid");
    const cancelReceipt = await systemCommandResult("receipts.cancel", {
      id: october.id,
      version: 1,
      reason: "誤り",
    });
    expect(cancelReceipt).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("支払済み") },
    });
    const cannotCancel = await systemCommandResult("supplierInvoices.cancel", {
      id: created.id,
      version: 2,
      reason: "誤り",
    });
    expect(cannotCancel.ok).toBe(false);

    const noReason = await as(user).hx(`/supplier-invoices/${created.id}/cancel-payment`, {
      _key: newKey(),
      version: "2",
      reason: "",
    });
    expect(await noReason.text()).toContain("入力内容を確認してください");
    const back = await as(user).hx(`/supplier-invoices/${created.id}/cancel-payment`, {
      _key: newKey(),
      version: "2",
      reason: "二重払いの訂正",
    });
    expect(back.headers.get("HX-Redirect")).toContain("notice=paymentCancelled");
    expect((await orderView(po.id)).order.status).toBe("received");
    const view = await systemQuery("supplierInvoices.get", { id: created.id });
    expect(view?.invoice.status).toBe("unpaid");
    expect(view?.payments[0]?.cancelled).toBe(true);
    expect(view?.payments[0]?.cancelReason).toBe("二重払いの訂正");

    // 取消すと入荷が外れ、別の請求書に入れ直せる
    const cancel = await as(user).hx(`/supplier-invoices/${created.id}/cancel`, {
      _key: newKey(),
      version: "3",
      reason: "請求書の差し替え",
    });
    expect(cancel.headers.get("HX-Redirect")).toContain("notice=cancelled");
    const candidates = await systemQuery("supplierInvoices.candidates", {
      supplierId,
      invoiceDate: "2026-10-31",
    });
    expect(candidates?.receipts.map((r) => r.id).toSorted()).toEqual(
      [september.id, october.id].toSorted(),
    );
  });

  it("分納の途中で支払っても発注は発注済みのまま。未払いの請求書の入荷を取り消すと計算額を直す", async () => {
    const supplierId = await createSupplier();
    const locationId = await createLocation();
    const item = await createItem(supplierId);
    const po = await createConfirmedOrder({
      supplierId,
      locationId,
      lines: [{ itemId: item.id, quantity: 5 }],
    });
    const first = await receive(po.id, [1]);
    const second = await receive(po.id, [1]);
    const inv = await systemCommand("supplierInvoices.create", {
      supplierId,
      invoiceDate: "2026-10-31",
      invoicedAmount: 2592,
      receiptIds: [first.id, second.id],
    });
    await systemCommand("receipts.cancel", { id: second.id, version: 1, reason: "誤り" });
    const view = await systemQuery("supplierInvoices.get", { id: inv.id });
    expect(view?.receipts.map((r) => r.id)).toEqual([first.id]);
    expect(view?.invoice.computedAmount).toBe(1296);
    expect(view?.invoice.difference).toBe(1296);
    expect(view?.invoice.differenceReason).toContain("の取消で計算額が変わりました");
    await systemCommand("supplierInvoices.pay", {
      id: inv.id,
      version: view?.invoice.version ?? 0,
      paidOn: "2026-11-30",
      amount: 1296,
    });
    expect((await orderView(po.id)).order.status).toBe("ordered");
  });
});

describe("支払予定一覧と一括支払い", () => {
  it("未払いの合計を出し、選んだ請求書を1つのトランザクションで支払済みにする", async () => {
    const user = await createEmployee(["accounting"]);
    const a = await invoiceSetup(false);
    const b = await invoiceSetup(false);
    const invA = await systemCommand("supplierInvoices.create", {
      supplierId: a.supplierId,
      invoiceDate: "2026-10-31",
      invoicedAmount: 6480,
      receiptIds: [a.september.id, a.october.id],
      paymentDueOn: "2026-11-05",
    });
    const invB = await systemCommand("supplierInvoices.create", {
      supplierId: b.supplierId,
      invoiceDate: "2026-10-31",
      invoicedAmount: 6480,
      receiptIds: [b.september.id, b.october.id],
      paymentDueOn: "2026-11-06",
    });
    const list = await (await as(user).get(`/payables?supplierId=${a.supplierId}`)).text();
    expect(list).toContain("未払い <strong>1件</strong>");
    expect(list).toContain(`value="${invA.id}:1"`);
    expect(list).not.toContain(invB.id);
    const csv = await as(user).post("/payables/csv", { _key: newKey(), supplierId: a.supplierId });
    const text = await csv.text();
    expect(text).toContain("請求書番号");
    expect(text).toContain("6480");

    // 1件でも支払えないもの（古い版）があれば、どれも支払わない
    const stale = await as(user).hx("/payables/pay", {
      _key: newKey(),
      paidOn: "2026-11-05",
      invoice: [`${invA.id}:1`, `${invB.id}:9`],
    });
    const staleHtml = await stale.text();
    expect(staleHtml).toContain("支払えない請求書があるため、どれも支払っていません");
    expect((await systemQuery("supplierInvoices.get", { id: invA.id }))?.invoice.status).toBe(
      "unpaid",
    );
    const form = {
      _key: newKey(),
      paidOn: "2026-11-05",
      invoice: [`${invA.id}:1`, `${invB.id}:1`],
    };
    const res = await as(user).hx("/payables/pay", form);
    const html = await res.text();
    expect(html).toContain("2件の仕入先請求書を支払済みにしました（合計 ¥12,960）");
    // 二重送信でも1回だけ
    const again = await as(user).hx("/payables/pay", form);
    expect(await again.text()).toContain("2件の仕入先請求書を支払済みにしました");
    const viewA = await systemQuery("supplierInvoices.get", { id: invA.id });
    expect(viewA?.invoice.status).toBe("paid");
    expect(viewA?.payments).toHaveLength(1);
    expect(viewA?.payments[0]?.amount).toBe(6480);
    expect((await orderView(a.po.id)).order.status).toBe("paid");
    const sales = await createEmployee(["sales"]);
    const denied = await as(sales).hx("/payables/pay", { ...form, _key: newKey() });
    expect(await denied.text()).toContain("この操作を行う権限がありません");
  });

  it("仕入先別・月別の買掛残高（請求額 − 支払額の累計）と CSV", async () => {
    const user = await createEmployee(["purchasing"]);
    const a = await invoiceSetup(false);
    const inv = await systemCommand("supplierInvoices.create", {
      supplierId: a.supplierId,
      invoiceDate: "2026-09-30",
      invoicedAmount: 6480,
      receiptIds: [a.september.id, a.october.id],
    });
    await systemCommand("supplierInvoices.pay", {
      id: inv.id,
      version: 1,
      paidOn: "2026-10-31",
      amount: 6000,
    });
    const data = await systemQuery("payables.balances", {
      from: "2026-09",
      to: "2026-11",
      supplierId: a.supplierId,
    });
    expect(data.months).toEqual(["2026-09", "2026-10", "2026-11"]);
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]?.months.map((m) => m.balance)).toEqual([6480, 480, 480]);
    const later = await systemQuery("payables.balances", {
      from: "2026-11",
      to: "2026-11",
      supplierId: a.supplierId,
    });
    expect(later.rows[0]?.opening).toBe(480);
    const html = await (
      await as(user).get(`/payables/balances?from=2026-09&to=2026-11&supplierId=${a.supplierId}`)
    ).text();
    expect(html).toContain("¥6,480");
    expect(html).toContain("¥480");
    const csv = await (
      await as(user).get(
        `/payables/balances.csv?from=2026-09&to=2026-11&supplierId=${a.supplierId}`,
      )
    ).text();
    expect(csv).toContain("2026-10,0,6000,480");
    const list = await (
      await as(user).get(`/supplier-invoices?supplierId=${a.supplierId}&status=paid`)
    ).text();
    expect(list).toContain("支払済み");
    const listCsv = await as(user).post("/supplier-invoices/csv", {
      _key: newKey(),
      supplierId: a.supplierId,
    });
    expect(await listCsv.text()).toContain("2026-10-31,6000");
  });
});
