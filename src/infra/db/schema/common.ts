import { integer, text } from "drizzle-orm/sqlite-core";

/** 全テーブル共通の列：ID（ULID）、作成・更新の日時と操作者、版番号（AGENTS.md 4章）。 */
export const auditColumns = {
  createdAt: text("created_at").notNull(),
  createdBy: text("created_by").notNull(),
  updatedAt: text("updated_at").notNull(),
  updatedBy: text("updated_by").notNull(),
  version: integer("version").notNull().default(1),
};

export const id = () => text("id").primaryKey();

/** 連絡先一式（取引先・保管場所・自社で共通） */
export const contactColumns = {
  contactName: text("contact_name"),
  postalCode: text("postal_code"),
  address: text("address"),
  phone: text("phone"),
  mobile: text("mobile"),
  fax: text("fax"),
  email: text("email"),
  lineId: text("line_id"),
  mainContact: text("main_contact", { enum: ["line", "email", "fax", "phone", "mobile"] }),
};
