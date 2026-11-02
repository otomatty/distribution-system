/**
 * 仕入先請求書の一部支払：残りの額より少ない支払は一部支払、残りが 0 になるまで支払え、支払済みになる。
 * 残りより多い支払はできない。支払は1件ずつ取り消せ、状態を決め直す。支払が残っている請求書は取り消せない。
 * 発注は、受入のある入荷がすべて支払済み（残りが 0）の請求書に入ったときだけ支払済みになる。
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { addDays, weekRange } from "../../src/domain/dates";
import type { Result } from "../../src/domain/result";
import { businessDb } from "../../src/infra/do/client";
import type { CommandInput, CommandName } from "../../src/usecases/registry";
import { createItem, createLocation, createSupplier } from "./fixtures";
import { as, createEmployee, newKey, systemCommand, systemQuery } from "./helpers";
import { systemCommandResult } from "./platform-helpers";
import { createConfirmedOrder, orderView, receive } from "./purchasing-fixtures";
import { today } from "./sales-fixtures";

async function command<N extends CommandName>(
  email: string,
  name: N,
  input: CommandInput<N>,
  key: string = newKey(),
): Promise<Result<unknown>> {
  return businessDb(env).command(name, input, { kind: "dev", email }, key);
}

/** 入荷 1 件（2 ケース = 2,400円、軽減税率 8% → 2,592円）を結びつけた仕入先請求書 */
async function invoiceSetup(paymentDueOn: string | null = null) {
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
    paymentDueOn,
  });
  return { supplierId, locationId, item, po, receipt, inv };
}

async function invoice(id: string) {
  const view = await systemQuery("supplierInvoices.get", { id });
  if (!view) throw new Error("仕入先請求書が見つかりません");
  return view;
}

describe("一部支払と支払済み", () => {
  it("残りより少ない支払は一部支払、残りと同じ額で支払済み。残りより多い支払はできない", async () => {
    const { po, inv } = await invoiceSetup();
    const accountant = await createEmployee(["accounting"]);
    // 権限：仕入先請求書の権限（経理・管理者）だけ
    const buyer = await createEmployee(["purchasing"]);
    expect(
      await command(buyer, "supplierInvoices.pay", {
        id: inv.id,
        version: 1,
        paidOn: "2026-11-01",
        amount: 1000,
      }),
    ).toMatchObject({ ok: false, error: { code: "forbidden" } });
    // 残りより多い支払はできない
    expect(
      await command(accountant, "supplierInvoices.pay", {
        id: inv.id,
        version: 1,
        paidOn: "2026-11-01",
        amount: 2593,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "validation", message: "支払額が残りの額（2,592 円）を超えています" },
    });

    const key = newKey();
    const input = { id: inv.id, version: 1, paidOn: "2026-11-01", amount: 1000 };
    const first = await command(accountant, "supplierInvoices.pay", input, key);
    expect(first).toMatchObject({ ok: true, value: { status: "partial" } });
    // 二重送信は前回の結果を返し、支払を2件にしない
    expect(await command(accountant, "supplierInvoices.pay", input, key)).toEqual(first);
    const partial = await invoice(inv.id);
    expect(partial.invoice).toMatchObject({ status: "partial", paidAmount: 1000, version: 2 });
    expect(partial.remaining).toBe(1592);
    expect(partial.payments).toHaveLength(1);
    expect(partial.actions).toMatchObject({ pay: true, cancel: false });
    // 一部支払では発注は支払済みにならない
    expect((await orderView(po.id)).order.status).toBe("received");
    // 古い版の支払は conflict
    expect(
      await command(accountant, "supplierInvoices.pay", {
        ...input,
        amount: 100,
      }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(
      await systemCommandResult("supplierInvoices.pay", {
        id: inv.id,
        version: 2,
        paidOn: "2026-11-02",
        amount: 1593,
      }),
    ).toMatchObject({
      ok: false,
      error: { message: "支払額が残りの額（1,592 円）を超えています" },
    });
    // 2回目
    await systemCommand("supplierInvoices.pay", {
      id: inv.id,
      version: 2,
      paidOn: "2026-11-02",
      amount: 592,
    });
    expect((await invoice(inv.id)).invoice).toMatchObject({ status: "partial", paidAmount: 1592 });
    // 3回目で残りが 0 になり支払済み。発注も支払済み
    const last = await systemCommand("supplierInvoices.pay", {
      id: inv.id,
      version: 3,
      paidOn: "2026-11-03",
      amount: 1000,
    });
    expect(last.status).toBe("paid");
    const paid = await invoice(inv.id);
    expect(paid.invoice).toMatchObject({
      status: "paid",
      paidAmount: 2592,
      lastPaidOn: "2026-11-03",
    });
    expect(paid.remaining).toBe(0);
    expect(paid.payments.map((p) => p.amount)).toEqual([1000, 592, 1000]);
    expect(paid.actions.pay).toBe(false);
    expect((await orderView(po.id)).order.status).toBe("paid");
    expect(
      await systemCommandResult("supplierInvoices.pay", {
        id: inv.id,
        version: 4,
        paidOn: "2026-11-03",
        amount: 1,
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    // 買掛残高は 請求額 − 支払額（11月の支払はすべて 11月に数える）
    const balances = await systemQuery("payables.balances", {
      from: "2026-10",
      to: "2026-11",
      supplierId: paid.invoice.supplierId,
    });
    expect(balances.rows[0]?.months.map((m) => [m.invoiced, m.paid, m.balance])).toEqual([
      [2592, 0, 2592],
      [0, 2592, 0],
    ]);
  });

  it("支払は1件ずつ取り消せる：支払済み → 一部支払 → 未払い。支払が残っている請求書は取り消せない", async () => {
    const { po, receipt, inv } = await invoiceSetup();
    const a = await systemCommand("supplierInvoices.pay", {
      id: inv.id,
      version: 1,
      paidOn: "2026-11-01",
      amount: 1592,
    });
    const b = await systemCommand("supplierInvoices.pay", {
      id: inv.id,
      version: 2,
      paidOn: "2026-11-02",
      amount: 1000,
    });
    expect((await orderView(po.id)).order.status).toBe("paid");
    const accountant = await createEmployee(["accounting"]);
    const view = await invoice(inv.id);
    expect(view.cancellablePaymentIds.toSorted()).toEqual([a.paymentId, b.paymentId].toSorted());

    const key = newKey();
    const input = { id: inv.id, version: 3, paymentId: a.paymentId, reason: "金額の入力誤り" };
    const cancelled = await command(accountant, "supplierInvoices.cancelPayment", input, key);
    expect(cancelled).toMatchObject({ ok: true, value: { status: "partial" } });
    expect(await command(accountant, "supplierInvoices.cancelPayment", input, key)).toEqual(
      cancelled,
    );
    const partial = await invoice(inv.id);
    expect(partial.invoice).toMatchObject({ status: "partial", paidAmount: 1000 });
    expect(partial.cancellablePaymentIds).toEqual([b.paymentId]);
    // 支払済みでなくなったので、発注は入荷済みに戻る
    expect((await orderView(po.id)).order.status).toBe("received");
    // 一部支払の請求書は取り消せない（先に支払をすべて取り消す）。入荷も取り消せない
    expect(
      await systemCommandResult("supplierInvoices.cancel", {
        id: inv.id,
        version: 4,
        reason: "差し替え",
      }),
    ).toMatchObject({
      ok: false,
      error: { message: "一部支払の請求書は取り消せません。先に支払をすべて取り消してください" },
    });
    expect(partial.actions.cancel).toBe(false);
    expect((await orderView(po.id)).cancellableReceiptIds).toEqual([]);
    expect(
      await systemCommandResult("receipts.cancel", { id: receipt.id, version: 1, reason: "誤り" }),
    ).toMatchObject({ ok: false, error: { message: expect.stringContaining("一部支払の請求書") } });
    // 取り消した支払はもう取り消せない
    expect(
      await systemCommandResult("supplierInvoices.cancelPayment", {
        id: inv.id,
        version: 4,
        paymentId: a.paymentId,
        reason: "もう一度",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_state", message: "この支払はすでに取り消されています" },
    });
    await systemCommand("supplierInvoices.cancelPayment", {
      id: inv.id,
      version: 4,
      paymentId: b.paymentId,
      reason: "支払先の誤り",
    });
    const unpaid = await invoice(inv.id);
    expect(unpaid.invoice).toMatchObject({ status: "unpaid", paidAmount: 0, lastPaidOn: null });
    expect(unpaid.actions.cancel).toBe(true);
    await systemCommand("supplierInvoices.cancel", { id: inv.id, version: 5, reason: "差し替え" });
    expect((await invoice(inv.id)).remaining).toBe(0);
  });

  it("一括支払いは選んだ請求書の残りの額を支払う（一部支払の請求書は残りだけ）", async () => {
    const a = await invoiceSetup("2026-11-05");
    const b = await invoiceSetup("2026-11-06");
    await systemCommand("supplierInvoices.pay", {
      id: a.inv.id,
      version: 1,
      paidOn: "2026-11-01",
      amount: 2000,
    });
    const result = await systemCommand("supplierInvoices.payBulk", {
      invoices: [
        { id: a.inv.id, version: 2 },
        { id: b.inv.id, version: 1 },
      ],
      paidOn: "2026-11-05",
    });
    expect(result).toMatchObject({ count: 2, amount: 592 + 2592 });
    const viewA = await invoice(a.inv.id);
    expect(viewA.invoice).toMatchObject({ status: "paid", paidAmount: 2592 });
    expect(viewA.payments.map((p) => p.amount)).toEqual([592, 2000]);
    expect((await invoice(b.inv.id)).invoice.status).toBe("paid");
    expect((await orderView(a.po.id)).order.status).toBe("paid");
  });
});

describe("支払予定・一覧・CSV・ダッシュボード", () => {
  it("支払の残っている請求書（未払い・一部支払）を、支払済みの額と残りの額つきで出し、状態で絞り込める", async () => {
    const week = weekRange(today());
    const a = await invoiceSetup(week.to);
    const b = await invoiceSetup(week.to);
    const c = await invoiceSetup(addDays(today(), -1));
    await systemCommand("supplierInvoices.pay", {
      id: a.inv.id,
      version: 1,
      paidOn: today(),
      amount: 1000,
    });
    const before = await systemQuery("purchasing.dashboard", {});
    const all = await systemQuery("payables.list", { supplierId: a.supplierId });
    expect(all.rows.map((r) => [r.status, r.paidAmount, r.remaining])).toEqual([
      ["partial", 1000, 1592],
    ]);
    expect(all.totals).toEqual({ count: 1, invoiced: 2592, paid: 1000, remaining: 1592 });
    expect(
      (await systemQuery("payables.list", { supplierId: a.supplierId, status: "unpaid" })).total,
    ).toBe(0);
    expect(
      (await systemQuery("payables.list", { supplierId: b.supplierId, status: "unpaid" })).total,
    ).toBe(1);

    const user = await createEmployee(["accounting"]);
    const page = await (await as(user).get(`/payables?supplierId=${a.supplierId}`)).text();
    expect(page).toContain("一部支払");
    expect(page).toContain("¥1,000");
    expect(page).toContain("<strong>¥1,592</strong>");
    expect(page).toContain("支払の残っている請求書 <strong>1件</strong>");
    const partialOnly = await (
      await as(user).get(`/payables?supplierId=${b.supplierId}&status=partial`)
    ).text();
    expect(partialOnly).toContain("条件に合う、支払の残っている仕入先請求書はありません");
    const csv = await (
      await as(user).post("/payables/csv", { _key: newKey(), supplierId: a.supplierId })
    ).text();
    expect(csv).toContain("支払済みの額,残りの額,最後の支払日");
    expect(csv).toContain(`,1000,1592,${today()},`);
    const list = await (
      await as(user).get(`/supplier-invoices?supplierId=${a.supplierId}&status=partial`)
    ).text();
    expect(list).toContain("一部支払");
    expect(list).toContain("<strong>¥1,592</strong>");
    const detail = await (await as(user).get(`/supplier-invoices/${a.inv.id}`)).text();
    expect(detail).toContain("残りの額は ¥1,592 です");
    expect(detail).toContain('value="1592"');

    // ダッシュボードの「今週の支払予定」は残りのある請求書を数え、残りの額を合計する。支払済みにすると外れる
    expect(before.payablesThisWeek.count).toBeGreaterThanOrEqual(2);
    await systemCommand("supplierInvoices.pay", {
      id: a.inv.id,
      version: 2,
      paidOn: today(),
      amount: 1592,
    });
    const after = await systemQuery("purchasing.dashboard", {});
    expect(after.payablesThisWeek.count).toBe(before.payablesThisWeek.count - 1);
    expect(before.payablesThisWeek.amount - after.payablesThisWeek.amount).toBe(1592);
    expect(after.overduePayables.count).toBeGreaterThanOrEqual(1);
    const dash = await (await as(user).get("/")).text();
    expect(dash).toContain("今週の支払予定");
    expect(dash).toContain("残りの合計");
    void c;
  });

  it("画面から一部支払を記録し、支払1件を取り消す", async () => {
    const { inv } = await invoiceSetup();
    const user = await createEmployee(["accounting"]);
    const over = await as(user).hx(`/supplier-invoices/${inv.id}/pay`, {
      _key: newKey(),
      version: "1",
      paidOn: "2026-11-01",
      amount: "3,000",
    });
    expect(await over.text()).toContain("支払額が残りの額（2,592 円）を超えています");
    const res = await as(user).hx(`/supplier-invoices/${inv.id}/pay`, {
      _key: newKey(),
      version: "1",
      paidOn: "2026-11-01",
      amount: "1,000",
    });
    expect(res.headers.get("HX-Redirect")).toBe(`/supplier-invoices/${inv.id}?notice=partial`);
    const page = await (await as(user).get(`/supplier-invoices/${inv.id}?notice=partial`)).text();
    expect(page).toContain("支払を記録しました（一部支払）");
    expect(page).toContain("一部支払");
    const paymentId = (await invoice(inv.id)).payments[0]?.id ?? "";
    const cancel = await as(user).hx(`/supplier-invoices/${inv.id}/cancel-payment`, {
      _key: newKey(),
      version: "2",
      paymentId,
      reason: "金額の誤り",
    });
    expect(cancel.headers.get("HX-Redirect")).toContain("notice=paymentCancelled");
    expect((await invoice(inv.id)).invoice.status).toBe("unpaid");
    const done = await (await as(user).get(`/supplier-invoices/${inv.id}`)).text();
    expect(done).toContain("取消の理由：金額の誤り");
  });
});
