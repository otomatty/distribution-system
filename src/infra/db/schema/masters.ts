import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { auditColumns, contactColumns, id } from "./common";

export const companySettings = sqliteTable("company_settings", {
  id: id(),
  name: text("name").notNull(),
  registrationNumber: text("registration_number"),
  postalCode: text("postal_code"),
  address: text("address"),
  phone: text("phone"),
  fax: text("fax"),
  email: text("email"),
  bankInfo: text("bank_info"),
  roundingMode: text("rounding_mode", { enum: ["floor", "round", "ceil"] })
    .notNull()
    .default("floor"),
  ...auditColumns,
});

export const taxRates = sqliteTable(
  "tax_rates",
  {
    id: id(),
    category: text("category", { enum: ["standard", "reduced"] }).notNull(),
    rateBps: integer("rate_bps").notNull(),
    effectiveFrom: text("effective_from").notNull(),
    ...auditColumns,
  },
  (t) => [uniqueIndex("tax_rates_category_from").on(t.category, t.effectiveFrom)],
);

export const employees = sqliteTable(
  "employees",
  {
    id: id(),
    authUserId: text("auth_user_id"),
    email: text("email").notNull(),
    name: text("name").notNull(),
    roles: text("roles", { mode: "json" }).$type<string[]>().notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("employees_email").on(t.email),
    uniqueIndex("employees_auth_user").on(t.authUserId),
  ],
);

export const partners = sqliteTable(
  "partners",
  {
    id: id(),
    name: text("name").notNull(),
    kana: text("kana").notNull(),
    honorific: text("honorific", { enum: ["御中", "様"] })
      .notNull()
      .default("御中"),
    isSupplier: integer("is_supplier", { mode: "boolean" }).notNull().default(false),
    isCustomer: integer("is_customer", { mode: "boolean" }).notNull().default(false),
    ...contactColumns,
    registrationNumber: text("registration_number"),
    closingDay: integer("closing_day"),
    paymentMonthOffset: integer("payment_month_offset"),
    paymentDay: integer("payment_day"),
    deliveryDays: integer("delivery_days").notNull().default(0),
    defaultSendMethod: text("default_send_method", { enum: ["email", "none"] })
      .notNull()
      .default("none"),
    orderMethodNote: text("order_method_note"),
    receiveMethodNote: text("receive_method_note"),
    mailOrderAllowed: integer("mail_order_allowed", { mode: "boolean" }).notNull().default(false),
    placeName: text("place_name"),
    memo: text("memo"),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    ...auditColumns,
  },
  (t) => [index("partners_kana").on(t.kana)],
);

export const locations = sqliteTable("locations", {
  id: id(),
  name: text("name").notNull(),
  ...contactColumns,
  memo: text("memo"),
  displayOrder: integer("display_order").notNull().default(0),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  ...auditColumns,
});

export const stores = sqliteTable("stores", {
  id: id(),
  name: text("name").notNull(),
  displayOrder: integer("display_order").notNull().default(0),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  ...auditColumns,
});

export const genres = sqliteTable("genres", {
  id: id(),
  name: text("name").notNull(),
  displayOrder: integer("display_order").notNull().default(0),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  ...auditColumns,
});

export const items = sqliteTable(
  "items",
  {
    id: id(),
    code: text("code").notNull(),
    jan: text("jan"),
    name: text("name").notNull(),
    supplierId: text("supplier_id").notNull(),
    genreId: text("genre_id"),
    temperatureZone: text("temperature_zone", { enum: ["ambient", "chilled", "frozen"] })
      .notNull()
      .default("ambient"),
    taxCategory: text("tax_category", { enum: ["standard", "reduced"] }).notNull(),
    purchaseUnitName: text("purchase_unit_name").notNull(),
    salesUnitName: text("sales_unit_name").notNull(),
    unitsPerPurchaseUnit: integer("units_per_purchase_unit").notNull().default(1),
    purchasePriceCenti: integer("purchase_price_centi").notNull(),
    salesPriceCenti: integer("sales_price_centi").notNull(),
    purchaseMinLot: integer("purchase_min_lot").notNull().default(1),
    salesMinLot: integer("sales_min_lot").notNull().default(1),
    leadTimeDays: integer("lead_time_days"),
    reorderEnabled: integer("reorder_enabled", { mode: "boolean" }).notNull().default(false),
    reorderPoint: integer("reorder_point").notNull().default(0),
    purchaseShippingNote: text("purchase_shipping_note"),
    salesShippingNote: text("sales_shipping_note"),
    inputPriceOnOrder: integer("input_price_on_order", { mode: "boolean" })
      .notNull()
      .default(false),
    memo: text("memo"),
    discontinued: integer("discontinued", { mode: "boolean" }).notNull().default(false),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("items_code").on(t.code),
    index("items_supplier").on(t.supplierId),
    index("items_genre").on(t.genreId),
    index("items_jan").on(t.jan),
  ],
);
