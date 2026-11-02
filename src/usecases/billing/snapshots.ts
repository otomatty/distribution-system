/**
 * 請求書・返還請求書の内容（スナップショット）。発行のときに発行時点の値を保存し、PDF 化と再ダウンロードに使う。
 * テンプレート（web/views/documents/invoice.tsx・credit-note.tsx）は値を表示するだけで、金額を計算しない。
 * 形を変えるときは version を上げ、保存済みの古い形も読めるようにする（帳票は7年保存）。
 */
import { z } from "zod";

import type { InvoiceLineDraft } from "../../domain/billing";
import type { RoundingMode, TaxCategory, TaxSummary } from "../../domain/money";
import type { PartnerRecord } from "../masters/partners.port";
import type { CompanySettings } from "../masters/settings.port";

const taxCategory = z.enum(["standard", "reduced"]);
const yenAmount = z.number().int();

const issuerSchema = z.object({
  name: z.string(),
  /** 適格請求書発行事業者の登録番号 */
  registrationNumber: z.string().nullable(),
  postalCode: z.string().nullable(),
  address: z.string().nullable(),
  phone: z.string().nullable(),
  fax: z.string().nullable(),
  email: z.string().nullable(),
  /** 振込先 */
  bankInfo: z.string().nullable(),
});

const recipientSchema = z.object({
  name: z.string(),
  honorific: z.string(),
  postalCode: z.string().nullable(),
  address: z.string().nullable(),
});

const lineSchema = z.object({
  /** 送料などは null */
  itemCode: z.string().nullable(),
  name: z.string(),
  /** 返品はマイナス */
  quantity: z.number().int(),
  unitName: z.string().nullable(),
  /** 単価（税抜、100分の1円単位） */
  unitPriceCenti: z.number().int(),
  /** 金額（税抜・円、明細ごとに丸め済み。返品はマイナス） */
  amount: yenAmount,
  taxCategory,
  /** 軽減税率の対象（帳票に「※」を付ける） */
  reduced: z.boolean(),
});

const taxGroupSchema = z.object({
  category: taxCategory,
  rateBps: z.number().int(),
  subtotal: yenAmount,
  tax: yenAmount,
});

export const invoiceSnapshotSchema = z.object({
  version: z.literal(1),
  /** 請求書番号（INV-2026-000001） */
  number: z.string(),
  issuedOn: z.string(),
  periodFrom: z.string().nullable(),
  periodTo: z.string().nullable(),
  dueOn: z.string().nullable(),
  issuer: issuerSchema,
  recipient: recipientSchema,
  /** 発送（納品書）ごとの明細。取引年月日は発送日 */
  deliveries: z.array(
    z.object({
      shippedOn: z.string(),
      deliveryNoteNumber: z.string(),
      salesOrderNumber: z.string(),
      lines: z.array(lineSchema),
    }),
  ),
  /** 返品伝票ごとのマイナスの明細。取引年月日は返品日 */
  returns: z.array(
    z.object({
      returnedOn: z.string(),
      number: z.string(),
      salesOrderNumber: z.string(),
      lines: z.array(lineSchema),
    }),
  ),
  /** 税率ごとの合計（税抜）と消費税額。明細のない税率は含めない */
  taxGroups: z.array(taxGroupSchema),
  subtotal: yenAmount,
  tax: yenAmount,
  /** 税込の合計（ご請求金額） */
  total: yenAmount,
  roundingMode: z.enum(["floor", "round", "ceil"]),
  /** 取り消して再発行した場合の、元の請求書番号 */
  reissuedFromNumber: z.string().nullable(),
  memo: z.string().nullable(),
});

export type InvoiceSnapshot = z.infer<typeof invoiceSnapshotSchema>;

export const creditNoteSnapshotSchema = z.object({
  version: z.literal(1),
  /** 返還請求書の番号（CN-2026-000001） */
  number: z.string(),
  issuedOn: z.string(),
  /** 返品伝票の番号と返品日（返品を受けた年月日） */
  returnNumber: z.string(),
  returnedOn: z.string(),
  /** 返品の元になった取引（発送）の年月日 */
  originalTransactionDate: z.string(),
  salesOrderNumber: z.string(),
  deliveryNoteNumber: z.string().nullable(),
  /** 返品を差し引いた請求書の番号 */
  invoiceNumber: z.string().nullable(),
  issuer: issuerSchema,
  recipient: recipientSchema,
  /** 返品の明細（数量・金額は正の数で、返還する額を表す） */
  lines: z.array(lineSchema),
  taxGroups: z.array(taxGroupSchema),
  subtotal: yenAmount,
  tax: yenAmount,
  /** 税込の返還額 */
  total: yenAmount,
  roundingMode: z.enum(["floor", "round", "ceil"]),
});

export type CreditNoteSnapshot = z.infer<typeof creditNoteSnapshotSchema>;

export function issuerOf(company: CompanySettings): z.infer<typeof issuerSchema> {
  return {
    name: company.name,
    registrationNumber: company.registrationNumber,
    postalCode: company.postalCode,
    address: company.address,
    phone: company.phone,
    fax: company.fax,
    email: company.email,
    bankInfo: company.bankInfo,
  };
}

export function recipientOf(customer: PartnerRecord): z.infer<typeof recipientSchema> {
  return {
    name: customer.name,
    honorific: customer.honorific,
    postalCode: customer.postalCode,
    address: customer.address,
  };
}

interface SnapshotLine {
  readonly itemCode: string | null;
  readonly line: Pick<
    InvoiceLineDraft,
    "description" | "quantity" | "unitName" | "unitPriceCenti" | "amount"
  > & { readonly taxCategory: TaxCategory };
}

function snapshotLine({ itemCode, line }: SnapshotLine): z.infer<typeof lineSchema> {
  return {
    itemCode,
    name: line.description,
    quantity: line.quantity,
    unitName: line.unitName,
    unitPriceCenti: line.unitPriceCenti,
    amount: line.amount,
    taxCategory: line.taxCategory,
    reduced: line.taxCategory === "reduced",
  };
}

export interface SnapshotDelivery {
  readonly shippedOn: string;
  readonly deliveryNoteNumber: string;
  readonly salesOrderNumber: string;
  readonly lines: readonly SnapshotLine[];
}

export interface SnapshotReturn {
  readonly returnedOn: string;
  readonly number: string;
  readonly salesOrderNumber: string;
  readonly lines: readonly SnapshotLine[];
}

/** 請求書の内容。金額は domain の planInvoice で計算した値をそのまま入れる */
export function buildInvoiceSnapshot(input: {
  readonly number: string;
  readonly issuedOn: string;
  readonly periodFrom: string | null;
  readonly periodTo: string | null;
  readonly dueOn: string | null;
  readonly company: CompanySettings;
  readonly customer: PartnerRecord;
  readonly deliveries: readonly SnapshotDelivery[];
  readonly returns: readonly SnapshotReturn[];
  readonly summary: TaxSummary;
  readonly roundingMode: RoundingMode;
  readonly reissuedFromNumber: string | null;
}): InvoiceSnapshot {
  return {
    version: 1,
    number: input.number,
    issuedOn: input.issuedOn,
    periodFrom: input.periodFrom,
    periodTo: input.periodTo,
    dueOn: input.dueOn,
    issuer: issuerOf(input.company),
    recipient: recipientOf(input.customer),
    deliveries: input.deliveries.map((d) => ({
      shippedOn: d.shippedOn,
      deliveryNoteNumber: d.deliveryNoteNumber,
      salesOrderNumber: d.salesOrderNumber,
      lines: d.lines.map(snapshotLine),
    })),
    returns: input.returns.map((r) => ({
      returnedOn: r.returnedOn,
      number: r.number,
      salesOrderNumber: r.salesOrderNumber,
      lines: r.lines.map(snapshotLine),
    })),
    taxGroups: input.summary.groups.map((g) => ({ ...g })),
    subtotal: input.summary.subtotal,
    tax: input.summary.tax,
    total: input.summary.total,
    roundingMode: input.roundingMode,
    reissuedFromNumber: input.reissuedFromNumber,
    memo: null,
  };
}

/** 返還請求書の内容。税は返還請求書1枚ごとに税率ごとに1回丸めた値（domain の summarizeTax） */
export function buildCreditNoteSnapshot(input: {
  readonly number: string;
  readonly issuedOn: string;
  readonly returnNumber: string;
  readonly returnedOn: string;
  readonly originalTransactionDate: string;
  readonly salesOrderNumber: string;
  readonly deliveryNoteNumber: string | null;
  readonly invoiceNumber: string | null;
  readonly company: CompanySettings;
  readonly customer: PartnerRecord;
  readonly lines: readonly SnapshotLine[];
  readonly summary: TaxSummary;
  readonly roundingMode: RoundingMode;
}): CreditNoteSnapshot {
  return {
    version: 1,
    number: input.number,
    issuedOn: input.issuedOn,
    returnNumber: input.returnNumber,
    returnedOn: input.returnedOn,
    originalTransactionDate: input.originalTransactionDate,
    salesOrderNumber: input.salesOrderNumber,
    deliveryNoteNumber: input.deliveryNoteNumber,
    invoiceNumber: input.invoiceNumber,
    issuer: issuerOf(input.company),
    recipient: recipientOf(input.customer),
    lines: input.lines.map(snapshotLine),
    taxGroups: input.summary.groups.map((g) => ({ ...g })),
    subtotal: input.summary.subtotal,
    tax: input.summary.tax,
    total: input.summary.total,
    roundingMode: input.roundingMode,
  };
}
