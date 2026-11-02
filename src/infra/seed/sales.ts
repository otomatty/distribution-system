/**
 * テストデータの手順（毎日）：受注（税率の混在・送料・単価の修正・メーカー直）、前日の受注の編集と取消、
 * 発送（保管場所ごとの一括発送、欠品の受注の分割と取消）、前日の発送の取消。
 */
import { and, asc, eq, lte } from "drizzle-orm";

import { addDays } from "../../domain/dates";
import {
  cancelSalesOrderCommand,
  createSalesOrder,
  splitSalesOrder,
  updateSalesOrder,
} from "../../usecases/sales/orders";
import {
  bulkShip,
  cancelShipmentCommand,
  shipSalesOrderCommand,
} from "../../usecases/sales/shipments";
import * as schema from "../db/schema";
import type { SeedEmployeeKey } from "./names";
import { placeOrder } from "./purchasing";
import type { Random } from "./random";
import { loadBalances, salesOrderLines, salesOrderVersion } from "./reads";
import { DayClock, dayNumber, weekday, type SeedDay, type SeedSession } from "./session";
import { employeeId, type World, type WorldCustomer, type WorldItem } from "./world";

/** 退職した社員（retired1）が無効になる日（期間の 55% の日）より前か */
export function beforeRetirement(session: SeedSession, day: SeedDay): boolean {
  return day.index < Math.floor(session.period.scale.days * 0.55);
}

const LOT1_QUANTITIES = [1, 2, 3, 4, 5, 6, 8, 10, 12, 20] as const;
const LOT1_WEIGHTS = [20, 18, 14, 10, 8, 10, 6, 6, 5, 3] as const;
const LOT_FACTORS = [1, 2, 3, 5] as const;
const LOT_WEIGHTS = [50, 30, 15, 5] as const;
const LINE_COUNTS = [1, 1, 2, 2, 3, 3, 4, 4, 5, 6, 8] as const;
const MEMOS = [
  "午前着希望",
  "のし紙をつける",
  "店舗の裏口に納品",
  "検品は先方の担当者が行う",
] as const;

function quantityFor(r: Random, item: WorldItem): number {
  if (item.salesMinLot <= 1) {
    const i = r.weighted([...LOT1_QUANTITIES.keys()], (k) => LOT1_WEIGHTS[k] ?? 0);
    return LOT1_QUANTITIES[i] ?? 1;
  }
  // ごく一部は最低ロットの倍数でない数量（警告が出るが登録できる）
  if (r.chance(0.02)) return item.salesMinLot + 1;
  const i = r.weighted([...LOT_FACTORS.keys()], (k) => LOT_WEIGHTS[k] ?? 0);
  return item.salesMinLot * (LOT_FACTORS[i] ?? 1);
}

function salesPerson(session: SeedSession, day: SeedDay, r: Random): SeedEmployeeKey {
  const people: SeedEmployeeKey[] = ["sales1", "sales2", "sales1", "multi1"];
  if (beforeRetirement(session, day)) people.push("retired1");
  return r.pick(people);
}

/** 受注を1件登録する（メーカー直なら、その仕入先への発注も作る） */
function takeOrder(
  session: SeedSession,
  world: World,
  day: SeedDay,
  r: Random,
  customer: WorldCustomer,
  clock: DayClock,
): void {
  const active = world.items.filter((i) => !i.discontinued);
  const makers = world.suppliers.filter(
    (s) => s.maker && !s.archived && s.items.some((i) => !i.discontinued),
  );
  const makerDirect = makers.length > 0 && r.chance(0.04);
  let items: WorldItem[];
  let locationId: string | null = null;
  let supplier = undefined;
  if (makerDirect) {
    supplier = r.weighted(makers, (s) => s.items.reduce((w, i) => w + i.weight, 0));
    const own = supplier.items.filter((i) => !i.discontinued);
    items = r.weightedSample(own, r.int(1, Math.min(3, own.length)), (i) => i.weight);
  } else {
    const homes = [world.locations.main, world.locations.cold, world.locations.second];
    locationId = r.weighted(homes, (l) =>
      active.filter((i) => i.homeId === l).reduce((w, i) => w + i.weight, 0),
    );
    const here = active.filter((i) => i.homeId === locationId);
    if (here.length === 0) return;
    items = r.weightedSample(here, Math.min(r.pick(LINE_COUNTS), here.length), (i) => i.weight);
  }
  const lines = items.map((item) => {
    const discount = r.chance(0.02);
    return {
      itemId: item.id,
      quantity: quantityFor(r, item),
      unitPriceCenti: discount
        ? Math.round((item.salesPriceCenti * 0.9) / 1000) * 1000
        : item.salesPriceCenti,
      priceOverrideReason: discount ? "数量値引き（先方と合意済み）" : null,
    };
  });
  const cold = items.some((i) => i.zone !== "ambient");
  const charges = r.chance(0.25)
    ? [
        {
          description: "送料",
          quantity: 1,
          unitAmount: r.pick([500, 800, 1000, 1200] as const),
          taxCategory: "standard" as const,
        },
        ...(cold
          ? [
              {
                description: "クール便料金",
                quantity: 1,
                unitAmount: 330,
                taxCategory: "standard" as const,
              },
            ]
          : []),
      ]
    : [];
  let deliveryRequestedOn: string | null = r.chance(0.1) ? null : addDays(day.date, r.int(1, 4));
  if (deliveryRequestedOn !== null && weekday(deliveryRequestedOn) === 0)
    deliveryRequestedOn = addDays(deliveryRequestedOn, 1);
  const person = salesPerson(session, day, r);
  const created = session.run(
    createSalesOrder,
    {
      customerId: customer.id,
      orderedOn: day.date,
      customerContactName: customer.contactName && r.chance(0.5) ? customer.contactName : null,
      makerDirect,
      locationId,
      employeeId: employeeId(world, person),
      deliveryRequestedOn,
      shipPlannedOn: null,
      memo: r.chance(0.05) ? r.pick(MEMOS) : null,
      lines,
      charges,
    },
    person,
    clock.next(),
    `受注（${customer.name}）`,
  );
  if (!created || !makerDirect || !supplier) return;
  // メーカー直：販売先へ直送してもらう発注を作る（在庫には入らない）
  placeOrder(
    session,
    world,
    day,
    supplier,
    { kind: "customer", customerId: customer.id },
    items.map((item, i) => ({
      item,
      quantity: Math.max(
        item.purchaseMinLot,
        Math.ceil((lines[i]?.quantity ?? 1) / item.unitsPerPurchaseUnit),
      ),
    })),
    clock,
    created.number,
  );
}

/** その日の受注（平日は scale の件数、土曜は半分、日曜は休み） */
export function takeOrders(session: SeedSession, world: World, day: SeedDay): void {
  const w = weekday(day.date);
  if (w === 0) return;
  const r = session.random("orders", day.date);
  const count = r.poisson(session.period.scale.salesOrdersPerWeekday * (w === 6 ? 0.5 : 1));
  const customers = world.customers.filter((c) => !c.archived);
  if (customers.length === 0) return;
  const clock = new DayClock(day.date, 11);
  for (let k = 0; k < count; k += 1) {
    const rk = session.random("order", day.date, k);
    takeOrder(
      session,
      world,
      day,
      rk,
      rk.weighted(customers, (c) => c.weight),
      clock,
    );
  }
}

/** 前日の受注のごく一部を、販売先の都合で取り消す・数量を変える */
export function changeOrders(session: SeedSession, world: World, day: SeedDay): void {
  const db = session.db;
  const orders = db
    .select()
    .from(schema.salesOrders)
    .where(
      and(
        eq(schema.salesOrders.status, "received"),
        eq(schema.salesOrders.orderedOn, addDays(day.date, -1)),
      ),
    )
    .orderBy(asc(schema.salesOrders.number))
    .all();
  const clock = new DayClock(day.date, 13);
  for (const o of orders) {
    if (o.splitFromId !== null) continue;
    const r = session.random("order-change", o.number);
    const cancel = r.chance(0.015);
    const edit = r.chance(0.03);
    if (cancel) {
      session.run(
        cancelSalesOrderCommand,
        { id: o.id, version: o.version, reason: "先方の都合により取消" },
        "sales2",
        clock.next(),
        `受注の取消（${o.number}）`,
      );
      continue;
    }
    if (!edit || o.makerDirect) continue;
    const lines = salesOrderLines(db, o.id);
    const charges = db
      .select()
      .from(schema.salesCharges)
      .where(eq(schema.salesCharges.salesOrderId, o.id))
      .orderBy(asc(schema.salesCharges.id))
      .all();
    session.run(
      updateSalesOrder,
      {
        id: o.id,
        version: o.version,
        fields: {
          customerId: o.customerId,
          orderedOn: o.orderedOn,
          customerContactName: o.customerContactName,
          makerDirect: o.makerDirect,
          locationId: o.locationId,
          employeeId: o.employeeId,
          deliveryRequestedOn: o.deliveryRequestedOn,
          shipPlannedOn: o.shipPlannedOn,
          memo: o.memo ?? "数量の変更の連絡あり",
          lines: lines.map((l, i) => ({
            itemId: l.itemId,
            quantity:
              i === 0 ? l.quantity + (world.itemsById.get(l.itemId)?.salesMinLot ?? 1) : l.quantity,
            unitPriceCenti: l.unitPriceCenti,
            priceOverrideReason: l.priceOverrideReason,
          })),
          charges: charges.map((c) => ({
            description: c.description,
            quantity: c.quantity,
            unitAmount: c.unitAmount,
            taxCategory: c.taxCategory,
          })),
        },
      },
      "sales2",
      clock.next(),
      `受注の編集（${o.number}）`,
    );
  }
}

interface DueOrder {
  readonly id: string;
  readonly number: string;
  readonly version: number;
  readonly makerDirect: boolean;
  readonly locationId: string | null;
  readonly shipPlannedOn: string;
}

/**
 * 出荷予定日になった受注を発送する。保管場所ごとに、受注番号の順に在庫が足りるものを一括発送する。
 * 在庫が足りない受注は待ち、3日以上遅れたら足りない分を分割して先に発送し、14日以上遅れたら取り消す。
 * 今日の出荷予定の6割は、発送リストで操作できるように残す。
 */
export function shipOrders(session: SeedSession, day: SeedDay): void {
  const db = session.db;
  const due: DueOrder[] = db
    .select({
      id: schema.salesOrders.id,
      number: schema.salesOrders.number,
      version: schema.salesOrders.version,
      makerDirect: schema.salesOrders.makerDirect,
      locationId: schema.salesOrders.locationId,
      shipPlannedOn: schema.salesOrders.shipPlannedOn,
    })
    .from(schema.salesOrders)
    .where(
      and(
        eq(schema.salesOrders.status, "received"),
        lte(schema.salesOrders.shipPlannedOn, day.date),
      ),
    )
    .orderBy(asc(schema.salesOrders.number))
    .all()
    .filter(
      (o) =>
        !(
          day.isToday &&
          o.shipPlannedOn === day.date &&
          !session.random("ship", o.number).chance(0.4)
        ),
    );
  const clock = new DayClock(day.date, 10);
  const shipper: SeedEmployeeKey = weekday(day.date) % 2 === 0 ? "warehouse1" : "sales1";
  for (const o of due.filter((x) => x.makerDirect)) {
    session.run(
      shipSalesOrderCommand,
      { id: o.id, version: o.version, shippedOn: day.date },
      shipper,
      clock.next(),
      `発送（${o.number}）`,
    );
  }
  const byLocation = new Map<string, DueOrder[]>();
  for (const o of due) {
    if (o.makerDirect || o.locationId === null) continue;
    byLocation.set(o.locationId, [...(byLocation.get(o.locationId) ?? []), o]);
  }
  for (const [locationId, orders] of byLocation) {
    const lines = new Map(orders.map((o) => [o.id, salesOrderLines(db, o.id)]));
    const itemIds = [...new Set([...lines.values()].flat().map((l) => l.itemId))];
    const balances = loadBalances(db, locationId, itemIds);
    const onHand = new Map(itemIds.map((id) => [id, balances.get(id, locationId).onHand]));
    const shippable: DueOrder[] = [];
    const short: DueOrder[] = [];
    for (const o of orders) {
      const ls = lines.get(o.id) ?? [];
      if (ls.every((l) => (onHand.get(l.itemId) ?? 0) >= l.quantity)) {
        for (const l of ls) onHand.set(l.itemId, (onHand.get(l.itemId) ?? 0) - l.quantity);
        shippable.push(o);
      } else short.push(o);
    }
    for (let i = 0; i < shippable.length; i += 200) {
      session.run(
        bulkShip,
        {
          orders: shippable.slice(i, i + 200).map((o) => ({ id: o.id, version: o.version })),
          shippedOn: day.date,
        },
        shipper,
        clock.next(),
        `一括発送（${shippable[i]?.number ?? ""} ほか）`,
      );
    }
    for (const o of short) handleShortage(session, day, o, locationId, clock, shipper);
  }
}

/** 在庫が足りない受注：遅れが小さければ待ち、3日以上なら分割して先に発送、14日以上なら取り消す */
function handleShortage(
  session: SeedSession,
  day: SeedDay,
  order: DueOrder,
  locationId: string,
  clock: DayClock,
  shipper: SeedEmployeeKey,
): void {
  const late = dayNumber(day.date) - dayNumber(order.shipPlannedOn);
  if (late < 3) return;
  const db = session.db;
  if (late >= 14) {
    session.run(
      cancelSalesOrderCommand,
      { id: order.id, version: order.version, reason: "欠品が続いたため、先方と相談のうえ取消" },
      "sales2",
      clock.next(),
      `欠品の受注の取消（${order.number}）`,
    );
    return;
  }
  const lines = salesOrderLines(db, order.id);
  const balances = loadBalances(
    db,
    locationId,
    lines.map((l) => l.itemId),
  );
  const moves = lines.flatMap((l) => {
    const have = Math.max(0, balances.get(l.itemId, locationId).onHand);
    return have >= l.quantity ? [] : [{ lineId: l.id, quantity: l.quantity - have }];
  });
  const moved = moves.reduce((s, m) => s + m.quantity, 0);
  const total = lines.reduce((s, l) => s + l.quantity, 0);
  if (moves.length === 0 || moved >= total) return;
  const split = session.run(
    splitSalesOrder,
    { id: order.id, version: order.version, moves, shipPlannedOn: addDays(day.date, 3) },
    "sales1",
    clock.next(),
    `欠品の分割（${order.number}）`,
  );
  if (!split) return;
  session.run(
    shipSalesOrderCommand,
    { id: order.id, version: salesOrderVersion(db, order.id), shippedOn: day.date },
    shipper,
    clock.next(),
    `分割した残りの発送（${order.number}）`,
  );
}

/** 前日の発送のごく一部を取り消す（数量の誤りなど）。受注は受注済みに戻り、翌日以降に発送し直す */
export function cancelMistakenShipments(session: SeedSession, day: SeedDay): void {
  const shipments = session.db
    .select({
      id: schema.shipments.id,
      version: schema.shipments.version,
      number: schema.shipments.deliveryNoteNumber,
    })
    .from(schema.shipments)
    .where(
      and(
        eq(schema.shipments.shippedOn, addDays(day.date, -1)),
        eq(schema.shipments.cancelled, false),
      ),
    )
    .orderBy(asc(schema.shipments.deliveryNoteNumber))
    .all();
  const clock = new DayClock(day.date, 15);
  for (const s of shipments) {
    if (!session.random("shipment-cancel", s.number).chance(0.003)) continue;
    session.run(
      cancelShipmentCommand,
      { shipmentId: s.id, version: s.version, reason: "数量の誤りのため発送を取り消し" },
      "sales1",
      clock.next(),
      `発送の取消（${s.number}）`,
    );
  }
}
