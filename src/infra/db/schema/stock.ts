import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { auditColumns, id } from "./common";

/** 在庫台帳（追記のみ）。誤りは reverses_id で打ち消しの行を追加して直す。 */
export const stockLedger = sqliteTable(
  "stock_ledger",
  {
    id: id(),
    occurredAt: text("occurred_at").notNull(),
    businessDate: text("business_date").notNull(),
    itemId: text("item_id").notNull(),
    locationId: text("location_id").notNull(),
    quantity: integer("quantity").notNull(),
    reason: text("reason").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    reversesId: text("reverses_id"),
    memo: text("memo"),
    createdBy: text("created_by").notNull(),
  },
  (t) => [
    index("stock_ledger_item").on(t.itemId, t.businessDate),
    index("stock_ledger_source").on(t.sourceType, t.sourceId),
  ],
);

/** 商品×保管場所の集計表。台帳への追記と同じトランザクションで更新する。 */
export const stockBalances = sqliteTable(
  "stock_balances",
  {
    itemId: text("item_id").notNull(),
    locationId: text("location_id").notNull(),
    onHand: integer("on_hand").notNull().default(0),
    allocated: integer("allocated").notNull().default(0),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.itemId, t.locationId] }),
    index("stock_balances_location").on(t.locationId),
  ],
);

export const stockOperations = sqliteTable(
  "stock_operations",
  {
    id: id(),
    number: text("number").notNull(),
    kind: text("kind", {
      enum: ["adjustment", "transfer", "store_transfer", "stocktake"],
    }).notNull(),
    operationDate: text("operation_date").notNull(),
    locationId: text("location_id").notNull(),
    toLocationId: text("to_location_id"),
    storeId: text("store_id"),
    adjustmentReason: text("adjustment_reason", {
      enum: ["adjustment", "sample", "disposal", "initial"],
    }),
    memo: text("memo"),
    ...auditColumns,
  },
  (t) => [index("stock_operations_date").on(t.operationDate)],
);

export const stockOperationLines = sqliteTable(
  "stock_operation_lines",
  {
    id: id(),
    operationId: text("operation_id").notNull(),
    itemId: text("item_id").notNull(),
    quantity: integer("quantity").notNull(),
  },
  (t) => [index("stock_operation_lines_op").on(t.operationId)],
);
