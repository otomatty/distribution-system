import type { RoundingMode, TaxCategory, TaxRateEntry } from "../../domain/money";
import type { WriteMeta } from "../ports";

export interface CompanySettings {
  readonly name: string;
  readonly registrationNumber: string | null;
  readonly postalCode: string | null;
  readonly address: string | null;
  readonly phone: string | null;
  readonly fax: string | null;
  readonly email: string | null;
  readonly bankInfo: string | null;
  readonly roundingMode: RoundingMode;
  readonly version: number;
}

export interface TaxRateRecord extends TaxRateEntry {
  readonly id: string;
}

export interface SettingsStore {
  getCompany(): CompanySettings;
  updateCompany(
    expectedVersion: number,
    patch: Omit<CompanySettings, "version">,
    meta: WriteMeta,
  ): boolean;
  listTaxRates(): TaxRateRecord[];
  addTaxRate(
    id: string,
    category: TaxCategory,
    rateBps: number,
    effectiveFrom: string,
    meta: WriteMeta,
  ): void;
  hasTaxRate(category: TaxCategory, effectiveFrom: string): boolean;
}
