/**
 * 開発用のテストデータの投入（要件定義書 9章、scripts/seed.mjs）。
 * - 本番・検証環境では使えない（/dev/seed は 404、業務 DB の seed も拒否する）
 * - 投入したデータは在庫・引当・状態・採番が整合し、同じ基準日なら毎回同じデータになる
 */
import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { Result } from "../../src/domain/result";
import * as schema from "../../src/infra/db/schema";
import { BusinessDb, SEED_FORBIDDEN_MESSAGE } from "../../src/infra/do/business-db";
import { businessDb } from "../../src/infra/do/client";
import type { SeedPlanResult, SeedRunResult, SeedVerifyResult } from "../../src/infra/seed/request";
import { createApp } from "../../src/web/app";
import { createSupplier } from "./fixtures";
import { ORIGIN } from "./helpers";
import { readDb } from "./platform-helpers";

const TODAY = "2026-11-02";

async function seedCall(body: unknown, target: Env = env): Promise<Response> {
  const request = new Request(`${ORIGIN}/dev/seed`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify(body),
  });
  if (target === env) return exports.default.fetch(request);
  return createApp().fetch(request, target, createExecutionContext());
}

async function seedValue<T>(body: unknown): Promise<T> {
  const res = await seedCall(body);
  const json = (await res.json()) as Result<T>;
  if (!json.ok) throw new Error(`${JSON.stringify(body)}: ${json.error.message}`);
  return json.value;
}

/** scripts/seed.mjs と同じ順に、tiny の手順をすべて実行する */
async function seedTiny(): Promise<{
  plan: SeedPlanResult;
  commands: number;
  rejected: number;
  rejections: string[];
}> {
  await seedValue({ action: "reset" });
  const plan = await seedValue<SeedPlanResult>({ action: "plan", scale: "tiny", today: TODAY });
  let commands = 0;
  let rejected = 0;
  const rejections: string[] = [];
  for (const step of plan.steps) {
    for (let chunk = 0; chunk < step.chunks; chunk += 1) {
      const r = await seedValue<SeedRunResult>({
        action: "run",
        scale: "tiny",
        today: TODAY,
        step: step.name,
        chunk,
      });
      commands += r.commands;
      rejected += r.rejected;
      rejections.push(...r.rejections);
    }
  }
  return { plan, commands, rejected, rejections };
}

/** 投入したデータの要約（2回の投入で同じになるか比べる） */
function fingerprint() {
  return readDb((db) => ({
    purchaseOrders: db
      .select({
        number: schema.purchaseOrders.number,
        status: schema.purchaseOrders.status,
        total: schema.purchaseOrders.total,
        orderedOn: schema.purchaseOrders.orderedOn,
      })
      .from(schema.purchaseOrders)
      .orderBy(schema.purchaseOrders.number)
      .all(),
    salesOrders: db
      .select({
        number: schema.salesOrders.number,
        status: schema.salesOrders.status,
        shipPlannedOn: schema.salesOrders.shipPlannedOn,
        customer: schema.partners.name,
      })
      .from(schema.salesOrders)
      .innerJoin(schema.partners, eq(schema.partners.id, schema.salesOrders.customerId))
      .orderBy(schema.salesOrders.number)
      .all(),
    ledger: db
      .select({
        businessDate: schema.stockLedger.businessDate,
        quantity: schema.stockLedger.quantity,
        reason: schema.stockLedger.reason,
      })
      .from(schema.stockLedger)
      .orderBy(schema.stockLedger.id)
      .all(),
    customerInvoices: db
      .select({
        number: schema.invoices.number,
        total: schema.invoices.total,
        allocated: schema.invoices.allocated,
        status: schema.invoices.status,
      })
      .from(schema.invoices)
      .orderBy(schema.invoices.number)
      .all(),
    invoices: db
      .select({
        number: schema.supplierInvoices.invoiceNumber,
        amount: schema.supplierInvoices.invoicedAmount,
        status: schema.supplierInvoices.status,
      })
      .from(schema.supplierInvoices)
      .orderBy(schema.supplierInvoices.invoiceNumber)
      .all(),
  }));
}

describe("テストデータの投入：本番では使えない", () => {
  it.each(["production", "staging"])("ENVIRONMENT が %s なら /dev/seed は 404", async (name) => {
    const res = await seedCall({ action: "verify" }, { ...env, ENVIRONMENT: name });
    expect(res.status).toBe(404);
  });

  it("ENVIRONMENT が production なら、業務 DB の seed も拒否する（データは消えない）", async () => {
    const result = await runInDurableObject(businessDb(env), async (_instance, state) => {
      const production = new BusinessDb(state, { ...env, ENVIRONMENT: "production" });
      return Promise.all([
        production.seed({ action: "reset" }),
        production.seed({ action: "plan", scale: "tiny" }),
      ]);
    });
    for (const r of result) {
      expect(r).toEqual({
        ok: false,
        error: { code: "forbidden", message: SEED_FORBIDDEN_MESSAGE },
      });
    }
    const employees = await readDb((db) => db.select().from(schema.employees).all());
    expect(employees.length).toBeGreaterThan(0);
  });

  it("依頼の内容が正しくなければ 400", async () => {
    expect((await seedCall({ action: "run", step: "x" })).status).toBe(400);
    expect((await seedCall("not json")).status).toBe(400);
    const unknown = await seedCall({ action: "run", scale: "tiny", step: "nothing", chunk: 0 });
    expect(unknown.status).toBe(400);
    const tooFar = await seedCall({
      action: "run",
      scale: "tiny",
      today: TODAY,
      step: "settings",
      chunk: 5,
    });
    expect(tooFar.status).toBe(400);
  });
});

describe("テストデータの投入：業務データがあるとき", () => {
  it("画面などで登録した業務データがあれば投入しない", async () => {
    await seedValue({ action: "reset" });
    const res = await exports.default.fetch(
      new Request(`${ORIGIN}/dev/seed`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({
          action: "run",
          scale: "tiny",
          today: TODAY,
          step: "settings",
          chunk: 0,
        }),
      }),
    );
    expect(res.status).toBe(200);
    await seedValue({ action: "reset" });
    await createSupplier();
    const conflict = await seedCall({
      action: "run",
      scale: "tiny",
      today: TODAY,
      step: "settings",
      chunk: 0,
    });
    expect(conflict.status).toBe(400);
    expect(await conflict.text()).toContain("業務データがすでにあります");
  });
});

describe("テストデータの投入（tiny）", () => {
  it("本物のユースケースで投入し、在庫・引当・状態・採番が整合する。同じ基準日なら毎回同じデータになる", async () => {
    const first = await seedTiny();
    const { plan } = first;
    expect(first.rejections).toEqual([]);
    expect(first.rejected).toBe(0);
    expect(first.commands).toBeGreaterThan(300);

    const verify = await seedValue<SeedVerifyResult>({ action: "verify" });
    expect(verify.checks.filter((c) => !c.ok)).toEqual([]);
    expect(verify.ok).toBe(true);

    // 業務の流れの各状態がそろっている
    const shape = await readDb((db) => ({
      poStatuses: new Set(
        db
          .select()
          .from(schema.purchaseOrders)
          .all()
          .map((p) => p.status),
      ),
      soStatuses: new Set(
        db
          .select()
          .from(schema.salesOrders)
          .all()
          .map((s) => s.status),
      ),
      makerDirect: db
        .select()
        .from(schema.salesOrders)
        .all()
        .filter((s) => s.makerDirect).length,
      kinds: new Set(
        db
          .select()
          .from(schema.stockOperations)
          .all()
          .map((o) => o.kind),
      ),
      reasons: new Set(
        db
          .select()
          .from(schema.stockLedger)
          .all()
          .map((l) => l.reason),
      ),
      taxCategories: new Set(
        db
          .select()
          .from(schema.items)
          .all()
          .map((i) => i.taxCategory),
      ),
      monthlyCustomers: db
        .select()
        .from(schema.partners)
        .all()
        .filter((p) => p.isCustomer && p.closingDay !== null).length,
      invoiceStatuses: new Set(
        db
          .select()
          .from(schema.supplierInvoices)
          .all()
          .map((i) => i.status),
      ),
      roles: new Set(
        db
          .select()
          .from(schema.employees)
          .all()
          .flatMap((e) => e.roles),
      ),
      // PDF は最近の分だけ（tiny は作らない）。索引はすべての発送・確定した発注にある
      rendered: db
        .select()
        .from(schema.documents)
        .all()
        .filter((d) => d.status !== "pending").length,
      documents: db.select().from(schema.documents).all().length,
      shipments: db.select().from(schema.shipments).all().length,
      customerInvoiceStatuses: new Set(
        db
          .select()
          .from(schema.invoices)
          .all()
          .map((i) => i.status),
      ),
      closingInvoices: db
        .select()
        .from(schema.invoices)
        .all()
        .filter((i) => i.periodTo !== null).length,
      returns: db.select().from(schema.salesReturns).all(),
      returnLines: db.select().from(schema.salesReturnLines).all(),
      creditNotes: db
        .select()
        .from(schema.salesReturns)
        .all()
        .filter((r) => r.creditNoteNumber !== null).length,
      payments: db.select().from(schema.customerPayments).all().length,
      disposals: db.select().from(schema.disposals).all().length,
    }));
    expect([...shape.poStatuses].toSorted()).toEqual(
      ["cancelled", "draft", "ordered", "paid", "received"].toSorted(),
    );
    expect([...shape.soStatuses].toSorted()).toEqual(["cancelled", "received", "shipped"]);
    expect(shape.makerDirect).toBeGreaterThan(0);
    expect(shape.kinds).toEqual(new Set(["adjustment", "transfer", "store_transfer", "stocktake"]));
    expect(shape.reasons.has("receipt")).toBe(true);
    expect(shape.reasons.has("shipment")).toBe(true);
    expect([...shape.taxCategories].toSorted()).toEqual(["reduced", "standard"]);
    expect(shape.monthlyCustomers).toBeGreaterThan(0);
    expect(shape.invoiceStatuses.has("paid")).toBe(true);
    expect(shape.invoiceStatuses.has("unpaid")).toBe(true);
    expect([...shape.roles].toSorted()).toEqual(["accounting", "admin", "purchasing", "sales"]);
    expect(shape.rendered).toBe(0);
    expect(shape.documents).toBeGreaterThan(shape.shipments);
    // 請求：発送ごとと締め処理の請求書、入金済み・一部入金・未入金、返品伝票（在庫に戻す・廃棄）と返還請求書、販売先廃棄
    expect([...shape.customerInvoiceStatuses].toSorted((a, b) => a.localeCompare(b))).toEqual([
      "paid",
      "partial",
      "unpaid",
    ]);
    expect(shape.closingInvoices).toBeGreaterThan(0);
    expect(shape.returns.length).toBeGreaterThan(0);
    expect(new Set(shape.returnLines.map((l) => l.restock)).size).toBe(2);
    expect(shape.returns.some((r) => r.invoiceId !== null)).toBe(true);
    expect(shape.creditNotes).toBeGreaterThan(0);
    expect(shape.payments).toBeGreaterThan(0);
    expect(shape.disposals).toBeGreaterThan(0);

    // 済んだ回をやり直しても（応答が届かなかったときなど）、前回の結果を返すだけで二重に投入しない
    const before = await fingerprint();
    const operations = plan.steps.find((s) => s.name === "operations");
    const again = await seedValue<SeedRunResult>({
      action: "run",
      scale: "tiny",
      today: TODAY,
      step: "operations",
      chunk: (operations?.chunks ?? 1) - 1,
    });
    expect(again.commands).toBeGreaterThan(0);
    expect(await fingerprint()).toEqual(before);

    const second = await seedTiny();
    expect(second.commands).toBe(first.commands);
    expect(await fingerprint()).toEqual(before);
  }, 60_000);
});
