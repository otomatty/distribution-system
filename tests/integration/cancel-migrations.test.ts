/**
 * マイグレーションのデータの移し替え（0006 の仕入先請求書の支払済みの額）。
 * 列を足す前に記録した支払を、マイグレーションの UPDATE で写せることを確かめる。
 * 列を足す ALTER は業務 DB の起動のたびに適用済みなので、ここでは列を空に戻してから UPDATE だけを流し直す。
 */
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { businessMigrations } from "../../src/infra/db/migrations/business.generated";
import { businessDb } from "../../src/infra/do/client";
import { createItem, createLocation, createSupplier } from "./fixtures";
import { systemCommand, systemQuery } from "./helpers";
import { createConfirmedOrder, receive } from "./purchasing-fixtures";

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
