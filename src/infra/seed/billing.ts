/**
 * テストデータの請求の区分の1日（取引の手順の1日の最後に行う。operations.ts）：
 * 返品伝票 → 請求書で差し引けない返品の返還請求書 → 締め処理（締め日のある販売先）→ 発送ごとの請求書（締め日のない販売先）→
 * 返還請求書（請求済みの返品）→ 入金と消込（返還額の消込を含む）→ 返還額の返金 → 販売先廃棄。
 * 書き込みはすべて請求の区分のユースケースを通す。
 *
 * - 取引の後に期間をまとめて請求すると、途中までは3年分の発送が未請求のまま残る（実際の運用にない状態で、
 *   未請求の発送を探す照会が遅くなる）。そのため、取引と同じ日の中で毎日請求する
 * - 発送の取消は発送の翌日の取引で済んでいる。ここでは前日の発送を請求する（取り消した発送は載らない）
 * - 返品伝票は発送の数日後に、ごく一部だけ記録する（在庫に戻すか廃棄か）。未請求の返品は次の請求書にマイナスで載る
 * - 請求書で差し引けない返品：記録した日の返品の一部（先方が差し引きでなく返還を求めた）と、30日たっても請求書に
 *   載らない返品（その販売先への発送がない、返品が請求を上回るなど）は、返還請求書を発行して精算する。返還額は、
 *   その販売先の入金のときに請求書へ先に充てる。返金を求めた販売先（一部）には7日後に、ほかは14日たっても充てる請求書が
 *   なければ一部を、残りを返金済みにする
 * - 入金：締め日のない販売先は曜日を決めて週に1回、翌週までに期限の来る請求書をまとめて払う。締め日のある販売先は
 *   期限の日に払う。ごく一部は一部だけ入金・振込手数料を差し引いて入金・期限を過ぎても未入金のままにする
 * - 今日は締め処理をしない（ダッシュボードの「締め処理待ちの販売先」に出す）
 */
import { and, asc, eq, gte, isNotNull, isNull, lte, sql } from "drizzle-orm";

import { addDays } from "../../domain/dates";
import { createDisposal } from "../../usecases/billing/disposals";
import {
  closeInvoices,
  draftInvoice,
  issueInvoiceCommand,
  listClosingCandidates,
} from "../../usecases/billing/invoices";
import {
  allocateCustomerPayment,
  createCustomerPayment,
  refundCustomerCredit,
} from "../../usecases/billing/payments";
import {
  createSalesReturn,
  issueCreditNote,
  issueUnbilledCreditNote,
} from "../../usecases/billing/returns";
import * as schema from "../db/schema";
import { inList } from "../db/sql-helpers";
import { salesOrderLines } from "./reads";
import { DayClock, weekday, type SeedDay, type SeedSession } from "./session";
import type { World } from "./world";

/** 締め日のない販売先の請求書の支払期限（発行日から） */
const DUE_DAYS = 30;
const BANK_FEES = [440, 660, 880] as const;

/** 発送の5日後に、ごく一部を返品伝票にする（在庫に戻す・廃棄） */
function recordSalesReturns(session: SeedSession, day: SeedDay): void {
  const db = session.db;
  const shipments = db
    .select({
      number: schema.shipments.deliveryNoteNumber,
      salesOrderId: schema.shipments.salesOrderId,
      locationId: schema.salesOrders.locationId,
    })
    .from(schema.shipments)
    .innerJoin(schema.salesOrders, eq(schema.salesOrders.id, schema.shipments.salesOrderId))
    .where(
      and(
        eq(schema.shipments.shippedOn, addDays(day.date, -5)),
        eq(schema.shipments.cancelled, false),
      ),
    )
    .orderBy(asc(schema.shipments.deliveryNoteNumber))
    .all();
  const clock = new DayClock(day.date, 11);
  for (const s of shipments) {
    const r = session.random("sales-return", s.number);
    if (!r.chance(0.012)) continue;
    const line = salesOrderLines(db, s.salesOrderId)[0];
    if (!line) continue;
    const restock = s.locationId !== null && r.chance(0.7);
    session.run(
      createSalesReturn,
      {
        salesOrderId: s.salesOrderId,
        returnedOn: day.date,
        memo: restock ? "未開封のため在庫に戻す" : "破損していたため廃棄",
        lines: [
          {
            salesOrderLineId: line.id,
            quantity: Math.min(line.quantity, r.int(1, 2)),
            restock,
            locationId: restock ? s.locationId : null,
          },
        ],
      },
      "sales2",
      clock.next(),
      `返品伝票（${s.number}）`,
    );
  }
}

/** 請求書に載せず返還請求書で精算する日数（返品日からこの日数たっても請求書に載らない返品を精算する） */
const STRANDED_RETURN_DAYS = 30;
/** 返金を求めた販売先には、返還請求書の発行からこの日数で返金する */
const REFUND_REQUESTED_DAYS = 7;
/** 返還額を充てる請求書がないまま、この日数たったら返金を考える */
const REFUND_AFTER_DAYS = 14;

/**
 * 請求書で差し引けない返品の返還請求書：今日記録した返品の一部（先方が返還を求めた）と、
 * 30日たっても請求書に載らない返品を、返還請求書で精算する（返還額は入金（相殺）になる）
 */
function settleUnbilledReturns(session: SeedSession, day: SeedDay): void {
  const db = session.db;
  const returns = db
    .select({
      id: schema.salesReturns.id,
      number: schema.salesReturns.number,
      version: schema.salesReturns.version,
      returnedOn: schema.salesReturns.returnedOn,
    })
    .from(schema.salesReturns)
    .leftJoin(
      schema.customerPayments,
      and(
        eq(schema.customerPayments.salesReturnId, schema.salesReturns.id),
        eq(schema.customerPayments.cancelled, false),
      ),
    )
    .where(
      and(
        isNull(schema.salesReturns.invoiceId),
        eq(schema.salesReturns.cancelled, false),
        isNull(schema.salesReturns.creditNoteNumber),
        isNull(schema.customerPayments.id),
        lte(schema.salesReturns.returnedOn, day.date),
      ),
    )
    .orderBy(asc(schema.salesReturns.number))
    .all();
  const clock = new DayClock(day.date, 12);
  for (const r of returns) {
    const requested =
      r.returnedOn === day.date && session.random("unbilled-credit", r.number).chance(0.35);
    const stranded = r.returnedOn <= addDays(day.date, -STRANDED_RETURN_DAYS);
    if (!requested && !stranded) continue;
    session.run(
      issueUnbilledCreditNote,
      { salesReturnId: r.id, version: r.version, issuedOn: day.date },
      "accounting2",
      clock.next(),
      `請求書で差し引けない返品の返還請求書（${r.number}）`,
    );
  }
}

interface OpenCredit {
  readonly id: string;
  readonly version: number;
  readonly customerId: string;
  readonly receivedOn: string;
  readonly returnNumber: string;
  remaining: number;
}

/** 残り（請求書に充てていない・返金していない額）のある返還額。返品伝票の番号の順 */
function openCredits(session: SeedSession, customerIds?: readonly string[]): OpenCredit[] {
  if (customerIds?.length === 0) return [];
  const conds = [
    isNotNull(schema.customerPayments.salesReturnId),
    eq(schema.customerPayments.cancelled, false),
  ];
  if (customerIds) conds.push(inList(schema.customerPayments.customerId, customerIds));
  return session.db
    .select({
      id: schema.customerPayments.id,
      version: schema.customerPayments.version,
      customerId: schema.customerPayments.customerId,
      receivedOn: schema.customerPayments.receivedOn,
      returnNumber: schema.salesReturns.number,
      remaining: sql<number>`${schema.customerPayments.amount}
        - coalesce((SELECT sum(a.amount) FROM payment_allocations a WHERE a.payment_id = customer_payments.id AND a.cancelled = 0), 0)
        - coalesce((SELECT sum(r.amount) FROM customer_refunds r WHERE r.payment_id = customer_payments.id AND r.cancelled = 0), 0)`,
    })
    .from(schema.customerPayments)
    .innerJoin(
      schema.salesReturns,
      eq(schema.salesReturns.id, schema.customerPayments.salesReturnId),
    )
    .where(and(...conds))
    .orderBy(asc(schema.salesReturns.number))
    .all()
    .filter((c) => c.remaining > 0);
}

function invoiceVersion(session: SeedSession, id: string): number {
  return (
    session.db
      .select({ version: schema.invoices.version })
      .from(schema.invoices)
      .where(eq(schema.invoices.id, id))
      .get()?.version ?? 1
  );
}

/**
 * 販売先の返還額を、払う請求書に先に充てる（返還額の入金から消し込む）。充てた額だけ、振り込む額を減らす
 */
function applyCredits(
  session: SeedSession,
  credits: readonly OpenCredit[],
  list: { invoice: OpenInvoice; amount: number }[],
  clock: DayClock,
  name: string,
): void {
  for (const credit of credits) {
    const allocations: {
      invoiceId: string;
      version: number;
      amount: number;
      adjustment: number;
      adjustmentKind: null;
    }[] = [];
    for (const b of list) {
      if (credit.remaining <= 0) break;
      if (b.amount <= 0) continue;
      const use = Math.min(credit.remaining, b.amount);
      allocations.push({
        invoiceId: b.invoice.id,
        version: invoiceVersion(session, b.invoice.id),
        amount: use,
        adjustment: 0,
        adjustmentKind: null,
      });
      b.amount -= use;
      credit.remaining -= use;
    }
    if (allocations.length === 0) continue;
    session.run(
      allocateCustomerPayment,
      { paymentId: credit.id, version: credit.version, allocations },
      "accounting1",
      clock.next(),
      `返還額の消込（${name}、${credit.returnNumber}）`,
    );
  }
}

/**
 * 返還額の返金：返金を求めた販売先（返還額の一部）には7日後に、ほかは14日たっても充てる請求書（未入金・一部入金）が
 * なければ一部を、残りを返金済みにする。それ以外は、後の請求書に充てるまで未消込の入金として売掛残高を減らす
 */
function refundCredits(session: SeedSession, day: SeedDay): void {
  const db = session.db;
  const due = openCredits(session).filter(
    (c) => c.receivedOn <= addDays(day.date, -REFUND_REQUESTED_DAYS),
  );
  if (due.length === 0) return;
  const open = new Set(
    db
      .select({ customerId: schema.invoices.customerId })
      .from(schema.invoices)
      .where(
        and(
          inList(schema.invoices.status, ["unpaid", "partial"]),
          inList(schema.invoices.customerId, [...new Set(due.map((c) => c.customerId))]),
        ),
      )
      .all()
      .map((r) => r.customerId),
  );
  const clock = new DayClock(day.date, 16);
  for (const c of due) {
    const r = session.random("credit-refund", c.returnNumber);
    const requested = r.chance(0.35);
    const idle = c.receivedOn <= addDays(day.date, -REFUND_AFTER_DAYS) && !open.has(c.customerId);
    if (!requested && !(idle && r.chance(0.6))) continue;
    session.run(
      refundCustomerCredit,
      {
        paymentId: c.id,
        version: c.version,
        refundedOn: day.date,
        memo: "返還額を指定の口座へ振込で返金",
      },
      "accounting1",
      clock.next(),
      `返還額の返金（${c.returnNumber}）`,
    );
  }
}

/**
 * 締め日のない販売先：前の営業日の発送ごとに請求書を発行する（未請求の返品伝票もマイナスで載せる）。
 * 月曜は土曜の分（日曜は休み）
 */
function issuePerShipment(session: SeedSession, day: SeedDay): void {
  const db = session.db;
  const previous = addDays(day.date, weekday(day.date) === 1 ? -2 : -1);
  const shipments = db
    .select({ id: schema.shipments.id, version: schema.shipments.version })
    .from(schema.shipments)
    .innerJoin(schema.salesOrders, eq(schema.salesOrders.id, schema.shipments.salesOrderId))
    .innerJoin(schema.partners, eq(schema.partners.id, schema.salesOrders.customerId))
    .where(
      and(
        gte(schema.shipments.shippedOn, previous),
        lte(schema.shipments.shippedOn, addDays(day.date, -1)),
        eq(schema.shipments.cancelled, false),
        isNull(schema.shipments.invoiceId),
        isNull(schema.partners.closingDay),
      ),
    )
    .orderBy(asc(schema.shipments.deliveryNoteNumber))
    .all();
  const clock = new DayClock(day.date, 17);
  for (const s of shipments) {
    const at = clock.next();
    const draft = session.ask(draftInvoice, { shipmentId: s.id }, at);
    if (!draft) continue;
    // 返品伝票を載せると合計がマイナスになるときは、返品は次の請求書に回す
    const returns = draft.preview
      ? draft.returns
          .filter((r) => draft.selectedReturnIds.includes(r.id))
          .map((r) => ({ id: r.id, version: r.version }))
      : [];
    session.run(
      issueInvoiceCommand,
      {
        shipmentId: s.id,
        version: s.version,
        returns,
        issuedOn: day.date,
        dueOn: addDays(day.date, DUE_DAYS),
      },
      day.index % 2 === 0 ? "accounting1" : "accounting2",
      at,
      `請求書（${draft.customer.name}）`,
    );
  }
}

/**
 * 締め日のある販売先：締め日の翌日から3日間に、締め日を迎えた期間の請求書を締め処理でまとめて発行する
 * （発行日は締め日）。今日は締め処理をしない
 */
function closeMonth(session: SeedSession, day: SeedDay): void {
  if (day.isToday) return;
  // 締め日は 20日・25日・月末（scale の取引先の取引条件）。その翌日から3日間だけ調べる
  if (![21, 22, 23, 26, 27, 28, 1, 2, 3].includes(Number(day.date.slice(8, 10)))) return;
  const clock = new DayClock(day.date, 9);
  const at = clock.next();
  const candidates = session.ask(listClosingCandidates, {}, at)?.candidates ?? [];
  const targets = candidates
    .filter((c) => c.ready && c.error === null && c.shipments.length > 0 && c.periodTo < day.date)
    .map((c) => ({
      customerId: c.customerId,
      periodFrom: c.periodFrom,
      periodTo: c.periodTo,
      shipments: c.shipments.map((s) => ({ id: s.id, version: s.version })),
      returns: c.returns.map((r) => ({ id: r.id, version: r.version })),
    }));
  for (let i = 0; i < targets.length; i += 50) {
    session.run(
      closeInvoices,
      { targets: targets.slice(i, i + 50) },
      "accounting1",
      clock.next(),
      `締め処理（${targets.length}件）`,
    );
  }
}

/** 前日に請求書に載った返品伝票の一部に、返還請求書を発行する */
function issueCreditNotes(session: SeedSession, day: SeedDay): void {
  const returns = session.db
    .select({
      id: schema.salesReturns.id,
      number: schema.salesReturns.number,
      version: schema.salesReturns.version,
    })
    .from(schema.salesReturns)
    .innerJoin(schema.invoices, eq(schema.invoices.id, schema.salesReturns.invoiceId))
    .where(
      and(
        eq(schema.invoices.issuedOn, addDays(day.date, -1)),
        eq(schema.salesReturns.cancelled, false),
        isNull(schema.salesReturns.creditNoteNumber),
      ),
    )
    .orderBy(asc(schema.salesReturns.number))
    .all();
  const clock = new DayClock(day.date, 13);
  for (const r of returns) {
    if (!session.random("credit-note", r.number).chance(0.4)) continue;
    session.run(
      issueCreditNote,
      { salesReturnId: r.id, version: r.version, issuedOn: day.date },
      "accounting2",
      clock.next(),
      `返還請求書（${r.number}）`,
    );
  }
}

interface OpenInvoice {
  readonly id: string;
  readonly number: string;
  readonly version: number;
  readonly customerId: string;
  readonly total: number;
  readonly allocated: number;
  readonly status: string;
  readonly dueOn: string | null;
  readonly monthly: boolean;
}

/** 請求書ごとの入金の仕方（請求書番号で決まる） */
function payPlan(session: SeedSession, invoice: OpenInvoice) {
  const r = session.random("receivable", invoice.number);
  return {
    /** 期限を過ぎても入金しない */
    never: r.chance(0.015),
    /** 半分だけ入金し、残りは30日後（半分は入金しないまま） */
    partial: r.chance(0.03),
    rest: r.chance(0.5),
    /** 期限より10日遅れて入金する */
    late: r.chance(0.05),
  };
}

/**
 * 入金と消込。販売先ごとに1件の入金にまとめ、入金を記録してから請求書に消し込む。
 * 締め日のない販売先は決まった曜日に翌週までの期限の分を、締め日のある販売先は期限の日に払う
 */
function receivePayments(session: SeedSession, world: World, day: SeedDay): void {
  const db = session.db;
  const rows: OpenInvoice[] = db
    .select({
      id: schema.invoices.id,
      number: schema.invoices.number,
      version: schema.invoices.version,
      customerId: schema.invoices.customerId,
      total: schema.invoices.total,
      allocated: schema.invoices.allocated,
      status: schema.invoices.status,
      dueOn: schema.invoices.dueOn,
      periodTo: schema.invoices.periodTo,
    })
    .from(schema.invoices)
    .where(
      and(
        inList(schema.invoices.status, ["unpaid", "partial"]),
        isNotNull(schema.invoices.dueOn),
        lte(schema.invoices.dueOn, addDays(day.date, 6)),
      ),
    )
    .orderBy(asc(schema.invoices.customerId), asc(schema.invoices.number))
    .all()
    .map((r) => Object.assign(r, { monthly: r.periodTo !== null }));
  const names = new Map(world.customers.map((c) => [c.id, c.name]));
  const byCustomer = new Map<string, { invoice: OpenInvoice; amount: number }[]>();
  for (const invoice of rows) {
    const due = invoice.dueOn ?? day.date;
    const plan = payPlan(session, invoice);
    if (plan.never) continue;
    const name = names.get(invoice.customerId) ?? invoice.customerId;
    // 締め日のない販売先は、曜日を決めて週に1回払う（翌週までに期限の来る分をまとめて）
    const payday = session.random("payday", name).int(1, 5);
    const outstanding = invoice.total - invoice.allocated;
    if (outstanding <= 0) continue;
    let amount = outstanding;
    if (invoice.status === "partial") {
      if (!plan.rest || addDays(due, 30) > day.date) continue;
    } else {
      const payOn = plan.late ? addDays(due, 10) : due;
      const ready = invoice.monthly
        ? payOn <= day.date
        : plan.late
          ? payOn <= day.date
          : weekday(day.date) === payday || due < day.date;
      if (!ready) continue;
      if (plan.partial) amount = Math.floor(outstanding / 2);
    }
    if (amount <= 0) continue;
    const list = byCustomer.get(invoice.customerId) ?? [];
    list.push({ invoice, amount });
    byCustomer.set(invoice.customerId, list);
  }
  const clock = new DayClock(day.date, 10);
  const credits = openCredits(session, [...byCustomer.keys()]);
  for (const [customerId, all] of byCustomer) {
    // 返還額があれば先に請求書へ充て、残りを振り込んでもらう
    applyCredits(
      session,
      credits.filter((c) => c.customerId === customerId),
      all,
      clock,
      names.get(customerId) ?? customerId,
    );
    const list = all.filter((b) => b.amount > 0);
    for (let i = 0; i < list.length; i += 200) {
      const batch = list.slice(i, i + 200);
      const r = session.random("payment", names.get(customerId) ?? "", day.date, i);
      const last = batch[batch.length - 1];
      // ごく一部は振込手数料を差し引いて振り込まれる（最後の請求書の差額にする）
      const fee = last && last.amount > 2000 && r.chance(0.04) ? r.pick(BANK_FEES) : 0;
      const total = batch.reduce((s, b) => s + b.amount, 0) - fee;
      if (total <= 0) continue;
      const at = clock.next();
      const created = session.run(
        createCustomerPayment,
        {
          customerId,
          receivedOn: day.date,
          amount: total,
          method: r.chance(0.9) ? "transfer" : r.pick(["cash", "other"] as const),
          memo: fee > 0 ? "振込手数料は先方負担で差し引き" : null,
          allocations: [],
        },
        "accounting1",
        at,
        `入金（${names.get(customerId) ?? customerId}）`,
      );
      if (!created) continue;
      session.run(
        allocateCustomerPayment,
        {
          paymentId: created.id,
          version: 1,
          allocations: batch.map((b) => {
            const isLast = b === last;
            return {
              invoiceId: b.invoice.id,
              // 返還額を充てた請求書は版番号が上がっている
              version: invoiceVersion(session, b.invoice.id),
              amount: isLast ? b.amount - fee : b.amount,
              adjustment: isLast ? fee : 0,
              adjustmentKind: isLast && fee > 0 ? ("bank_fee" as const) : null,
            };
          }),
        },
        "accounting1",
        at,
        `消込（${names.get(customerId) ?? customerId}）`,
      );
    }
  }
}

/** 販売先廃棄：毎週月曜に、最近30日に出荷した販売先のいくつかで廃棄を記録する（請求・在庫には影響しない） */
function recordDisposals(session: SeedSession, world: World, day: SeedDay): void {
  if (weekday(day.date) !== 1) return;
  const db = session.db;
  const shipped = db
    .select({
      customerId: schema.salesOrders.customerId,
      itemId: schema.salesOrderLines.itemId,
    })
    .from(schema.shipments)
    .innerJoin(schema.salesOrders, eq(schema.salesOrders.id, schema.shipments.salesOrderId))
    .innerJoin(
      schema.salesOrderLines,
      eq(schema.salesOrderLines.salesOrderId, schema.shipments.salesOrderId),
    )
    .where(
      and(
        eq(schema.shipments.cancelled, false),
        lte(schema.shipments.shippedOn, day.date),
        sql`${schema.shipments.shippedOn} >= ${addDays(day.date, -30)}`,
      ),
    )
    .all();
  const itemsByCustomer = new Map<string, string[]>();
  for (const s of shipped) {
    const list = itemsByCustomer.get(s.customerId) ?? [];
    if (!list.includes(s.itemId)) list.push(s.itemId);
    itemsByCustomer.set(s.customerId, list);
  }
  const candidates = world.customers.filter((c) => itemsByCustomer.has(c.id));
  if (candidates.length === 0) return;
  const r = session.random("disposals", day.date);
  const clock = new DayClock(day.date, 15);
  const picked = r.weightedSample(candidates, r.int(1, 2), (c) => c.weight);
  for (const customer of picked) {
    const items = (itemsByCustomer.get(customer.id) ?? []).toSorted();
    const lines = r
      .weightedSample(items, Math.min(items.length, r.int(1, 3)), () => 1)
      .map((itemId) => ({
        itemId,
        quantity: r.int(1, 3),
        reason: r.pick(["expired", "expired", "damaged", "other", null] as const),
      }));
    session.run(
      createDisposal,
      {
        customerId: customer.id,
        disposedOn: day.date,
        contactName: customer.contactName,
        memo: null,
        lines,
      },
      "sales2",
      clock.next(),
      `販売先廃棄（${customer.name}）`,
    );
  }
}

/** 請求の区分の1日（日曜は呼ばれない） */
export function billingDay(session: SeedSession, world: World, day: SeedDay): void {
  recordSalesReturns(session, day);
  settleUnbilledReturns(session, day);
  closeMonth(session, day);
  issuePerShipment(session, day);
  issueCreditNotes(session, day);
  receivePayments(session, world, day);
  refundCredits(session, day);
  recordDisposals(session, world, day);
}
