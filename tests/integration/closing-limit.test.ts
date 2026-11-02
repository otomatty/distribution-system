/**
 * 締め処理の件数の上限：締め処理の画面（候補）と締め処理（コマンド）で、同じ件数まで読み、同じ判定をする。
 * 以前は画面が500件まで、コマンドが501件まで読んで比べていたため、500件を超える販売先は
 * いつまでも「画面を開き直してください」になっていた。
 */
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { describe, expect, it } from "vitest";

import { formatYen } from "../../src/domain/money";
import * as schema from "../../src/infra/db/schema";
import { businessDb } from "../../src/infra/do/client";
import { CLOSING_MAX_SHIPMENTS } from "../../src/usecases/billing/invoices";
import {
  billingSetup,
  createClosingCustomer,
  invoiceView,
  lastMonth,
  shipOrder,
} from "./billing-fixtures";
import { as, createEmployee, systemCommand, systemQuery } from "./helpers";
import { systemCommandResult } from "./platform-helpers";

let serial = 0;

/**
 * 発送済みの受注を1件作り、同じ明細の発送済みの受注を count 件、業務 DB に直接足す
 * （ユースケースで1件ずつ作ると時間がかかるため。在庫は動かさない）
 */
async function manyShipments(count: number) {
  const setup = await billingSetup();
  const period = lastMonth();
  const customer = await createClosingCustomer();
  const shipped = await shipOrder(setup, {
    customerId: customer.id,
    shippedOn: period.from,
    lines: [{ itemId: setup.a.id, quantity: 1, unitPriceCenti: 15_050 }],
    charges: [],
  });
  serial += 1;
  const tag = `${Date.now().toString(36)}${serial}`;
  await runInDurableObject(businessDb(env), (_instance, state) => {
    const db = drizzle(state.storage, { schema });
    const at = new Date().toISOString();
    const audit = { createdAt: at, createdBy: "system", updatedAt: at, updatedBy: "system" };
    db.transaction((tx) => {
      for (let i = 0; i < count; i += 1) {
        const orderId = `bulk-so-${tag}-${i}`;
        tx.insert(schema.salesOrders)
          .values({
            id: orderId,
            number: `SO-BULK-${tag}-${i}`,
            customerId: customer.id,
            status: "shipped",
            orderedOn: period.from,
            locationId: setup.locationId,
            shipPlannedOn: period.from,
            ...audit,
          })
          .run();
        tx.insert(schema.salesOrderLines)
          .values({
            id: `bulk-sol-${tag}-${i}`,
            salesOrderId: orderId,
            lineNo: 1,
            itemId: setup.a.id,
            quantity: 1,
            unitPriceCenti: 15_050,
            taxCategory: "reduced",
          })
          .run();
        tx.insert(schema.shipments)
          .values({
            id: `bulk-sh-${tag}-${i}`,
            salesOrderId: orderId,
            deliveryNoteNumber: `DN-BULK-${tag}-${String(i).padStart(5, "0")}`,
            shippedOn: period.to,
            ...audit,
          })
          .run();
      }
    });
  });
  return { customer, period, first: shipped };
}

async function candidateOf(customerId: string) {
  const { candidates } = await systemQuery("invoices.closing", { customerId });
  const c = candidates[0];
  if (!c) throw new Error("no candidate");
  return c;
}

function targetOf(c: Awaited<ReturnType<typeof candidateOf>>) {
  return {
    customerId: c.customerId,
    periodFrom: c.periodFrom,
    periodTo: c.periodTo,
    shipments: c.shipments.map((s) => ({ id: s.id, version: s.version })),
    returns: c.returns.map((r) => ({ id: r.id, version: r.version })),
  };
}

describe("締め処理の件数の上限", () => {
  it("500件を超える発送も、画面とコマンドで同じ件数を読んで締め処理できる", async () => {
    // 1件（ユースケース）+ 500件（直接）= 501件。以前の上限（500件）を1件超える
    const { customer, period } = await manyShipments(500);
    const c = await candidateOf(customer.id);
    expect(c.shipments).toHaveLength(501);
    expect(c.error).toBeNull();
    expect(c.issuable).toBe(true);
    const r = await systemCommand("invoices.close", { targets: [targetOf(c)] });
    const view = await invoiceView(r.issued[0]?.id ?? "");
    expect(view.invoice.shipments).toHaveLength(501);
    expect(view.invoice.periodTo).toBe(period.to);
    // 150.50円（明細ごとに切り捨てて150円）× 501件 = 75,150円、軽減税率 8% → 6,012円
    expect(view.invoice.total).toBe(81_162);
  });

  it(`上限（${CLOSING_MAX_SHIPMENTS}件）を超えると、画面は理由を出して選べなくし、コマンドも理由を返す`, async () => {
    const { customer } = await manyShipments(CLOSING_MAX_SHIPMENTS);
    const c = await candidateOf(customer.id);
    const limit = formatYen(CLOSING_MAX_SHIPMENTS);
    expect(c.error).toContain(`未請求の発送が ${limit} 件を超えている`);
    expect(c.issuable).toBe(false);
    expect(c.summary).toBeNull();
    const user = await createEmployee(["accounting"]);
    const page = await (await as(user).get(`/invoices/closing?customerId=${customer.id}`)).text();
    expect(page).toContain(`未請求の発送が ${limit} 件を超えている`);
    expect(page).toMatch(new RegExp(`value="${c.customerId}"[^>]*disabled`));
    // 上限までの発送を選んでも、コマンドは「開き直す」ではなく上限の理由を返す
    const target = {
      ...targetOf(c),
      shipments: targetOf(c).shipments.slice(0, CLOSING_MAX_SHIPMENTS),
    };
    const r = await systemCommandResult("invoices.close", { targets: [target] });
    expect(r).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(r.ok ? "" : r.error.message).toContain(`未請求の発送が ${limit} 件を超えている`);
  });
});
