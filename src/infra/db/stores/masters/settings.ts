import { and, asc, eq, sql } from "drizzle-orm";

import type { CompanySettings, SettingsStore } from "../../../../usecases/masters/settings.port";
import { auditInsert, type Db } from "../../client";
import { companySettings, taxRates } from "../../schema";

const MAIN = "main";

export function settingsStore(db: Db): SettingsStore {
  return {
    getCompany(): CompanySettings {
      const r = db.select().from(companySettings).where(eq(companySettings.id, MAIN)).get();
      if (!r) throw new Error("company_settings が初期化されていません");
      return {
        name: r.name,
        registrationNumber: r.registrationNumber,
        postalCode: r.postalCode,
        address: r.address,
        phone: r.phone,
        fax: r.fax,
        email: r.email,
        bankInfo: r.bankInfo,
        roundingMode: r.roundingMode,
        version: r.version,
      };
    },
    updateCompany(expectedVersion, patch, meta) {
      const rows = db
        .update(companySettings)
        .set({
          ...patch,
          version: sql`${companySettings.version} + 1`,
          updatedAt: meta.at,
          updatedBy: meta.by,
        })
        .where(and(eq(companySettings.id, MAIN), eq(companySettings.version, expectedVersion)))
        .returning({ id: companySettings.id })
        .all();
      return rows.length === 1;
    },
    listTaxRates() {
      return db
        .select({
          id: taxRates.id,
          category: taxRates.category,
          rateBps: taxRates.rateBps,
          effectiveFrom: taxRates.effectiveFrom,
        })
        .from(taxRates)
        .orderBy(asc(taxRates.category), asc(taxRates.effectiveFrom))
        .all();
    },
    addTaxRate(id, category, rateBps, effectiveFrom, meta) {
      db.insert(taxRates)
        .values({ id, category, rateBps, effectiveFrom, ...auditInsert(meta) })
        .run();
    },
    hasTaxRate(category, effectiveFrom) {
      return (
        db
          .select({ id: taxRates.id })
          .from(taxRates)
          .where(and(eq(taxRates.category, category), eq(taxRates.effectiveFrom, effectiveFrom)))
          .get() !== undefined
      );
    },
  };
}

/** 初回起動時の初期データ（自社情報の枠と、2019年10月からの税率） */
export function bootstrapSettings(db: Db, at: string): void {
  const meta = { at, by: "system" };
  if (
    !db
      .select({ id: companySettings.id })
      .from(companySettings)
      .where(eq(companySettings.id, MAIN))
      .get()
  ) {
    db.insert(companySettings)
      .values({
        id: MAIN,
        name: "（自社名を設定してください）",
        roundingMode: "floor",
        ...auditInsert(meta),
      })
      .run();
  }
  if (!db.select({ id: taxRates.id }).from(taxRates).limit(1).get()) {
    db.insert(taxRates)
      .values([
        {
          id: "tax-standard-2019",
          category: "standard",
          rateBps: 1000,
          effectiveFrom: "2019-10-01",
          ...auditInsert(meta),
        },
        {
          id: "tax-reduced-2019",
          category: "reduced",
          rateBps: 800,
          effectiveFrom: "2019-10-01",
          ...auditInsert(meta),
        },
      ])
      .run();
  }
}
