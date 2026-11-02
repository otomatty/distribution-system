/**
 * 返品伝票と返還請求書（要件定義書 3.11）のユースケース。
 * 在庫に戻す返品の在庫への影響、返品できる数、取消（打ち消しの行）、発送の取消との関係、返還請求書の発行。
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
  invoiceView,
  issuePerShipment,
  recordReturn,
  returnVersion,
  shipOrder,
} from "./billing-fixtures";
import { createEmployee, newKey, systemCommand, systemQuery } from "./helpers";
import { documentRow, systemCommandResult } from "./platform-helpers";
import { createOrder, getOrder, level, today } from "./sales-fixtures";

async function as<N extends CommandName>(
  email: string,
  name: N,
  input: CommandInput<N>,
  key: string = crypto.randomUUID(),
): Promise<Result<unknown>> {
  return businessDb(env).command(name, input, { kind: "dev", email }, key);
}

async function returnsOf(orderId: string) {
  const r = await systemQuery("salesReturns.forOrder", { salesOrderId: orderId });
  if (!r) throw new Error("order not found");
  return r;
}

describe("返品伝票", () => {
  it("在庫に戻す明細は保管場所の在庫を増やし、廃棄の明細は在庫を動かさない。返品額は受注の単価から", async () => {
    const setup = await billingSetup();
    const shipped = await shipOrder(setup);
    const before = {
      a: await level(setup.a.id, setup.locationId),
      b: await level(setup.b.id, setup.locationId),
    };
    const order = await getOrder(shipped.order.id);
    const [lineA, lineB] = order.order.lines;
    const sales = await createEmployee(["sales"]);
    const input = {
      salesOrderId: shipped.order.id,
      returnedOn: today(),
      memo: "外箱つぶれ",
      lines: [
        { salesOrderLineId: lineA!.id, quantity: 2, restock: true, locationId: setup.locationId },
        { salesOrderLineId: lineB!.id, quantity: 1, restock: false, locationId: setup.locationId },
      ],
    };
    const accounting = await createEmployee(["accounting"]);
    expect(await as(accounting, "salesReturns.create", input)).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    const key = newKey();
    const first = await as(sales, "salesReturns.create", input, key);
    expect(await as(sales, "salesReturns.create", input, key)).toEqual(first);
    expect(first.ok).toBe(true);

    expect((await level(setup.a.id, setup.locationId)).onHand).toBe(before.a.onHand + 2);
    expect((await level(setup.b.id, setup.locationId)).onHand).toBe(before.b.onHand);
    const ledger = await systemQuery("stock.ledger", {
      itemId: setup.a.id,
      locationId: setup.locationId,
      reason: "sales_return",
    });
    expect(ledger.rows.rows.map((r) => r.quantity)).toEqual([2]);

    const view = await returnsOf(shipped.order.id);
    expect(view.returns).toHaveLength(1);
    const ret = view.returns[0]!;
    expect(ret.number).toMatch(/^RT-\d{4}-\d{6}$/);
    expect(ret.memo).toBe("外箱つぶれ");
    expect(ret.lines.map((l) => [l.quantity, l.amount, l.restock, l.locationId])).toEqual([
      [2, 301, true, setup.locationId],
      [1, 100, false, null],
    ]);
    expect(ret.subtotal).toBe(401);
    expect(ret.cancellable).toBe(true);
    expect(view.lines.map((l) => [l.shipped, l.returned, l.remaining])).toEqual([
      [3, 2, 1],
      [6, 1, 5],
    ]);
    expect(view.canRecord).toBe(true);
  });

  it("返品できる数（発送した数 − 返品済み）を超えられない。発送前・発送日より前・今日より後は記録しない", async () => {
    const setup = await billingSetup();
    const shipped = await shipOrder(setup, { shippedOn: addDays(today(), -2) });
    await recordReturn(shipped.order.id, { quantity: 2, restockTo: null });
    const line = (await getOrder(shipped.order.id)).order.lines[0]!;
    const one = (quantity: number, returnedOn = today()) =>
      systemCommandResult("salesReturns.create", {
        salesOrderId: shipped.order.id,
        returnedOn,
        lines: [{ salesOrderLineId: line.id, quantity, restock: false, locationId: null }],
      });
    expect(await one(2)).toMatchObject({
      ok: false,
      error: {
        fields: [{ field: "lines.0.quantity", message: "返品できる数（残り1）を超えています" }],
      },
    });
    expect(await one(1, addDays(today(), -3))).toMatchObject({
      ok: false,
      error: { fields: [{ field: "returnedOn" }] },
    });
    expect(await one(1, addDays(today(), 1))).toMatchObject({
      ok: false,
      error: { fields: [{ field: "returnedOn" }] },
    });
    expect(
      await systemCommandResult("salesReturns.create", {
        salesOrderId: shipped.order.id,
        returnedOn: today(),
        lines: [{ salesOrderLineId: line.id, quantity: 1, restock: true, locationId: null }],
      }),
    ).toMatchObject({ ok: false, error: { fields: [{ field: "lines.0.locationId" }] } });
    expect((await one(1)).ok).toBe(true);
    expect((await returnsOf(shipped.order.id)).lines[0]?.remaining).toBe(0);

    const open = await createOrder({
      customerId: setup.customer.id,
      locationId: setup.locationId,
      lines: [{ itemId: setup.a.id, quantity: 1, unitPriceCenti: 15_050 }],
    });
    const openLine = (await getOrder(open.id)).order.lines[0]!;
    expect(
      await systemCommandResult("salesReturns.create", {
        salesOrderId: open.id,
        returnedOn: today(),
        lines: [{ salesOrderLineId: openLine.id, quantity: 1, restock: false, locationId: null }],
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    expect((await returnsOf(open.id)).canRecord).toBe(false);
  });

  it("取消で在庫を打ち消しの行で戻す。返品伝票があるうちは発送を取り消せない", async () => {
    const setup = await billingSetup();
    const shipped = await shipOrder(setup);
    const ret = await recordReturn(shipped.order.id, { quantity: 2, restockTo: setup.locationId });
    const onHand = (await level(setup.a.id, setup.locationId)).onHand;
    const shipmentVersion = (await getOrder(shipped.order.id)).shipments[0]!.version;
    expect(
      await systemCommandResult("shipments.cancel", {
        shipmentId: shipped.shipmentId,
        version: shipmentVersion,
        reason: "誤り",
      }),
    ).toMatchObject({ ok: false, error: { message: expect.stringContaining("返品伝票") } });

    const version = await returnVersion(ret.id);
    expect(
      await systemCommandResult("salesReturns.cancel", {
        id: ret.id,
        version: version + 1,
        reason: "誤り",
      }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    await systemCommand("salesReturns.cancel", { id: ret.id, version, reason: "数え間違い" });
    expect((await level(setup.a.id, setup.locationId)).onHand).toBe(onHand - 2);
    const view = await systemQuery("salesReturns.get", { id: ret.id });
    expect(view?.ret.cancelled).toBe(true);
    expect(view?.cancelBlocker).toBeNull();
    expect(
      await systemCommandResult("salesReturns.cancel", {
        id: ret.id,
        version: view!.ret.version,
        reason: "もう一度",
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    // 取り消した返品伝票は返品済みの数に数えない
    expect((await returnsOf(shipped.order.id)).lines[0]?.returned).toBe(0);
    await systemCommand("shipments.cancel", {
      shipmentId: shipped.shipmentId,
      version: shipmentVersion,
      reason: "誤り",
    });
  });

  it("請求書に載せた返品伝票は取り消せない", async () => {
    const setup = await billingSetup();
    const shipped = await shipOrder(setup);
    const ret = await recordReturn(shipped.order.id, { restockTo: null });
    await issuePerShipment(shipped, {
      returns: [{ id: ret.id, version: await returnVersion(ret.id) }],
    });
    const view = await systemQuery("salesReturns.get", { id: ret.id });
    expect(view?.ret.cancellable).toBe(false);
    expect(view?.cancelBlocker).toContain("請求書");
    expect(
      await systemCommandResult("salesReturns.cancel", {
        id: ret.id,
        version: view!.ret.version,
        reason: "誤り",
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_state" } });
  });
});

describe("返還請求書", () => {
  it("請求書に載せた返品伝票について、経理が発行できる（税込1万円未満は任意）", async () => {
    const setup = await billingSetup();
    const shipped = await shipOrder(setup);
    const ret = await recordReturn(shipped.order.id, { quantity: 2, restockTo: null });
    // 未請求の返品伝票は、請求書で差し引けない返品として発行する（billing-credit-notes.test.ts）。
    // 請求済みの返品の発行（帳票だけ）はできない
    const notYet = await systemQuery("salesReturns.get", { id: ret.id });
    expect(notYet?.creditNote).toMatchObject({ kind: "unbilled", obligation: "optional" });
    expect(
      await systemCommandResult("creditNotes.issue", {
        salesReturnId: ret.id,
        version: notYet!.ret.version,
        issuedOn: today(),
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_state", message: expect.stringContaining("未請求の返品伝票です") },
    });

    const invoice = await issuePerShipment(shipped, {
      returns: [{ id: ret.id, version: await returnVersion(ret.id) }],
    });
    const view = await systemQuery("salesReturns.get", { id: ret.id });
    expect(view?.creditNote).toMatchObject({
      kind: "billed",
      issuable: true,
      blocker: null,
      obligation: "optional",
    });
    expect(view?.credit).toBeNull();
    expect(view?.creditNote.preview).toMatchObject({ subtotal: 301, tax: 24, total: 325 });
    const input = { salesReturnId: ret.id, version: view!.ret.version, issuedOn: today() };
    const sales = await createEmployee(["sales"]);
    expect(await as(sales, "creditNotes.issue", input)).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    const accounting = await createEmployee(["accounting"]);
    const key = newKey();
    const first = await as(accounting, "creditNotes.issue", input, key);
    expect(await as(accounting, "creditNotes.issue", input, key)).toEqual(first);
    const issued = (first.ok ? first.value : null) as { number: string; documentId: string };
    expect(issued.number).toMatch(/^CN-\d{4}-\d{6}$/);
    const doc = await documentRow(issued.documentId);
    expect(doc).toMatchObject({
      documentType: "credit_note",
      entityId: ret.id,
      partnerId: setup.customer.id,
      amount: 325,
    });
    const snapshot = creditNoteSnapshotSchema.parse(JSON.parse(doc!.snapshotJson));
    expect(snapshot).toMatchObject({
      returnedOn: today(),
      originalTransactionDate: today(),
      invoiceNumber: invoice.number,
      taxGroups: [{ category: "reduced", rateBps: 800, subtotal: 301, tax: 24 }],
    });
    expect(snapshot.lines[0]).toMatchObject({ quantity: 2, amount: 301, reduced: true });

    const after = await systemQuery("salesReturns.get", { id: ret.id });
    expect(after?.ret.creditNoteNumber).toBe(issued.number);
    expect(after?.creditNote.documentId).toBe(issued.documentId);
    expect(after?.creditNote.issuable).toBe(false);
    expect(
      await systemCommandResult("creditNotes.issue", { ...input, version: after!.ret.version }),
    ).toMatchObject({ ok: false, error: { code: "invalid_state" } });

    // 請求書を取り消すと返品伝票は未請求に戻る（返還請求書を発行していても次の請求書に載せる）
    const inv = await invoiceView(invoice.id);
    await systemCommand("invoices.cancel", {
      id: invoice.id,
      version: inv.invoice.version,
      reason: "誤り",
    });
    const back = await systemQuery("salesReturns.get", { id: ret.id });
    expect(back?.ret.invoiceId).toBeNull();
    expect(back?.cancelBlocker).toContain("返還請求書");
    const draft = await systemQuery("invoices.draft", { shipmentId: shipped.shipmentId });
    expect(draft?.returns.map((r) => r.id)).toEqual([ret.id]);
  });

  it("税込1万円以上の返品は交付が必要と示し、発行日は返品日より前にできない", async () => {
    const setup = await billingSetup();
    const shipped = await shipOrder(setup, {
      lines: [
        {
          itemId: setup.b.id,
          quantity: 40,
          unitPriceCenti: 30_000,
          priceOverrideReason: "特注品",
        },
      ],
      charges: [],
    });
    const ret = await recordReturn(shipped.order.id, { quantity: 40, restockTo: setup.locationId });
    await issuePerShipment(
      { shipmentId: shipped.shipmentId, shipmentVersion: shipped.shipmentVersion },
      { returns: [] },
    );
    // 請求書に載せなかった返品は、請求書で差し引けない返品として発行できる
    const r = await systemQuery("salesReturns.get", { id: ret.id });
    expect(r?.creditNote).toMatchObject({ kind: "unbilled", issuable: true });
    expect(r?.creditNote.obligation).toBe("required");
    expect(
      await systemCommandResult("creditNotes.issueUnbilled", {
        salesReturnId: ret.id,
        version: r!.ret.version,
        issuedOn: addDays(today(), -1),
      }),
    ).toMatchObject({
      ok: false,
      error: {
        fields: [{ field: "issuedOn", message: `発行日は返品日（${today()}）以降にしてください` }],
      },
    });
  });
});
