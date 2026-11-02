/**
 * テストデータの手順「取引」：期間の1日ずつ、業務の流れの順に操作する。
 * 1日の中の順番：入荷 → 第二倉庫への移動 → 発送 → 受注 → 受注の変更 → 発注 → 仕入返品 → 取消 →
 * 在庫操作 → 棚卸 → 仕入先請求書 → 支払。日曜は休み。
 *
 * 請求の区分（請求書・締め処理・入金と消込・返品伝票・販売先廃棄）は別の手順（billing）として、
 * 取引の手順の後に同じ期間を1日ずつ進めて足す（発送は請求書の発行より前に終わっているため）。
 */
import { and, eq } from "drizzle-orm";

import { addDays } from "../../domain/dates";
import { updateEmployee } from "../../usecases/masters/employees";
import { discontinueItem } from "../../usecases/masters/items";
import { archivePartner } from "../../usecases/masters/partners";
import * as schema from "../db/schema";
import { employeeEmail } from "./names";
import {
  cancelMistakenReceipts,
  cancelOrders,
  paySupplierInvoices,
  purchaseReplenishment,
  receiveDeliveries,
  registerSupplierInvoices,
  returnDefects,
} from "./purchasing";
import { cancelMistakenShipments, changeOrders, shipOrders, takeOrders } from "./sales";
import { DayClock, weekday, type SeedDay, type SeedSession } from "./session";
import { stockOperations, stocktake, transferToSecond } from "./stock";
import { loadWorld, type World } from "./world";

/** 1日の操作。順番に実行する */
const DAILY: readonly ((session: SeedSession, world: World, day: SeedDay) => void)[] = [
  (s, _w, d) => receiveDeliveries(s, d),
  transferToSecond,
  (s, _w, d) => shipOrders(s, d),
  takeOrders,
  changeOrders,
  purchaseReplenishment,
  (s, _w, d) => returnDefects(s, d),
  (s, _w, d) => cancelMistakenReceipts(s, d),
  (s, _w, d) => cancelMistakenShipments(s, d),
  (s, _w, d) => cancelOrders(s, d),
  stockOperations,
  stocktake,
  registerSupplierInvoices,
  (s, _w, d) => paySupplierInvoices(s, d),
];

/** 期間の途中（55% の日）に、取引の終わった販売先・取扱終了の商品・退職した社員を記録する */
function masterChanges(session: SeedSession, world: World, day: SeedDay): boolean {
  if (day.index !== Math.floor(session.period.scale.days * 0.55)) return false;
  const db = session.db;
  const clock = new DayClock(day.date, 8);
  const open = new Set(
    db
      .select({ customerId: schema.salesOrders.customerId })
      .from(schema.salesOrders)
      .where(eq(schema.salesOrders.status, "received"))
      .all()
      .map((x) => x.customerId),
  );
  const customers = world.customers
    .filter((c) => !c.archived && !open.has(c.id))
    .toSorted((a, b) => a.weight - b.weight || a.name.localeCompare(b.name))
    .slice(0, Math.max(1, Math.floor(world.customers.length * 0.01)));
  for (const c of customers) {
    const version =
      db
        .select({ version: schema.partners.version })
        .from(schema.partners)
        .where(eq(schema.partners.id, c.id))
        .get()?.version ?? 1;
    session.run(
      archivePartner,
      { id: c.id, version, archived: true },
      "sales1",
      clock.next(),
      `取引終了（${c.name}）`,
    );
  }
  const items = world.items
    .filter((i) => !i.discontinued)
    .toSorted((a, b) => a.weight - b.weight || a.code.localeCompare(b.code))
    .slice(0, Math.max(1, Math.floor(world.items.length * 0.02)));
  for (const i of items) {
    const version =
      db
        .select({ version: schema.items.version })
        .from(schema.items)
        .where(eq(schema.items.id, i.id))
        .get()?.version ?? 1;
    session.run(
      discontinueItem,
      { id: i.id, version, discontinued: true },
      "purchasing1",
      clock.next(),
      `取扱終了（${i.code}）`,
    );
  }
  const retired = db
    .select()
    .from(schema.employees)
    .where(
      and(eq(schema.employees.email, employeeEmail("retired1")), eq(schema.employees.active, true)),
    )
    .get();
  if (retired) {
    session.run(
      updateEmployee,
      {
        id: retired.id,
        version: retired.version,
        name: retired.name,
        roles: ["sales"],
        active: false,
      },
      "admin",
      clock.next(),
      "退職した社員の無効化",
    );
  }
  return true;
}

/** 取引の手順の chunk 番目（scale.daysPerChunk 日分）。戻り値は画面に出す期間 */
export function runOperations(session: SeedSession, chunk: number): string {
  const { scale, from, today } = session.period;
  const first = chunk * scale.daysPerChunk;
  const last = Math.min(scale.days, first + scale.daysPerChunk) - 1;
  let world = loadWorld(session);
  for (let index = first; index <= last; index += 1) {
    const date = addDays(from, index);
    const day: SeedDay = { date, index, isToday: date === today };
    if (masterChanges(session, world, day)) world = loadWorld(session);
    if (weekday(date) === 0) continue;
    for (const activity of DAILY) activity(session, world, day);
  }
  return `${addDays(from, first)}〜${addDays(from, last)}`;
}
