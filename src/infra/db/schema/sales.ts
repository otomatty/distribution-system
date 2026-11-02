import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { auditColumns, id } from "./common";

export const salesOrders = sqliteTable(
  "sales_orders",
  {
    id: id(),
    number: text("number").notNull(),
    customerId: text("customer_id").notNull(),
    status: text("status", { enum: ["received", "shipped", "cancelled"] }).notNull(),
    orderedOn: text("ordered_on").notNull(),
    customerContactName: text("customer_contact_name"),
    makerDirect: integer("maker_direct", { mode: "boolean" }).notNull().default(false),
    locationId: text("location_id"),
    employeeId: text("employee_id"),
    deliveryRequestedOn: text("delivery_requested_on"),
    shipPlannedOn: text("ship_planned_on").notNull(),
    splitFromId: text("split_from_id"),
    memo: text("memo"),
    cancelReason: text("cancel_reason"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("sales_orders_number").on(t.number),
    index("sales_orders_status_ship").on(t.status, t.shipPlannedOn),
    index("sales_orders_customer").on(t.customerId),
    // 受注の詳細で分割先の受注を探す（受注の取得のたびに使う。発送・一括発送でも呼ばれる）
    index("sales_orders_split_from").on(t.splitFromId),
    // 受注一覧の並び（出荷予定日の新しい順）。並べ替えずに1ページ分だけ読む（docs/performance.md）
    index("sales_orders_ship_planned").on(t.shipPlannedOn, t.number),
  ],
);

export const salesOrderLines = sqliteTable(
  "sales_order_lines",
  {
    id: id(),
    salesOrderId: text("sales_order_id").notNull(),
    lineNo: integer("line_no").notNull(),
    itemId: text("item_id").notNull(),
    quantity: integer("quantity").notNull(),
    unitPriceCenti: integer("unit_price_centi").notNull(),
    priceOverrideReason: text("price_override_reason"),
    taxCategory: text("tax_category", { enum: ["standard", "reduced"] }).notNull(),
    memo: text("memo"),
  },
  (t) => [
    index("sales_order_lines_order").on(t.salesOrderId),
    index("sales_order_lines_item").on(t.itemId),
  ],
);

/** 受注の送料など（金額は税抜・円） */
export const salesCharges = sqliteTable(
  "sales_charges",
  {
    id: id(),
    salesOrderId: text("sales_order_id").notNull(),
    description: text("description").notNull().default("送料"),
    quantity: integer("quantity").notNull().default(1),
    unitAmount: integer("unit_amount").notNull(),
    taxCategory: text("tax_category", { enum: ["standard", "reduced"] })
      .notNull()
      .default("standard"),
    memo: text("memo"),
  },
  (t) => [index("sales_charges_order").on(t.salesOrderId)],
);

/** 発送（受注1件に有効なものは1件） */
export const shipments = sqliteTable(
  "shipments",
  {
    id: id(),
    salesOrderId: text("sales_order_id").notNull(),
    deliveryNoteNumber: text("delivery_note_number").notNull(),
    shippedOn: text("shipped_on").notNull(),
    invoiceId: text("invoice_id"),
    cancelled: integer("cancelled", { mode: "boolean" }).notNull().default(false),
    cancelReason: text("cancel_reason"),
    ...auditColumns,
  },
  (t) => [
    index("shipments_order").on(t.salesOrderId),
    index("shipments_invoice").on(t.invoiceId),
    index("shipments_date").on(t.shippedOn),
    // 未請求の発送を期間で探す（発送ごとの請求書・締め処理。未請求のすべてを読まない）
    index("shipments_unbilled").on(t.invoiceId, t.shippedOn),
  ],
);

export const invoices = sqliteTable(
  "invoices",
  {
    id: id(),
    number: text("number").notNull(),
    customerId: text("customer_id").notNull(),
    issuedOn: text("issued_on").notNull(),
    periodFrom: text("period_from"),
    periodTo: text("period_to"),
    dueOn: text("due_on"),
    subtotal: integer("subtotal").notNull(),
    tax: integer("tax").notNull(),
    total: integer("total").notNull(),
    taxSummary: text("tax_summary", { mode: "json" })
      .$type<{ category: string; rateBps: number; subtotal: number; tax: number }[]>()
      .notNull(),
    roundingMode: text("rounding_mode", { enum: ["floor", "round", "ceil"] }).notNull(),
    recipientSnapshot: text("recipient_snapshot", { mode: "json" })
      .$type<Record<string, string | null>>()
      .notNull(),
    issuerSnapshot: text("issuer_snapshot", { mode: "json" })
      .$type<Record<string, string | null>>()
      .notNull(),
    allocated: integer("allocated").notNull().default(0),
    status: text("status", { enum: ["unpaid", "partial", "paid", "cancelled"] }).notNull(),
    pdfKey: text("pdf_key"),
    reissuedFromId: text("reissued_from_id"),
    cancelReason: text("cancel_reason"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("invoices_number").on(t.number),
    index("invoices_customer").on(t.customerId, t.issuedOn),
    index("invoices_status_due").on(t.status, t.dueOn),
    // 請求書一覧の並び（発行日の新しい順）と発行日の絞り込み
    index("invoices_issued").on(t.issuedOn, t.number),
  ],
);

/** 請求書の発行時点の明細の写し。return_line はマイナスの金額。 */
export const invoiceLines = sqliteTable(
  "invoice_lines",
  {
    id: id(),
    invoiceId: text("invoice_id").notNull(),
    lineNo: integer("line_no").notNull(),
    sourceType: text("source_type", { enum: ["shipment_line", "charge", "return_line"] }).notNull(),
    sourceId: text("source_id").notNull(),
    transactionDate: text("transaction_date").notNull(),
    description: text("description").notNull(),
    quantity: integer("quantity").notNull(),
    unitName: text("unit_name"),
    unitPriceCenti: integer("unit_price_centi").notNull(),
    amount: integer("amount").notNull(),
    taxCategory: text("tax_category", { enum: ["standard", "reduced"] }).notNull(),
  },
  (t) => [index("invoice_lines_invoice").on(t.invoiceId)],
);

export const salesReturns = sqliteTable(
  "sales_returns",
  {
    id: id(),
    number: text("number").notNull(),
    salesOrderId: text("sales_order_id").notNull(),
    customerId: text("customer_id").notNull(),
    returnedOn: text("returned_on").notNull(),
    invoiceId: text("invoice_id"),
    creditNoteNumber: text("credit_note_number"),
    creditNotePdfKey: text("credit_note_pdf_key"),
    cancelled: integer("cancelled", { mode: "boolean" }).notNull().default(false),
    memo: text("memo"),
    ...auditColumns,
  },
  (t) => [
    index("sales_returns_order").on(t.salesOrderId),
    index("sales_returns_customer").on(t.customerId),
  ],
);

export const salesReturnLines = sqliteTable(
  "sales_return_lines",
  {
    id: id(),
    salesReturnId: text("sales_return_id").notNull(),
    salesOrderLineId: text("sales_order_line_id").notNull(),
    itemId: text("item_id").notNull(),
    quantity: integer("quantity").notNull(),
    restock: integer("restock", { mode: "boolean" }).notNull(),
    locationId: text("location_id"),
    unitPriceCenti: integer("unit_price_centi").notNull(),
    /** 返品額（税抜・円、正の数で持ち、請求書ではマイナスの明細にする） */
    amount: integer("amount").notNull(),
    taxCategory: text("tax_category", { enum: ["standard", "reduced"] }).notNull(),
  },
  (t) => [index("sales_return_lines_return").on(t.salesReturnId)],
);

export const customerPayments = sqliteTable(
  "customer_payments",
  {
    id: id(),
    customerId: text("customer_id").notNull(),
    receivedOn: text("received_on").notNull(),
    amount: integer("amount").notNull(),
    method: text("method", { enum: ["transfer", "cash", "offset", "other"] }).notNull(),
    cancelled: integer("cancelled", { mode: "boolean" }).notNull().default(false),
    memo: text("memo"),
    ...auditColumns,
  },
  (t) => [
    index("customer_payments_customer").on(t.customerId, t.receivedOn),
    // 売掛残高の未消込の入金の集計（表を読まずに索引だけで足す）
    index("customer_payments_customer_amount").on(t.customerId, t.cancelled, t.amount),
  ],
);

export const paymentAllocations = sqliteTable(
  "payment_allocations",
  {
    id: id(),
    paymentId: text("payment_id").notNull(),
    invoiceId: text("invoice_id").notNull(),
    amount: integer("amount").notNull(),
    adjustment: integer("adjustment").notNull().default(0),
    adjustmentKind: text("adjustment_kind", { enum: ["bank_fee", "discount", "other"] }),
    cancelled: integer("cancelled", { mode: "boolean" }).notNull().default(false),
    ...auditColumns,
  },
  (t) => [
    index("payment_allocations_payment").on(t.paymentId),
    index("payment_allocations_invoice").on(t.invoiceId),
    // 売掛残高の入金ごとの消込の集計（表を読まずに索引だけで足す）
    index("payment_allocations_payment_amount").on(t.paymentId, t.cancelled, t.amount),
  ],
);

export const disposals = sqliteTable(
  "disposals",
  {
    id: id(),
    number: text("number").notNull(),
    customerId: text("customer_id").notNull(),
    disposedOn: text("disposed_on").notNull(),
    contactName: text("contact_name"),
    memo: text("memo"),
    /** 取消（取り消した伝票は一覧に残し、廃棄率の集計から除く）と、その理由・日時（UTC）・操作者 */
    cancelled: integer("cancelled", { mode: "boolean" }).notNull().default(false),
    cancelReason: text("cancel_reason"),
    cancelledAt: text("cancelled_at"),
    cancelledBy: text("cancelled_by"),
    ...auditColumns,
  },
  (t) => [index("disposals_customer").on(t.customerId, t.disposedOn)],
);

export const disposalLines = sqliteTable(
  "disposal_lines",
  {
    id: id(),
    disposalId: text("disposal_id").notNull(),
    itemId: text("item_id").notNull(),
    quantity: integer("quantity").notNull(),
    reason: text("reason", { enum: ["expired", "damaged", "other"] }),
  },
  (t) => [
    index("disposal_lines_disposal").on(t.disposalId),
    index("disposal_lines_item").on(t.itemId),
  ],
);
