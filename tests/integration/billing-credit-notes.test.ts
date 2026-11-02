/**
 * 請求書で差し引けない返品の返還請求書（要件定義書 3.11 の追加の決定）。
 * - どの請求書にも載っていない返品伝票について返還請求書を発行すると、返品伝票は精算済みになり（以後の請求書・締め処理に載せない）、
 *   返還額（税込）が方法「相殺」の入金（返還額）になる。返還額は未消込の入金として売掛残高を減らす
 * - 返還額は後の請求書に消し込めるほか、残りを返金済みにできる（返金した額は売掛残高を減らさない。返金は取り消せる）
 * - 返還請求書の取消は、返還額を請求書に充てていない・返金していないときだけ。返品伝票の取消は、先に返還請求書を取り消す
 * - 請求書に載せた返品の返還請求書（帳票だけ）は今までどおり（billing-returns.test.ts）
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { addDays } from "../../src/domain/dates";
import type { Result } from "../../src/domain/result";
import { businessDb } from "../../src/infra/do/client";
import { creditNoteSnapshotSchema } from "../../src/usecases/billing/snapshots";
import type { CommandInput, CommandName } from "../../src/usecases/registry";
import {
  billingSetup,
  createClosingCustomer,
  invoiceView,
  issuePerShipment,
  lastMonth,
  recordReturn,
  returnVersion,
  shipOrder,
} from "./billing-fixtures";
import { as as client, createEmployee, newKey, systemCommand, systemQuery } from "./helpers";
import { documentRow, systemCommandResult } from "./platform-helpers";
import { today } from "./sales-fixtures";

async function as<N extends CommandName>(
  email: string,
  name: N,
  input: CommandInput<N>,
  key: string = crypto.randomUUID(),
): Promise<Result<unknown>> {
  return businessDb(env).command(name, input, { kind: "dev", email }, key);
}

async function returnView(id: string) {
  const view = await systemQuery("salesReturns.get", { id });
  if (!view) throw new Error("return not found");
  return view;
}

async function paymentView(id: string) {
  const view = await systemQuery("customerPayments.get", { id });
  if (!view) throw new Error("payment not found");
  return view;
}

async function balanceOf(customerId: string) {
  const r = await systemQuery("receivables.balances", { customerId });
  return r.rows[0];
}

/** 発送して返品（商品 a を2個、廃棄）し、請求書で差し引けない返品として返還請求書を発行する（返還額 325円） */
async function creditedReturn() {
  const setup = await billingSetup();
  const shipped = await shipOrder(setup);
  const ret = await recordReturn(shipped.order.id, { quantity: 2, restockTo: null });
  const issued = await systemCommand("creditNotes.issueUnbilled", {
    salesReturnId: ret.id,
    version: await returnVersion(ret.id),
    issuedOn: today(),
  });
  return { setup, shipped, ret, issued };
}

describe("請求書で差し引けない返品の返還請求書", () => {
  it("未請求の返品伝票を返還請求書で精算し、返還額を入金（相殺）にする。権限と二重送信", async () => {
    const setup = await billingSetup();
    const shipped = await shipOrder(setup);
    const ret = await recordReturn(shipped.order.id, { quantity: 2, restockTo: null });
    const before = await returnView(ret.id);
    expect(before.creditNote).toMatchObject({
      kind: "unbilled",
      issuable: true,
      blocker: null,
      obligation: "optional",
    });
    expect(before.creditNote.preview).toMatchObject({ subtotal: 301, tax: 24, total: 325 });
    expect(before.ret.unbilledCreditIssuable).toBe(true);

    const input = { salesReturnId: ret.id, version: before.ret.version, issuedOn: today() };
    const sales = await createEmployee(["sales"]);
    expect(await as(sales, "creditNotes.issueUnbilled", input)).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    const accounting = await createEmployee(["accounting"]);
    const key = newKey();
    const first = await as(accounting, "creditNotes.issueUnbilled", input, key);
    expect(await as(accounting, "creditNotes.issueUnbilled", input, key)).toEqual(first);
    const issued = (first.ok ? first.value : null) as {
      number: string;
      documentId: string;
      paymentId: string;
      amount: number;
    };
    expect(issued.number).toMatch(/^CN-\d{4}-\d{6}$/);
    expect(issued.amount).toBe(325);

    // 帳票（適格返還請求書）。請求書には載っていないので請求書番号はない
    const doc = await documentRow(issued.documentId);
    expect(doc).toMatchObject({
      documentType: "credit_note",
      entityId: ret.id,
      partnerId: setup.customer.id,
      amount: 325,
    });
    const snapshot = creditNoteSnapshotSchema.parse(JSON.parse(doc!.snapshotJson));
    expect(snapshot).toMatchObject({
      number: issued.number,
      invoiceNumber: null,
      returnedOn: today(),
      originalTransactionDate: today(),
      total: 325,
    });

    // 返品伝票は精算済み（取り消すには先に返還請求書を取り消す）
    const after = await returnView(ret.id);
    expect(after.ret).toMatchObject({
      creditNoteNumber: issued.number,
      creditPaymentId: issued.paymentId,
      invoiceId: null,
      cancellable: false,
      unbilledCreditIssuable: false,
    });
    expect(after.cancelBlocker).toContain("先に返還請求書を取り消してください");
    expect(after.creditNote).toMatchObject({ kind: null, issuable: false });
    expect(after.credit).toEqual({
      paymentId: issued.paymentId,
      amount: 325,
      allocated: 0,
      refunded: 0,
      remaining: 325,
      cancellable: true,
      cancelBlocker: null,
    });
    const forOrder = await systemQuery("salesReturns.forOrder", {
      salesOrderId: shipped.order.id,
    });
    expect(forOrder?.returns[0]).toMatchObject({
      creditPaymentId: issued.paymentId,
      unbilledCreditIssuable: false,
    });

    // 返還額は方法「相殺」の入金。未消込の間は売掛残高を減らす。入金の取消では取り消せない
    const payment = await paymentView(issued.paymentId);
    expect(payment.payment).toMatchObject({
      customerId: setup.customer.id,
      receivedOn: today(),
      amount: 325,
      method: "offset",
      salesReturnId: ret.id,
      salesReturnNumber: ret.number,
    });
    expect(payment).toMatchObject({
      unallocated: 325,
      refundedAmount: 0,
      refundable: true,
      cancellable: false,
    });
    expect(await balanceOf(setup.customer.id)).toMatchObject({
      billed: 0,
      unallocated: 325,
      balance: -325,
    });
    expect(
      await systemCommandResult("customerPayments.cancel", {
        paymentId: issued.paymentId,
        version: payment.payment.version,
        reason: "誤り",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_state", message: expect.stringContaining("返還請求書を取り消して") },
    });
    const list = await systemQuery("customerPayments.list", {
      customerId: setup.customer.id,
      credit: true,
    });
    expect(list.rows.map((r) => [r.id, r.unallocated, r.salesReturnNumber])).toEqual([
      [issued.paymentId, 325, ret.number],
    ]);

    // 二度は発行できない。返品伝票も取り消せない
    expect(
      await systemCommandResult("creditNotes.issueUnbilled", {
        ...input,
        version: after.ret.version,
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    expect(
      await systemCommandResult("creditNotes.issue", { ...input, version: after.ret.version }),
    ).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    expect(
      await systemCommandResult("salesReturns.cancel", {
        id: ret.id,
        version: after.ret.version,
        reason: "誤り",
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_state" } });
  });

  it("精算した返品伝票は、以後の発送ごとの請求書にも締め処理にも載せない", async () => {
    const { setup, ret } = await creditedReturn();
    // 同じ販売先の次の発送の請求書の見積もりに、精算した返品は出ない
    const next = await shipOrder(setup);
    const draft = await systemQuery("invoices.draft", { shipmentId: next.shipmentId });
    expect(draft?.returns).toEqual([]);
    // 画面に残っていた返品伝票を載せようとしても、載せない（業務エラー）
    expect(
      await systemCommandResult("invoices.issue", {
        shipmentId: next.shipmentId,
        version: next.shipmentVersion,
        returns: [{ id: ret.id, version: await returnVersion(ret.id) }],
        issuedOn: today(),
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "conflict", message: expect.stringContaining("返還請求書で精算") },
    });
    const invoice = await issuePerShipment(next);
    expect((await invoiceView(invoice.id)).invoice.total).toBe(2027);

    // 締め処理：締め日のある販売先の、締め日までの精算した返品は載せない
    const monthly = await createClosingCustomer();
    const period = lastMonth();
    const shipped = await shipOrder(setup, { customerId: monthly.id, shippedOn: period.from });
    const monthlyReturn = await recordReturn(shipped.order.id, {
      quantity: 1,
      restockTo: null,
      returnedOn: period.from,
    });
    await systemCommand("creditNotes.issueUnbilled", {
      salesReturnId: monthlyReturn.id,
      version: await returnVersion(monthlyReturn.id),
      issuedOn: period.to,
    });
    const closing = await systemQuery("invoices.closing", { customerId: monthly.id });
    expect(closing.candidates[0]?.returns).toEqual([]);
    expect(closing.candidates[0]?.shipments.map((s) => s.id)).toEqual([shipped.shipmentId]);
  });

  it("請求書に載せた・取り消した・0円の返品伝票と、発行日の誤り・古い版番号は業務エラー", async () => {
    const setup = await billingSetup();
    const shipped = await shipOrder(setup);
    const billed = await recordReturn(shipped.order.id, { restockTo: null });
    await issuePerShipment(shipped, {
      returns: [{ id: billed.id, version: await returnVersion(billed.id) }],
    });
    expect(
      await systemCommandResult("creditNotes.issueUnbilled", {
        salesReturnId: billed.id,
        version: await returnVersion(billed.id),
        issuedOn: today(),
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_state", message: expect.stringContaining("請求済みの返品") },
    });

    const second = await shipOrder(setup, { shippedOn: addDays(today(), -2) });
    const cancelled = await recordReturn(second.order.id, {
      restockTo: null,
      returnedOn: addDays(today(), -1),
    });
    await systemCommand("salesReturns.cancel", {
      id: cancelled.id,
      version: await returnVersion(cancelled.id),
      reason: "誤り",
    });
    expect(
      await systemCommandResult("creditNotes.issueUnbilled", {
        salesReturnId: cancelled.id,
        version: await returnVersion(cancelled.id),
        issuedOn: today(),
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_state" } });

    const open = await recordReturn(second.order.id, {
      restockTo: null,
      returnedOn: addDays(today(), -1),
    });
    const version = await returnVersion(open.id);
    const issue = (issuedOn: string, v = version) =>
      systemCommandResult("creditNotes.issueUnbilled", {
        salesReturnId: open.id,
        version: v,
        issuedOn,
      });
    expect(await issue(addDays(today(), -2))).toMatchObject({
      ok: false,
      error: { fields: [{ field: "issuedOn" }] },
    });
    expect(await issue(addDays(today(), 1))).toMatchObject({
      ok: false,
      error: { fields: [{ field: "issuedOn" }] },
    });
    expect(await issue(today(), version + 1)).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    expect(
      await systemCommandResult("creditNotes.issueUnbilled", {
        salesReturnId: "01ZZZZZZZZZZZZZZZZZZZZZZZZ",
        version: 1,
        issuedOn: today(),
      }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });

    // 0円の返品（単価 0 円の明細）は返す額がないので精算しない
    const free = await shipOrder(setup, {
      lines: [
        { itemId: setup.a.id, quantity: 1, unitPriceCenti: 0, priceOverrideReason: "見本品" },
      ],
      charges: [],
    });
    const zero = await recordReturn(free.order.id, { restockTo: null });
    const zeroView = await returnView(zero.id);
    expect(zeroView.creditNote).toMatchObject({ kind: "unbilled", issuable: false });
    expect(zeroView.creditNote.blocker).toContain("返還額が0円");
    expect(
      await systemCommandResult("creditNotes.issueUnbilled", {
        salesReturnId: zero.id,
        version: zeroView.ret.version,
        issuedOn: today(),
      }),
    ).toMatchObject({ ok: false, error: { code: "validation" } });
  });
});

describe("返還額の消込・返金と、返還請求書の取消", () => {
  it("返還額を後の請求書に消し込める。消し込んでいる・返金している間は返還請求書を取り消せない", async () => {
    const { setup, ret, issued } = await creditedReturn();
    const next = await shipOrder(setup);
    const invoice = await issuePerShipment(next);
    const inv = await invoiceView(invoice.id);
    // 返還額 325円を請求書（2,027円）に充てる（/receipts/:id の消込と同じ）
    const allocated = await systemCommand("customerPayments.allocate", {
      paymentId: issued.paymentId,
      version: (await paymentView(issued.paymentId)).payment.version,
      allocations: [{ invoiceId: invoice.id, version: inv.invoice.version, amount: 325 }],
    });
    expect(allocated.remaining).toBe(0);
    expect((await invoiceView(invoice.id)).invoice).toMatchObject({
      status: "partial",
      allocated: 325,
    });
    // 請求書の詳細の消込にも、返還額から消し込んだと示す
    const accounting = await createEmployee(["accounting"]);
    const invoicePage = await (await client(accounting).get(`/invoices/${invoice.id}`)).text();
    expect(invoicePage).toContain("返還請求書の返還額");
    expect(await balanceOf(setup.customer.id)).toMatchObject({
      billed: 2027 - 325,
      unallocated: 0,
      balance: 2027 - 325,
    });
    const view = await returnView(ret.id);
    expect(view.credit).toMatchObject({ allocated: 325, remaining: 0, cancellable: false });
    expect(view.credit?.cancelBlocker).toContain("先に消込を取り消してください");
    expect(
      await systemCommandResult("creditNotes.cancelUnbilled", {
        salesReturnId: ret.id,
        version: view.ret.version,
        reason: "誤り",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_state", message: expect.stringContaining("先に消込を") },
    });
    // 返還額が残っていないので返金済みにもできない
    expect((await paymentView(issued.paymentId)).refundable).toBe(false);

    // 消込を取り消すと、返還額の残りに戻る
    const allocation = (await paymentView(issued.paymentId)).allocations[0]!;
    await systemCommand("paymentAllocations.cancel", {
      allocationId: allocation.id,
      version: allocation.version,
      reason: "消込の誤り",
    });
    expect((await returnView(ret.id)).credit).toMatchObject({
      allocated: 0,
      remaining: 325,
      cancellable: true,
    });
  });

  it("返還額の残りを返金済みにする（売掛残高を減らさなくなる）。返金は取り消せる。権限と二重送信", async () => {
    const { setup, ret, issued } = await creditedReturn();
    const payment = await paymentView(issued.paymentId);
    const input = {
      paymentId: issued.paymentId,
      version: payment.payment.version,
      refundedOn: today(),
      memo: "口座へ振込で返金",
    };
    const sales = await createEmployee(["sales"]);
    expect(await as(sales, "customerPayments.refund", input)).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    const accounting = await createEmployee(["accounting"]);
    const key = newKey();
    const first = await as(accounting, "customerPayments.refund", input, key);
    expect(await as(accounting, "customerPayments.refund", input, key)).toEqual(first);
    expect(first).toMatchObject({ ok: true, value: { amount: 325 } });

    const refunded = await paymentView(issued.paymentId);
    expect(refunded).toMatchObject({ unallocated: 0, refundedAmount: 325, refundable: false });
    expect(refunded.refunds).toMatchObject([
      { amount: 325, refundedOn: today(), memo: "口座へ振込で返金", cancelled: false },
    ]);
    // 返金した返還額は売掛残高を減らさない（請求書もないので売掛残高は 0、販売先は一覧に出ない）
    expect(await balanceOf(setup.customer.id)).toBeUndefined();
    expect(
      (
        await systemQuery("customerPayments.list", {
          customerId: setup.customer.id,
          unallocated: true,
        })
      ).rows,
    ).toEqual([]);
    // 返金したら請求書に充てられず、返還請求書も取り消せない
    const next = await shipOrder(setup);
    const invoice = await issuePerShipment(next);
    expect(
      await systemCommandResult("customerPayments.allocate", {
        paymentId: issued.paymentId,
        version: refunded.payment.version,
        allocations: [
          {
            invoiceId: invoice.id,
            version: (await invoiceView(invoice.id)).invoice.version,
            amount: 1,
          },
        ],
      }),
    ).toMatchObject({ ok: false, error: { code: "validation" } });
    const view = await returnView(ret.id);
    expect(view.credit?.cancelBlocker).toContain("先に返金を取り消してください");
    expect(
      await systemCommandResult("creditNotes.cancelUnbilled", {
        salesReturnId: ret.id,
        version: view.ret.version,
        reason: "誤り",
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_state" } });

    // 返金の取消（権限・理由・二重の取消）
    const refund = refunded.refunds[0]!;
    const cancelInput = { refundId: refund.id, version: refund.version, reason: "返金の誤り" };
    expect(await as(sales, "customerRefunds.cancel", cancelInput)).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    expect(
      await systemCommandResult("customerRefunds.cancel", { ...cancelInput, reason: "" }),
    ).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(
      await systemCommandResult("customerRefunds.cancel", {
        ...cancelInput,
        version: refund.version + 1,
      }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    const cancelKey = newKey();
    const cancelled = await as(accounting, "customerRefunds.cancel", cancelInput, cancelKey);
    expect(await as(accounting, "customerRefunds.cancel", cancelInput, cancelKey)).toEqual(
      cancelled,
    );
    expect(cancelled.ok).toBe(true);
    expect(
      await systemCommandResult("customerRefunds.cancel", {
        ...cancelInput,
        version: refund.version + 1,
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    const back = await paymentView(issued.paymentId);
    expect(back).toMatchObject({ unallocated: 325, refundedAmount: 0, refundable: true });
    expect(back.refunds[0]).toMatchObject({ cancelled: true, cancelReason: "返金の誤り" });
    expect(await balanceOf(setup.customer.id)).toMatchObject({
      billed: 2027,
      unallocated: 325,
      balance: 2027 - 325,
    });
  });

  it("返金の業務エラー：返還額でない入金・返金日・古い版番号・残りなし", async () => {
    const { issued } = await creditedReturn();
    const setup = await billingSetup();
    const plain = await systemCommand("customerPayments.create", {
      customerId: setup.customer.id,
      receivedOn: today(),
      amount: 1000,
      method: "transfer",
    });
    expect(
      await systemCommandResult("customerPayments.refund", {
        paymentId: plain.id,
        version: 1,
        refundedOn: today(),
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_state", message: expect.stringContaining("返還請求書の返還額だけ") },
    });
    const version = (await paymentView(issued.paymentId)).payment.version;
    const refund = (refundedOn: string, v = version) =>
      systemCommandResult("customerPayments.refund", {
        paymentId: issued.paymentId,
        version: v,
        refundedOn,
      });
    expect(await refund(addDays(today(), -1))).toMatchObject({
      ok: false,
      error: { fields: [{ field: "refundedOn" }] },
    });
    expect(await refund(addDays(today(), 1))).toMatchObject({
      ok: false,
      error: { fields: [{ field: "refundedOn" }] },
    });
    expect(await refund(today(), version + 1)).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    expect((await refund(today())).ok).toBe(true);
    expect(await refund(today(), version + 1)).toMatchObject({
      ok: false,
      error: { code: "invalid_state" },
    });
    expect(
      await systemCommandResult("customerPayments.refund", {
        paymentId: "01ZZZZZZZZZZZZZZZZZZZZZZZZ",
        version: 1,
        refundedOn: today(),
      }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(
      await systemCommandResult("customerRefunds.cancel", {
        refundId: "01ZZZZZZZZZZZZZZZZZZZZZZZZ",
        version: 1,
        reason: "誤り",
      }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("返還請求書の取消：返還額の入金と帳票を取り消し、返品伝票は未請求に戻る。権限・二重送信・理由", async () => {
    const { setup, shipped, ret, issued } = await creditedReturn();
    const view = await returnView(ret.id);
    const input = { salesReturnId: ret.id, version: view.ret.version, reason: "発行の誤り" };
    const sales = await createEmployee(["sales"]);
    expect(await as(sales, "creditNotes.cancelUnbilled", input)).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    expect(
      await systemCommandResult("creditNotes.cancelUnbilled", { ...input, reason: "" }),
    ).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(
      await systemCommandResult("creditNotes.cancelUnbilled", {
        ...input,
        version: input.version + 1,
      }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    const accounting = await createEmployee(["accounting"]);
    const key = newKey();
    const first = await as(accounting, "creditNotes.cancelUnbilled", input, key);
    expect(await as(accounting, "creditNotes.cancelUnbilled", input, key)).toEqual(first);
    expect(first.ok).toBe(true);

    expect((await documentRow(issued.documentId))?.cancelled).toBe(true);
    const payment = await paymentView(issued.paymentId);
    expect(payment.payment.cancelled).toBe(true);
    expect(payment.unallocated).toBe(0);
    expect(await balanceOf(setup.customer.id)).toBeUndefined();
    const back = await returnView(ret.id);
    expect(back.ret).toMatchObject({
      creditNoteNumber: null,
      creditPaymentId: null,
      cancellable: true,
      unbilledCreditIssuable: true,
    });
    expect(back.credit).toBeNull();
    expect(back.creditNote.documentId).toBeNull();
    // 未請求に戻ったので、次の請求書に載せられる（もう一度、返還請求書で精算することもできる）
    const next = await shipOrder(setup);
    const draft = await systemQuery("invoices.draft", { shipmentId: next.shipmentId });
    expect(draft?.returns.map((r) => r.id)).toEqual([ret.id]);
    // 2回目の取消・請求書に載せた返品の返還請求書の取消はできない
    expect(
      await systemCommandResult("creditNotes.cancelUnbilled", {
        ...input,
        version: back.ret.version,
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    await issuePerShipment(next, {
      returns: [{ id: ret.id, version: back.ret.version }],
    });
    const billedVersion = await returnVersion(ret.id);
    await systemCommand("creditNotes.issue", {
      salesReturnId: ret.id,
      version: billedVersion,
      issuedOn: today(),
    });
    expect(
      await systemCommandResult("creditNotes.cancelUnbilled", {
        salesReturnId: ret.id,
        version: await returnVersion(ret.id),
        reason: "誤り",
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    expect(shipped.order.id).toBeTruthy();
  });
});

describe("画面：請求書で差し引けない返品の返還請求書と返還額", () => {
  it("返品伝票の詳細と受注詳細に発行の操作を出し、入金の一覧・詳細・登録画面で返還額と示す", async () => {
    const accounting = await createEmployee(["accounting"]);
    const salesUser = await createEmployee(["sales"]);
    const setup = await billingSetup();
    const shipped = await shipOrder(setup);
    const ret = await recordReturn(shipped.order.id, { quantity: 2, restockTo: null });

    const detail = await (await client(accounting).get(`/sales-returns/${ret.id}`)).text();
    expect(detail).toContain('id="credit-note"');
    expect(detail).toContain("返還請求書を発行（請求書で差し引けない返品）");
    expect(detail).toContain(`/sales-returns/${ret.id}/credit-note/unbilled`);
    const salesDetail = await (await client(salesUser).get(`/sales-returns/${ret.id}`)).text();
    expect(salesDetail).toContain("返還請求書を発行する権限がありません");
    const order = await (await client(accounting).get(`/sales-orders/${shipped.order.id}`)).text();
    expect(order).toContain(`/sales-returns/${ret.id}#credit-note`);
    expect(order).toContain("返還請求書を発行（請求書で差し引けない返品）");
    const salesOrder = await (
      await client(salesUser).get(`/sales-orders/${shipped.order.id}`)
    ).text();
    expect(salesOrder).not.toContain("返還請求書を発行（請求書で差し引けない返品）");

    const issued = await client(accounting).hx(`/sales-returns/${ret.id}/credit-note/unbilled`, {
      _key: newKey(),
      version: String(await returnVersion(ret.id)),
      issuedOn: today(),
    });
    const issuedHtml = await issued.text();
    expect(issuedHtml).toContain("返品は精算済みにし");
    expect(issuedHtml).toContain("返還請求書で精算");
    expect(issuedHtml).toContain("返還額の入金を開く");
    expect(issuedHtml).toContain("返還請求書を取り消す");
    const paymentId = (await returnView(ret.id)).credit!.paymentId;
    const orderAfter = await (
      await client(accounting).get(`/sales-orders/${shipped.order.id}`)
    ).text();
    expect(orderAfter).toContain("返還請求書で精算（請求書では差し引かない）");

    // 入金の一覧・詳細：返還額と示す。入金の取消ではなく返還請求書の取消へ案内する
    const receipts = await (
      await client(accounting).get(`/receipts?customerId=${setup.customer.id}`)
    ).text();
    expect(receipts).toContain("返還請求書の返還額");
    const receipt = await (await client(accounting).get(`/receipts/${paymentId}`)).text();
    expect(receipt).toContain(`返還請求書の返還額 ${today()}`);
    expect(receipt).toContain(ret.number);
    expect(receipt).toContain("残り（¥325）を返金済みにする");
    expect(receipt).not.toContain("入金を取り消す");
    expect(receipt).toContain("返品伝票の画面で返還請求書を取り消す");

    // 入金の登録画面：販売先の返還額の残りを知らせる（販売先を選んだときの部分 HTML も）
    const form = await (
      await client(accounting).get(`/receipts/new?customerId=${setup.customer.id}`)
    ).text();
    expect(form).toContain("請求書に充てられる返還請求書の返還額があります");
    expect(form).toContain(`/receipts/${paymentId}`);
    const partial = await (
      await client(accounting).get(`/receipts/new/invoices?customerId=${setup.customer.id}`)
    ).text();
    expect(partial).toContain("請求書に充てられる返還請求書の返還額があります");

    // 返金と、返金の取消
    const refunded = await client(accounting).hx(`/receipts/${paymentId}/refund`, {
      _key: newKey(),
      version: String((await paymentView(paymentId)).payment.version),
      refundedOn: today(),
      memo: "振込で返金",
    });
    const refundedHtml = await refunded.text();
    expect(refundedHtml).toContain("返還額の残りを返金済みにしました");
    expect(refundedHtml).toContain("振込で返金");
    const refund = (await paymentView(paymentId)).refunds[0]!;
    const back = await client(accounting).hx(`/receipts/refunds/${refund.id}/cancel`, {
      _key: newKey(),
      version: String(refund.version),
      reason: "誤り",
    });
    expect(await back.text()).toContain("返金を取り消しました");
    const denied = await client(salesUser).hx(`/receipts/refunds/${refund.id}/cancel`, {
      _key: newKey(),
      version: String(refund.version + 1),
      reason: "誤り",
    });
    expect(denied.status).toBe(403);

    // 返還請求書の取消（画面）
    const cancelled = await client(accounting).hx(`/sales-returns/${ret.id}/credit-note/cancel`, {
      _key: newKey(),
      version: String(await returnVersion(ret.id)),
      reason: "発行の誤り",
    });
    expect(await cancelled.text()).toContain("返還請求書を取り消しました");
  });
});
