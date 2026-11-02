/**
 * 発注書の内容（スナップショット）。確定のときに作り、帳票（documents）に保存する。
 * テンプレート（web/views/documents/purchase-order.tsx）はこのスキーマで検証して表示するだけで、計算しない。
 * 金額・税額は domain（orderAmounts）で計算した値を入れる。
 */
import { z } from "zod";

const text = z.string();
const nullableText = z.string().nullable();

const party = z.object({
  name: text,
  postalCode: nullableText,
  address: nullableText,
  phone: nullableText,
  fax: nullableText,
});

export const purchaseOrderSnapshot = z.object({
  number: text,
  /** 発注日 */
  orderedOn: text,
  deliveryRequestedOn: nullableText,
  paymentDueOn: nullableText,
  /** 発行者（自社） */
  issuer: party.extend({ registrationNumber: nullableText, email: nullableText }),
  /** 宛先（仕入先） */
  supplier: party.extend({
    honorific: text,
    contactName: nullableText,
  }),
  /** 納入先 */
  destination: z.object({
    kind: z.enum(["location", "customer", "other"]),
    /** 保管場所名・販売先名。その他の届け先は null（address に名前と住所が入る） */
    name: nullableText,
    postalCode: nullableText,
    address: nullableText,
    phone: nullableText,
  }),
  /** 社内の担当者 */
  employeeName: nullableText,
  lines: z.array(
    z.object({
      no: z.number().int(),
      itemCode: text,
      itemName: text,
      jan: nullableText,
      /** 数量（仕入単位） */
      quantity: z.number().int(),
      purchaseUnitName: text,
      unitsPerPurchaseUnit: z.number().int(),
      salesUnitName: text,
      /** 単価（仕入単位あたり、税抜、centi-yen） */
      unitPriceCenti: z.number().int(),
      /** 金額（税抜・円） */
      amount: z.number().int(),
      taxCategory: z.enum(["standard", "reduced"]),
      memo: nullableText,
    }),
  ),
  /** 税率ごとの合計と消費税 */
  taxGroups: z.array(
    z.object({
      category: z.enum(["standard", "reduced"]),
      rateBps: z.number().int(),
      subtotal: z.number().int(),
      tax: z.number().int(),
    }),
  ),
  subtotal: z.number().int(),
  tax: z.number().int(),
  total: z.number().int(),
  memo: nullableText,
});

export type PurchaseOrderSnapshot = z.infer<typeof purchaseOrderSnapshot>;
