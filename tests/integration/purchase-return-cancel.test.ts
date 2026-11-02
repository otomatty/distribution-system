/**
 * 仕入返品の取消（入荷の取消と同じ条件）。理由が必須、版番号・受付番号・操作履歴、在庫は打ち消しの行で戻す、
 * 未払いの仕入先請求書からは外して計算額と差額を直す、支払（一部を含む）を記録した請求書の仕入返品は取り消せない。
 */
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { Result } from "../../src/domain/result";
import * as schema from "../../src/infra/db/schema";
import { businessDb } from "../../src/infra/do/client";
import type { CommandInput, CommandName } from "../../src/usecases/registry";
import { createItem, createLocation, createSupplier } from "./fixtures";
import { as, createEmployee, newKey, systemCommand, systemQuery } from "./helpers";
import { readDb, systemCommandResult } from "./platform-helpers";
import { createConfirmedOrder, onHand, orderView, receive } from "./purchasing-fixtures";

async function command<N extends CommandName>(
  email: string,
  name: N,
  input: CommandInput<N>,
  key: string = newKey(),
): Promise<Result<unknown>> {
  return businessDb(env).command(name, input, { kind: "dev", email }, key);
}

/** 入荷（受入 2 ケース = 24 個）と、その仕入返品（units 個） */
async function returnSetup(units = 6) {
  const supplierId = await createSupplier();
  const locationId = await createLocation();
  const item = await createItem(supplierId);
  const po = await createConfirmedOrder({
    supplierId,
    locationId,
    lines: [{ itemId: item.id, quantity: 2 }],
  });
  const receipt = await receive(po.id, [2]);
  const lineId = (await orderView(po.id)).order.lines[0]?.id ?? "";
  const ret = await systemCommand("purchaseReturns.create", {
    purchaseOrderId: po.id,
    returnedOn: "2026-10-15",
    locationId,
    lines: [{ lineId, units }],
  });
  return { supplierId, locationId, item, po, receipt, lineId, ret };
}

async function returnOf(orderId: string, returnId: string) {
  const view = await orderView(orderId);
  const ret = view.returns.find((r) => r.id === returnId);
  if (!ret) throw new Error("仕入返品が見つかりません");
  return { view, ret };
}

function ledgerOf(returnId: string) {
  return readDb((db) =>
    db
      .select()
      .from(schema.stockLedger)
      .where(
        and(
          eq(schema.stockLedger.sourceType, "purchase_return"),
          eq(schema.stockLedger.sourceId, returnId),
        ),
      )
      .orderBy(schema.stockLedger.id)
      .all(),
  );
}

describe("仕入返品の取消", () => {
  it("在庫を打ち消しの行で戻し、返品できる数も戻る。権限・二重送信・版番号・理由を確かめる", async () => {
    const { po, item, locationId, ret } = await returnSetup(6);
    expect(await onHand(item.id, locationId)).toBe(24 - 6);
    const before = await returnOf(po.id, ret.id);
    expect(before.view.lines[0]?.returnableUnits).toBe(18);
    expect(before.view.cancellableReturnIds).toEqual([ret.id]);
    const version = before.ret.version;

    // 権限：仕入返品の権限（仕入担当・管理者）だけ
    for (const roles of [["sales"], ["accounting"]] as const) {
      const user = await createEmployee([...roles]);
      expect(
        await command(user, "purchaseReturns.cancel", { id: ret.id, version, reason: "誤り" }),
      ).toMatchObject({ ok: false, error: { code: "forbidden" } });
    }
    // 理由が必須・古い版は conflict・見つからなければ not_found
    expect(
      await systemCommandResult("purchaseReturns.cancel", { id: ret.id, version, reason: " " }),
    ).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(
      await systemCommandResult("purchaseReturns.cancel", {
        id: ret.id,
        version: version + 1,
        reason: "誤り",
      }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(
      await systemCommandResult("purchaseReturns.cancel", {
        id: "01ZZZZZZZZZZZZZZZZZZZZZZZZ",
        version: 1,
        reason: "誤り",
      }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });

    const buyer = await createEmployee(["purchasing"]);
    const key = newKey();
    const input = { id: ret.id, version, reason: "返品数の入力誤り" };
    const first = await command(buyer, "purchaseReturns.cancel", input, key);
    expect(first).toMatchObject({ ok: true, value: { id: ret.id, purchaseOrderId: po.id } });
    // 同じ受付番号の二重送信は前回の結果を返し、二重に戻さない
    expect(await command(buyer, "purchaseReturns.cancel", input, key)).toEqual(first);
    expect(await onHand(item.id, locationId)).toBe(24);
    const ledger = await ledgerOf(ret.id);
    expect(ledger.map((l) => l.quantity)).toEqual([-6, 6]);
    expect(ledger[1]?.reversesId).toBe(ledger[0]?.id);
    expect(ledger[1]?.memo).toContain("返品数の入力誤り");

    const after = await returnOf(po.id, ret.id);
    expect(after.ret).toMatchObject({
      cancelled: true,
      cancelReason: "返品数の入力誤り",
      cancelledAt: expect.any(String),
      cancelledByName: "テスト社員",
    });
    expect(after.view.lines[0]?.returnableUnits).toBe(24);
    expect(after.view.cancellableReturnIds).toEqual([]);
    // 発注の状態は変わらない（仕入返品は入荷済みの数・残りの数を変えない）
    expect(after.view.order.status).toBe(before.view.order.status);
    expect(after.view.lines[0]?.remaining).toBe(before.view.lines[0]?.remaining);
    // 取り消した仕入返品はもう取り消せない
    expect(
      await systemCommandResult("purchaseReturns.cancel", {
        id: ret.id,
        version: after.ret.version,
        reason: "もう一度",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_state", message: "この仕入返品はすでに取り消されています" },
    });
    const audit = await readDb((db) =>
      db.query.auditLogs.findMany({ where: (l, { eq: e }) => e(l.entityId, ret.id) }),
    );
    expect(audit.map((l) => l.action)).toEqual(["create", "cancel"]);
    expect(audit[1]?.afterJson).toContain("返品数の入力誤り");
  });

  it("未払いの仕入先請求書から差し引いていれば請求書から外し、計算額と差額を直す", async () => {
    const { supplierId, po, receipt, ret } = await returnSetup(12);
    // 入荷 2,400円 − 返品 1,200円 = 1,200円、軽減税率 8% → 1,296円
    const inv = await systemCommand("supplierInvoices.create", {
      supplierId,
      invoiceDate: "2026-10-31",
      invoicedAmount: 1296,
      receiptIds: [receipt.id],
      returnIds: [ret.id],
    });
    expect((await returnOf(po.id, ret.id)).ret.supplierInvoiceStatus).toBe("unpaid");
    const { ret: current } = await returnOf(po.id, ret.id);
    await systemCommand("purchaseReturns.cancel", {
      id: ret.id,
      version: current.version,
      reason: "仕入先が返品を受けなかった",
    });
    const view = await systemQuery("supplierInvoices.get", { id: inv.id });
    expect(view?.returns).toEqual([]);
    expect(view?.invoice.computedAmount).toBe(2592);
    expect(view?.invoice.difference).toBe(1296 - 2592);
    expect(view?.invoice.differenceReason).toBe(
      `仕入返品 ${ret.number} の取消で計算額が変わりました`,
    );
    expect((await returnOf(po.id, ret.id)).ret.supplierInvoiceId).toBeNull();
    const audit = await readDb((db) =>
      db.query.auditLogs.findMany({ where: (l, { eq: e }) => e(l.entityId, inv.id) }),
    );
    expect(audit.map((l) => l.action)).toContain("detach_return");
  });

  it("支払（一部を含む）を記録した請求書の仕入返品は取り消せない。支払をすべて取り消せば取り消せる", async () => {
    const { supplierId, po, receipt, ret } = await returnSetup(12);
    const inv = await systemCommand("supplierInvoices.create", {
      supplierId,
      invoiceDate: "2026-10-31",
      invoicedAmount: 1296,
      receiptIds: [receipt.id],
      returnIds: [ret.id],
    });
    const part = await systemCommand("supplierInvoices.pay", {
      id: inv.id,
      version: 1,
      paidOn: "2026-11-01",
      amount: 500,
    });
    const partial = await returnOf(po.id, ret.id);
    expect(partial.view.cancellableReturnIds).toEqual([]);
    expect(
      await systemCommandResult("purchaseReturns.cancel", {
        id: ret.id,
        version: partial.ret.version,
        reason: "誤り",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_state", message: expect.stringContaining("一部支払の請求書") },
    });
    await systemCommand("supplierInvoices.pay", {
      id: inv.id,
      version: 2,
      paidOn: "2026-11-02",
      amount: 796,
    });
    expect((await orderView(po.id)).order.status).toBe("paid");
    expect(
      await systemCommandResult("purchaseReturns.cancel", {
        id: ret.id,
        version: partial.ret.version,
        reason: "誤り",
      }),
    ).toMatchObject({
      ok: false,
      error: { message: "支払済みの請求書に含まれる仕入返品は取り消せません" },
    });
    // 支払をすべて取り消して未払いに戻せば、取り消せる（請求書から外す）
    const payments = (await systemQuery("supplierInvoices.get", { id: inv.id }))?.payments ?? [];
    let version = 3;
    for (const p of payments) {
      await systemCommand("supplierInvoices.cancelPayment", {
        id: inv.id,
        version,
        paymentId: p.id,
        reason: "返品の取消のため",
      });
      version += 1;
    }
    expect((await systemQuery("supplierInvoices.get", { id: inv.id }))?.invoice.status).toBe(
      "unpaid",
    );
    expect(part.status).toBe("partial");
    const ok = await systemCommandResult("purchaseReturns.cancel", {
      id: ret.id,
      version: partial.ret.version,
      reason: "誤り",
    });
    expect(ok.ok).toBe(true);
  });

  it("支払済みの発注でも、請求書に入っていない仕入返品は取り消せる（発注は支払済みのまま）", async () => {
    const supplierId = await createSupplier();
    const locationId = await createLocation();
    const item = await createItem(supplierId);
    const po = await createConfirmedOrder({
      supplierId,
      locationId,
      lines: [{ itemId: item.id, quantity: 1 }],
    });
    const receipt = await receive(po.id, [1]);
    const inv = await systemCommand("supplierInvoices.create", {
      supplierId,
      invoiceDate: "2026-10-31",
      invoicedAmount: 1296,
      receiptIds: [receipt.id],
    });
    await systemCommand("supplierInvoices.pay", {
      id: inv.id,
      version: 1,
      paidOn: "2026-11-01",
      amount: 1296,
    });
    const lineId = (await orderView(po.id)).order.lines[0]?.id ?? "";
    const ret = await systemCommand("purchaseReturns.create", {
      purchaseOrderId: po.id,
      returnedOn: "2026-11-01",
      locationId,
      lines: [{ lineId, units: 2 }],
    });
    const { view, ret: current } = await returnOf(po.id, ret.id);
    expect(view.order.status).toBe("paid");
    expect(view.cancellableReturnIds).toEqual([ret.id]);
    await systemCommand("purchaseReturns.cancel", {
      id: ret.id,
      version: current.version,
      reason: "誤り",
    });
    expect((await orderView(po.id)).order.status).toBe("paid");
    expect(await onHand(item.id, locationId)).toBe(12);
  });

  it("仕入返品を取り消すと、その商品の入荷を取り消せるようになる", async () => {
    const { po, receipt, ret } = await returnSetup(6);
    expect((await orderView(po.id)).cancellableReceiptIds).toEqual([receipt.id]);
    expect(
      await systemCommandResult("receipts.cancel", { id: receipt.id, version: 1, reason: "誤り" }),
    ).toMatchObject({ ok: false, error: { message: expect.stringContaining("仕入返品") } });
    const { ret: current } = await returnOf(po.id, ret.id);
    await systemCommand("purchaseReturns.cancel", {
      id: ret.id,
      version: current.version,
      reason: "誤り",
    });
    await systemCommand("receipts.cancel", { id: receipt.id, version: 1, reason: "誤り" });
    expect((await orderView(po.id)).order.status).toBe("ordered");
  });
});

describe("仕入返品の取消の画面（発注詳細）", () => {
  it("取消の欄で理由を入力して取り消し、取り消した仕入返品は印と理由つきで残る", async () => {
    const { po, ret } = await returnSetup(6);
    const buyer = await createEmployee(["purchasing"]);
    const page = await (await as(buyer).get(`/purchase-orders/${po.id}`)).text();
    expect(page).toContain(`/purchase-orders/${po.id}/returns/${ret.id}/cancel`);
    expect(page).toContain(`${ret.number} の取消の理由`);
    // 受注・出荷担当には取消の欄を出さない
    const sales = await createEmployee(["sales"]);
    const salesPage = await (await as(sales).get(`/purchase-orders/${po.id}`)).text();
    expect(salesPage).not.toContain(`/returns/${ret.id}/cancel`);

    const { ret: current } = await returnOf(po.id, ret.id);
    const path = `/purchase-orders/${po.id}/returns/${ret.id}/cancel`;
    const noReason = await as(buyer).hx(path, {
      _key: newKey(),
      version: String(current.version),
      number: ret.number,
      reason: "",
    });
    const noReasonHtml = await noReason.text();
    expect(noReasonHtml).toContain(`id="return-cancel-${ret.id}"`);
    expect(noReasonHtml).toContain("入力内容を確認してください");
    const denied = await as(sales).hx(path, {
      _key: newKey(),
      version: String(current.version),
      number: ret.number,
      reason: "誤り",
    });
    expect(await denied.text()).toContain("この操作を行う権限がありません");

    const res = await as(buyer).hx(path, {
      _key: newKey(),
      version: String(current.version),
      number: ret.number,
      reason: "返品先の取り違え",
    });
    expect(res.headers.get("HX-Redirect")).toBe(`/purchase-orders/${po.id}?notice=returnCancelled`);
    const after = await (
      await as(buyer).get(`/purchase-orders/${po.id}?notice=returnCancelled`)
    ).text();
    expect(after).toContain("仕入返品を取り消しました");
    expect(after).toContain("取消の理由：返品先の取り違え");
    expect(after).not.toContain(`/returns/${ret.id}/cancel`);
  });
});
