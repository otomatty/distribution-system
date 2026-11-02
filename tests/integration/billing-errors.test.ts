/**
 * 請求・入金・返品のユースケースの業務エラー（見つからない、状態が違う、版番号が古い）と、絞り込みのない照会。
 */
import { describe, expect, it } from "vitest";

import { addDays } from "../../src/domain/dates";
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
import { systemCommand, systemQuery } from "./helpers";
import { systemCommandResult } from "./platform-helpers";
import { getOrder, today } from "./sales-fixtures";

describe("請求書の業務エラー", () => {
  it("見つからない・取り消した発送・すでに載った返品伝票・古い版番号の返品伝票", async () => {
    expect(
      await systemCommandResult("invoices.issue", {
        shipmentId: "missing",
        version: 1,
        issuedOn: today(),
      }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });

    const setup = await billingSetup();
    const cancelled = await shipOrder(setup);
    const shipment = (await getOrder(cancelled.order.id)).shipments[0]!;
    await systemCommand("shipments.cancel", {
      shipmentId: shipment.id,
      version: shipment.version,
      reason: "誤り",
    });
    const future = await shipOrder(setup);
    expect(
      await systemCommandResult("invoices.issue", {
        shipmentId: future.shipmentId,
        version: future.shipmentVersion,
        issuedOn: addDays(today(), 1),
      }),
    ).toMatchObject({ ok: false, error: { message: "発行日は今日より後にできません" } });
    expect(
      await systemCommandResult("invoices.issue", {
        shipmentId: cancelled.shipmentId,
        version: shipment.version + 1,
        issuedOn: today(),
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_state" } });

    // 同じ日の返品伝票2件は番号の順に載る。載った返品伝票は別の請求書に載せられない
    const a = await shipOrder(setup);
    const b = await shipOrder(setup);
    const r1 = await recordReturn(a.order.id, { restockTo: null });
    const r2 = await recordReturn(a.order.id, { restockTo: null });
    const refs = [
      { id: r2.id, version: await returnVersion(r2.id) },
      { id: r1.id, version: await returnVersion(r1.id) },
    ];
    expect(
      await systemCommandResult("invoices.issue", {
        shipmentId: b.shipmentId,
        version: b.shipmentVersion,
        issuedOn: today(),
        returns: [{ ...refs[0]!, version: refs[0]!.version + 1 }],
      }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    const issued = await issuePerShipment(b, { returns: refs });
    expect((await invoiceView(issued.id)).invoice.returns.map((r) => r.id)).toEqual([r1.id, r2.id]);
    expect(
      await systemCommandResult("invoices.issue", {
        shipmentId: a.shipmentId,
        version: a.shipmentVersion,
        issuedOn: today(),
        returns: [{ id: r1.id, version: await returnVersion(r1.id) }],
      }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });

    // 取消：見つからない・古い版番号。再発行：見つからない・取消済み
    const view = await invoiceView(issued.id);
    expect(
      await systemCommandResult("invoices.cancel", { id: "missing", version: 1, reason: "x" }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(
      await systemCommandResult("invoices.cancel", {
        id: issued.id,
        version: view.invoice.version + 1,
        reason: "x",
      }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(
      await systemCommandResult("invoices.reissue", { id: "missing", version: 1, reason: "x" }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    // 発送ごとの請求書の再発行で支払期限を指定しなければ、元の支払期限のまま
    const re = await systemCommand("invoices.reissue", {
      id: issued.id,
      version: view.invoice.version,
      reason: "宛名",
    });
    expect((await invoiceView(re.id)).invoice).toMatchObject({
      dueOn: view.invoice.dueOn,
      returns: [{ id: r1.id }, { id: r2.id }],
    });
    expect(
      await systemCommandResult("invoices.reissue", {
        id: issued.id,
        version: (await invoiceView(issued.id)).invoice.version,
        reason: "もう一度",
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_state" } });
  });

  it("締め処理：見つからない販売先、合計がマイナスになる販売先は発行しない（候補にも理由を出す）", async () => {
    const setup = await billingSetup();
    const period = lastMonth();
    expect(
      await systemCommandResult("invoices.close", {
        targets: [
          {
            customerId: "missing",
            periodFrom: period.from,
            periodTo: period.to,
            shipments: [{ id: "x", version: 1 }],
          },
        ],
      }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });

    const customer = await createClosingCustomer();
    await shipOrder(setup, {
      customerId: customer.id,
      shippedOn: period.from,
      lines: [{ itemId: setup.a.id, quantity: 1, unitPriceCenti: 15_050 }],
      charges: [],
    });
    const big = await shipOrder(setup, {
      customerId: customer.id,
      shippedOn: addDays(period.from, -1),
      lines: [{ itemId: setup.b.id, quantity: 30, unitPriceCenti: 10_000 }],
      charges: [],
    });
    // 前の期間の発送を先に締める。その期間の返品は大きく、次の期間に回すとマイナスになる
    const first = (await systemQuery("invoices.closing", { customerId: customer.id }))
      .candidates[0]!;
    await systemCommand("invoices.close", {
      targets: [
        {
          customerId: customer.id,
          periodFrom: first.periodFrom,
          periodTo: first.periodTo,
          shipments: first.shipments.map((s) => ({ id: s.id, version: s.version })),
        },
      ],
    });
    await recordReturn(big.order.id, {
      quantity: 20,
      returnedOn: period.from,
      restockTo: setup.locationId,
    });
    const c = (await systemQuery("invoices.closing", { customerId: customer.id })).candidates[0]!;
    expect(c.summary).toBeNull();
    expect(c.error).toContain("マイナス");
    expect(
      await systemCommandResult("invoices.close", {
        targets: [
          {
            customerId: customer.id,
            periodFrom: c.periodFrom,
            periodTo: c.periodTo,
            shipments: c.shipments.map((s) => ({ id: s.id, version: s.version })),
            returns: c.returns.map((r) => ({ id: r.id, version: r.version })),
          },
        ],
      }),
    ).toMatchObject({ ok: false, error: { code: "validation" } });
  });

  it("絞り込みのない照会（すべての販売先）", async () => {
    const setup = await billingSetup();
    await shipOrder(setup);
    expect((await systemQuery("invoices.list", {})).page).toBe(1);
    const unbilled = await systemQuery("invoices.unbilled", { billing: "per_shipment" });
    expect(unbilled.rows.every((r) => r.billing === "per_shipment")).toBe(true);
    expect(unbilled.total).toBeGreaterThanOrEqual(1);
    expect((await systemQuery("invoices.closing", {})).today).toBe(today());
    expect((await systemQuery("customerPayments.list", {})).page).toBe(1);
    expect((await systemQuery("receivables.balances", {})).today).toBe(today());
    expect((await systemQuery("receivables.schedule", {})).today).toBe(today());
    expect((await systemQuery("disposals.list", {})).page).toBe(1);
    expect(
      (await systemQuery("disposals.rates", { from: addDays(today(), -1), to: today() })).page,
    ).toBe(1);
    expect(await systemQuery("invoices.get", { id: "missing" })).toBeNull();
    expect(await systemQuery("salesReturns.get", { id: "missing" })).toBeNull();
    expect(await systemQuery("salesReturns.forOrder", { salesOrderId: "missing" })).toBeNull();
    expect(await systemQuery("customerPayments.get", { id: "missing" })).toBeNull();
  });
});

describe("入金と消込の業務エラー", () => {
  it("差額だけの消込、見つからない入金・消込、古い版番号の入金の取消", async () => {
    const setup = await billingSetup();
    const invoice = await issuePerShipment(await shipOrder(setup));
    const v = (await invoiceView(invoice.id)).invoice.version;
    // 入金から充てる額が 0 でも、差額だけで消し込める
    const payment = await systemCommand("customerPayments.create", {
      customerId: setup.customer.id,
      receivedOn: today(),
      amount: 2000,
      method: "transfer",
      allocations: [{ invoiceId: invoice.id, version: v, amount: 2000, adjustment: 0 }],
    });
    const v2 = (await invoiceView(invoice.id)).invoice.version;
    const other = await systemCommand("customerPayments.create", {
      customerId: setup.customer.id,
      receivedOn: today(),
      amount: 1,
      method: "other",
      allocations: [
        { invoiceId: invoice.id, version: v2, amount: 0, adjustment: 27, adjustmentKind: "other" },
      ],
    });
    expect(other.remaining).toBe(1);
    expect((await invoiceView(invoice.id)).invoice.status).toBe("paid");

    expect(
      await systemCommandResult("customerPayments.allocate", {
        paymentId: "missing",
        version: 1,
        allocations: [{ invoiceId: invoice.id, version: 1, amount: 1 }],
      }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    // 入金済みの請求書には消し込めない
    const p = (await systemQuery("customerPayments.get", { id: other.id }))!;
    expect(
      await systemCommandResult("customerPayments.allocate", {
        paymentId: other.id,
        version: p.payment.version,
        allocations: [{ invoiceId: invoice.id, version: v2, amount: 1 }],
      }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(
      await systemCommandResult("paymentAllocations.cancel", {
        allocationId: "missing",
        version: 1,
        reason: "x",
      }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(
      await systemCommandResult("customerPayments.cancel", {
        paymentId: "missing",
        version: 1,
        reason: "x",
      }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    const view = (await systemQuery("customerPayments.get", { id: payment.id }))!;
    expect(
      await systemCommandResult("customerPayments.cancel", {
        paymentId: payment.id,
        version: view.payment.version + 1,
        reason: "x",
      }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});

describe("返品伝票と返還請求書の業務エラー", () => {
  it("見つからない受注・保管場所、在庫が足りず戻せない取消、発送を取り消した後の返品伝票", async () => {
    expect(
      await systemCommandResult("salesReturns.create", {
        salesOrderId: "missing",
        returnedOn: today(),
        lines: [{ salesOrderLineId: "x", quantity: 1, restock: false }],
      }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    const setup = await billingSetup();
    const shipped = await shipOrder(setup);
    const line = (await getOrder(shipped.order.id)).order.lines[0]!;
    expect(
      await systemCommandResult("salesReturns.create", {
        salesOrderId: shipped.order.id,
        returnedOn: today(),
        lines: [{ salesOrderLineId: line.id, quantity: 1, restock: true, locationId: "missing" }],
      }),
    ).toMatchObject({ ok: false, error: { fields: [{ field: "lines.0.locationId" }] } });
    expect(
      await systemCommandResult("salesReturns.cancel", { id: "missing", version: 1, reason: "x" }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(
      await systemCommandResult("creditNotes.issue", {
        salesReturnId: "missing",
        version: 1,
        issuedOn: today(),
      }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });

    // 在庫に戻した商品を出荷してしまうと、返品伝票を取り消せない（在庫がマイナスになる）
    const ret = await recordReturn(shipped.order.id, { quantity: 3, restockTo: setup.locationId });
    const stock = await systemQuery("stock.levels", {
      itemIds: [setup.a.id],
      locationId: setup.locationId,
    });
    await shipOrder(setup, {
      lines: [{ itemId: setup.a.id, quantity: stock[0]!.onHand, unitPriceCenti: 15_050 }],
      charges: [],
    });
    expect(
      await systemCommandResult("salesReturns.cancel", {
        id: ret.id,
        version: await returnVersion(ret.id),
        reason: "誤り",
      }),
    ).toMatchObject({ ok: false, error: { code: "insufficient_stock" } });

    // 取り消した返品伝票は、発送を取り消した後も見られる（元の取引年月日は返品日にする）
    const other = await shipOrder(setup, {
      shippedOn: addDays(today(), -1),
      lines: [{ itemId: setup.b.id, quantity: 6, unitPriceCenti: 10_000 }],
    });
    const r2 = await recordReturn(other.order.id, { restockTo: null });
    await systemCommand("salesReturns.cancel", {
      id: r2.id,
      version: await returnVersion(r2.id),
      reason: "誤り",
    });
    const s = (await getOrder(other.order.id)).shipments[0]!;
    expect(s.cancellable).toBe(true);
    await systemCommand("shipments.cancel", {
      shipmentId: s.id,
      version: s.version,
      reason: "誤り",
    });
    const view = await systemQuery("salesReturns.get", { id: r2.id });
    expect(view?.creditNote.issuable).toBe(false);
    expect(view?.ret.cancelled).toBe(true);
  });

  it("返還請求書：発行日が返品日より前・古い版番号は発行しない", async () => {
    const setup = await billingSetup();
    const shipped = await shipOrder(setup);
    const ret = await recordReturn(shipped.order.id, { restockTo: null });
    await issuePerShipment(shipped, {
      returns: [{ id: ret.id, version: await returnVersion(ret.id) }],
    });
    const v = await returnVersion(ret.id);
    expect(
      await systemCommandResult("creditNotes.issue", {
        salesReturnId: ret.id,
        version: v,
        issuedOn: addDays(today(), -1),
      }),
    ).toMatchObject({ ok: false, error: { fields: [{ field: "issuedOn" }] } });
    expect(
      await systemCommandResult("creditNotes.issue", {
        salesReturnId: ret.id,
        version: v,
        issuedOn: addDays(today(), 1),
      }),
    ).toMatchObject({ ok: false, error: { message: "発行日は今日より後にできません" } });
    expect(
      await systemCommandResult("creditNotes.issue", {
        salesReturnId: ret.id,
        version: v + 1,
        issuedOn: today(),
      }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});
