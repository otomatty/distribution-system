/**
 * 請求書の発行・締め処理・取消と再発行（要件定義書 3.10、4章 請求書の状態遷移）のユースケース。
 * 金額の写し、発送・返品伝票との結びつき、帳票の発行と取消、権限・二重送信・版番号の確認。
 */
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { addDays, addMonths, monthOf, monthRange } from "../../src/domain/dates";
import type { Result } from "../../src/domain/result";
import * as schema from "../../src/infra/db/schema";
import { businessDb } from "../../src/infra/do/client";
import { invoiceSnapshotSchema } from "../../src/usecases/billing/snapshots";
import type { CommandInput, CommandName } from "../../src/usecases/registry";
import {
  billingSetup,
  createClosingCustomer,
  invoiceView,
  issuePerShipment,
  lastMonth,
  recordReturn,
  returnVersion,
  setTerms,
  shipOrder,
} from "./billing-fixtures";
import { createEmployee, newKey, systemCommand, systemQuery } from "./helpers";
import { documentRow, readDb, systemCommandResult } from "./platform-helpers";
import { createCustomer, getOrder, today } from "./sales-fixtures";

async function as<N extends CommandName>(
  email: string,
  name: N,
  input: CommandInput<N>,
  key: string = crypto.randomUUID(),
): Promise<Result<unknown>> {
  return businessDb(env).command(name, input, { kind: "dev", email }, key);
}

async function shipmentRow(id: string) {
  return readDb((db) =>
    db.select().from(schema.shipments).where(eq(schema.shipments.id, id)).get(),
  );
}

async function invoiceLines(invoiceId: string) {
  return readDb((db) =>
    db.select().from(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, invoiceId)).all(),
  );
}

describe("発送ごとの請求書", () => {
  it("発送の明細・送料と未請求の返品を写し、税率ごとに1回だけ税を丸め、帳票を発行する", async () => {
    const setup = await billingSetup();
    const shipped = await shipOrder(setup);
    const ret = await recordReturn(shipped.order.id, { quantity: 1, restockTo: null });
    const shipment = await shipmentRow(shipped.shipmentId);
    const issued = await issuePerShipment(
      { shipmentId: shipped.shipmentId, shipmentVersion: shipment!.version },
      { returns: [{ id: ret.id, version: await returnVersion(ret.id) }] },
    );
    expect(issued.number).toMatch(/^INV-\d{4}-\d{6}$/);
    expect(issued.total).toBe(1865);

    const view = await invoiceView(issued.id);
    expect(view.invoice).toMatchObject({
      status: "unpaid",
      customerId: setup.customer.id,
      issuedOn: today(),
      dueOn: addDays(today(), 30),
      periodFrom: null,
      subtotal: 1701,
      tax: 164,
      total: 1865,
      allocated: 0,
      roundingMode: "floor",
    });
    expect(view.kind).toBe("per_shipment");
    expect(view.invoice.taxSummary).toEqual([
      { category: "standard", rateBps: 1000, subtotal: 1400, tax: 140 },
      { category: "reduced", rateBps: 800, subtotal: 301, tax: 24 },
    ]);
    expect(view.invoice.recipientSnapshot).toMatchObject({
      name: setup.customer.name,
      honorific: "御中",
    });
    expect(view.invoice.lines.map((l) => [l.sourceType, l.quantity, l.amount])).toEqual([
      ["shipment_line", 3, 451],
      ["shipment_line", 6, 600],
      ["charge", 1, 800],
      ["return_line", -1, -150],
    ]);
    expect((await invoiceLines(issued.id)).every((l) => /^[0-9A-Z]{26}$/.test(l.id))).toBe(true);
    expect(view.invoice.shipments.map((s) => s.id)).toEqual([shipped.shipmentId]);
    expect(view.invoice.returns.map((r) => r.id)).toEqual([ret.id]);
    expect((await shipmentRow(shipped.shipmentId))?.invoiceId).toBe(issued.id);

    const doc = await documentRow(issued.documentId);
    expect(doc).toMatchObject({
      documentType: "invoice",
      number: issued.number,
      entityId: issued.id,
      partnerId: setup.customer.id,
      transactionDate: today(),
      amount: 1865,
    });
    const snapshot = invoiceSnapshotSchema.parse(JSON.parse(doc!.snapshotJson));
    expect(snapshot.deliveries).toHaveLength(1);
    expect(snapshot.deliveries[0]?.lines.map((l) => [l.name, l.reduced])).toEqual([
      [setup.a.name, true],
      [setup.b.name, false],
      ["送料", false],
    ]);
    expect(snapshot.returns[0]?.lines[0]).toMatchObject({ quantity: -1, amount: -150 });
    expect(view.document?.documentId).toBe(issued.documentId);

    // 発送の取消は請求書を先に取り消す必要がある
    const order = await getOrder(shipped.order.id);
    expect(order.shipments[0]?.cancellable).toBe(false);
  });

  it("経理・管理者だけが発行できる。受付番号が同じなら1回分だけ処理する", async () => {
    const setup = await billingSetup();
    const shipped = await shipOrder(setup);
    const input = {
      shipmentId: shipped.shipmentId,
      version: (await shipmentRow(shipped.shipmentId))!.version,
      issuedOn: today(),
    };
    const sales = await createEmployee(["sales"]);
    expect(await as(sales, "invoices.issue", input)).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    const accounting = await createEmployee(["accounting"]);
    const key = newKey();
    const first = await as(accounting, "invoices.issue", input, key);
    const second = await as(accounting, "invoices.issue", input, key);
    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    const list = await systemQuery("invoices.list", { customerId: setup.customer.id });
    expect(list.total).toBe(1);
    // 受付番号が違えば、もう請求書に載っているので発行しない
    expect(await as(accounting, "invoices.issue", input, newKey())).toMatchObject({
      ok: false,
      error: { code: "invalid_state" },
    });
  });

  it("古い版番号・締め日のある販売先・発行日が発送日より前・他の販売先の返品は発行しない", async () => {
    const setup = await billingSetup();
    const shipped = await shipOrder(setup, { shippedOn: addDays(today(), -3) });
    const version = (await shipmentRow(shipped.shipmentId))!.version;
    expect(
      await systemCommandResult("invoices.issue", {
        shipmentId: shipped.shipmentId,
        version: version + 1,
        issuedOn: today(),
      }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    const early = await systemCommandResult("invoices.issue", {
      shipmentId: shipped.shipmentId,
      version,
      issuedOn: addDays(today(), -4),
    });
    expect(early).toMatchObject({
      ok: false,
      error: { code: "validation", fields: [{ field: "issuedOn" }] },
    });
    expect(
      await systemCommandResult("invoices.issue", {
        shipmentId: shipped.shipmentId,
        version,
        issuedOn: today(),
        dueOn: addDays(today(), -1),
      }),
    ).toMatchObject({ ok: false, error: { fields: [{ field: "dueOn" }] } });

    const other = await billingSetup();
    const otherShipped = await shipOrder(other);
    const otherReturn = await recordReturn(otherShipped.order.id, { restockTo: null });
    expect(
      await systemCommandResult("invoices.issue", {
        shipmentId: shipped.shipmentId,
        version,
        issuedOn: today(),
        returns: [{ id: otherReturn.id, version: await returnVersion(otherReturn.id) }],
      }),
    ).toMatchObject({ ok: false, error: { code: "validation" } });

    await setTerms(setup.customer.id);
    expect(
      await systemCommandResult("invoices.issue", {
        shipmentId: shipped.shipmentId,
        version,
        issuedOn: today(),
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    expect(await systemQuery("invoices.draft", { shipmentId: shipped.shipmentId })).toMatchObject({
      closing: true,
    });
  });

  it("返品で合計がマイナスになる請求書は作らない。見積もりは返品を選び直せる", async () => {
    const setup = await billingSetup();
    const small = await shipOrder(setup, {
      lines: [{ itemId: setup.a.id, quantity: 1, unitPriceCenti: 15_050 }],
      charges: [],
    });
    const big = await shipOrder(setup, {
      lines: [{ itemId: setup.b.id, quantity: 30, unitPriceCenti: 10_000 }],
      charges: [],
    });
    const ret = await recordReturn(big.order.id, { quantity: 20, restockTo: setup.locationId });
    const draft = await systemQuery("invoices.draft", { shipmentId: small.shipmentId });
    expect(draft?.selectedReturnIds).toEqual([ret.id]);
    expect(draft?.preview).toBeNull();
    expect(draft?.previewError).toContain("マイナス");
    const without = await systemQuery("invoices.draft", {
      shipmentId: small.shipmentId,
      returnIds: [],
    });
    expect(without?.preview?.summary.total).toBe(150 + 12);
    expect(
      await systemCommandResult("invoices.issue", {
        shipmentId: small.shipmentId,
        version: small.shipmentVersion,
        issuedOn: today(),
        returns: [{ id: ret.id, version: await returnVersion(ret.id) }],
      }),
    ).toMatchObject({ ok: false, error: { code: "validation" } });

    // 未請求の発送の一覧（発送ごとか締め処理か、税込の合計）
    const unbilled = await systemQuery("invoices.unbilled", { customerId: setup.customer.id });
    expect(unbilled.rows.map((r) => [r.shipmentId, r.total, r.billing])).toEqual([
      [small.shipmentId, 162, "per_shipment"],
      [big.shipmentId, 3300, "per_shipment"],
    ]);
    expect(await systemQuery("invoices.draft", { shipmentId: "missing" })).toBeNull();
  });
});

describe("締め処理", () => {
  it("締め期間内の未請求の発送と締め日までの返品をまとめて発行し、支払期限を取引条件から決める", async () => {
    const setup = await billingSetup();
    const period = lastMonth();
    const customer = await createClosingCustomer();
    const first = await shipOrder(setup, { customerId: customer.id, shippedOn: period.from });
    const second = await shipOrder(setup, {
      customerId: customer.id,
      shippedOn: addDays(period.from, 5),
      charges: [],
    });
    const ret = await recordReturn(first.order.id, {
      quantity: 1,
      returnedOn: addDays(period.from, 6),
      restockTo: setup.locationId,
    });
    // 今月の発送は次の締め期間（今回は載せない）
    const later = await shipOrder(setup, { customerId: customer.id, shippedOn: today() });

    const { candidates } = await systemQuery("invoices.closing", { customerId: customer.id });
    expect(candidates).toHaveLength(1);
    const c = candidates[0]!;
    expect(c).toMatchObject({
      periodFrom: period.from,
      periodTo: period.to,
      ready: true,
      error: null,
    });
    expect(c.shipments.map((s) => s.id)).toEqual([first.shipmentId, second.shipmentId]);
    expect(c.returns.map((r) => r.id)).toEqual([ret.id]);
    // 税は請求書1枚で税率ごとに1回：標準 2,000円 → 200円、軽減 752円 → 60円
    expect(c.summary?.groups).toEqual([
      { category: "standard", rateBps: 1000, subtotal: 2000, tax: 200 },
      { category: "reduced", rateBps: 800, subtotal: 752, tax: 60 },
    ]);
    expect(c.summary?.total).toBe(3012);
    expect((await systemQuery("billing.dashboard", {})).closingWaiting).toBeGreaterThanOrEqual(1);

    const accounting = await createEmployee(["accounting"]);
    const input = {
      targets: [
        {
          customerId: customer.id,
          periodFrom: c.periodFrom,
          periodTo: c.periodTo,
          shipments: c.shipments.map((s) => ({ id: s.id, version: s.version })),
          returns: c.returns.map((r) => ({ id: r.id, version: r.version })),
        },
      ],
    };
    const sales = await createEmployee(["sales"]);
    expect(await as(sales, "invoices.close", input)).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    const r = await as(accounting, "invoices.close", input, newKey());
    expect(r.ok).toBe(true);
    const issued = (r.ok ? r.value : null) as { issued: { id: string; total: number }[] };
    expect(issued.issued).toHaveLength(1);
    const view = await invoiceView(issued.issued[0]!.id);
    expect(view.kind).toBe("closing");
    expect(view.invoice).toMatchObject({
      issuedOn: period.to,
      periodFrom: period.from,
      periodTo: period.to,
      total: c.summary?.total,
    });
    // 月末締め翌月末払い（前の月の締めなので、今月末）
    expect(view.invoice.dueOn).toBe(monthRange(monthOf(today())).to);
    const due = (await systemQuery("invoices.closing", { customerId: customer.id })).candidates[0];
    // 今月の発送が次の候補になる（まだ締め日前）
    expect(due?.shipments.map((s) => s.id)).toEqual([later.shipmentId]);
    expect(due?.ready).toBe(false);
  });

  it("画面を開いた後に発送が増えた・締め日前・締め日のない販売先は締め処理しない", async () => {
    const setup = await billingSetup();
    const period = lastMonth();
    const customer = await createClosingCustomer();
    await shipOrder(setup, { customerId: customer.id, shippedOn: period.from });
    const c = (await systemQuery("invoices.closing", { customerId: customer.id })).candidates[0]!;
    const target = {
      customerId: customer.id,
      periodFrom: c.periodFrom,
      periodTo: c.periodTo,
      shipments: c.shipments.map((s) => ({ id: s.id, version: s.version })),
      returns: [],
    };
    // 同じ販売先を2回含めると、1件目も発行しない（1つのトランザクション）
    expect(
      await systemCommandResult("invoices.close", { targets: [target, target] }),
    ).toMatchObject({ ok: false, error: { code: "validation" } });
    expect((await systemQuery("invoices.list", { customerId: customer.id })).total).toBe(0);
    await shipOrder(setup, { customerId: customer.id, shippedOn: period.to });
    expect(await systemCommandResult("invoices.close", { targets: [target] })).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    // 締め日の設定と合わない期間、締め日を迎えていない期間
    expect(
      await systemCommandResult("invoices.close", {
        targets: [{ ...target, periodFrom: addDays(c.periodFrom, 1) }],
      }),
    ).toMatchObject({ ok: false, error: { code: "validation" } });
    const next = monthRange(addMonths(monthOf(today()), 1));
    expect(
      await systemCommandResult("invoices.close", {
        targets: [{ ...target, periodFrom: next.from, periodTo: next.to }],
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    const plain = await createCustomer();
    expect(
      await systemCommandResult("invoices.close", {
        targets: [{ ...target, customerId: plain.id }],
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    // 締め処理の画面の候補も、まだ締め日前の期間は ready にならない
    const fresh = await createClosingCustomer();
    await shipOrder(setup, { customerId: fresh.id, shippedOn: today() });
    const pending = (await systemQuery("invoices.closing", { customerId: fresh.id })).candidates[0];
    expect(pending?.ready).toBe(pending?.periodTo === today());
  });
});

describe("請求書の取消と再発行", () => {
  it("取消で発送・返品伝票が未請求に戻り、帳票が取消済みになる。理由は必須", async () => {
    const setup = await billingSetup();
    const shipped = await shipOrder(setup);
    const ret = await recordReturn(shipped.order.id, { restockTo: null });
    const issued = await issuePerShipment(shipped, {
      returns: [{ id: ret.id, version: await returnVersion(ret.id) }],
    });
    const view = await invoiceView(issued.id);
    expect(
      await systemCommandResult("invoices.cancel", {
        id: issued.id,
        version: view.invoice.version,
        reason: " ",
      }),
    ).toMatchObject({ ok: false, error: { code: "validation" } });
    const sales = await createEmployee(["sales"]);
    expect(
      await as(sales, "invoices.cancel", {
        id: issued.id,
        version: view.invoice.version,
        reason: "宛名の誤り",
      }),
    ).toMatchObject({ ok: false, error: { code: "forbidden" } });
    await systemCommand("invoices.cancel", {
      id: issued.id,
      version: view.invoice.version,
      reason: "宛名の誤り",
    });
    const after = await invoiceView(issued.id);
    expect(after.invoice).toMatchObject({ status: "cancelled", cancelReason: "宛名の誤り" });
    expect(after.invoice.shipments).toEqual([]);
    expect(after.actions.cancel).toBe(false);
    expect((await shipmentRow(shipped.shipmentId))?.invoiceId).toBeNull();
    expect((await documentRow(issued.documentId))?.cancelled).toBe(true);
    expect((await systemQuery("salesReturns.get", { id: ret.id }))?.ret.invoiceId).toBeNull();
    expect(
      await systemCommandResult("invoices.cancel", {
        id: issued.id,
        version: after.invoice.version,
        reason: "もう一度",
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    // 未請求に戻った発送は、もう一度発行できる（取り消していれば発送も取り消せる）
    expect((await getOrder(shipped.order.id)).shipments[0]?.invoiceId).toBeNull();
  });

  it("消込のある請求書は取り消せない（消込を取り消せば取り消せる）", async () => {
    const setup = await billingSetup();
    const shipped = await shipOrder(setup);
    const issued = await issuePerShipment(shipped);
    const view = await invoiceView(issued.id);
    const payment = await systemCommand("customerPayments.create", {
      customerId: setup.customer.id,
      receivedOn: today(),
      amount: 1000,
      method: "transfer",
      allocations: [{ invoiceId: issued.id, version: view.invoice.version, amount: 1000 }],
    });
    const partial = await invoiceView(issued.id);
    expect(partial.invoice.status).toBe("partial");
    expect(partial.cancelBlocker).toContain("消込");
    expect(
      await systemCommandResult("invoices.cancel", {
        id: issued.id,
        version: partial.invoice.version,
        reason: "誤り",
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    const allocation = (await systemQuery("customerPayments.get", { id: payment.id }))!
      .allocations[0]!;
    await systemCommand("paymentAllocations.cancel", {
      allocationId: allocation.id,
      version: allocation.version,
    });
    const unpaid = await invoiceView(issued.id);
    expect(unpaid.invoice).toMatchObject({ status: "unpaid", allocated: 0 });
    await systemCommand("invoices.cancel", {
      id: issued.id,
      version: unpaid.invoice.version,
      reason: "誤り",
    });
  });

  it("再発行は同じ発送・返品伝票で新しい番号の請求書を作り、元の請求書を指す", async () => {
    const setup = await billingSetup();
    const period = lastMonth();
    const customer = await createClosingCustomer();
    const shipped = await shipOrder(setup, { customerId: customer.id, shippedOn: period.from });
    const ret = await recordReturn(shipped.order.id, {
      returnedOn: addDays(period.from, 1),
      restockTo: null,
    });
    const c = (await systemQuery("invoices.closing", { customerId: customer.id })).candidates[0]!;
    const closed = await systemCommand("invoices.close", {
      targets: [
        {
          customerId: customer.id,
          periodFrom: c.periodFrom,
          periodTo: c.periodTo,
          shipments: c.shipments.map((s) => ({ id: s.id, version: s.version })),
          returns: c.returns.map((r) => ({ id: r.id, version: r.version })),
        },
      ],
    });
    const old = closed.issued[0]!;
    const before = await invoiceView(old.id);
    const r = await systemCommand("invoices.reissue", {
      id: old.id,
      version: before.invoice.version,
      reason: "住所の変更",
    });
    expect(r.number).not.toBe(old.number);
    const reissued = await invoiceView(r.id);
    expect(reissued.invoice).toMatchObject({
      reissuedFromId: old.id,
      reissuedFromNumber: old.number,
      periodFrom: c.periodFrom,
      periodTo: c.periodTo,
      issuedOn: before.invoice.issuedOn,
      dueOn: before.invoice.dueOn,
      total: before.invoice.total,
      status: "unpaid",
    });
    expect(reissued.invoice.shipments.map((s) => s.id)).toEqual([shipped.shipmentId]);
    expect(reissued.invoice.returns.map((x) => x.id)).toEqual([ret.id]);
    const cancelled = await invoiceView(old.id);
    expect(cancelled.invoice.status).toBe("cancelled");
    expect(cancelled.invoice.reissuedTo).toEqual([{ id: r.id, number: r.number }]);
    const snapshot = invoiceSnapshotSchema.parse(
      JSON.parse((await documentRow(r.documentId))!.snapshotJson),
    );
    expect(snapshot.reissuedFromNumber).toBe(old.number);
    // 発送ごとの請求書の再発行は、支払期限を指定できる
    const plain = await billingSetup();
    const ps = await shipOrder(plain);
    const pi = await issuePerShipment(ps);
    const pv = await invoiceView(pi.id);
    const pr = await systemCommand("invoices.reissue", {
      id: pi.id,
      version: pv.invoice.version,
      reason: "期限の変更",
      dueOn: addDays(today(), 60),
    });
    expect((await invoiceView(pr.id)).invoice.dueOn).toBe(addDays(today(), 60));
  });
});

describe("請求書の一覧", () => {
  it("状態・販売先・発行日・期限超過・番号・送付の失敗で絞り込む", async () => {
    const setup = await billingSetup();
    const a = await shipOrder(setup);
    const b = await shipOrder(setup);
    const first = await issuePerShipment(a, { dueOn: today() });
    const second = await issuePerShipment(b, {
      issuedOn: today(),
      dueOn: today(),
    });
    const list = await systemQuery("invoices.list", { customerId: setup.customer.id });
    expect(list.rows.map((r) => r.id)).toEqual([second.id, first.id]);
    expect(list.rows[0]).toMatchObject({ outstanding: 2027, overdue: false });
    expect(list.rows[0]?.document?.documentId).toBe(second.documentId);
    expect(
      (await systemQuery("invoices.list", { customerId: setup.customer.id, q: first.number })).rows,
    ).toHaveLength(1);
    expect(
      (await systemQuery("invoices.list", { customerId: setup.customer.id, status: "paid" })).total,
    ).toBe(0);
    expect(
      (await systemQuery("invoices.list", { customerId: setup.customer.id, status: "open" })).total,
    ).toBe(2);
    expect(
      (await systemQuery("invoices.list", { customerId: setup.customer.id, overdue: true })).total,
    ).toBe(0);
    expect(
      (
        await systemQuery("invoices.list", {
          customerId: setup.customer.id,
          issuedFrom: addDays(today(), 1),
        })
      ).total,
    ).toBe(0);
    expect(
      (await systemQuery("invoices.list", { customerId: setup.customer.id, sendFailed: true }))
        .total,
    ).toBe(0);
  });
});
