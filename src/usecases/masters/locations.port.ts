import type { WriteMeta } from "../ports";
import type { MainContact } from "./partners.port";
import type { MasterOption } from "./simple-masters.port";

/** 保管場所（在庫を置く場所）。連絡先一式は取引先と共通の部品で検証する */
export interface LocationFields {
  readonly name: string;
  readonly contactName: string | null;
  readonly postalCode: string | null;
  readonly address: string | null;
  readonly phone: string | null;
  readonly mobile: string | null;
  readonly fax: string | null;
  readonly email: string | null;
  readonly lineId: string | null;
  readonly mainContact: MainContact | null;
  readonly memo: string | null;
  readonly displayOrder: number;
}

export interface LocationRecord extends LocationFields {
  readonly id: string;
  readonly archived: boolean;
  readonly version: number;
  readonly updatedAt: string;
}

export interface LocationStore {
  get(id: string): LocationRecord | undefined;
  list(includeArchived: boolean): LocationRecord[];
  options(): MasterOption[];
  findByName(name: string): LocationRecord | undefined;
  insert(id: string, fields: LocationFields, meta: WriteMeta): void;
  update(
    id: string,
    expectedVersion: number,
    patch: Partial<LocationFields & { archived: boolean }>,
    meta: WriteMeta,
  ): boolean;
}
