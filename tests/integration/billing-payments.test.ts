/**
 * 入金と消込・売掛残高（要件定義書 3.11、4章 請求書の状態遷移）のユースケース。
 * 1件の入金を複数の請求書に、1枚の請求書に複数の入金を当てる。差額の処理、超過の扱い、取消。
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { addDays } from "../../src/domain/dates";
import type { Result } from "../../src/domain/result";
import { businessDb } from "../../src/infra/do/client";
import type { CommandInput, CommandName } from "../../src/usecases/registry";
import { billingSetup, invoiceView, issuePerShipment, shipOrder } from "./billing-fixtures";
import { createEmployee, newKey, systemCommand, systemQuery } from "./helpers";
import { systemCommandResult } from "./platform-helpers";
import { today } from "./sales-fixtures";

async function as<N extends CommandName>(
  email: string,
  name: N,
  input: CommandInput<N>,
  key: string = crypto.randomUUID(),
): Promise<Result<unknown>> {
  return businessDb(env).command(name, input, { kind: "dev", email }, key);
}

/** 販売先と、税込 2,027 円の請求書を2枚（支払期限は昨日と30日後） */
async function twoInvoices() {
  const setup = await billingSetup();
  const first = await issuePerShipment(await shipOrder(setup), { dueOn: today() });
  const second = await issuePerShipment(await shipOrder(setup), { dueOn: addDays(today(), 30) });
  return { setup, first, second };
}

async function paymentView(id: string) {
  const view = await systemQuery("customerPayments.get", { id });
  if (!view) throw new Error("payment not found");
  return view;
}

describe("入金の記録と消込", () => {
  it("1件の入金を複数の請求書に消し込み、差額（振込手数料）も請求残高を減らす", async () => {
    const { setup, first, second } = await twoInvoices();
    const v1 = (await invoiceView(first.id)).invoice.version;
    const v2 = (await invoiceView(second.id)).invoice.version;
    const accounting = await createEmployee(["accounting"]);
    const input = {
      customerId: setup.customer.id,
      receivedOn: today(),
      amount: 3000,
      method: "transfer" as const,
      memo: "11月分",
      allocations: [
        {
          invoiceId: first.id,
          version: v1,
          amount: 1587,
          adjustment: 440,
          adjustmentKind: "bank_fee" as const,
        },
        { invoiceId: second.id, version: v2, amount: 1413, adjustment: 0, adjustmentKind: null },
      ],
    };
    const sales = await createEmployee(["sales"]);
    expect(await as(sales, "customerPayments.create", input)).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    const key = newKey();
    const r = await as(accounting, "customerPayments.create", input, key);
    expect(await as(accounting, "customerPayments.create", input, key)).toEqual(r);
    expect(r).toMatchObject({ ok: true, value: { remaining: 0 } });
    const paymentId = (r.ok ? r.value : null) as { id: string };

    expect((await invoiceView(first.id)).invoice).toMatchObject({
      status: "paid",
      allocated: 2027,
    });
    const partial = await invoiceView(second.id);
    expect(partial.invoice).toMatchObject({ status: "partial", allocated: 1413 });
    expect(partial.outstanding).toBe(614);
    expect(partial.invoice.allocations.map((a) => [a.amount, a.adjustment])).toEqual([[1413, 0]]);

    const view = await paymentView(paymentId.id);
    expect(view).toMatchObject({ allocatedAmount: 3000, unallocated: 0 });
    expect(view.payment).toMatchObject({ amount: 3000, method: "transfer", memo: "11月分" });
    expect(view.allocations.map((a) => [a.invoiceNumber, a.adjustmentKind])).toEqual(
      expect.arrayContaining([
        [first.number, "bank_fee"],
        [second.number, null],
      ]),
    );
    const list = await systemQuery("customerPayments.list", { customerId: setup.customer.id });
    expect(list.rows.map((p) => [p.amount, p.allocatedAmount, p.unallocated])).toEqual([
      [3000, 3000, 0],
    ]);
  });

  it("請求残高を超えては消し込めない。入金が多ければ残りは未消込として残り、後で消し込める", async () => {
    const { setup, first, second } = await twoInvoices();
    const v1 = (await invoiceView(first.id)).invoice.version;
    expect(
      await systemCommandResult("customerPayments.create", {
        customerId: setup.customer.id,
        receivedOn: today(),
        amount: 5000,
        method: "cash",
        allocations: [{ invoiceId: first.id, version: v1, amount: 2028 }],
      }),
    ).toMatchObject({
      ok: false,
      error: {
        fields: [{ field: "allocations.0.amount", message: "請求残高を超えて消し込めません" }],
      },
    });
    const payment = await systemCommand("customerPayments.create", {
      customerId: setup.customer.id,
      receivedOn: today(),
      amount: 5000,
      method: "cash",
      allocations: [{ invoiceId: first.id, version: v1, amount: 2027 }],
    });
    expect(payment.remaining).toBe(2973);
    const unallocated = await systemQuery("customerPayments.list", {
      customerId: setup.customer.id,
      unallocated: true,
    });
    expect(unallocated.rows.map((p) => p.unallocated)).toEqual([2973]);

    const view = await paymentView(payment.id);
    expect(view.openInvoices.map((i) => i.id)).toEqual([second.id]);
    const v2 = (await invoiceView(second.id)).invoice.version;
    expect(
      await systemCommandResult("customerPayments.allocate", {
        paymentId: payment.id,
        version: view.payment.version + 1,
        allocations: [{ invoiceId: second.id, version: v2, amount: 100 }],
      }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(
      await systemCommandResult("customerPayments.allocate", {
        paymentId: payment.id,
        version: view.payment.version,
        allocations: [{ invoiceId: second.id, version: v2, amount: 0 }],
      }),
    ).toMatchObject({ ok: false, error: { code: "validation" } });
    // 入金の残り（2,973円）を超えては充てられない（請求残高 2,027円までなので差額で埋める）
    const allocated = await systemCommand("customerPayments.allocate", {
      paymentId: payment.id,
      version: view.payment.version,
      allocations: [
        {
          invoiceId: second.id,
          version: v2,
          amount: 2000,
          adjustment: 27,
          adjustmentKind: "discount",
        },
      ],
    });
    expect(allocated.remaining).toBe(973);
    expect((await invoiceView(second.id)).invoice.status).toBe("paid");
    expect((await paymentView(payment.id)).unallocated).toBe(973);
  });

  it("差額の区分がない・今日より後・他の販売先の請求書・古い版番号は消し込まない", async () => {
    const { setup, first } = await twoInvoices();
    const v1 = (await invoiceView(first.id)).invoice.version;
    const base = {
      customerId: setup.customer.id,
      receivedOn: today(),
      amount: 1000,
      method: "transfer" as const,
    };
    expect(
      await systemCommandResult("customerPayments.create", {
        ...base,
        allocations: [{ invoiceId: first.id, version: v1, amount: 500, adjustment: 10 }],
      }),
    ).toMatchObject({ ok: false, error: { fields: [{ field: "allocations.0.adjustmentKind" }] } });
    expect(
      await systemCommandResult("customerPayments.create", {
        ...base,
        receivedOn: addDays(today(), 1),
      }),
    ).toMatchObject({ ok: false, error: { fields: [{ field: "receivedOn" }] } });
    expect(
      await systemCommandResult("customerPayments.create", {
        ...base,
        allocations: [{ invoiceId: first.id, version: v1 + 1, amount: 500 }],
      }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    const other = await twoInvoices();
    expect(
      await systemCommandResult("customerPayments.create", {
        ...base,
        allocations: [{ invoiceId: other.first.id, version: 1, amount: 500 }],
      }),
    ).toMatchObject({ ok: false, error: { fields: [{ field: "allocations.0.invoiceId" }] } });
    expect(
      await systemCommandResult("customerPayments.create", { ...base, customerId: "missing" }),
    ).toMatchObject({ ok: false, error: { fields: [{ field: "customerId" }] } });
    expect(
      await systemCommandResult("customerPayments.create", { ...base, amount: 0 }),
    ).toMatchObject({ ok: false, error: { code: "validation" } });
    // どれも失敗したので、入金は記録されていない
    expect(
      (await systemQuery("customerPayments.list", { customerId: setup.customer.id })).total,
    ).toBe(0);
  });
});

describe("消込と入金の取消", () => {
  it("消込の取消で入金済み → 一部入金 → 未入金に戻り、入金の未消込残高が増える", async () => {
    const { setup, first } = await twoInvoices();
    const v = (await invoiceView(first.id)).invoice.version;
    const p1 = await systemCommand("customerPayments.create", {
      customerId: setup.customer.id,
      receivedOn: today(),
      amount: 1000,
      method: "transfer",
      allocations: [{ invoiceId: first.id, version: v, amount: 1000 }],
    });
    const v2 = (await invoiceView(first.id)).invoice.version;
    const p2 = await systemCommand("customerPayments.create", {
      customerId: setup.customer.id,
      receivedOn: today(),
      amount: 1027,
      method: "offset",
      allocations: [{ invoiceId: first.id, version: v2, amount: 1027 }],
    });
    expect((await invoiceView(first.id)).invoice.status).toBe("paid");
    const a2 = (await paymentView(p2.id)).allocations[0]!;
    const sales = await createEmployee(["sales"]);
    expect(
      await as(sales, "paymentAllocations.cancel", {
        allocationId: a2.id,
        version: a2.version,
        reason: "誤り",
      }),
    ).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(
      await systemCommandResult("paymentAllocations.cancel", {
        allocationId: a2.id,
        version: a2.version + 1,
        reason: "誤り",
      }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    // 消込の取消も理由が必須（入金・請求書の画面に出す）
    expect(
      await systemCommandResult("paymentAllocations.cancel", {
        allocationId: a2.id,
        version: a2.version,
        reason: " ",
      }),
    ).toMatchObject({ ok: false, error: { code: "validation" } });
    await systemCommand("paymentAllocations.cancel", {
      allocationId: a2.id,
      version: a2.version,
      reason: "別の請求書に消し込む",
    });
    expect((await invoiceView(first.id)).invoice).toMatchObject({
      status: "partial",
      allocated: 1000,
    });
    expect((await paymentView(p2.id)).unallocated).toBe(1027);
    expect((await paymentView(p2.id)).allocations[0]).toMatchObject({
      cancelled: true,
      cancelReason: "別の請求書に消し込む",
      cancelledAt: expect.any(String),
    });
    expect(
      (await invoiceView(first.id)).invoice.allocations.find((a) => a.id === a2.id)?.cancelReason,
    ).toBe("別の請求書に消し込む");
    expect(
      await systemCommandResult("paymentAllocations.cancel", {
        allocationId: a2.id,
        version: a2.version + 1,
        reason: "もう一度",
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_state" } });

    // 入金の取消は、その入金の消込もまとめて取り消す（理由は必須）
    const view = await paymentView(p1.id);
    expect(
      await systemCommandResult("customerPayments.cancel", {
        paymentId: p1.id,
        version: view.payment.version,
        reason: "",
      }),
    ).toMatchObject({ ok: false, error: { code: "validation" } });
    const cancelled = await systemCommand("customerPayments.cancel", {
      paymentId: p1.id,
      version: view.payment.version,
      reason: "二重に記録した",
    });
    expect(cancelled.cancelledAllocations).toBe(1);
    expect((await invoiceView(first.id)).invoice).toMatchObject({ status: "unpaid", allocated: 0 });
    const after = await paymentView(p1.id);
    expect(after).toMatchObject({ unallocated: 0, openInvoices: [] });
    // 取消の理由・日時・操作者を入金に記録し、まとめて取り消した消込には入金の取消の理由を残す
    expect(after.payment).toMatchObject({
      cancelled: true,
      cancelReason: "二重に記録した",
      cancelledAt: expect.any(String),
    });
    expect(after.allocations[0]?.cancelReason).toBe("入金の取消：二重に記録した");
    expect(
      await systemCommandResult("customerPayments.cancel", {
        paymentId: p1.id,
        version: after.payment.version,
        reason: "もう一度",
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    expect(
      await systemCommandResult("customerPayments.allocate", {
        paymentId: p1.id,
        version: after.payment.version,
        allocations: [{ invoiceId: first.id, version: 1, amount: 1 }],
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    expect(
      (await systemQuery("customerPayments.list", { customerId: setup.customer.id })).total,
    ).toBe(1);
    expect(
      (
        await systemQuery("customerPayments.list", {
          customerId: setup.customer.id,
          includeCancelled: true,
        })
      ).total,
    ).toBe(2);
  });
});

describe("売掛残高と入金予定", () => {
  it("販売先ごとの請求残高・期限超過・未消込の入金と、支払期限の順の入金予定", async () => {
    const setup = await billingSetup();
    const overdue = await issuePerShipment(
      await shipOrder(setup, { shippedOn: addDays(today(), -40) }),
      {
        issuedOn: addDays(today(), -40),
        dueOn: addDays(today(), -10),
      },
    );
    const later = await issuePerShipment(await shipOrder(setup), { dueOn: addDays(today(), 20) });
    const third = await shipOrder(setup);
    const noDue = await systemCommand("invoices.issue", {
      shipmentId: third.shipmentId,
      version: third.shipmentVersion,
      issuedOn: today(),
    });
    await systemCommand("customerPayments.create", {
      customerId: setup.customer.id,
      receivedOn: today(),
      amount: 500,
      method: "transfer",
    });
    const balances = await systemQuery("receivables.balances", { customerId: setup.customer.id });
    expect(balances.rows).toHaveLength(1);
    expect(balances.rows[0]).toMatchObject({
      customerName: setup.customer.name,
      billed: 2027 * 3,
      overdue: 2027,
      unallocated: 500,
      balance: 2027 * 3 - 500,
      openCount: 3,
      overdueCount: 1,
      nextDueOn: addDays(today(), -10),
    });
    const schedule = await systemQuery("receivables.schedule", { customerId: setup.customer.id });
    expect(schedule.rows.map((r) => [r.id, r.overdue])).toEqual([
      [overdue.id, true],
      [later.id, false],
      [noDue.id, false],
    ]);
    expect(
      (await systemQuery("receivables.schedule", { customerId: setup.customer.id, overdue: true }))
        .rows,
    ).toHaveLength(1);
    expect(
      (
        await systemQuery("receivables.schedule", {
          customerId: setup.customer.id,
          dueTo: today(),
        })
      ).total,
    ).toBe(1);
    expect(
      (await systemQuery("invoices.list", { customerId: setup.customer.id, overdue: true })).rows[0]
        ?.overdue,
    ).toBe(true);
    expect((await systemQuery("billing.dashboard", {})).overdueInvoices).toBeGreaterThanOrEqual(1);
    const open = await systemQuery("customerPayments.openInvoices", {
      customerId: setup.customer.id,
    });
    expect(open[0]).toMatchObject({ id: overdue.id, overdue: true, outstanding: 2027 });
  });
});
