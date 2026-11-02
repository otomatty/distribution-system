/**
 * マイグレーションのデータの移し替え（0006 の仕入先請求書の支払済みの額、0009 の取消の理由・日時・操作者）。
 * 列を足す前に記録した取消（理由は操作履歴だけにあった）と支払を、マイグレーションの UPDATE で写せることを確かめる。
 * 列を足す ALTER は業務 DB の起動のたびに適用済みなので、ここでは列を空に戻してから UPDATE だけを流し直す。
 */
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { businessMigrations } from "../../src/infra/db/migrations/business.generated";
import { businessDb } from "../../src/infra/do/client";
import {
  billingSetup,
  issuePerShipment,
  recordReturn,
  returnVersion,
  shipOrder,
} from "./billing-fixtures";
import { createItem, createLocation, createSupplier } from "./fixtures";
import { systemCommand, systemQuery } from "./helpers";
import { createConfirmedOrder, receive } from "./purchasing-fixtures";
import { today } from "./sales-fixtures";

/** マイグレーションの中の UPDATE 文だけ（データの移し替え） */
function updates(key: string): string[] {
  const sql = businessMigrations.migrations[key];
  if (sql === undefined) throw new Error(`マイグレーション ${key} がありません`);
  return sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("UPDATE"));
}

function exec(statements: readonly string[]): Promise<void> {
  return runInDurableObject(businessDb(env), (_instance, state) => {
    for (const s of statements) state.storage.sql.exec(s);
  });
}

describe("マイグレーションのデータの移し替え", () => {
  it("0009：取り消した入金・消込・返品伝票の理由を操作履歴から写し、日時・操作者は最後の更新から写す", async () => {
    expect(updates("m0009")).toHaveLength(3);
    const setup = await billingSetup();
    const shipped = await shipOrder(setup);
    const invoice = await issuePerShipment(shipped);
    const payment = await systemCommand("customerPayments.create", {
      customerId: setup.customer.id,
      receivedOn: today(),
      amount: 1000,
      method: "transfer",
      allocations: [{ invoiceId: invoice.id, version: 1, amount: 1000 }],
    });
    const view = await systemQuery("customerPayments.get", { id: payment.id });
    await systemCommand("customerPayments.cancel", {
      paymentId: payment.id,
      version: view?.payment.version ?? 0,
      reason: "二重に記録した",
    });
    const second = await shipOrder(setup);
    const ret = await recordReturn(second.order.id, { quantity: 1 });
    await systemCommand("salesReturns.cancel", {
      id: ret.id,
      version: await returnVersion(ret.id),
      reason: "数え間違い",
    });
    // 列を足す前の記録と同じ状態（理由・日時・操作者が空）にする
    await exec([
      "UPDATE customer_payments SET cancel_reason = NULL, cancelled_at = NULL, cancelled_by = NULL",
      "UPDATE payment_allocations SET cancel_reason = NULL, cancelled_at = NULL, cancelled_by = NULL",
      "UPDATE sales_returns SET cancel_reason = NULL, cancelled_at = NULL, cancelled_by = NULL",
    ]);
    expect(
      (await systemQuery("customerPayments.get", { id: payment.id }))?.payment.cancelReason,
    ).toBeNull();

    await exec(updates("m0009"));
    const restored = await systemQuery("customerPayments.get", { id: payment.id });
    expect(restored?.payment).toMatchObject({
      cancelReason: "二重に記録した",
      cancelledAt: expect.any(String),
    });
    expect(restored?.allocations[0]).toMatchObject({
      cancelReason: "入金の取消：二重に記録した",
      cancelledAt: expect.any(String),
    });
    expect((await systemQuery("salesReturns.get", { id: ret.id }))?.ret).toMatchObject({
      cancelReason: "数え間違い",
      cancelledAt: expect.any(String),
    });
  });

  it("0006：仕入先請求書の支払済みの額を、取り消していない支払の合計から写す", async () => {
    expect(updates("m0006")).toHaveLength(1);
    const supplierId = await createSupplier();
    const locationId = await createLocation();
    const item = await createItem(supplierId);
    const po = await createConfirmedOrder({
      supplierId,
      locationId,
      lines: [{ itemId: item.id, quantity: 2 }],
    });
    const receipt = await receive(po.id, [2]);
    const inv = await systemCommand("supplierInvoices.create", {
      supplierId,
      invoiceDate: "2026-10-31",
      invoicedAmount: 2592,
      receiptIds: [receipt.id],
    });
    const a = await systemCommand("supplierInvoices.pay", {
      id: inv.id,
      version: 1,
      paidOn: "2026-11-01",
      amount: 1000,
    });
    await systemCommand("supplierInvoices.pay", {
      id: inv.id,
      version: 2,
      paidOn: "2026-11-02",
      amount: 500,
    });
    await systemCommand("supplierInvoices.cancelPayment", {
      id: inv.id,
      version: 3,
      paymentId: a.paymentId,
      reason: "誤り",
    });
    await exec([`UPDATE supplier_invoices SET paid_amount = 0 WHERE id = '${inv.id}'`]);
    expect((await systemQuery("supplierInvoices.get", { id: inv.id }))?.invoice.paidAmount).toBe(0);
    await exec(updates("m0006"));
    expect((await systemQuery("supplierInvoices.get", { id: inv.id }))?.invoice.paidAmount).toBe(
      500,
    );
  });
});
