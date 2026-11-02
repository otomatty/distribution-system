/**
 * 画面に出す金額の合計は照会（ユースケース）が返し、画面は表示するだけにする（AGENTS.md 4章「金額と数量」）。
 * - 発注詳細：入荷ごと・仕入返品ごとの金額（税抜）
 * - 入金の詳細：消込ごとに請求書へ充てた額（入金額 + 差額）
 * - 締め処理の確認：選んだ販売先の請求額の合計
 */
import { describe, expect, it } from "vitest";

import { addDays } from "../../src/domain/dates";
import {
  billingSetup,
  createClosingCustomer,
  invoiceView,
  issuePerShipment,
  lastMonth,
  shipOrder,
} from "./billing-fixtures";
import { as, createEmployee, systemCommand, systemQuery } from "./helpers";
import { createConfirmedOrder, orderView, purchasingSetup, receive } from "./purchasing-fixtures";
import { today } from "./sales-fixtures";

describe("画面に出す合計は照会が返す", () => {
  it("発注詳細の入荷ごと・仕入返品ごとの金額（税抜）", async () => {
    const user = await createEmployee(["purchasing"]);
    const { supplierId, locationId, a, b } = await purchasingSetup();
    const po = await createConfirmedOrder({
      supplierId,
      locationId,
      lines: [
        { itemId: a.id, quantity: 3 },
        { itemId: b.id, quantity: 2, unitPriceCenti: 99_999 },
      ],
    });
    // 1,200 × 3 + 999.99 × 2 = 3,600 + 1,999（1円未満は明細ごとに切り捨て）
    await receive(po.id, [3, 2]);
    const lineId = (await orderView(po.id)).order.lines[0]?.id ?? "";
    await systemCommand("purchaseReturns.create", {
      purchaseOrderId: po.id,
      returnedOn: "2026-10-15",
      locationId,
      lines: [{ lineId, units: 6 }],
    });
    const view = await orderView(po.id);
    expect(view.receipts.map((r) => r.subtotal)).toEqual([5599]);
    // 6個 × 1,200円 ÷ 12 = 600円
    expect(view.returns.map((r) => r.subtotal)).toEqual([600]);
    const html = await (await as(user).get(`/purchase-orders/${po.id}`)).text();
    expect(html).toContain("¥5,599");
    expect(html).toContain("¥600");
  });

  it("入金の詳細の、消込ごとに請求書へ充てた額（入金額 + 差額）", async () => {
    const user = await createEmployee(["accounting"]);
    const setup = await billingSetup();
    const invoice = await issuePerShipment(await shipOrder(setup), {
      dueOn: addDays(today(), 30),
    });
    const v = (await invoiceView(invoice.id)).invoice.version;
    const payment = await systemCommand("customerPayments.create", {
      customerId: setup.customer.id,
      receivedOn: today(),
      amount: 1587,
      method: "transfer",
      allocations: [
        {
          invoiceId: invoice.id,
          version: v,
          amount: 1587,
          adjustment: 440,
          adjustmentKind: "bank_fee",
        },
      ],
    });
    const view = await systemQuery("customerPayments.get", { id: payment.id });
    expect(view?.allocations.map((a) => a.settled)).toEqual([2027]);
    const html = await (await as(user).get(`/receipts/${payment.id}`)).text();
    expect(html).toContain(`${invoice.number} への消込（¥2,027）を取り消します`);
  });

  it("締め処理の確認の、選んだ販売先の請求額の合計", async () => {
    const user = await createEmployee(["accounting"]);
    const setup = await billingSetup();
    const period = lastMonth();
    const x = await createClosingCustomer();
    const y = await createClosingCustomer();
    await shipOrder(setup, { customerId: x.id, shippedOn: period.from });
    await shipOrder(setup, { customerId: y.id, shippedOn: period.from, charges: [] });
    const r = await systemQuery("invoices.closing", { selected: [x.id, y.id, "missing"] });
    const totals = (r.selection?.targets ?? []).map((t) => t.summary?.total ?? 0);
    expect(r.selection?.targets.map((t) => t.customerId).toSorted()).toEqual(
      [x.id, y.id].toSorted(),
    );
    // 2,027円（送料800円つき）と 1,147円（送料なし）
    expect(totals.toSorted((p, q) => p - q)).toEqual([1147, 2027]);
    expect(r.selection?.total).toBe(3174);
    expect((await systemQuery("invoices.closing", {})).selection).toBeNull();
    const confirm = await (
      await as(user).hx("/invoices/closing/confirm", { customerId: [x.id, y.id], issuedOn: "" })
    ).text();
    expect(confirm).toContain("2 件");
    expect(confirm).toContain("請求額の合計 ¥3,174");
  });
});
