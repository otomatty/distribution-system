/**
 * テストデータの手順（毎日）：発注（在庫が減った商品を仕入先ごとに）、入荷（分納・その場の返品・打ち切り）、
 * 仕入返品、入荷の取消、発注の取消、仕入先請求書（締め日・週ごと）、支払。
 */
import { and, asc, eq, isNotNull, isNull, lte, sql } from "drizzle-orm";

import { addDays, latestClosedPeriod } from "../../domain/dates";
import { remainingQuantity } from "../../domain/purchasing";
import {
  cancelPurchaseOrder,
  confirmPurchaseOrder,
  createPurchaseOrder,
} from "../../usecases/purchasing/purchase-orders";
import { createPurchaseReturn } from "../../usecases/purchasing/purchase-returns";
import { cancelPurchaseReceipt, recordPurchaseReceipt } from "../../usecases/purchasing/receipts";
import {
  createSupplierInvoice,
  payBulkSupplierInvoices,
  previewSupplierInvoice,
} from "../../usecases/purchasing/supplier-invoices";
import * as schema from "../db/schema";
import type { SeedEmployeeKey } from "./names";
import { incomingByItem, loadBalances, purchaseOrderLines } from "./reads";
import { DayClock, dayNumber, weekday, type SeedDay, type SeedSession } from "./session";
import {
  employeeId,
  reorderLevel,
  targetStock,
  type World,
  type WorldItem,
  type WorldSupplier,
} from "./world";

const BUYERS: readonly SeedEmployeeKey[] = ["purchasing1", "purchasing2", "purchasing1", "multi1"];

export interface PurchaseLine {
  readonly item: WorldItem;
  /** 仕入単位の数 */
  readonly quantity: number;
}

export type Destination =
  | { readonly kind: "location"; readonly locationId: string }
  | { readonly kind: "customer"; readonly customerId: string }
  | { readonly kind: "other"; readonly address: string };

/** 発注を作り、確定して送付する（最近の数日分は作成中のまま残すことがある） */
export function placeOrder(
  session: SeedSession,
  world: World,
  day: SeedDay,
  supplier: WorldSupplier,
  destination: Destination,
  lines: readonly PurchaseLine[],
  clock: DayClock,
  key: string,
  /** メーカー直の受注から作るとき、その受注（発注と受注を相互に表示する） */
  salesOrderId: string | null = null,
): string | undefined {
  const r = session.random("po", day.date, supplier.name, key);
  const buyer = r.pick(BUYERS);
  const lead = Math.max(...lines.map((l) => l.item.leadTimeDays));
  const created = session.run(
    createPurchaseOrder,
    {
      supplierId: supplier.id,
      orderedOn: day.date,
      supplierContactName: null,
      destinationKind: destination.kind,
      destinationLocationId: destination.kind === "location" ? destination.locationId : null,
      destinationCustomerId: destination.kind === "customer" ? destination.customerId : null,
      destinationAddress: destination.kind === "other" ? destination.address : null,
      employeeId: employeeId(world, buyer),
      deliveryRequestedOn: addDays(day.date, lead),
      paymentDueOn: null,
      salesOrderId,
      memo: r.chance(0.05) ? "先方の在庫を確認済み" : null,
      lines: lines.map((l) => ({
        itemId: l.item.id,
        quantity: l.quantity,
        unitPriceCenti: l.item.purchasePriceCenti,
        memo: null,
      })),
    },
    buyer,
    clock.next(),
    `発注（${supplier.name}）`,
  );
  if (!created) return undefined;
  const recent = day.date > addDays(session.period.today, -3);
  // 最近の発注の一部（今日の最初の発注は必ず）と、ごく一部の古い発注（後で取り消す）は作成中のまま
  const draft = (recent && r.chance(0.25)) || r.chance(0.004);
  if (draft || (day.isToday && session.once("draft"))) return created.id;
  const email =
    day.date >= session.period.renderFrom && supplier.sendMethod === "email"
      ? supplier.email
      : null;
  session.run(
    confirmPurchaseOrder,
    { id: created.id, version: 1, sendMethod: email ? "email" : "none", recipient: email },
    buyer,
    clock.next(),
    `発注の確定（${created.number}）`,
  );
  return created.id;
}

/** 発注の日の仕入先について、在庫（出荷可能数 + 入荷予定）が減った商品を発注する */
export function purchaseReplenishment(session: SeedSession, world: World, day: SeedDay): void {
  const balances = loadBalances(session.db);
  const incoming = incomingByItem(session.db);
  const locations = [world.locations.main, world.locations.cold, world.locations.second];
  const n = dayNumber(day.date);
  // 発注の日が日曜（休み）に当たる仕入先は、翌日の月曜に発注する
  const orderDay = (s: WorldSupplier) =>
    n % s.cycle === s.offset || (weekday(day.date) === 1 && (n - 1) % s.cycle === s.offset);
  const clock = new DayClock(day.date, 14);
  for (const s of world.suppliers) {
    if (s.archived || s.items.length === 0 || !orderDay(s)) continue;
    const byDestination = new Map<string, PurchaseLine[]>();
    for (const item of s.items) {
      if (item.discontinued) continue;
      const position =
        balances.availableEverywhere(item.id, locations) + (incoming.get(item.id) ?? 0);
      if (position > reorderLevel(item, s)) continue;
      const need = targetStock(item, s) - position;
      if (need <= 0) continue;
      const lot = item.purchaseMinLot;
      const cases = Math.max(lot, Math.ceil(need / item.unitsPerPurchaseUnit / lot) * lot);
      // 第二倉庫の商品は本社倉庫で受けてから移す
      const destination = item.home === "cold" ? world.locations.cold : world.locations.main;
      const list = byDestination.get(destination) ?? [];
      list.push({ item, quantity: cases });
      byDestination.set(destination, list);
    }
    for (const [locationId, lines] of byDestination) {
      for (let i = 0; i < lines.length; i += 200) {
        placeOrder(
          session,
          world,
          day,
          s,
          { kind: "location", locationId },
          lines.slice(i, i + 200),
          clock,
          // 乱数の種には保管場所の ID（毎回変わる）ではなく、保管場所の区別を使う
          `${locationId === world.locations.cold ? "cold" : "main"}:${i}`,
        );
      }
    }
  }
}

/** 納品希望日になった発注の入荷（遅れ・分納・その場の返品・残りの打ち切り） */
export function receiveDeliveries(session: SeedSession, day: SeedDay): void {
  const db = session.db;
  const due = db
    .select({
      id: schema.purchaseOrders.id,
      number: schema.purchaseOrders.number,
      version: schema.purchaseOrders.version,
      destinationKind: schema.purchaseOrders.destinationKind,
      deliveryRequestedOn: schema.purchaseOrders.deliveryRequestedOn,
    })
    .from(schema.purchaseOrders)
    .where(
      and(
        eq(schema.purchaseOrders.status, "ordered"),
        lte(schema.purchaseOrders.deliveryRequestedOn, day.date),
      ),
    )
    .orderBy(asc(schema.purchaseOrders.number))
    .all();
  const clock = new DayClock(day.date, 9);
  for (const po of due) {
    const r = session.random("receive", po.number);
    const delay = r.chance(0.06) ? r.int(1, 3) : 0;
    const partial = po.destinationKind === "location" && r.chance(0.08);
    const returnOne = r.chance(0.03);
    const closeRest = r.chance(0.3);
    const gap = r.int(2, 4);
    const keepForToday = !r.chance(0.5);
    const receipts = db
      .select({ receivedOn: schema.receipts.receivedOn })
      .from(schema.receipts)
      .where(and(eq(schema.receipts.purchaseOrderId, po.id), eq(schema.receipts.cancelled, false)))
      .all();
    const last = receipts.reduce<string | null>(
      (max, x) => (max === null || x.receivedOn > max ? x.receivedOn : max),
      null,
    );
    const arrival =
      last === null ? addDays(po.deliveryRequestedOn ?? day.date, delay) : addDays(last, gap);
    if (arrival > day.date) continue;
    // 今日届く予定のものは、半分ほどを入荷予定一覧に残す
    if (day.isToday && arrival === day.date && keepForToday) continue;
    const lines = purchaseOrderLines(db, po.id)
      .map((l) => Object.assign(l, { remaining: remainingQuantity(l) }))
      .filter((l) => l.remaining > 0);
    if (lines.length === 0) continue;
    const first = last === null;
    let input = lines.map((l) => ({
      lineId: l.id,
      accepted: l.remaining,
      returned: 0,
      closeRemaining: false,
    }));
    let memo: string | null = null;
    if (first && partial) {
      const split = lines
        .map((l) => ({
          lineId: l.id,
          accepted: Math.floor(l.remaining * 0.6),
          returned: 0,
          closeRemaining: false,
        }))
        .filter((l) => l.accepted > 0);
      if (split.length > 0) {
        input = split;
        memo = "分納（残りは後日）";
      }
    } else if (!first && closeRest) {
      input = lines.map((l) => ({
        lineId: l.id,
        accepted: Math.floor(l.remaining * 0.5),
        returned: 0,
        closeRemaining: true,
      }));
      memo = "残りは仕入先の欠品のため打ち切り";
    } else if (first && returnOne) {
      const target = input.find((l) => l.accepted >= 2);
      if (target) {
        target.accepted -= 1;
        target.returned = 1;
        memo = "1点破損のためその場で返品";
      }
    }
    session.run(
      recordPurchaseReceipt,
      { purchaseOrderId: po.id, version: po.version, receivedOn: day.date, memo, lines: input },
      r.chance(0.7) ? "warehouse1" : "purchasing1",
      clock.next(),
      `入荷（${po.number}）`,
    );
  }
}

/** 3日前の入荷から、ごく一部を不良品として仕入返品する */
export function returnDefects(session: SeedSession, day: SeedDay): void {
  const db = session.db;
  const receipts = db
    .select({
      id: schema.receipts.id,
      number: schema.receipts.number,
      purchaseOrderId: schema.receipts.purchaseOrderId,
      locationId: schema.receipts.locationId,
    })
    .from(schema.receipts)
    .where(
      and(
        eq(schema.receipts.receivedOn, addDays(day.date, -3)),
        eq(schema.receipts.cancelled, false),
        isNotNull(schema.receipts.locationId),
      ),
    )
    .orderBy(asc(schema.receipts.number))
    .all();
  const clock = new DayClock(day.date, 15);
  for (const rc of receipts) {
    const r = session.random("purchase-return", rc.number);
    if (!r.chance(0.01) || rc.locationId === null) continue;
    const line = db
      .select({
        lineId: schema.receiptLines.purchaseOrderLineId,
        itemId: schema.receiptLines.itemId,
        accepted: schema.receiptLines.accepted,
        units: schema.receiptLines.unitsPerPurchaseUnit,
      })
      .from(schema.receiptLines)
      .where(eq(schema.receiptLines.receiptId, rc.id))
      .all()
      .find((l) => l.accepted > 0);
    if (!line) continue;
    const units = Math.min(r.int(1, 2), line.accepted * line.units);
    if (
      loadBalances(db, rc.locationId, [line.itemId]).get(line.itemId, rc.locationId).onHand < units
    )
      continue;
    session.run(
      createPurchaseReturn,
      {
        purchaseOrderId: rc.purchaseOrderId,
        returnedOn: day.date,
        locationId: rc.locationId,
        memo: "不良品のため返品",
        lines: [{ lineId: line.lineId, units }],
      },
      "purchasing1",
      clock.next(),
      `仕入返品（${rc.number}）`,
    );
  }
}

/** 前日の入荷のごく一部を取り消す（入力の誤り）。発注は発注済みに戻り、後日あらためて入荷する */
export function cancelMistakenReceipts(session: SeedSession, day: SeedDay): void {
  const db = session.db;
  const receipts = db
    .select({
      id: schema.receipts.id,
      number: schema.receipts.number,
      version: schema.receipts.version,
      purchaseOrderId: schema.receipts.purchaseOrderId,
      locationId: schema.receipts.locationId,
    })
    .from(schema.receipts)
    .where(
      and(
        eq(schema.receipts.receivedOn, addDays(day.date, -1)),
        eq(schema.receipts.cancelled, false),
        isNull(schema.receipts.supplierInvoiceId),
      ),
    )
    .orderBy(asc(schema.receipts.number))
    .all();
  const clock = new DayClock(day.date, 15);
  for (const rc of receipts) {
    if (!session.random("receipt-cancel", rc.number).chance(0.003)) continue;
    const returned = db
      .select({ id: schema.purchaseReturns.id })
      .from(schema.purchaseReturns)
      .where(eq(schema.purchaseReturns.purchaseOrderId, rc.purchaseOrderId))
      .get();
    if (returned) continue;
    if (rc.locationId !== null) {
      const lines = db
        .select({
          itemId: schema.receiptLines.itemId,
          units: schema.receiptLines.accepted,
          per: schema.receiptLines.unitsPerPurchaseUnit,
        })
        .from(schema.receiptLines)
        .where(eq(schema.receiptLines.receiptId, rc.id))
        .all();
      const balances = loadBalances(
        db,
        rc.locationId,
        lines.map((l) => l.itemId),
      );
      const locationId = rc.locationId;
      // 戻すと在庫がマイナスになる（もう出荷した）なら取り消さない
      if (lines.some((l) => balances.get(l.itemId, locationId).onHand < l.units * l.per)) continue;
    }
    session.run(
      cancelPurchaseReceipt,
      { id: rc.id, version: rc.version, reason: "入荷数の入力誤りのため取消" },
      "purchasing1",
      clock.next(),
      `入荷の取消（${rc.number}）`,
    );
  }
}

/** 前日の発注のごく一部を取り消し、古い作成中の発注（2日前）を片付ける */
export function cancelOrders(session: SeedSession, day: SeedDay): void {
  const db = session.db;
  const clock = new DayClock(day.date, 15);
  const select = (status: "ordered" | "draft", orderedOn: string) =>
    db
      .select({
        id: schema.purchaseOrders.id,
        number: schema.purchaseOrders.number,
        version: schema.purchaseOrders.version,
      })
      .from(schema.purchaseOrders)
      .where(
        and(
          eq(schema.purchaseOrders.status, status),
          eq(schema.purchaseOrders.orderedOn, orderedOn),
        ),
      )
      .orderBy(asc(schema.purchaseOrders.number))
      .all();
  for (const po of select("ordered", addDays(day.date, -1))) {
    if (!session.random("po-cancel", po.number).chance(0.01)) continue;
    // 入荷が始まった発注は取り消せない（リードタイムが1日なら、もう届いていることがある）
    const received = db
      .select({ id: schema.receipts.id })
      .from(schema.receipts)
      .where(and(eq(schema.receipts.purchaseOrderId, po.id), eq(schema.receipts.cancelled, false)))
      .get();
    if (received) continue;
    session.run(
      cancelPurchaseOrder,
      { id: po.id, version: po.version, reason: "仕入先の欠品のため取消" },
      "purchasing2",
      clock.next(),
      `発注の取消（${po.number}）`,
    );
  }
  const oldDraft = addDays(day.date, -2);
  // 最近の作成中の発注は、ダッシュボードの「作成中のままの発注」に出るよう残す
  if (oldDraft > addDays(session.period.today, -3)) return;
  for (const po of select("draft", oldDraft)) {
    session.run(
      cancelPurchaseOrder,
      { id: po.id, version: po.version, reason: "作成の誤りのため取消" },
      "purchasing1",
      clock.next(),
      `作成中の発注の取消（${po.number}）`,
    );
  }
}

/**
 * 仕入先請求書：締め日のある仕入先は締め日の3日後（日曜なら翌日）に、締め期間までの未請求の入荷と仕入返品で登録する。
 * 締め日のない仕入先は、毎週月曜に3日以上前の未請求の入荷で登録する。たまに送料と差額がある。
 */
export function registerSupplierInvoices(session: SeedSession, world: World, day: SeedDay): void {
  const db = session.db;
  const clock = new DayClock(day.date, 17);
  for (const [index, s] of world.suppliers.entries()) {
    let to: string;
    if (s.terms) {
      const period = latestClosedPeriod(day.date, s.terms.closingDay);
      // 締め日の3日後に登録する（日曜に当たれば翌日。それより後の日は調べない）
      if (addDays(period.to, 3) > day.date || addDays(period.to, 5) < day.date) continue;
      to = period.to;
    } else {
      if (weekday(day.date) !== 1) continue;
      to = addDays(day.date, -3);
    }
    for (let batch = 0; batch < 10; batch += 1) {
      const receiptIds = db
        .select({ id: schema.receipts.id })
        .from(schema.receipts)
        .innerJoin(
          schema.purchaseOrders,
          eq(schema.purchaseOrders.id, schema.receipts.purchaseOrderId),
        )
        .where(
          and(
            eq(schema.purchaseOrders.supplierId, s.id),
            isNull(schema.receipts.supplierInvoiceId),
            eq(schema.receipts.cancelled, false),
            lte(schema.receipts.receivedOn, to),
            // 受入のない入荷（全数を返品・打ち切り）は請求の対象にならない
            sql`EXISTS (SELECT 1 FROM receipt_lines rl WHERE rl.receipt_id = receipts.id AND rl.accepted > 0)`,
          ),
        )
        .orderBy(asc(schema.receipts.number))
        .limit(500)
        .all()
        .map((x) => x.id);
      if (receiptIds.length === 0) break;
      const returnIds = db
        .select({ id: schema.purchaseReturns.id })
        .from(schema.purchaseReturns)
        .where(
          and(
            eq(schema.purchaseReturns.supplierId, s.id),
            isNull(schema.purchaseReturns.supplierInvoiceId),
            eq(schema.purchaseReturns.cancelled, false),
            lte(schema.purchaseReturns.returnedOn, to),
          ),
        )
        .orderBy(asc(schema.purchaseReturns.number))
        .limit(500)
        .all()
        .map((x) => x.id);
      const r = session.random("supplier-invoice", s.name, day.date, batch);
      const shippingFee = r.chance(0.15) ? r.pick([500, 800, 1200] as const) : 0;
      const at = clock.next();
      const previewOf = (returns: string[]) =>
        session.ask(
          previewSupplierInvoice,
          { supplierId: s.id, invoiceDate: day.date, receiptIds, returnIds: returns, shippingFee },
          at,
        )?.amounts?.computedAmount ?? null;
      // 仕入返品が入荷より多くて請求額が0円以下になるときは、返品を次の請求書に回す
      let returns = returnIds;
      let computed = previewOf(returns);
      if (computed !== null && computed <= 0 && returns.length > 0) {
        returns = [];
        computed = previewOf(returns);
      }
      if (computed === null || computed <= 0) break;
      const picked = r.chance(0.05) ? r.pick([-300, -100, -12, 5, 40, 250] as const) : 0;
      const difference = computed + picked > 0 ? picked : 0;
      const created = session.run(
        createSupplierInvoice,
        {
          supplierId: s.id,
          invoiceDate: day.date,
          receiptIds,
          returnIds: returns,
          shippingFee,
          invoiceNumber: `S${String(index + 1).padStart(4, "0")}-${day.date.replaceAll("-", "")}-${batch + 1}`,
          invoicedAmount: computed + difference,
          differenceReason: difference === 0 ? null : "先方の計算との端数の違い",
          paymentDueOn: s.terms ? null : addDays(day.date, 30),
          memo: null,
        },
        r.chance(0.6) ? "accounting1" : "accounting2",
        at,
        `仕入先請求書（${s.name}）`,
      );
      if (!created) break;
    }
  }
}

/** 支払予定日になった仕入先請求書を一括で支払う（ごく一部は10日遅れる） */
export function paySupplierInvoices(session: SeedSession, day: SeedDay): void {
  const due = session.db
    .select({
      id: schema.supplierInvoices.id,
      version: schema.supplierInvoices.version,
      invoiceNumber: schema.supplierInvoices.invoiceNumber,
      invoicedAmount: schema.supplierInvoices.invoicedAmount,
      paymentDueOn: schema.supplierInvoices.paymentDueOn,
    })
    .from(schema.supplierInvoices)
    .where(
      and(
        eq(schema.supplierInvoices.status, "unpaid"),
        lte(schema.supplierInvoices.paymentDueOn, day.date),
      ),
    )
    .orderBy(asc(schema.supplierInvoices.paymentDueOn), asc(schema.supplierInvoices.invoiceNumber))
    .all()
    .filter((x) => {
      // 0円以下の請求書は支払わない（一括支払いは1件でも支払えなければ何も支払わない）
      if (x.invoicedAmount <= 0) return false;
      const late = session.random("pay", x.invoiceNumber ?? x.id).chance(0.02) ? 10 : 0;
      return x.paymentDueOn !== null && addDays(x.paymentDueOn, late) <= day.date;
    });
  const clock = new DayClock(day.date, 10);
  for (let i = 0; i < due.length; i += 200) {
    session.run(
      payBulkSupplierInvoices,
      {
        invoices: due.slice(i, i + 200).map((x) => ({ id: x.id, version: x.version })),
        paidOn: day.date,
        memo: "振込",
      },
      "accounting1",
      clock.next(),
      "一括支払い",
    );
  }
}
