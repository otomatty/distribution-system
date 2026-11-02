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
  itemNew: () => "/items/new",
  item: (id: string) => `/items/${enc(id)}`,
  itemEdit: (id: string) => `/items/${enc(id)}/edit`,
  itemDiscontinue: (id: string) => `/items/${enc(id)}/discontinue`,
  itemDelete: (id: string) => `/items/${enc(id)}/delete`,
  /** 商品選択ダイアログの検索結果（部分 HTML） */
  itemPicker: (query?: Query) => withQuery("/items/picker", query),
  /** 商品の CSV 一括登録（画面・確認・取込・ひな形） */
  itemImport: () => "/items/import",
  itemImportCheck: () => "/items/import/check",
  itemImportTemplate: () => "/items/import/template.csv",

  locations: (query?: Query) => withQuery("/masters/locations", query),
  locationNew: () => "/masters/locations/new",
  location: (id: string) => `/masters/locations/${enc(id)}`,
  locationArchive: (id: string) => `/masters/locations/${enc(id)}/archive`,
  stores: (query?: Query) => withQuery("/masters/stores", query),
  storeNew: () => "/masters/stores/new",
  store: (id: string) => `/masters/stores/${enc(id)}`,
  storeArchive: (id: string) => `/masters/stores/${enc(id)}/archive`,
  genres: (query?: Query) => withQuery("/masters/genres", query),
  genreNew: () => "/masters/genres/new",
  genre: (id: string) => `/masters/genres/${enc(id)}`,
  genreArchive: (id: string) => `/masters/genres/${enc(id)}/archive`,

  employees: () => "/admin/employees",
  employeeNew: () => "/admin/employees/new",
  employee: (id: string) => `/admin/employees/${enc(id)}`,
  settings: () => "/admin/settings",
  settingsCompany: () => "/admin/settings/company",
  settingsTaxRates: () => "/admin/settings/tax-rates",
};
