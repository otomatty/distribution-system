/**
 * テストデータの手順：初期在庫、毎日の在庫操作（第二倉庫への移動、店舗払い出し、サンプル・処分・調整）、
 * 月末の棚卸（保管場所を順番に）。
 */
import { addDays, monthOf, monthRange } from "../../domain/dates";
import { createStockOperation } from "../../usecases/stock/operations";
import { createStocktake } from "../../usecases/stock/stocktaking";
import { loadBalances } from "./reads";
import { DayClock, weekday, type SeedDay, type SeedSession } from "./session";
import { targetStock, type World } from "./world";

const LINES_PER_OPERATION = 300;

/** 初期在庫（期間の始まりの日に、理由「初期在庫」の調整で入れる） */
export function seedInitialStock(session: SeedSession, world: World): void {
  const clock = new DayClock(session.period.from, 8);
  for (const locationId of [world.locations.main, world.locations.cold, world.locations.second]) {
    const lines = world.items
      .filter((i) => i.homeId === locationId && !i.discontinued)
      .map((item) => {
        const supplier = world.suppliersById.get(item.supplierId);
        const base = supplier ? targetStock(item, supplier) : item.unitsPerPurchaseUnit;
        return {
          itemId: item.id,
          quantity: Math.ceil(base / item.unitsPerPurchaseUnit) * item.unitsPerPurchaseUnit,
        };
      });
    for (let i = 0; i < lines.length; i += LINES_PER_OPERATION) {
      session.run(
        createStockOperation,
        {
          kind: "adjustment",
          reason: "initial",
          operationDate: session.period.from,
          locationId,
          memo: "初期在庫",
          lines: lines.slice(i, i + LINES_PER_OPERATION),
        },
        "warehouse1",
        clock.next(),
        "初期在庫",
      );
    }
  }
}

/** 本社倉庫で受けた第二倉庫の商品を、第二倉庫へ移す（毎日） */
export function transferToSecond(session: SeedSession, world: World, day: SeedDay): void {
  const main = world.locations.main;
  const items = world.items.filter((i) => i.home === "second");
  const balances = loadBalances(
    session.db,
    main,
    items.map((i) => i.id),
  );
  const lines = items.flatMap((i) => {
    const b = balances.get(i.id, main);
    const quantity = b.onHand - b.allocated;
    return quantity > 0 ? [{ itemId: i.id, quantity }] : [];
  });
  const clock = new DayClock(day.date, 9);
  for (let i = 0; i < lines.length; i += LINES_PER_OPERATION) {
    session.run(
      createStockOperation,
      {
        kind: "transfer",
        operationDate: day.date,
        locationId: main,
        toLocationId: world.locations.second,
        memo: "入荷した第二倉庫の商品を移動",
        lines: lines.slice(i, i + LINES_PER_OPERATION),
      },
      "warehouse1",
      clock.next(),
      "第二倉庫への移動",
    );
  }
}

/** 店舗払い出し（月・水・金）、サンプル（木）、処分（毎月1日以降の最初の営業日）、数え直しの調整（毎月15日ごろ） */
export function stockOperations(session: SeedSession, world: World, day: SeedDay): void {
  const w = weekday(day.date);
  const main = world.locations.main;
  const clock = new DayClock(day.date, 16);
  const mainItems = world.items.filter((i) => i.homeId === main && !i.discontinued);
  const balances = loadBalances(session.db, main);
  // 同じ日の払い出しで使った数（店舗ごとに同じ商品を選ぶことがある）
  const used = new Map<string, number>();
  const available = (itemId: string) => {
    const b = balances.get(itemId, main);
    return b.onHand - b.allocated - (used.get(itemId) ?? 0);
  };
  if ((w === 1 || w === 3 || w === 5) && mainItems.length > 0) {
    for (const [s, storeId] of world.stores.entries()) {
      const r = session.random("store-transfer", day.date, s);
      const picked = r.weightedSample(mainItems, r.int(3, 8), (i) => i.weight);
      const lines = picked.flatMap((i) => {
        const quantity = r.int(1, 6);
        if (available(i.id) < quantity) return [];
        used.set(i.id, (used.get(i.id) ?? 0) + quantity);
        return [{ itemId: i.id, quantity }];
      });
      if (lines.length === 0) continue;
      session.run(
        createStockOperation,
        {
          kind: "store_transfer",
          operationDate: day.date,
          locationId: main,
          storeId,
          memo: null,
          lines,
        },
        "warehouse1",
        clock.next(),
        "店舗払い出し",
      );
    }
  }
  const r = session.random("adjustments", day.date);
  if (w === 4 && mainItems.length > 0) {
    const item = r.weighted(mainItems, (i) => i.weight);
    if (available(item.id) >= 1) {
      session.run(
        createStockOperation,
        {
          kind: "adjustment",
          reason: "sample",
          operationDate: day.date,
          locationId: main,
          memo: "商談用のサンプル",
          lines: [{ itemId: item.id, quantity: -1 }],
        },
        "sales1",
        clock.next(),
        "サンプル",
      );
    }
  }
  const cold = world.locations.cold;
  const coldItems = world.items.filter((i) => i.homeId === cold && !i.discontinued);
  // 毎月の最初の営業日に、冷蔵倉庫の賞味期限切れを処分する
  const first = `${monthOf(day.date)}-01`;
  if (day.date === (weekday(first) === 0 ? addDays(first, 1) : first) && coldItems.length > 0) {
    const coldBalances = loadBalances(session.db, cold);
    const lines = r
      .weightedSample(coldItems, r.int(1, 3), (i) => i.weight)
      .flatMap((i) => {
        const quantity = r.int(1, 3);
        const b = coldBalances.get(i.id, cold);
        return b.onHand - b.allocated >= quantity ? [{ itemId: i.id, quantity: -quantity }] : [];
      });
    if (lines.length > 0) {
      session.run(
        createStockOperation,
        {
          kind: "adjustment",
          reason: "disposal",
          operationDate: day.date,
          locationId: cold,
          memo: "賞味期限切れのため処分",
          lines,
        },
        "warehouse1",
        clock.next(),
        "処分",
      );
    }
  }
  if (day.date.endsWith("-15") && w !== 0 && mainItems.length > 0) {
    const item = r.weighted(mainItems, (i) => i.weight);
    const quantity = r.chance(0.5) || available(item.id) < 1 ? 1 : -1;
    session.run(
      createStockOperation,
      {
        kind: "adjustment",
        reason: "adjustment",
        operationDate: day.date,
        locationId: main,
        memo: "数え直しの結果",
        lines: [{ itemId: item.id, quantity }],
      },
      "warehouse1",
      clock.next(),
      "在庫の調整",
    );
  }
}

/** 月末（日曜なら前日）に、保管場所を順番に棚卸する。ごく一部の商品に差異を出す */
export function stocktake(session: SeedSession, world: World, day: SeedDay): void {
  let last = monthRange(monthOf(day.date)).to;
  if (weekday(last) === 0) last = addDays(last, -1);
  if (day.date !== last) return;
  const month = Number(day.date.slice(0, 4)) * 12 + Number(day.date.slice(5, 7));
  const locations = [world.locations.main, world.locations.cold, world.locations.second];
  const locationId = locations[month % locations.length];
  if (!locationId) return;
  const balances = loadBalances(session.db, locationId);
  const items = world.items.filter((i) => balances.get(i.id, locationId).onHand > 0);
  const r = session.random("stocktake", day.date);
  const lines = items.map((i) => {
    const onHand = balances.get(i.id, locationId).onHand;
    const counted = r.chance(0.02) ? Math.max(0, onHand + r.pick([-2, -1, 1] as const)) : onHand;
    return { itemId: i.id, counted, expected: onHand };
  });
  if (lines.length === 0) return;
  session.run(
    createStocktake,
    { operationDate: day.date, locationId, memo: "月末の棚卸", lines },
    "warehouse1",
    new DayClock(day.date, 18).next(),
    "棚卸",
  );
}
