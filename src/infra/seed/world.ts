/**
 * 取引を作るときに使うマスタと、その性質（売れ行き・置き場所・発注の間隔など）。
 * 性質は商品コード・取引先名から乱数で決めるので、何回に分けて投入しても同じになる。
 */
import type { ClosingTerms } from "../../domain/dates";
import * as schema from "../db/schema";
import { employeeEmail, SEED_LOCATIONS, type ItemSpec, type SeedLocationKey } from "./names";
import { randomFor } from "./random";
import { SEED, type SeedScale } from "./scale";
import type { SeedSession } from "./session";

/** 平均の明細数（受注1件あたり）と、平均の数量（販売単位） */
const LINES_PER_ORDER = 3.5;
const QUANTITY_MEAN_LOT1 = 4.66;
const QUANTITY_MEAN_LOT_FACTOR = 1.8;

/** 商品の売れ行きの重み（商品コードの番号から決める。少数の商品がよく売れる） */
export function itemWeight(index: number): number {
  return 1 / (0.05 + randomFor(SEED, "weight", index).next());
}

/** 商品の置き場所：冷蔵・冷凍は冷蔵倉庫、常温は本社倉庫（2割は第二倉庫） */
export function itemHome(index: number, zone: string): SeedLocationKey {
  if (zone !== "ambient") return "cold";
  return randomFor(SEED, "home", index).chance(0.2) ? "second" : "main";
}

function meanQuantity(salesMinLot: number): number {
  return salesMinLot > 1 ? salesMinLot * QUANTITY_MEAN_LOT_FACTOR : QUANTITY_MEAN_LOT1;
}

/** 1日あたり（暦日）の販売数の見込み */
export function dailyDemand(
  scale: SeedScale,
  index: number,
  salesMinLot: number,
  totalWeight: number,
): number {
  const linesPerDay = (scale.salesOrdersPerWeekday * 5.5 * LINES_PER_ORDER) / 7;
  return (linesPerDay * itemWeight(index) * meanQuantity(salesMinLot)) / totalWeight;
}

export function specDemand(scale: SeedScale, specs: readonly ItemSpec[]) {
  const total = specs.reduce((s, x) => s + itemWeight(x.index), 0);
  return (spec: ItemSpec) => dailyDemand(scale, spec.index, spec.salesMinLot, total);
}

/** IT000123 → 122（自動採番した商品の作った順）。それ以外は null */
function seedIndex(code: string): number | null {
  const m = /^IT(\d{6})$/.exec(code);
  return m ? Number(m[1]) - 1 : null;
}

export interface WorldItem {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly supplierId: string;
  readonly taxCategory: "standard" | "reduced";
  readonly unitsPerPurchaseUnit: number;
  readonly purchasePriceCenti: number;
  readonly salesPriceCenti: number;
  readonly purchaseMinLot: number;
  readonly salesMinLot: number;
  readonly leadTimeDays: number;
  readonly discontinued: boolean;
  readonly zone: string;
  readonly weight: number;
  readonly homeId: string;
  readonly home: SeedLocationKey;
  readonly demand: number;
}

export interface WorldSupplier {
  readonly id: string;
  readonly name: string;
  readonly maker: boolean;
  readonly email: string | null;
  readonly sendMethod: "email" | "none";
  readonly terms: ClosingTerms | null;
  readonly archived: boolean;
  /** 発注の間隔（暦日）と、どの日に発注するか */
  readonly cycle: number;
  readonly offset: number;
  readonly items: WorldItem[];
}

export interface WorldCustomer {
  readonly id: string;
  readonly name: string;
  readonly weight: number;
  readonly deliveryDays: number;
  readonly contactName: string | null;
  readonly archived: boolean;
  readonly monthly: boolean;
}

export interface World {
  readonly items: readonly WorldItem[];
  readonly itemsById: ReadonlyMap<string, WorldItem>;
  readonly suppliers: readonly WorldSupplier[];
  readonly suppliersById: ReadonlyMap<string, WorldSupplier>;
  readonly customers: readonly WorldCustomer[];
  readonly locations: Readonly<Record<SeedLocationKey, string>>;
  readonly stores: readonly string[];
  /** 社員のメールアドレス → ID */
  readonly employees: ReadonlyMap<string, string>;
}

const CYCLES = [3, 4, 7, 10, 14] as const;

export function loadWorld(session: SeedSession): World {
  const db = session.db;
  const locationRows = db
    .select({ id: schema.locations.id, name: schema.locations.name })
    .from(schema.locations)
    .all();
  const locationId = (key: SeedLocationKey): string => {
    const name = SEED_LOCATIONS.find((l) => l.key === key)?.name;
    const row = locationRows.find((l) => l.name === name);
    if (!row)
      throw new Error(`保管場所「${name ?? key}」がありません。マスタの手順から実行してください`);
    return row.id;
  };
  const locations = {
    main: locationId("main"),
    cold: locationId("cold"),
    second: locationId("second"),
  };
  const itemRows = db.select().from(schema.items).all();
  const seedItems = itemRows.flatMap((r) => {
    const index = seedIndex(r.code);
    return index === null ? [] : [{ r, index }];
  });
  const totalWeight = seedItems.reduce((s, x) => s + itemWeight(x.index), 0);
  const items: WorldItem[] = seedItems
    .map(({ r, index }) => {
      const home = itemHome(index, r.temperatureZone);
      return {
        id: r.id,
        code: r.code,
        name: r.name,
        supplierId: r.supplierId,
        taxCategory: r.taxCategory,
        unitsPerPurchaseUnit: r.unitsPerPurchaseUnit,
        purchasePriceCenti: r.purchasePriceCenti,
        salesPriceCenti: r.salesPriceCenti,
        purchaseMinLot: r.purchaseMinLot,
        salesMinLot: r.salesMinLot,
        leadTimeDays: r.leadTimeDays ?? 3,
        discontinued: r.discontinued,
        zone: r.temperatureZone,
        weight: itemWeight(index),
        home,
        homeId: locations[home],
        demand: dailyDemand(session.period.scale, index, r.salesMinLot, totalWeight),
      };
    })
    .toSorted((a, b) => a.code.localeCompare(b.code));
  const partnerRows = db
    .select()
    .from(schema.partners)
    .all()
    .toSorted((a, b) => a.name.localeCompare(b.name));
  const supplierRows = partnerRows.filter((p) => p.isSupplier);
  const supplierWeight = new Map<string, number>();
  for (const i of items)
    supplierWeight.set(i.supplierId, (supplierWeight.get(i.supplierId) ?? 0) + i.weight);
  const ranked = supplierRows
    .map((s) => s.id)
    .toSorted(
      (a, b) => (supplierWeight.get(b) ?? 0) - (supplierWeight.get(a) ?? 0) || a.localeCompare(b),
    );
  const rank = new Map(ranked.map((id, i) => [id, i / Math.max(1, ranked.length)]));
  const suppliers: WorldSupplier[] = supplierRows.map((s) => {
    const r = rank.get(s.id) ?? 1;
    const cycle =
      r < 0.1
        ? CYCLES[0]
        : r < 0.3
          ? CYCLES[1]
          : r < 0.6
            ? CYCLES[2]
            : r < 0.85
              ? CYCLES[3]
              : CYCLES[4];
    const terms =
      s.closingDay !== null && s.paymentMonthOffset !== null && s.paymentDay !== null
        ? {
            closingDay: s.closingDay,
            paymentMonthOffset: s.paymentMonthOffset,
            paymentDay: s.paymentDay,
          }
        : null;
    return {
      id: s.id,
      name: s.name,
      maker: /水産|農園|酒造|牧場|茶園/.test(s.name),
      email: s.email,
      sendMethod: s.defaultSendMethod,
      terms,
      archived: s.archived,
      cycle,
      offset: randomFor(SEED, "cycle", s.name).int(0, cycle - 1),
      items: items.filter((i) => i.supplierId === s.id),
    };
  });
  const customers: WorldCustomer[] = partnerRows
    .filter((p) => p.isCustomer)
    .map((p) => ({
      id: p.id,
      name: p.name,
      weight: 1 / (0.03 + randomFor(SEED, "customer", p.name).next()),
      deliveryDays: p.deliveryDays,
      contactName: p.contactName,
      archived: p.archived,
      monthly: p.closingDay !== null,
    }));
  const stores = db
    .select({ id: schema.stores.id, name: schema.stores.name, order: schema.stores.displayOrder })
    .from(schema.stores)
    .all()
    .toSorted((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    .map((s) => s.id);
  const employees = new Map(
    db
      .select({ id: schema.employees.id, email: schema.employees.email })
      .from(schema.employees)
      .all()
      .map((e) => [e.email, e.id]),
  );
  return {
    items,
    itemsById: new Map(items.map((i) => [i.id, i])),
    suppliers,
    suppliersById: new Map(suppliers.map((s) => [s.id, s])),
    customers,
    locations,
    stores,
    employees,
  };
}

/** 社員の ID（受注・発注の社内の担当者） */
export function employeeId(world: World, key: Parameters<typeof employeeEmail>[0]): string | null {
  return world.employees.get(employeeEmail(key)) ?? null;
}

/** 発注で目指す在庫の量（販売単位）：次の発注までと、リードタイムの分に余裕を足す */
export function targetStock(item: WorldItem, supplier: WorldSupplier): number {
  const days = supplier.cycle + item.leadTimeDays + 5;
  return Math.max(item.unitsPerPurchaseUnit, Math.ceil(item.demand * days + 2 * lumpOf(item)));
}

/**
 * 発注する在庫の水準（販売単位）：次の発注の分の入荷までに売れる見込み。これを下回ったら発注する。
 * 売れ行きの遅い商品でも1件の受注でまとめて出るので、受注1件分の数量の余裕を足す。
 */
export function reorderLevel(item: WorldItem, supplier: WorldSupplier): number {
  return item.demand * (supplier.cycle + item.leadTimeDays + 2) + lumpOf(item);
}

/** 受注1件の明細の数量の目安（多めの値） */
function lumpOf(item: WorldItem): number {
  return item.salesMinLot > 1 ? item.salesMinLot * 3 : 10;
}
