import type { WriteMeta } from "../ports";
import type { Page } from "../schemas";

export type MainContact = "line" | "email" | "fax" | "phone" | "mobile";
export type SendMethod = "email" | "none";

export interface PartnerFields {
  readonly name: string;
  readonly kana: string;
  readonly honorific: "御中" | "様";
  readonly isSupplier: boolean;
  readonly isCustomer: boolean;
  readonly contactName: string | null;
  readonly postalCode: string | null;
  readonly address: string | null;
  readonly phone: string | null;
  readonly mobile: string | null;
  readonly fax: string | null;
  readonly email: string | null;
  readonly lineId: string | null;
  readonly mainContact: MainContact | null;
  readonly deliveryDays: number;
  readonly defaultSendMethod: SendMethod;
  readonly orderMethodNote: string | null;
  readonly receiveMethodNote: string | null;
  readonly mailOrderAllowed: boolean;
  readonly placeName: string | null;
  readonly memo: string | null;
}

export interface PartnerTerms {
  readonly registrationNumber: string | null;
  readonly closingDay: number | null;
  readonly paymentMonthOffset: number | null;
  readonly paymentDay: number | null;
}

export interface PartnerRecord extends PartnerFields, PartnerTerms {
  readonly id: string;
  readonly archived: boolean;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PartnerFilter {
  readonly q?: string | undefined;
  readonly role?: "supplier" | "customer" | undefined;
  readonly includeArchived?: boolean | undefined;
}

export interface PartnerOption {
  readonly id: string;
  readonly name: string;
  readonly kana: string;
}

export interface PartnerStore {
  get(id: string): PartnerRecord | undefined;
  list(filter: PartnerFilter, page: number, pageSize: number): Page<PartnerRecord>;
  options(role: "supplier" | "customer"): PartnerOption[];
  insert(id: string, fields: PartnerFields & PartnerTerms, meta: WriteMeta): void;
  /** 版番号が一致したときだけ更新する。更新できたら true */
  update(
    id: string,
    expectedVersion: number,
    patch: Partial<PartnerFields & PartnerTerms & { archived: boolean }>,
    meta: WriteMeta,
  ): boolean;
  /** 取引（発注・受注・商品など）で使われているか */
  isReferenced(id: string): boolean;
  delete(id: string): void;
}
