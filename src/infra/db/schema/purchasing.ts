import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { auditColumns, id } from "./common";

export const purchaseOrders = sqliteTable(
  "purchase_orders",
  {
    id: id(),
    number: text("number").notNull(),
    supplierId: text("supplier_id").notNull(),
    status: text("status", {
      enum: ["draft", "ordered", "received", "paid", "cancelled"],
    }).notNull(),
    orderedOn: text("ordered_on").notNull(),
    supplierContactName: text("supplier_contact_name"),
    destinationKind: text("destination_kind", {
      enum: ["location", "customer", "other"],
    }).notNull(),
    destinationLocationId: text("destination_location_id"),
    destinationCustomerId: text("destination_customer_id"),
    destinationAddress: text("destination_address"),
    employeeId: text("employee_id"),
    deliveryRequestedOn: text("delivery_requested_on"),
    paymentDueOn: text("payment_due_on"),
    sendMethod: text("send_method", { enum: ["email", "none"] })
      .notNull()
      .default("none"),
    salesOrderId: text("sales_order_id"),
    memo: text("memo"),
    cancelReason: text("cancel_reason"),
    confirmedAt: text("confirmed_at"),
    /** 明細の金額の合計（税抜・円）。保存のたびに domain で計算して持つ（一覧と CSV に使う） */
    subtotal: integer("subtotal").notNull().default(0),
    /** 消費税（税率ごとに1回丸めた合計・円） */
    tax: integer("tax").notNull().default(0),
    /** 税込の合計（円） */
    total: integer("total").notNull().default(0),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("purchase_orders_number").on(t.number),
    index("purchase_orders_status").on(t.status, t.orderedOn),
    index("purchase_orders_supplier").on(t.supplierId),
  ],
);

export const purchaseOrderLines = sqliteTable(
  "purchase_order_lines",
  {
    id: id(),
    purchaseOrderId: text("purchase_order_id").notNull(),
    lineNo: integer("line_no").notNull(),
    itemId: text("item_id").notNull(),
    quantity: integer("quantity").notNull(),
    unitPriceCenti: integer("unit_price_centi").notNull(),
    unitsPerPurchaseUnit: integer("units_per_purchase_unit").notNull(),
    taxCategory: text("tax_category", { enum: ["standard", "reduced"] }).notNull(),
    receivedQuantity: integer("received_quantity").notNull().default(0),
    closed: integer("closed", { mode: "boolean" }).notNull().default(false),
    memo: text("memo"),
  },
  (t) => [
    index("purchase_order_lines_order").on(t.purchaseOrderId),
    index("purchase_order_lines_item").on(t.itemId),
  ],
);

export const receipts = sqliteTable(
  "receipts",
  {
    id: id(),
    number: text("number").notNull(),
    purchaseOrderId: text("purchase_order_id").notNull(),
    receivedOn: text("received_on").notNull(),
    locationId: text("location_id"),
    supplierInvoiceId: text("supplier_invoice_id"),
    cancelled: integer("cancelled", { mode: "boolean" }).notNull().default(false),
    cancelReason: text("cancel_reason"),
    memo: text("memo"),
    ...auditColumns,
  },
  (t) => [
    index("receipts_order").on(t.purchaseOrderId),
    index("receipts_invoice").on(t.supplierInvoiceId),
  ],
);

export const receiptLines = sqliteTable(
  "receipt_lines",
  {
    id: id(),
    receiptId: text("receipt_id").notNull(),
    purchaseOrderLineId: text("purchase_order_line_id").notNull(),
    itemId: text("item_id").notNull(),
    accepted: integer("accepted").notNull(),
    returned: integer("returned").notNull(),
    closedRemaining: integer("closed_remaining", { mode: "boolean" }).notNull().default(false),
    unitPriceCenti: integer("unit_price_centi").notNull(),
    unitsPerPurchaseUnit: integer("units_per_purchase_unit").notNull(),
    taxCategory: text("tax_category", { enum: ["standard", "reduced"] }).notNull(),
    amount: integer("amount").notNull(),
  },
  (t) => [
    index("receipt_lines_receipt").on(t.receiptId),
    index("receipt_lines_order_line").on(t.purchaseOrderLineId),
  ],
);

export const purchaseReturns = sqliteTable(
  "purchase_returns",
  {
    id: id(),
    number: text("number").notNull(),
    supplierId: text("supplier_id").notNull(),
    /** 返品した商品の発注（発注の詳細画面から記録する） */
    purchaseOrderId: text("purchase_order_id"),
    returnedOn: text("returned_on").notNull(),
    locationId: text("location_id").notNull(),
    supplierInvoiceId: text("supplier_invoice_id"),
    cancelled: integer("cancelled", { mode: "boolean" }).notNull().default(false),
    memo: text("memo"),
    ...auditColumns,
  },
  (t) => [
    index("purchase_returns_supplier").on(t.supplierId),
    index("purchase_returns_order").on(t.purchaseOrderId),
    index("purchase_returns_invoice").on(t.supplierInvoiceId),
  ],
);

export const purchaseReturnLines = sqliteTable(
  "purchase_return_lines",
  {
    id: id(),
    purchaseReturnId: text("purchase_return_id").notNull(),
    /** 返品した発注明細（返品できる数 = 受入数 × 入数 − これまでの返品） */
    purchaseOrderLineId: text("purchase_order_line_id"),
    itemId: text("item_id").notNull(),
    /** 在庫から減らす数（販売単位） */
    quantity: integer("quantity").notNull(),
    /** 発注明細の単価の写し（仕入単位あたり、税抜、centi-yen） */
    unitPriceCenti: integer("unit_price_centi").notNull().default(0),
    /** 返品額（税抜・円） */
    amount: integer("amount").notNull(),
    taxCategory: text("tax_category", { enum: ["standard", "reduced"] }).notNull(),
  },
  (t) => [
    index("purchase_return_lines_return").on(t.purchaseReturnId),
    index("purchase_return_lines_order_line").on(t.purchaseOrderLineId),
  ],
);

export const supplierInvoices = sqliteTable(
  "supplier_invoices",
  {
    id: id(),
    supplierId: text("supplier_id").notNull(),
    invoiceNumber: text("invoice_number"),
    invoiceDate: text("invoice_date").notNull(),
    /** 請求額（税込・円） */
    invoicedAmount: integer("invoiced_amount").notNull(),
    /** 送料（税込・円） */
    shippingFee: integer("shipping_fee").notNull().default(0),
    /** システムの計算額（税込・円） */
    computedAmount: integer("computed_amount").notNull(),
    difference: integer("difference").notNull().default(0),
    differenceReason: text("difference_reason"),
    paymentDueOn: text("payment_due_on"),
    status: text("status", { enum: ["unpaid", "paid", "cancelled"] }).notNull(),
    attachmentKey: text("attachment_key"),
    cancelReason: text("cancel_reason"),
    memo: text("memo"),
    ...auditColumns,
  },
  (t) => [
    index("supplier_invoices_supplier").on(t.supplierId),
    index("supplier_invoices_due").on(t.status, t.paymentDueOn),
  ],
);

export const supplierPayments = sqliteTable(
  "supplier_payments",
  {
    id: id(),
    supplierInvoiceId: text("supplier_invoice_id").notNull(),
    paidOn: text("paid_on").notNull(),
    amount: integer("amount").notNull(),
    cancelled: integer("cancelled", { mode: "boolean" }).notNull().default(false),
    cancelReason: text("cancel_reason"),
    memo: text("memo"),
    ...auditColumns,
  },
  (t) => [index("supplier_payments_invoice").on(t.supplierInvoiceId)],
);

/**
 * 仕入先請求書の添付 PDF（要件定義書 3.7 Should、7章 電子帳簿保存法）。
 * 受け取った PDF は版ごとに1行で、消したり上書きしたりしない。差し替えは新しい版として追加し、最新の版を表示する。
 * ファイルは R2 の supplier-invoices/<請求書 ID>/<添付 ID>.pdf（バケットロックの対象）。
 */
export const supplierInvoiceAttachments = sqliteTable(
  "supplier_invoice_attachments",
  {
    id: id(),
    supplierInvoiceId: text("supplier_invoice_id").notNull(),
    r2Key: text("r2_key").notNull(),
    /** 受け取ったときのファイル名 */
    fileName: text("file_name").notNull(),
    /** バイト数 */
    size: integer("size").notNull(),
    /** 内容の SHA-256（16進数）。保存後に改変されていないことを確かめるため */
    sha256: text("sha256").notNull(),
    ...auditColumns,
  },
  (t) => [index("supplier_invoice_attachments_invoice").on(t.supplierInvoiceId)],
);
