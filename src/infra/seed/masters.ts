/**
 * テストデータの手順：自社設定・税率表・社員・保管場所・払い出し先店舗・ジャンル、取引先、商品。
 * マスタは取引を作る期間の始まりの1週間前に登録したことにする。
 */
import { addDays } from "../../domain/dates";
import { createEmployee } from "../../usecases/masters/employees";
import { createItem } from "../../usecases/masters/items";
import { createLocation } from "../../usecases/masters/locations";
import { createPartner, updatePartnerTerms } from "../../usecases/masters/partners";
import { addTaxRate, updateCompanySettings } from "../../usecases/masters/settings";
import { genreUsecases, retailStoreUsecases } from "../../usecases/masters/simple-masters";
import * as schema from "../db/schema";
import {
  employeeEmail,
  fictionalAddress,
  fictionalPhone,
  GENRES,
  itemSpecs,
  partnerSpecs,
  SEED_COMPANY,
  SEED_EMPLOYEES,
  SEED_LOCATIONS,
  SEED_STORES,
  type ItemSpec,
  type PartnerSpec,
} from "./names";
import { DayClock, type SeedSession } from "./session";

/** マスタを登録した日（取引の始まりの1週間前） */
export function mastersDate(session: SeedSession): string {
  return addDays(session.period.from, -7);
}

/** 取引先の一覧（毎回同じ内容） */
export function allPartnerSpecs(session: SeedSession): PartnerSpec[] {
  const { suppliers, customers, both } = session.period.scale;
  return partnerSpecs(session.random("partners"), { suppliers, customers, both });
}

export function allItemSpecs(session: SeedSession, partners: readonly PartnerSpec[]): ItemSpec[] {
  const suppliers = partners
    .filter((p) => p.kind !== "customer")
    .map((p) => ({ index: p.index, name: p.name }));
  return itemSpecs(session.random("items"), session.period.scale.items, suppliers);
}

/** 自社設定・税率表・社員・保管場所・払い出し先店舗・ジャンル */
export function seedSettings(session: SeedSession): void {
  const clock = new DayClock(mastersDate(session), 9);
  const company = session.db
    .select({ version: schema.companySettings.version })
    .from(schema.companySettings)
    .get();
  session.run(
    updateCompanySettings,
    { version: company?.version ?? 1, ...SEED_COMPANY, roundingMode: "floor" },
    "admin",
    clock.next(),
    "自社設定",
  );
  // 税率表：初期データ（2019年10月から）がなければ足す
  const rates = session.db.select().from(schema.taxRates).all();
  for (const [category, ratePercent] of [
    ["standard", 10],
    ["reduced", 8],
  ] as const) {
    if (!rates.some((r) => r.category === category && r.effectiveFrom <= session.period.from)) {
      session.run(
        addTaxRate,
        { category, ratePercent, effectiveFrom: "2019-10-01" },
        "admin",
        clock.next(),
        "税率表",
      );
    }
  }
  for (const e of SEED_EMPLOYEES) {
    session.run(
      createEmployee,
      { email: employeeEmail(e.key), name: e.name, roles: [...e.roles] },
      "admin",
      clock.next(),
      `社員 ${e.name}`,
    );
  }
  for (const l of SEED_LOCATIONS) {
    const { postalCode, address } = fictionalAddress(l.n);
    session.run(
      createLocation,
      {
        name: l.name,
        postalCode,
        address,
        phone: fictionalPhone("00", l.n),
        contactName: "倉庫 五郎",
        displayOrder: l.displayOrder,
        memo: l.key === "cold" ? "冷蔵・冷凍の商品を置く" : null,
      },
      "admin",
      clock.next(),
      `保管場所 ${l.name}`,
    );
  }
  for (const [i, name] of SEED_STORES.entries()) {
    session.run(
      retailStoreUsecases.create,
      { name, displayOrder: i + 1 },
      "admin",
      clock.next(),
      `店舗 ${name}`,
    );
  }
  for (const [i, g] of GENRES.entries()) {
    session.run(
      genreUsecases.create,
      { name: g.name, displayOrder: (i + 1) * 10 },
      "admin",
      clock.next(),
      `ジャンル ${g.name}`,
    );
  }
}

/** 取引先（chunk 番目のまとまり）。取引条件と登録番号は経理担当が登録する */
export function seedPartners(session: SeedSession, chunk: number): void {
  const size = session.period.scale.partnersPerChunk;
  const specs = allPartnerSpecs(session).slice(chunk * size, (chunk + 1) * size);
  const clock = new DayClock(mastersDate(session), 10 + (chunk % 6));
  for (const p of specs) {
    const created = session.run(
      createPartner,
      {
        name: p.name,
        kana: p.kana,
        honorific: p.honorific,
        isSupplier: p.kind !== "customer",
        isCustomer: p.kind !== "supplier",
        contactName: p.contactName,
        postalCode: p.postalCode,
        address: p.address,
        phone: p.phone,
        mobile: p.mobile,
        fax: p.fax,
        email: p.email,
        lineId: p.lineId,
        mainContact: p.mainContact,
        deliveryDays: p.deliveryDays,
        defaultSendMethod: p.defaultSendMethod,
        orderMethodNote: p.kind === "customer" ? null : "FAX または メールで発注",
        receiveMethodNote: p.kind === "supplier" ? null : "電話・FAX で受注",
        mailOrderAllowed: p.mailOrderAllowed,
        placeName: p.placeName,
        memo: null,
      },
      p.index % 2 === 0 ? "purchasing1" : "sales1",
      clock.next(),
      `取引先 ${p.name}`,
    );
    if (!created || (p.terms === null && p.registrationNumber === null)) continue;
    session.run(
      updatePartnerTerms,
      {
        id: created.id,
        version: 1,
        terms: {
          registrationNumber: p.registrationNumber,
          closingDay: p.terms?.closingDay ?? null,
          paymentMonthOffset: p.terms?.paymentMonthOffset ?? null,
          paymentDay: p.terms?.paymentDay ?? null,
        },
      },
      "accounting1",
      clock.next(),
      `取引条件 ${p.name}`,
    );
  }
}

/** 1日あたりの販売数の見込み（商品ごと）から、発注点在庫数を決める */
export function reorderPointFor(spec: ItemSpec, dailyDemand: number): number {
  return Math.max(spec.salesMinLot, Math.ceil(dailyDemand * (spec.leadTimeDays + 2)));
}

/** 商品（chunk 番目のまとまり）。商品コードは自動で採番する（IT000001 から） */
export function seedItems(
  session: SeedSession,
  chunk: number,
  dailyDemand: (spec: ItemSpec) => number,
): void {
  const partners = allPartnerSpecs(session);
  const size = session.period.scale.itemsPerChunk;
  const specs = allItemSpecs(session, partners).slice(chunk * size, (chunk + 1) * size);
  const partnerIds = new Map(
    session.db
      .select({ id: schema.partners.id, name: schema.partners.name })
      .from(schema.partners)
      .all()
      .map((p) => [p.name, p.id]),
  );
  const genreIds = new Map(
    session.db
      .select({ id: schema.genres.id, name: schema.genres.name })
      .from(schema.genres)
      .all()
      .map((g) => [g.name, g.id]),
  );
  const clock = new DayClock(mastersDate(session), 13 + (chunk % 5));
  for (const spec of specs) {
    const supplier = partners[spec.supplierIndex];
    const supplierId = supplier ? partnerIds.get(supplier.name) : undefined;
    if (!supplierId) continue;
    const reorderEnabled = session.random("reorder", spec.index).chance(0.6);
    session.run(
      createItem,
      {
        code: "",
        jan: spec.jan,
        name: spec.name,
        supplierId,
        genreId: genreIds.get(spec.genre) ?? null,
        temperatureZone: spec.temperatureZone,
        taxCategory: spec.taxCategory,
        purchaseUnitName: spec.purchaseUnitName,
        salesUnitName: spec.salesUnitName,
        unitsPerPurchaseUnit: spec.unitsPerPurchaseUnit,
        purchasePriceCenti: spec.purchasePriceCenti,
        salesPriceCenti: spec.salesPriceCenti,
        purchaseMinLot: spec.purchaseMinLot,
        salesMinLot: spec.salesMinLot,
        leadTimeDays: spec.leadTimeDays,
        reorderEnabled,
        reorderPoint: reorderEnabled ? reorderPointFor(spec, dailyDemand(spec)) : 0,
        purchaseShippingNote: spec.temperatureZone === "ambient" ? null : "クール便で納品",
        salesShippingNote: spec.temperatureZone === "ambient" ? null : "クール便で発送",
        inputPriceOnOrder: spec.inputPriceOnOrder,
        memo: spec.memo,
      },
      spec.index % 3 === 0 ? "purchasing2" : "purchasing1",
      clock.next(),
      `商品 ${spec.name}`,
    );
  }
}

/** 投入を始める前に、業務データが空であることを確かめる（同じデータを2回入れないため） */
export function hasBusinessData(session: SeedSession): boolean {
  const partner = session.db
    .select({ id: schema.partners.id })
    .from(schema.partners)
    .limit(1)
    .get();
  const item = session.db.select({ id: schema.items.id }).from(schema.items).limit(1).get();
  return partner !== undefined || item !== undefined;
}
