/** 画面や帳票に出す番号（種別 × 年ごとの連番）。 */
export const DOCUMENT_PREFIXES = {
  purchaseOrder: "PO",
  receipt: "RC",
  salesOrder: "SO",
  deliveryNote: "DN",
  invoice: "INV",
  creditNote: "CN",
  salesReturn: "RT",
  purchaseReturn: "PR",
  disposal: "DS",
  stockOperation: "SOP",
  item: "IT",
} as const;

export type DocumentKind = keyof typeof DOCUMENT_PREFIXES;

export function formatDocumentNumber(kind: DocumentKind, year: number, seq: number): string {
  if (!Number.isInteger(seq) || seq < 1) throw new RangeError("連番は1以上の整数");
  if (kind === "item") return `${DOCUMENT_PREFIXES.item}${String(seq).padStart(6, "0")}`;
  return `${DOCUMENT_PREFIXES[kind]}-${year}-${String(seq).padStart(6, "0")}`;
}

/** 採番の単位。商品コードは年でリセットしない。 */
export function sequenceKey(kind: DocumentKind, year: number): string {
  return kind === "item" ? "item" : `${kind}:${year}`;
}
