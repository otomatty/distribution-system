/** 仕入のユースケースの業務エラー（見つからない・選べない・古い版など）を、業務 DB に直接送って確かめる */
import { describe, expect, it } from "vitest";

import { createItem, createLocation, createSupplier } from "./fixtures";
import { createEmployee, systemCommand, systemQuery } from "./helpers";
import { systemCommandResult } from "./platform-helpers";
import {
  createConfirmedOrder,
  createCustomer,
  createOrder,
  orderView,
  purchasingSetup,
  receive,
} from "./purchasing-fixtures";

const MISSING = "01ZZZZZZZZZZZZZZZZZZZZZZZZ";

function errorOf(r: { ok: boolean; error?: { message: string } }): string {
  return r.ok ? "" : (r.error?.message ?? "");
}

describe("見つからない伝票", () => {
  it("発注・入荷・仕入返品・仕入先請求書の操作は not_found、照会は null", async () => {
    const results = await Promise.all([
      systemCommandResult("purchaseOrders.update", {
        id: MISSING,
        version: 1,
        fields: { supplierId: MISSING, orderedOn: "2026-10-01", destinationKind: "other" },
      }),
      systemCommandResult("purchaseOrders.confirm", {
        id: MISSING,
        version: 1,
        sendMethod: "none",
        recipient: null,
      }),
      systemCommandResult("purchaseOrders.cancel", { id: MISSING, version: 1, reason: "x" }),
      systemCommandResult("purchaseOrders.updateMemo", { id: MISSING, version: 1, memo: "x" }),
      systemCommandResult("receipts.record", {
        purchaseOrderId: MISSING,
        version: 1,
        receivedOn: "2026-10-01",
        lines: [{ lineId: MISSING, accepted: 1, returned: 0 }],
      }),
      systemCommandResult("receipts.cancel", { id: MISSING, version: 1, reason: "x" }),
      systemCommandResult("purchaseReturns.create", {
        purchaseOrderId: MISSING,
        returnedOn: "2026-10-01",
        locationId: MISSING,
        lines: [{ lineId: MISSING, units: 1 }],
      }),
      systemCommandResult("supplierInvoices.pay", {
        id: MISSING,
        version: 1,
        paidOn: "2026-10-01",
        amount: 1,
      }),
      systemCommandResult("supplierInvoices.cancel", { id: MISSING, version: 1, reason: "x" }),
      systemCommandResult("supplierInvoices.cancelPayment", {
        id: MISSING,
        version: 1,
        reason: "x",
      }),
    ]);
    for (const r of results) expect(r).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await systemQuery("purchaseOrders.get", { id: MISSING })).toBeNull();
    expect(await systemQuery("supplierInvoices.get", { id: MISSING })).toBeNull();
    expect(
      await systemQuery("supplierInvoices.candidates", {
        supplierId: MISSING,
        invoiceDate: "2026-10-01",
      }),
    ).toBeNull();
    const preview = await systemQuery("supplierInvoices.preview", {
      supplierId: MISSING,
      invoiceDate: "2026-10-01",
    });
    expect(preview.error).toBe("仕入先を選んでください");
    expect(
      errorOf(
        await systemCommandResult("supplierInvoices.create", {
          supplierId: MISSING,
          invoiceDate: "2026-10-01",
          invoicedAmount: 0,
        }),
      ),
    ).toBe("仕入先を選んでください");
  });
});

describe("発注の入力の検証", () => {
  it("仕入先・納入先・担当者・明細の商品を確かめる", async () => {
    const { supplierId, locationId, a } = await purchasingSetup();
    const customerId = await createCustomer();
    const base = {
      supplierId,
      orderedOn: "2026-10-01",
      destinationKind: "location" as const,
      destinationLocationId: locationId,
      lines: [{ itemId: a.id, quantity: 1, unitPriceCenti: 100 }],
    };
    const create = (overrides: Record<string, unknown>) =>
      systemCommandResult("purchaseOrders.create", { ...base, ...overrides });
    expect(errorOf(await create({ supplierId: customerId }))).toBe("仕入先を選んでください");
    expect(errorOf(await create({ supplierId: MISSING }))).toBe("仕入先を選んでください");
    expect(errorOf(await create({ destinationLocationId: MISSING }))).toBe(
      "保管場所を選んでください",
    );
    expect(
      errorOf(await create({ destinationKind: "customer", destinationCustomerId: supplierId })),
    ).toBe("納入先の販売先を選んでください");
    expect(errorOf(await create({ destinationKind: "customer" }))).toBe(
      "納入先の販売先を選んでください",
    );
    expect(errorOf(await create({ employeeId: MISSING }))).toBe("担当者を選んでください");
    expect(
      errorOf(
        await create({
          lines: [
            { itemId: a.id, quantity: 1, unitPriceCenti: 100 },
            { itemId: a.id, quantity: 2, unitPriceCenti: 100 },
          ],
        }),
      ),
    ).toBe("同じ商品が複数の行にあります");
    expect(
      errorOf(await create({ lines: [{ itemId: MISSING, quantity: 1, unitPriceCenti: 100 }] })),
    ).toBe("登録されていない商品です");
    // 税率表にない日付（2019-10-01 より前）
    expect(errorOf(await create({ orderedOn: "2019-01-01" }))).toContain("税率が設定にありません");

    const userEmail = await createEmployee(["purchasing"], "担当者");
    const employees = await systemQuery("employees.list", {});
    const employee = employees.find((e) => e.email === userEmail);
    if (!employee) throw new Error("社員が見つかりません");
    const ok = await systemCommand("purchaseOrders.create", { ...base, employeeId: employee.id });
    expect((await orderView(ok.id)).order.employeeName).toBe("担当者");
    // 無効にした社員は新しく選べないが、すでに選んでいる発注はそのまま保存できる
    await systemCommand("employees.update", {
      id: employee.id,
      version: employee.version,
      name: employee.name,
      roles: [...employee.roles],
      active: false,
    });
    expect(errorOf(await create({ employeeId: employee.id }))).toBe("担当者を選んでください");
    const kept = await systemCommandResult("purchaseOrders.update", {
      id: ok.id,
      version: 1,
      fields: { ...base, employeeId: employee.id },
    });
    expect(kept.ok).toBe(true);
  });

  it("取引終了の仕入先・保管場所・販売先は新しく選べないが、選んでいる作成中の発注は保存できる", async () => {
    const supplierId = await createSupplier();
    const item = await createItem(supplierId);
    const locationId = await createLocation();
    const customerId = await createCustomer();
    const po = await createOrder({
      supplierId,
      locationId,
      lines: [{ itemId: item.id, quantity: 1 }],
    });
    const direct = await createOrder({
      supplierId,
      customerId,
      lines: [{ itemId: item.id, quantity: 1 }],
    });
    await systemCommand("partners.archive", { id: supplierId, version: 1, archived: true });
    await systemCommand("locations.archive", { id: locationId, version: 1, archived: true });
    await systemCommand("partners.archive", { id: customerId, version: 1, archived: true });
    const fields = {
      supplierId,
      orderedOn: "2026-10-01",
      destinationKind: "location" as const,
      destinationLocationId: locationId,
      lines: [{ itemId: item.id, quantity: 2, unitPriceCenti: 100 }],
    };
    expect(errorOf(await systemCommandResult("purchaseOrders.create", fields))).toBe(
      "取引終了の仕入先は選べません",
    );
    expect(
      (await systemCommandResult("purchaseOrders.update", { id: po.id, version: 1, fields })).ok,
    ).toBe(true);
    const other = await createSupplier();
    const otherItem = await createItem(other);
    const otherFields = {
      ...fields,
      supplierId: other,
      lines: [{ itemId: otherItem.id, quantity: 1, unitPriceCenti: 1 }],
    };
    expect(errorOf(await systemCommandResult("purchaseOrders.create", otherFields))).toBe(
      "取引終了の保管場所は選べません",
    );
    const customerFields = {
      ...fields,
      destinationKind: "customer" as const,
      destinationCustomerId: customerId,
    };
    expect(
      errorOf(
        await systemCommandResult("purchaseOrders.create", {
          ...customerFields,
          supplierId: other,
          lines: [],
        }),
      ),
    ).toBe("取引終了の販売先は選べません");
    expect(
      (
        await systemCommandResult("purchaseOrders.update", {
          id: direct.id,
          version: 1,
          fields: customerFields,
        })
      ).ok,
    ).toBe(true);
  });

  it("明細の計算の照会：登録されていない商品・不正な日付・税率表にない日付", async () => {
    const { a } = await purchasingSetup();
    const r = await systemQuery("purchaseOrders.preview", {
      orderedOn: "bad",
      lines: [
        { itemId: a.id, quantity: "2", price: "1000" },
        { itemId: MISSING, quantity: "1", price: "1" },
      ],
    });
    expect(r.lines[0]?.amount).toBe(2000);
    expect(r.lines[1]?.error).toBe("登録されていない商品です");
    expect(r.summary?.total).toBe(2160);
    const old = await systemQuery("purchaseOrders.preview", {
      orderedOn: "2019-01-01",
      lines: [{ itemId: a.id, quantity: "x", price: "1" }],
    });
    expect(old.summary).toBeNull();
    expect(old.error).toContain("税率が設定にありません");
    expect(old.lines[0]?.error).toBe("数量は1以上の整数で入力してください");
  });

  it("古い版での確定・取消は conflict", async () => {
    const { supplierId, locationId, a } = await purchasingSetup();
    const po = await createOrder({
      supplierId,
      locationId,
      lines: [{ itemId: a.id, quantity: 1 }],
    });
    await systemCommand("purchaseOrders.updateMemo", { id: po.id, version: 1, memo: "x" });
    const stale = await Promise.all([
      systemCommandResult("purchaseOrders.confirm", {
        id: po.id,
        version: 1,
        sendMethod: "none",
        recipient: null,
      }),
      systemCommandResult("purchaseOrders.cancel", { id: po.id, version: 1, reason: "x" }),
    ]);
    for (const r of stale) expect(r).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});

describe("入荷・仕入返品の検証", () => {
  it("古い版での入荷の取消、未来の返品日はエラー", async () => {
    const { supplierId, locationId, a, b } = await purchasingSetup();
    const po = await createConfirmedOrder({
      supplierId,
      locationId,
      lines: [
        { itemId: a.id, quantity: 2 },
        { itemId: b.id, quantity: 1 },
      ],
    });
    const receipt = await receive(po.id, [2, 0]);
    const stale = await systemCommandResult("receipts.cancel", {
      id: receipt.id,
      version: 9,
      reason: "x",
    });
    expect(stale).toMatchObject({ ok: false, error: { code: "conflict" } });
    const view = await orderView(po.id);
    // 入荷のない明細（b）は返品できる数が 0
    expect(view.lines[1]?.returnableUnits).toBe(0);
    const future = await systemCommandResult("purchaseReturns.create", {
      purchaseOrderId: po.id,
      returnedOn: "2099-01-01",
      locationId,
      lines: [{ lineId: view.order.lines[0]?.id ?? "", units: 1 }],
    });
    expect(errorOf(future)).toBe("今日より後の日付は指定できません");
  });
});

/** 仕入先請求書（入荷2件、請求額を指定）を作る */
async function invoiceFor(amount: number) {
  const supplierId = await createSupplier();
  const locationId = await createLocation();
  const item = await createItem(supplierId);
  const po = await createConfirmedOrder({
    supplierId,
    locationId,
    lines: [{ itemId: item.id, quantity: 3 }],
  });
  const r1 = await receive(po.id, [1]);
  const r2 = await receive(po.id, [1]);
  const inv = await systemCommand("supplierInvoices.create", {
    supplierId,
    invoiceDate: "2026-10-31",
    invoicedAmount: amount,
    differenceReason: amount === 2592 ? null : "先方の計算",
    receiptIds: [r1.id, r2.id],
  });
  return { supplierId, po, r1, r2, inv };
}

describe("仕入先請求書・支払の検証", () => {
  it("一括支払い：同じ請求書の重複は1回に、見つからない・支払済みがあれば何もしない", async () => {
    const a = await invoiceFor(2592);
    const b = await invoiceFor(2592);
    await systemCommand("supplierInvoices.pay", {
      id: b.inv.id,
      version: 1,
      paidOn: "2026-11-01",
      amount: 2592,
    });
    const failed = await systemCommandResult("supplierInvoices.payBulk", {
      invoices: [
        { id: a.inv.id, version: 1 },
        { id: b.inv.id, version: 2 },
        { id: MISSING, version: 1 },
      ],
      paidOn: "2026-11-05",
    });
    expect(failed).toMatchObject({
      ok: false,
      error: {
        details: expect.arrayContaining([
          "見つからない請求書が含まれています",
          expect.stringContaining("未払いの請求書だけを支払えます"),
        ]),
      },
    });
    const done = await systemCommand("supplierInvoices.payBulk", {
      invoices: [
        { id: a.inv.id, version: 1 },
        { id: a.inv.id, version: 1 },
      ],
      paidOn: "2026-11-05",
    });
    expect(done).toMatchObject({ count: 1, amount: 2592 });
  });

  it("古い版での支払・支払の取消・取消は conflict", async () => {
    const { inv } = await invoiceFor(2592);
    const stale = await Promise.all([
      systemCommandResult("supplierInvoices.pay", {
        id: inv.id,
        version: 9,
        paidOn: "2026-11-01",
        amount: 1,
      }),
      systemCommandResult("supplierInvoices.cancel", { id: inv.id, version: 9, reason: "x" }),
    ]);
    for (const r of stale) expect(r).toMatchObject({ ok: false, error: { code: "conflict" } });
    await systemCommand("supplierInvoices.pay", {
      id: inv.id,
      version: 1,
      paidOn: "2026-11-01",
      amount: 1,
    });
    const cancel = await systemCommandResult("supplierInvoices.cancelPayment", {
      id: inv.id,
      version: 1,
      reason: "x",
    });
    expect(cancel).toMatchObject({ ok: false, error: { code: "conflict" } });
    const notPaid = await systemCommandResult("supplierInvoices.cancelPayment", {
      id: (await invoiceFor(2592)).inv.id,
      version: 1,
      reason: "x",
    });
    expect(errorOf(notPaid)).toContain("支払済みの請求書だけ");
  });

  it("入荷の取消で差額がなくなれば、差額の理由はそのまま残す", async () => {
    // 1件分（1,296円）の請求に2件の入荷を結びつけていた
    const { inv, r2 } = await invoiceFor(1296);
    await systemCommand("receipts.cancel", { id: r2.id, version: 1, reason: "誤り" });
    const view = await systemQuery("supplierInvoices.get", { id: inv.id });
    expect(view?.invoice.difference).toBe(0);
    expect(view?.invoice.differenceReason).toBe("先方の計算");
    // 取消済みの請求書に結びついていない入荷の取消は、請求書を変えない
    const other = await invoiceFor(2592);
    await systemCommand("supplierInvoices.cancel", { id: other.inv.id, version: 1, reason: "x" });
    const r = await systemCommandResult("receipts.cancel", {
      id: other.r1.id,
      version: 1,
      reason: "誤り",
    });
    expect(r.ok).toBe(true);
  });

  it("仕入先請求書の登録：税率表にない請求日、取消済みの入荷はエラー", async () => {
    const { supplierId, po } = await (async () => {
      const s = await createSupplier();
      const l = await createLocation();
      const i = await createItem(s);
      const p = await createConfirmedOrder({
        supplierId: s,
        locationId: l,
        lines: [{ itemId: i.id, quantity: 2 }],
      });
      return { supplierId: s, po: p };
    })();
    const receipt = await receive(po.id, [1]);
    const old = await systemCommandResult("supplierInvoices.create", {
      supplierId,
      invoiceDate: "2019-01-01",
      invoicedAmount: 1,
      receiptIds: [receipt.id],
    });
    expect(errorOf(old)).toContain("税率が設定にありません");
    const preview = await systemQuery("supplierInvoices.preview", {
      supplierId,
      invoiceDate: "2019-01-01",
      receiptIds: [receipt.id],
    });
    expect(preview.error).toContain("税率が設定にありません");
    await systemCommand("receipts.cancel", { id: receipt.id, version: 1, reason: "誤り" });
    const cancelled = await systemCommandResult("supplierInvoices.create", {
      supplierId,
      invoiceDate: "2026-10-31",
      invoicedAmount: 1,
      receiptIds: [receipt.id],
    });
    expect(errorOf(cancelled)).toContain("画面を開き直してください");
  });
});

describe("支払予定と買掛残高の照会", () => {
  it("支払予定日を過ぎたものだけ・期間の指定・仕入先の指定なし", async () => {
    const supplierId = await createSupplier();
    const locationId = await createLocation();
    const item = await createItem(supplierId);
    const po = await createConfirmedOrder({
      supplierId,
      locationId,
      lines: [{ itemId: item.id, quantity: 2 }],
    });
    const r1 = await receive(po.id, [1]);
    const r2 = await receive(po.id, [1]);
    const overdue = await systemCommand("supplierInvoices.create", {
      supplierId,
      invoiceDate: "2026-01-31",
      invoicedAmount: 1296,
      receiptIds: [r1.id],
      paymentDueOn: "2026-02-28",
    });
    const future = await systemCommand("supplierInvoices.create", {
      supplierId,
      invoiceDate: "2026-10-31",
      invoicedAmount: 1296,
      receiptIds: [r2.id],
      paymentDueOn: "2099-12-31",
    });
    const ids = async (input: Record<string, unknown>) =>
      (await systemQuery("payables.list", { supplierId, ...input })).rows.map((r) => r.id);
    expect(await ids({ overdue: true })).toEqual([overdue.id]);
    expect(await ids({ overdue: true, dueTo: "2026-02-01" })).toEqual([]);
    expect(await ids({ overdue: true, dueTo: "2099-12-31" })).toEqual([overdue.id]);
    expect(await ids({ dueFrom: "2099-01-01" })).toEqual([future.id]);
    const all = await systemQuery("payables.list", {});
    expect(all.totals.count).toBeGreaterThanOrEqual(2);
    const invoices = await systemQuery("supplierInvoices.list", {});
    expect(invoices.total).toBeGreaterThanOrEqual(2);
    const byDate = await systemQuery("supplierInvoices.list", {
      supplierId,
      from: "2026-10-01",
      to: "2026-10-31",
      q: "",
    });
    expect(byDate.rows.map((r) => r.id)).toEqual([future.id]);
    const orders = await systemQuery("purchaseOrders.list", {});
    expect(orders.total).toBeGreaterThanOrEqual(1);
    const balances = await systemQuery("payables.balances", {});
    expect(balances.months).toHaveLength(6);
    expect(balances.rows.some((r) => r.supplierId === supplierId)).toBe(true);
    const empty = await systemQuery("payables.balances", { from: "2026-12", to: "2026-01" });
    expect(empty).toEqual({ months: [], rows: [] });
  });
});
