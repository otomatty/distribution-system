/** マスタ（社員・設定・取引先・商品・保管場所・払い出し先店舗・ジャンル）のユースケース */
import { createEmployee, getEmployee, listEmployees, updateEmployee } from "./employees";
import {
  createItem,
  deleteItem,
  discontinueItem,
  getItem,
  getItems,
  listItems,
  pickItems,
  updateItem,
} from "./items";
import {
  archiveLocation,
  createLocation,
  getLocation,
  listLocations,
  locationOptions,
  updateLocation,
} from "./locations";
import {
  archivePartner,
  createPartner,
  deletePartner,
  getPartner,
  listPartners,
  partnerOptions,
  updatePartner,
  updatePartnerTerms,
} from "./partners";
import { addTaxRate, getSettings, updateCompanySettings } from "./settings";
import { genreUsecases, retailStoreUsecases } from "./simple-masters";

export const mastersCommands = {
  "employees.create": createEmployee,
  "employees.update": updateEmployee,
  "partners.create": createPartner,
  "partners.update": updatePartner,
  "partners.updateTerms": updatePartnerTerms,
  "partners.archive": archivePartner,
  "partners.delete": deletePartner,
  "settings.updateCompany": updateCompanySettings,
  "settings.addTaxRate": addTaxRate,
  "items.create": createItem,
  "items.update": updateItem,
  "items.discontinue": discontinueItem,
  "items.delete": deleteItem,
  "locations.create": createLocation,
  "locations.update": updateLocation,
  "locations.archive": archiveLocation,
  "genres.create": genreUsecases.create,
  "genres.update": genreUsecases.update,
  "genres.archive": genreUsecases.archive,
  "retailStores.create": retailStoreUsecases.create,
  "retailStores.update": retailStoreUsecases.update,
  "retailStores.archive": retailStoreUsecases.archive,
} as const;

export const mastersQueries = {
  "employees.list": listEmployees,
  "employees.get": getEmployee,
  "partners.list": listPartners,
  "partners.get": getPartner,
  "partners.options": partnerOptions,
  "settings.get": getSettings,
  "items.list": listItems,
  "items.get": getItem,
  "items.getMany": getItems,
  "items.pick": pickItems,
  "locations.list": listLocations,
  "locations.get": getLocation,
  "locations.options": locationOptions,
  "genres.list": genreUsecases.list,
  "genres.get": genreUsecases.get,
  "genres.options": genreUsecases.options,
  "retailStores.list": retailStoreUsecases.list,
  "retailStores.get": retailStoreUsecases.get,
  "retailStores.options": retailStoreUsecases.options,
} as const;
