/**
 * 発注の状態を、明細の入荷の進み具合と支払の状況から決めること（入荷の記録・入荷の取消・支払・支払の取消・請求書の取消）と、
 * 請求額が 0 円以下の仕入先請求書の精算（相殺・返金を受ける）。
 */
import { describe, expect, it } from "vitest";

import { createItem, createLocation, createSupplier } from "./fixtures";
import { as, createEmployee, newKey, systemCommand, systemQuery } from "./helpers";
import { systemCommandResult } from "./platform-helpers";
import { createConfirmedOrder, orderView, receive } from "./purchasing-fixtures";

/** 仕入先・保管場所・商品（入数12、1,200円/ケース、軽減税率）と、1明細の発注 */
async function singleLineOrder(quantity: number) {
  const supplierId = await createSupplier();
  const locationId = await createLocation();
  const item = await createItem(supplierId);
  const po = await createConfirmedOrder({
    supplierId,
    locationId,
    lines: [{ itemId: item.id, quantity }],
  });
  return { supplierId, locationId, item, po };
}

async function status(orderId: string) {
  return (await orderView(orderId)).order.status;
}

async function invoiceAndPay(supplierId: string, receiptIds: string[], amount: number) {
  const inv = await systemCommand("supplierInvoices.create", {
    supplierId,
    invoiceDate: "2026-10-31",
    invoicedAmount: amount,
    receiptIds,
    differenceReason: "テスト",
  });
  await systemCommand("supplierInvoices.pay", {
    id: inv.id,
    version: 1,
    paidOn: "2026-10-31",
    amount,
  });
  return inv;
}

describe("入荷の取消のあとの発注の状態（明細から決める）", () => {
  it("ほかの入荷で残りを打ち切ってあれば、入荷を取り消しても入荷済みのまま", async () => {
    const { po } = await singleLineOrder(10);
    const a = await receive(po.id, [6]);
    await receive(po.id, [3], { close: [true] });
    expect(await status(po.id)).toBe("received");

    await systemCommand("receipts.cancel", { id: a.id, version: 1, reason: "誤り" });
    const view = await orderView(po.id);
    // B の打ち切りが残っているので、残りは 0。発注済みに戻すと二度と入荷を記録できなくなる
    expect(view.lines[0]?.remaining).toBe(0);
    expect(view.order.status).toBe("received");
    expect(view.actions.receive).toBe(false);
  });

  it("打ち切りを含む入荷を取り消すと、残りが戻って発注済みになる", async () => {
    const { po } = await singleLineOrder(10);
    await receive(po.id, [6]);
    const b = await receive(po.id, [3], { close: [true] });
    await systemCommand("receipts.cancel", { id: b.id, version: 1, reason: "打ち切りの誤り" });
    const view = await orderView(po.id);
    expect(view.lines[0]?.remaining).toBe(4);
    expect(view.order.status).toBe("ordered");
    expect(view.actions.receive).toBe(true);
  });
});

describe("支払うものが残っていない発注は支払済みにする", () => {
  it("支払済みの入荷のあと、受入 0 の入荷で打ち切ると、支払済みになる", async () => {
    const { supplierId, po } = await singleLineOrder(10);
    const a = await receive(po.id, [6]);
    // 6ケース × 1,200円 = 7,200円、軽減税率 8% → 7,776円
    const x = await invoiceAndPay(supplierId, [a.id], 7776);
    expect(await status(po.id)).toBe("ordered");

    const b = await receive(po.id, [0], { close: [true] });
    expect(b.status).toBe("paid");
    expect(await status(po.id)).toBe("paid");

    // 支払を取り消すと入荷済みに戻る（A が未払いになる）
    await systemCommand("supplierInvoices.cancelPayment", {
      id: x.id,
      version: 2,
      reason: "支払の誤り",
    });
    expect(await status(po.id)).toBe("received");
    // 請求書を取り消しても、A は未払いのままなので入荷済み
    await systemCommand("supplierInvoices.cancel", { id: x.id, version: 3, reason: "差し替え" });
    expect(await status(po.id)).toBe("received");
    // 打ち切りを取り消すと発注済みに戻る
    await systemCommand("receipts.cancel", { id: b.id, version: 1, reason: "打ち切りの誤り" });
    expect(await status(po.id)).toBe("ordered");
  });

  it("全数をその場で返品した（受入のある入荷がない）発注は、入荷の記録で支払済みになる", async () => {
    const { po } = await singleLineOrder(2);
    const r = await receive(po.id, [0], { returned: [2] });
    expect(r.status).toBe("paid");
    const view = await orderView(po.id);
    expect(view.order.status).toBe("paid");
    // 支払済みの発注の入荷は取り消せない
    expect(view.cancellableReceiptIds).toEqual([]);
  });

  it("未払いの入荷を取り消して、残りの入荷がすべて支払済みなら支払済みになる", async () => {
    const { supplierId, po } = await singleLineOrder(10);
    const a = await receive(po.id, [6]);
    await invoiceAndPay(supplierId, [a.id], 7776);
    const b = await receive(po.id, [2]);
    await receive(po.id, [0], { close: [true] });
    expect(await status(po.id)).toBe("received");
    await systemCommand("receipts.cancel", { id: b.id, version: 1, reason: "誤り" });
    const view = await orderView(po.id);
    expect(view.lines[0]?.remaining).toBe(0);
    expect(view.order.status).toBe("paid");
  });
});

/** 前の請求で支払った入荷の返品が、次の請求の入荷より多い仕入先 */
async function negativeInvoiceSetup() {
  const { supplierId, locationId, item, po } = await singleLineOrder(5);
  const first = await receive(po.id, [5]);
  await invoiceAndPay(supplierId, [first.id], 6480);
  const lineId = (await orderView(po.id)).order.lines[0]?.id ?? "";
  // 2ケース分（24個 = 2,400円）を仕入返品する
  const ret = await systemCommand("purchaseReturns.create", {
    purchaseOrderId: po.id,
    returnedOn: "2026-10-20",
    locationId,
    lines: [{ lineId, units: 24 }],
  });
  const po2 = await createConfirmedOrder({
    supplierId,
    locationId,
    lines: [{ itemId: item.id, quantity: 1 }],
  });
  const second = await receive(po2.id, [1], { receivedOn: "2026-10-21" });
  // (1,200 − 2,400) × 1.08 = −1,296
  const inv = await systemCommand("supplierInvoices.create", {
    supplierId,
    invoiceDate: "2026-10-31",
    invoicedAmount: -1296,
    receiptIds: [second.id],
    returnIds: [ret.id],
  });
  return { supplierId, po2, inv };
}

describe("請求額が 0 円以下の仕入先請求書（相殺・返金を受ける）", () => {
  it("請求額と同じ額（マイナス）で精算でき、買掛残高は 0 になり、発注は支払済みになる", async () => {
    const user = await createEmployee(["accounting"]);
    const { supplierId, po2, inv } = await negativeInvoiceSetup();
    const view = await systemQuery("supplierInvoices.get", { id: inv.id });
    expect(view?.invoice.computedAmount).toBe(-1296);
    expect(view?.actions.pay).toBe(true);
    expect(view?.settlement).toBe(true);
    const page = await (await as(user).get(`/supplier-invoices/${inv.id}`)).text();
    expect(page).toContain("精算する（相殺・返金）");
    expect(page).not.toContain("支払済みにする");
    const list = await (await as(user).get(`/payables?supplierId=${supplierId}`)).text();
    expect(list).toContain("精算（相殺・返金）");

    for (const amount of ["0", "-1", "1296"]) {
      const bad = await as(user).hx(`/supplier-invoices/${inv.id}/pay`, {
        _key: newKey(),
        version: "1",
        paidOn: "2026-11-02",
        amount,
      });
      expect(await bad.text()).toContain("請求額と同じ");
    }
    const res = await as(user).hx(`/supplier-invoices/${inv.id}/pay`, {
      _key: newKey(),
      version: "1",
      paidOn: "2026-11-02",
      amount: "-1,296",
    });
    expect(res.headers.get("HX-Redirect")).toContain("notice=paid");
    const paid = await systemQuery("supplierInvoices.get", { id: inv.id });
    expect(paid?.invoice.status).toBe("paid");
    expect(paid?.payments[0]?.amount).toBe(-1296);
    expect(await status(po2.id)).toBe("paid");
    // 支払予定（未払い）から消える
    const payables = await systemQuery("payables.list", { supplierId });
    expect(payables.rows.map((r) => r.id)).not.toContain(inv.id);
    // 10月：請求 6,480 − 1,296、支払 6,480 → 月末の残高 −1,296（仕入先から相殺・返金を受ける額）
    // 11月：精算 −1,296 → 月末の残高 0
    const balances = await systemQuery("payables.balances", {
      from: "2026-10",
      to: "2026-11",
      supplierId,
    });
    expect(balances.rows[0]?.months.map((m) => m.balance)).toEqual([-1296, 0]);
  });

  it("一括支払いでも請求額（0 円・マイナス）で精算する", async () => {
    const { supplierId, po2, inv } = await negativeInvoiceSetup();
    const locationId = await createLocation();
    const item = await createItem(supplierId);
    const po = await createConfirmedOrder({
      supplierId,
      locationId,
      lines: [{ itemId: item.id, quantity: 1 }],
    });
    const r = await receive(po.id, [1]);
    const lineId = (await orderView(po.id)).order.lines[0]?.id ?? "";
    const ret = await systemCommand("purchaseReturns.create", {
      purchaseOrderId: po.id,
      returnedOn: "2026-10-22",
      locationId,
      lines: [{ lineId, units: 12 }],
    });
    // 入荷 1,200 − 返品 1,200 = 0 円
    const zero = await systemCommand("supplierInvoices.create", {
      supplierId,
      invoiceDate: "2026-10-31",
      invoicedAmount: 0,
      receiptIds: [r.id],
      returnIds: [ret.id],
    });
    const result = await systemCommand("supplierInvoices.payBulk", {
      invoices: [
        { id: inv.id, version: 1 },
        { id: zero.id, version: 1 },
      ],
      paidOn: "2026-11-02",
    });
    expect(result).toMatchObject({ count: 2, amount: -1296 });
    expect((await systemQuery("supplierInvoices.get", { id: zero.id }))?.payments[0]?.amount).toBe(
      0,
    );
    expect(await status(po2.id)).toBe("paid");
    expect(await status(po.id)).toBe("paid");
  });

  it("請求額が 1 円以上の請求書は、これまでどおり 1 円以上の支払額で支払う", async () => {
    const { supplierId, po } = await singleLineOrder(1);
    const r = await receive(po.id, [1]);
    const inv = await systemCommand("supplierInvoices.create", {
      supplierId,
      invoiceDate: "2026-10-31",
      invoicedAmount: 1296,
      receiptIds: [r.id],
    });
    const zero = await systemCommandResult("supplierInvoices.pay", {
      id: inv.id,
      version: 1,
      paidOn: "2026-11-02",
      amount: 0,
    });
    expect(zero).toMatchObject({ ok: false, error: { code: "validation" } });
    const negative = await systemCommandResult("supplierInvoices.pay", {
      id: inv.id,
      version: 1,
      paidOn: "2026-11-02",
      amount: -1296,
    });
    expect(negative.ok).toBe(false);
    // 一部の額でも支払える（差額は経理が確かめる）
    await systemCommand("supplierInvoices.pay", {
      id: inv.id,
      version: 1,
      paidOn: "2026-11-02",
      amount: 1000,
    });
    expect(await status(po.id)).toBe("paid");
    const view = await systemQuery("supplierInvoices.get", { id: inv.id });
    expect(view?.settlement).toBe(false);
  });
});
