import { enc, withQuery, type Query } from "./query";

/** マスタ・管理の画面 */
export const mastersPaths = {
  partners: (query?: Query) => withQuery("/partners", query),
  partnerNew: () => "/partners/new",
  partner: (id: string) => `/partners/${enc(id)}`,
  partnerEdit: (id: string) => `/partners/${enc(id)}/edit`,
  partnerTerms: (id: string) => `/partners/${enc(id)}/terms`,
  partnerArchive: (id: string) => `/partners/${enc(id)}/archive`,
  partnerDelete: (id: string) => `/partners/${enc(id)}/delete`,

  items: (query?: Query) => withQuery("/items", query),
  locations: () => "/masters/locations",
  stores: () => "/masters/stores",
  genres: () => "/masters/genres",
  employees: () => "/admin/employees",
  settings: () => "/admin/settings",
};
