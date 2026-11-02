/**
 * 在庫の記録（usecases/stock/ledger.ts）の不変条件を、業務 DB の Durable Object の中で確かめる（AGENTS.md 5章）。
 * - 台帳の合計 = 集計表の現在庫（商品×保管場所ごと）
 * - 出荷可能数 = 現在庫 − 引当数、現在庫と引当数は 0 以上
 * 記録・打ち消し・引当の増減をランダムな順で行い、失敗した操作は何も残さないこと（トランザクションの取り消し）も確かめる。
 */
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import fc from "fast-check";
import { monotonicFactory } from "ulid";
import { describe, expect, it } from "vitest";

import type { Result } from "../../src/domain/result";
import { ROLES } from "../../src/domain/roles";
import { balanceKey, parseShortages, type StockReason } from "../../src/domain/stock";
import type { Db } from "../../src/infra/db/client";
import * as schema from "../../src/infra/db/schema";
import { createStores } from "../../src/infra/db/stores";
import type { BusinessDb } from "../../src/infra/do/business-db";
import {
  changeAllocation,
  postStock,
  reverseStock,
  stockLevel,
  stockLevels,
  type StockWriteContext,
} from "../../src/usecases/stock/ledger";

class Rollback extends Error {}

const ulid = monotonicFactory();

function contextFor(db: Db, today = "2026-11-02"): StockWriteContext {
  const now = new Date(`${today}T03:00:00Z`);
  return {
    actor: { employeeId: "system", name: "システム", email: "system", roles: [...ROLES] },
    clock: { now: () => now, today: () => today },
    ids: { next: () => ulid() },
    stores: createStores(db),
  };
}

/** ユースケースと同じく、失敗したらトランザクションを取り消す */
function inTransaction<T>(db: Db, fn: (ctx: StockWriteContext) => Result<T>): Result<T> {
  try {
    return db.transaction((tx) => {
      const r = fn(contextFor(tx));
      if (!r.ok) throw new Rollback(JSON.stringify(r));
      return r;
    });
  } catch (e) {
    if (e instanceof Rollback) {
      const parsed: Result<T> = JSON.parse(e.message);
      return parsed;
    }
    throw e;
  }
}

/** 操作の結果（実際）と、モデルから求めた結果（期待） */
type Outcome = { actual: unknown; expected: unknown };

/** 結果の比較用の要約。失敗なら、不足の内容（details）が読めることも含める */
function summary(r: Result<unknown>, count: number) {
  return r.ok
    ? { ok: true, code: null, count }
    : { ok: false, code: r.error.code, count: parseShortages(r.error.details).length > 0 };
}

function stub() {
  return env.BUSINESS_DB.get(env.BUSINESS_DB.idFromName("stock-ledger-test"));
}

async function withDb<T>(fn: (db: Db) => T): Promise<T> {
  return runInDurableObject(stub(), (_instance: BusinessDb, state) =>
    fn(drizzle(state.storage, { schema })),
  );
}

function ledgerSums(db: Db, itemIds: readonly string[]) {
  const rows = db
    .select({
      itemId: schema.stockLedger.itemId,
      locationId: schema.stockLedger.locationId,
      sum: sql<number>`sum(${schema.stockLedger.quantity})`,
    })
    .from(schema.stockLedger)
    .where(
      sql`${schema.stockLedger.itemId} IN (SELECT value FROM json_each(${JSON.stringify(itemIds)}))`,
    )
    .groupBy(schema.stockLedger.itemId, schema.stockLedger.locationId)
    .all();
  return new Map(rows.map((r) => [balanceKey(r.itemId, r.locationId), r.sum]));
}

function balances(db: Db, itemIds: readonly string[]) {
  const rows = db
    .select()
    .from(schema.stockBalances)
    .where(
      sql`${schema.stockBalances.itemId} IN (SELECT value FROM json_each(${JSON.stringify(itemIds)}))`,
    )
    .all();
  return new Map(rows.map((r) => [balanceKey(r.itemId, r.locationId), r]));
}

describe("在庫の記録", () => {
  it("記録・打ち消し・引当を組み合わせても、台帳の合計と集計表が一致する（性質）", async () => {
    let run = 0;
    const step = fc.oneof(
      fc.record({
        kind: fc.constant("post" as const),
        source: fc.integer({ min: 0, max: 4 }),
        postings: fc.array(
          fc.record({
            item: fc.integer({ min: 0, max: 2 }),
            location: fc.integer({ min: 0, max: 1 }),
            quantity: fc.integer({ min: -6, max: 10 }),
          }),
          { minLength: 1, maxLength: 4 },
        ),
      }),
      fc.record({ kind: fc.constant("reverse" as const), source: fc.integer({ min: 0, max: 4 }) }),
      fc.record({
        kind: fc.constant("allocate" as const),
        changes: fc.array(
          fc.record({
            item: fc.integer({ min: 0, max: 2 }),
            location: fc.integer({ min: 0, max: 1 }),
            quantity: fc.integer({ min: -5, max: 5 }),
          }),
          { minLength: 1, maxLength: 3 },
        ),
      }),
    );

    await withDb((db) => {
      fc.assert(
        fc.property(fc.array(step, { minLength: 1, maxLength: 30 }), (steps) => {
          run += 1;
          const itemIds = [0, 1, 2].map((i) => `prop-${run}-item-${i}`);
          const locationIds = [0, 1].map((l) => `prop-${run}-loc-${l}`);
          const sourceId = (s: number) => `prop-${run}-src-${s}`;
          const key = (i: number, l: number) => balanceKey(itemIds[i] ?? "", locationIds[l] ?? "");
          // 期待値のモデル
          const onHand = new Map<string, number>();
          const allocated = new Map<string, number>();
          const open = new Map<number, { key: string; quantity: number }[]>();

          function post(s: Extract<(typeof steps)[number], { kind: "post" }>): Outcome {
            const net = new Map<string, number>();
            for (const p of s.postings) {
              const k = key(p.item, p.location);
              net.set(k, (net.get(k) ?? 0) + p.quantity);
            }
            const shortage = [...net].some(([k, q]) => (onHand.get(k) ?? 0) + q < 0);
            const nonZero = s.postings.filter((p) => p.quantity !== 0);
            const r = inTransaction(db, (ctx) =>
              postStock(
                ctx,
                { sourceType: "receipt", sourceId: sourceId(s.source), businessDate: "2026-11-02" },
                s.postings.map((p) => ({
                  itemId: itemIds[p.item] ?? "",
                  locationId: locationIds[p.location] ?? "",
                  quantity: p.quantity,
                  reason: "receipt" satisfies StockReason,
                })),
              ),
            );
            if (r.ok) {
              for (const [k, q] of net) onHand.set(k, (onHand.get(k) ?? 0) + q);
              const rows = open.get(s.source) ?? [];
              for (const p of nonZero)
                rows.push({ key: key(p.item, p.location), quantity: p.quantity });
              open.set(s.source, rows);
            }
            return {
              actual: summary(r, r.ok ? r.value.entryIds.length : 0),
              expected: shortage
                ? { ok: false, code: "insufficient_stock", count: true }
                : { ok: true, code: null, count: nonZero.length },
            };
          }

          function reverse(s: Extract<(typeof steps)[number], { kind: "reverse" }>): Outcome {
            const rows = open.get(s.source) ?? [];
            const net = new Map<string, number>();
            for (const row of rows) net.set(row.key, (net.get(row.key) ?? 0) - row.quantity);
            const shortage = [...net].some(([k, q]) => (onHand.get(k) ?? 0) + q < 0);
            const r = inTransaction(db, (ctx) =>
              reverseStock(ctx, {
                sourceType: "receipt",
                sourceId: sourceId(s.source),
                businessDate: "2026-11-03",
              }),
            );
            if (r.ok) {
              for (const [k, q] of net) onHand.set(k, (onHand.get(k) ?? 0) + q);
              open.set(s.source, []);
            }
            return {
              actual: summary(r, r.ok ? r.value.entryIds.length : 0),
              expected: shortage
                ? { ok: false, code: "insufficient_stock", count: true }
                : { ok: true, code: null, count: rows.length },
            };
          }

          function allocate(s: Extract<(typeof steps)[number], { kind: "allocate" }>): Outcome {
            const net = new Map<string, number>();
            for (const c of s.changes) {
              const k = key(c.item, c.location);
              net.set(k, (net.get(k) ?? 0) + c.quantity);
            }
            const negative = [...net].some(([k, q]) => (allocated.get(k) ?? 0) + q < 0);
            const r = inTransaction(db, (ctx) =>
              changeAllocation(
                ctx,
                s.changes.map((c) => ({
                  itemId: itemIds[c.item] ?? "",
                  locationId: locationIds[c.location] ?? "",
                  quantity: c.quantity,
                })),
              ),
            );
            if (r.ok) for (const [k, q] of net) allocated.set(k, (allocated.get(k) ?? 0) + q);
            return {
              actual: summary(r, 0),
              expected: negative
                ? { ok: false, code: "invalid_state", count: true }
                : { ok: true, code: null, count: 0 },
            };
          }

          for (const s of steps) {
            const outcome =
              s.kind === "post" ? post(s) : s.kind === "reverse" ? reverse(s) : allocate(s);
            expect(outcome.actual).toEqual(outcome.expected);

            // 不変条件
            const sums = ledgerSums(db, itemIds);
            const table = balances(db, itemIds);
            for (const [k, row] of table) {
              expect(row.onHand).toBe(sums.get(k) ?? 0);
              expect(row.onHand).toBeGreaterThanOrEqual(0);
              expect(row.allocated).toBeGreaterThanOrEqual(0);
            }
            // 同じ伝票の中で打ち消し合った組は集計表の行がない（= 0）
            for (const [k, sum] of sums) expect(table.get(k)?.onHand ?? 0).toBe(sum);
            const ctx = contextFor(db);
            for (let l = 0; l < locationIds.length; l += 1) {
              const levels = stockLevels(ctx, itemIds, locationIds[l] ?? "");
              for (let i = 0; i < itemIds.length; i += 1) {
                const level = levels.get(itemIds[i] ?? "");
                const k = key(i, l);
                expect(level?.onHand).toBe(onHand.get(k) ?? 0);
                expect(level?.allocated).toBe(allocated.get(k) ?? 0);
                expect(level?.available).toBe((onHand.get(k) ?? 0) - (allocated.get(k) ?? 0));
              }
            }
          }
        }),
        { seed: 20261102, numRuns: 40 },
      );
    });
  });

  it("打ち消しの行は元の行を指し、2回目の打ち消しでは何も記録しない", async () => {
    await withDb((db) => {
      const source = {
        sourceType: "shipment" as const,
        sourceId: "rev-src-1",
        businessDate: "2026-11-02",
        memo: "テスト",
      };
      const posted = inTransaction(db, (ctx) =>
        postStock(ctx, source, [
          { itemId: "rev-item", locationId: "rev-loc", quantity: 5, reason: "adjustment" },
          { itemId: "rev-item", locationId: "rev-loc", quantity: 0, reason: "adjustment" },
        ]),
      );
      expect(posted.ok && posted.value.entryIds.length).toBe(1);
      const first = inTransaction(db, (ctx) =>
        reverseStock(ctx, { ...source, businessDate: "2026-11-05" }),
      );
      expect(first.ok && first.value.entryIds.length).toBe(1);
      const second = inTransaction(db, (ctx) => reverseStock(ctx, source));
      expect(second.ok && second.value.entryIds.length).toBe(0);

      const rows = db
        .select()
        .from(schema.stockLedger)
        .where(
          and(
            eq(schema.stockLedger.sourceType, "shipment"),
            eq(schema.stockLedger.sourceId, "rev-src-1"),
          ),
        )
        .orderBy(schema.stockLedger.id)
        .all();
      expect(rows).toHaveLength(2);
      expect(rows[1]?.reversesId).toBe(rows[0]?.id);
      expect(rows[1]?.quantity).toBe(-5);
      expect(rows[1]?.businessDate).toBe("2026-11-05");
      expect(rows[1]?.reason).toBe("adjustment");
      expect(stockLevel(contextFor(db), "rev-item", "rev-loc")).toEqual({
        onHand: 0,
        allocated: 0,
        available: 0,
      });
    });
  });

  it("整数でない数量は記録しない", async () => {
    await withDb((db) => {
      const r = inTransaction(db, (ctx) =>
        postStock(ctx, { sourceType: "receipt", sourceId: "x", businessDate: "2026-11-02" }, [
          { itemId: "a", locationId: "b", quantity: 1.5, reason: "receipt" },
        ]),
      );
      expect(!r.ok && r.error.code).toBe("validation");
      const a = inTransaction(db, (ctx) =>
        changeAllocation(ctx, [{ itemId: "a", locationId: "b", quantity: Number.NaN }]),
      );
      expect(!a.ok && a.error.code).toBe("validation");
    });
  });

  it("引当は現在庫を超えてもよい（出荷可能数がマイナスになる）", async () => {
    await withDb((db) => {
      const r = inTransaction(db, (ctx) =>
        changeAllocation(ctx, [{ itemId: "over-item", locationId: "over-loc", quantity: 3 }]),
      );
      expect(r.ok).toBe(true);
      expect(stockLevel(contextFor(db), "over-item", "over-loc")).toEqual({
        onHand: 0,
        allocated: 3,
        available: -3,
      });
    });
  });
});
