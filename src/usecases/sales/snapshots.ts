/**
 * 納品書の内容（スナップショット）。発送のときに発行時点の値を保存し、PDF 化と再ダウンロードに使う。
 * テンプレート（web/views/documents/delivery-note.tsx）は値を表示するだけで、金額を計算しない。
 * 形を変えるときは version を上げ、保存済みの古い形も読めるようにする（帳票は7年保存）。
 *
 * - version 2：発行日（issuedOn）を持つ（要件定義書 3.10「発行日は発行の操作で決める」）
 * - version 1：発行日を持たない。当時は納品書の日付が発送日だったので、発行日 = 発送日として読む
 */
import { z } from "zod";

import { ratesOn, type RoundingMode } from "../../domain/money";
import { err, ok, type Result } from "../../domain/result";
import { orderAmounts } from "../../domain/sales";
import type { CompanySettings, TaxRateRecord } from "../masters/settings.port";
import type { SalesOrderDetail } from "./orders.port";

const taxCategory = z.enum(["standard", "reduced"]);
const yenAmount = z.number().int();

const deliveryNoteFields = z.object({
  /** 納品書番号（DN-2026-000001） */
  number: z.string(),
  /** 発送日（取引年月日・納品日） */
  shippedOn: z.string(),
  salesOrderNumber: z.string(),
  issuer: z.object({
    name: z.string(),
    /** 適格請求書発行事業者の登録番号 */
    registrationNumber: z.string().nullable(),
    postalCode: z.string().nullable(),
    address: z.string().nullable(),
    phone: z.string().nullable(),
    fax: z.string().nullable(),
    email: z.string().nullable(),
  }),
  customer: z.object({
    name: z.string(),
    honorific: z.string(),
    postalCode: z.string().nullable(),
    address: z.string().nullable(),
    /** 先方の担当者名（受注に入力したもの） */
    contactName: z.string().nullable(),
  }),
  lines: z.array(
    z.object({
      itemCode: z.string(),
      name: z.string(),
      quantity: z.number().int(),
      unitName: z.string(),
      /** 単価（税抜、100分の1円単位） */
      unitPriceCenti: z.number().int(),
      /** 金額（税抜・円、明細ごとに丸め済み） */
      amount: yenAmount,
      taxCategory,
      /** 軽減税率の対象（帳票に「※」を付ける） */
      reduced: z.boolean(),
    }),
  ),
  charges: z.array(
    z.object({
      description: z.string(),
      quantity: z.number().int(),
      unitAmount: yenAmount,
      amount: yenAmount,
      taxCategory,
      reduced: z.boolean(),
    }),
  ),
  /** 税率ごとの合計（税抜）と消費税額。明細のない税率は含めない */
  taxGroups: z.array(
    z.object({
      category: taxCategory,
      rateBps: z.number().int(),
      subtotal: yenAmount,
      tax: yenAmount,
    }),
  ),
  subtotal: yenAmount,
  tax: yenAmount,
  /** 税込の合計 */
  total: yenAmount,
  roundingMode: z.enum(["floor", "round", "ceil"]),
  memo: z.string().nullable(),
});

const deliveryNoteV2 = deliveryNoteFields.extend({
  version: z.literal(2),
  /** 発行日（発送の操作で決める。初期値は当日、月締めの販売先は締め日） */
  issuedOn: z.string(),
});

/** 発行日のない古い形（version 1）。発行日 = 発送日として読む */
const deliveryNoteV1 = deliveryNoteFields
  .extend({ version: z.literal(1) })
  .transform((v) => ({ ...v, version: 2 as const, issuedOn: v.shippedOn }));

/** 保存済みの納品書の内容。古い形（version 1）も今の形（version 2）にそろえて読む */
export const deliveryNoteSnapshotSchema = z.union([deliveryNoteV2, deliveryNoteV1]);

/** 今の形（発行するときに作る形。古い形も読むとこの形になる） */
export type DeliveryNoteSnapshot = z.output<typeof deliveryNoteSnapshotSchema>;
/** 保存済みの形（古い形を含む） */
export type StoredDeliveryNoteSnapshot = z.input<typeof deliveryNoteSnapshotSchema>;

/** 発送する受注から納品書の内容を作る。税率は発送日の時点のもの */
export function buildDeliveryNoteSnapshot(input: {
  readonly number: string;
  readonly shippedOn: string;
  readonly issuedOn: string;
  readonly order: SalesOrderDetail;
  readonly company: CompanySettings;
  readonly taxRates: readonly TaxRateRecord[];
}): Result<DeliveryNoteSnapshot> {
  const { order, company } = input;
  const rates = ratesOn(input.taxRates, input.shippedOn);
  if (!rates)
    return err("invalid_state", "発送日の税率が設定されていません（管理者に連絡してください）");
  const mode: RoundingMode = company.roundingMode;
  const amounts = orderAmounts(order.lines, order.charges, rates, mode);
  return ok({
    version: 2,
    number: input.number,
    shippedOn: input.shippedOn,
    issuedOn: input.issuedOn,
    salesOrderNumber: order.number,
    issuer: {
      name: company.name,
      registrationNumber: company.registrationNumber,
      postalCode: company.postalCode,
      address: company.address,
      phone: company.phone,
      fax: company.fax,
      email: company.email,
    },
    customer: {
      name: order.customerName,
      honorific: order.customerHonorific,
      postalCode: order.customerPostalCode,
      address: order.customerAddress,
      contactName: order.customerContactName,
    },
    lines: amounts.lines.map((l) => ({
      itemCode: l.itemCode,
      name: l.itemName,
      quantity: l.quantity,
      unitName: l.salesUnitName,
      unitPriceCenti: l.unitPriceCenti,
      amount: l.amount,
      taxCategory: l.taxCategory,
      reduced: l.taxCategory === "reduced",
    })),
    charges: amounts.charges.map((c) => ({
      description: c.description,
      quantity: c.quantity,
      unitAmount: c.unitAmount,
      amount: c.amount,
      taxCategory: c.taxCategory,
      reduced: c.taxCategory === "reduced",
    })),
    taxGroups: amounts.summary.groups.map((g) => ({ ...g })),
    subtotal: amounts.summary.subtotal,
    tax: amounts.summary.tax,
    total: amounts.summary.total,
    roundingMode: mode,
    memo: null,
  });
}
