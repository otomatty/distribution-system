/** 役割と権限表（要件定義書 2章）。権限はユースケースの中で必ず判定する。 */

export const ROLES = ["purchasing", "sales", "accounting", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Readonly<Record<Role, string>> = {
  purchasing: "仕入担当",
  sales: "受注・出荷担当",
  accounting: "経理担当",
  admin: "管理者",
};

export const PERMISSIONS = {
  view: ["purchasing", "sales", "accounting", "admin"],
  "employees.manage": ["admin"],
  "settings.manage": ["admin"],
  "locations.manage": ["admin"],
  "items.manage": ["purchasing", "admin"],
  "partners.manage": ["purchasing", "sales", "admin"],
  "partners.terms": ["accounting", "admin"],
  "purchaseOrders.manage": ["purchasing", "admin"],
  "receipts.manage": ["purchasing", "sales", "admin"],
  "purchaseReturns.manage": ["purchasing", "admin"],
  "supplierInvoices.manage": ["accounting", "admin"],
  "salesOrders.manage": ["sales", "admin"],
  "shipments.manage": ["sales", "admin"],
  "salesReturns.manage": ["sales", "admin"],
  "disposals.manage": ["sales", "admin"],
  "invoices.manage": ["accounting", "admin"],
  "payments.manage": ["accounting", "admin"],
  "stock.manage": ["sales", "admin"],
  /** 帳票の PDF の作り直し、全員の処理状況の閲覧など、共通の仕組みの管理 */
  "platform.admin": ["admin"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(roles: readonly Role[], permission: Permission): boolean {
  const allowed: readonly Role[] = PERMISSIONS[permission];
  return roles.some((r) => allowed.includes(r));
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}
