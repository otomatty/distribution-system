/**
 * 投入したデータの整合の確認（scripts/seed.mjs の最後と、結合テストで使う）。
 * - 在庫：集計表の現在庫 = 台帳の合計、現在庫 ≥ 0、引当数 = 受注済みの受注（メーカー直を除く）の数量の合計
 * - 受注：発送済みの受注には有効な発送が1件、それ以外は0件
 * - 発注：明細の入荷済みの数 = 有効な入荷の受入数 + 返品数、入荷済み・支払済みの発注は残りが0
 * - 仕入先請求書：支払済みの請求書には有効な支払が1件、支払済みの発注の入荷（受入のあるもの）はすべて支払済みの請求書に入っている
 * - 採番：番号の最大 = 採番の次の番号 − 1
 */
import { and, count, eq, isNotNull, sql } from "drizzle-orm";

import { DOCUMENT_PREFIXES, sequenceKey, type DocumentKind } from "../../domain/numbering";
import type { Db } from "../db/client";
import * as schema from "../db/schema";
import type { SeedCheck, SeedVerifyResult } from "./request";

function check(name: string, problems: readonly string[]): SeedCheck {
  return {
    name,
    ok: problems.length === 0,
    mismatches: problems.length,
    sample: problems.slice(0, 5),
  };
}

function key(itemId: string, locationId: string | null): string {
  return `${itemId}:${locationId ?? ""}`;
}

function stockChecks(db: Db): SeedCheck[] {
  const ledger = db
    .select({
      itemId: schema.stockLedger.itemId,
      locationId: schema.stockLedger.locationId,
      total: sql<number>`sum(${schema.stockLedger.quantity})`,
    })
    .from(schema.stockLedger)
    .groupBy(schema.stockLedger.itemId, schema.stockLedger.locationId)
    .all();
  const allocations = db
    .select({
      itemId: schema.salesOrderLines.itemId,
      locationId: schema.salesOrders.locationId,
      total: sql<number>`sum(${schema.salesOrderLines.quantity})`,
    })
    .from(schema.salesOrderLines)
    .innerJoin(schema.salesOrders, eq(schema.salesOrders.id, schema.salesOrderLines.salesOrderId))
    .where(
      and(
        eq(schema.salesOrders.status, "received"),
        eq(schema.salesOrders.makerDirect, false),
        isNotNull(schema.salesOrders.locationId),
      ),
    )
    .groupBy(schema.salesOrderLines.itemId, schema.salesOrders.locationId)
    .all();
  const balances = db.select().from(schema.stockBalances).all();
  const ledgerMap = new Map(ledger.map((l) => [key(l.itemId, l.locationId), l.total]));
  const allocMap = new Map(allocations.map((a) => [key(a.itemId, a.locationId), a.total]));
  const balanceMap = new Map(balances.map((b) => [key(b.itemId, b.locationId), b]));
  const onHand: string[] = [];
  const negative: string[] = [];
  const allocated: string[] = [];
  for (const k of new Set([...ledgerMap.keys(), ...balanceMap.keys()])) {
    const b = balanceMap.get(k);
    const l = ledgerMap.get(k) ?? 0;
    if ((b?.onHand ?? 0) !== l) onHand.push(`${k} 集計表 ${b?.onHand ?? 0} / 台帳 ${l}`);
    if ((b?.onHand ?? 0) < 0) negative.push(`${k} ${b?.onHand ?? 0}`);
  }
  for (const k of new Set([...allocMap.keys(), ...balanceMap.keys()])) {
    const b = balanceMap.get(k)?.allocated ?? 0;
    const a = allocMap.get(k) ?? 0;
    if (b !== a) allocated.push(`${k} 集計表 ${b} / 受注 ${a}`);
  }
  return [
    check("現在庫 = 台帳の合計", onHand),
    check("現在庫がマイナスでない", negative),
    check("引当数 = 受注済みの受注の数量", allocated),
  ];
}

function salesChecks(db: Db): SeedCheck[] {
  const rows = db
    .select({
      number: schema.salesOrders.number,
      status: schema.salesOrders.status,
      active: sql<number>`(SELECT count(*) FROM shipments s WHERE s.sales_order_id = sales_orders.id AND s.cancelled = 0)`,
    })
    .from(schema.salesOrders)
    .all();
  const problems = rows
    .filter((r) => (r.status === "shipped" ? r.active !== 1 : r.active !== 0))
    .map((r) => `${r.number}（${r.status}）の有効な発送 ${r.active} 件`);
  return [check("発送済みの受注には有効な発送が1件", problems)];
}

function purchasingChecks(db: Db): SeedCheck[] {
  const lines = db
    .select({
      number: schema.purchaseOrders.number,
      status: schema.purchaseOrders.status,
      quantity: schema.purchaseOrderLines.quantity,
      receivedQuantity: schema.purchaseOrderLines.receivedQuantity,
      closed: schema.purchaseOrderLines.closed,
      recorded: sql<number>`coalesce((SELECT sum(rl.accepted + rl.returned) FROM receipt_lines rl
        INNER JOIN receipts r ON r.id = rl.receipt_id
        WHERE rl.purchase_order_line_id = purchase_order_lines.id AND r.cancelled = 0), 0)`,
    })
    .from(schema.purchaseOrderLines)
    .innerJoin(
      schema.purchaseOrders,
      eq(schema.purchaseOrders.id, schema.purchaseOrderLines.purchaseOrderId),
    )
    .all();
  const received = lines
    .filter((l) => l.receivedQuantity !== l.recorded)
    .map((l) => `${l.number} 明細 ${l.receivedQuantity} / 入荷 ${l.recorded}`);
  const done = lines
    .filter(
      (l) =>
        (l.status === "received" || l.status === "paid") &&
        !l.closed &&
        l.quantity - l.receivedQuantity !== 0,
    )
    .map((l) => `${l.number}（${l.status}）に残りがある`);
  const invoices = db
    .select({
      id: schema.supplierInvoices.id,
      status: schema.supplierInvoices.status,
      payments: sql<number>`(SELECT count(*) FROM supplier_payments p WHERE p.supplier_invoice_id = supplier_invoices.id AND p.cancelled = 0)`,
    })
    .from(schema.supplierInvoices)
    .all();
  const paid = invoices
    .filter((i) => (i.status === "paid" ? i.payments !== 1 : i.payments !== 0))
    .map((i) => `${i.id}（${i.status}）の支払 ${i.payments} 件`);
  const paidOrders = db
    .select({
      number: schema.purchaseOrders.number,
      unpaid: sql<number>`(SELECT count(*) FROM receipts r
        LEFT JOIN supplier_invoices si ON si.id = r.supplier_invoice_id
        WHERE r.purchase_order_id = purchase_orders.id AND r.cancelled = 0
          AND EXISTS (SELECT 1 FROM receipt_lines rl WHERE rl.receipt_id = r.id AND rl.accepted > 0)
          AND (si.id IS NULL OR si.status <> 'paid'))`,
    })
    .from(schema.purchaseOrders)
    .where(eq(schema.purchaseOrders.status, "paid"))
    .all()
    .filter((o) => o.unpaid > 0)
    .map((o) => `${o.number} に未払いの入荷 ${o.unpaid} 件`);
  return [
    check("発注明細の入荷済みの数 = 入荷の合計", received),
    check("入荷済みの発注に残りがない", done),
    check("支払済みの請求書には支払が1件", paid),
    check("支払済みの発注の入荷はすべて支払済み", paidOrders),
  ];
}

function sequenceChecks(db: Db): SeedCheck[] {
  const columns: readonly [DocumentKind, string[]][] = [
    [
      "purchaseOrder",
      db
        .select({ n: schema.purchaseOrders.number })
        .from(schema.purchaseOrders)
        .all()
        .map((r) => r.n),
    ],
    [
      "receipt",
      db
        .select({ n: schema.receipts.number })
        .from(schema.receipts)
        .all()
        .map((r) => r.n),
    ],
    [
      "salesOrder",
      db
        .select({ n: schema.salesOrders.number })
        .from(schema.salesOrders)
        .all()
        .map((r) => r.n),
    ],
    [
      "deliveryNote",
      db
        .select({ n: schema.shipments.deliveryNoteNumber })
        .from(schema.shipments)
        .all()
        .map((r) => r.n),
    ],
    [
      "purchaseReturn",
      db
        .select({ n: schema.purchaseReturns.number })
        .from(schema.purchaseReturns)
        .all()
        .map((r) => r.n),
    ],
    [
      "stockOperation",
      db
        .select({ n: schema.stockOperations.number })
        .from(schema.stockOperations)
        .all()
        .map((r) => r.n),
    ],
    [
      "item",
      db
        .select({ n: schema.items.code })
        .from(schema.items)
        .all()
        .map((r) => r.n),
    ],
  ];
  const next = new Map(
    db
      .select()
      .from(schema.sequences)
      .all()
      .map((s) => [s.key, s.nextValue]),
  );
  const problems: string[] = [];
  for (const [kind, numbers] of columns) {
    const max = new Map<string, number>();
    for (const number of numbers) {
      const m =
        kind === "item"
          ? /^IT(\d{6})$/.exec(number)
          : new RegExp(`^${DOCUMENT_PREFIXES[kind]}-(\\d{4})-(\\d{6})$`).exec(number);
      if (!m) continue;
      const k = kind === "item" ? sequenceKey(kind, 0) : sequenceKey(kind, Number(m[1]));
      const value = Number(kind === "item" ? m[1] : m[2]);
      max.set(k, Math.max(max.get(k) ?? 0, value));
    }
    for (const [k, value] of max) {
      if ((next.get(k) ?? 1) - 1 !== value)
        problems.push(`${k} 最大 ${value} / 次の番号 ${next.get(k) ?? 1}`);
    }
  }
  return [check("採番の次の番号 = 番号の最大 + 1", problems)];
}

function n(row: { n: number } | undefined): number {
  return row?.n ?? 0;
}

export function verifySeed(db: Db): SeedVerifyResult {
  const checks = [
    ...stockChecks(db),
    ...salesChecks(db),
    ...purchasingChecks(db),
    ...sequenceChecks(db),
  ];
  const counts: Record<string, number> = {
    取引先: n(db.select({ n: count() }).from(schema.partners).get()),
    商品: n(db.select({ n: count() }).from(schema.items).get()),
    社員: n(db.select({ n: count() }).from(schema.employees).get()),
    発注: n(db.select({ n: count() }).from(schema.purchaseOrders).get()),
    発注明細: n(db.select({ n: count() }).from(schema.purchaseOrderLines).get()),
    入荷: n(db.select({ n: count() }).from(schema.receipts).get()),
    仕入返品: n(db.select({ n: count() }).from(schema.purchaseReturns).get()),
    仕入先請求書: n(db.select({ n: count() }).from(schema.supplierInvoices).get()),
    支払: n(db.select({ n: count() }).from(schema.supplierPayments).get()),
    受注: n(db.select({ n: count() }).from(schema.salesOrders).get()),
    受注明細: n(db.select({ n: count() }).from(schema.salesOrderLines).get()),
    発送: n(db.select({ n: count() }).from(schema.shipments).get()),
    在庫操作: n(db.select({ n: count() }).from(schema.stockOperations).get()),
    在庫台帳: n(db.select({ n: count() }).from(schema.stockLedger).get()),
    帳票: n(db.select({ n: count() }).from(schema.documents).get()),
    操作履歴: n(db.select({ n: count() }).from(schema.auditLogs).get()),
    メーカー直の受注: n(
      db
        .select({ n: count() })
        .from(schema.salesOrders)
        .where(eq(schema.salesOrders.makerDirect, true))
        .get(),
    ),
    分割した受注: n(
      db
        .select({ n: count() })
        .from(schema.salesOrders)
        .where(isNotNull(schema.salesOrders.splitFromId))
        .get(),
    ),
    取消の受注: n(
      db
        .select({ n: count() })
        .from(schema.salesOrders)
        .where(eq(schema.salesOrders.status, "cancelled"))
        .get(),
    ),
    受注済みの受注: n(
      db
        .select({ n: count() })
        .from(schema.salesOrders)
        .where(eq(schema.salesOrders.status, "received"))
        .get(),
    ),
    作成中の発注: n(
      db
        .select({ n: count() })
        .from(schema.purchaseOrders)
        .where(eq(schema.purchaseOrders.status, "draft"))
        .get(),
    ),
    取消の発注: n(
      db
        .select({ n: count() })
        .from(schema.purchaseOrders)
        .where(eq(schema.purchaseOrders.status, "cancelled"))
        .get(),
    ),
    支払済みの発注: n(
      db
        .select({ n: count() })
        .from(schema.purchaseOrders)
        .where(eq(schema.purchaseOrders.status, "paid"))
        .get(),
    ),
    分納の発注: n(
      db
        .select({ n: count() })
        .from(schema.purchaseOrders)
        .where(
          sql`(SELECT count(*) FROM receipts r WHERE r.purchase_order_id = purchase_orders.id AND r.cancelled = 0) > 1`,
        )
        .get(),
    ),
    メーカー直の発注: n(
      db
        .select({ n: count() })
        .from(schema.purchaseOrders)
        .where(eq(schema.purchaseOrders.destinationKind, "customer"))
        .get(),
    ),
  };
  return { action: "verify", ok: checks.every((c) => c.ok), checks, counts };
}
