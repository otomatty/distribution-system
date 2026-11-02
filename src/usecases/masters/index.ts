/** マスタ（社員・設定・取引先・商品・保管場所・払い出し先店舗・ジャンル）のユースケース */
import { createEmployee, getEmployee, listEmployees, updateEmployee } from "./employees";
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
} as const;

export const mastersQueries = {
  "employees.list": listEmployees,
  "employees.get": getEmployee,
  "partners.list": listPartners,
  "partners.get": getPartner,
  "partners.options": partnerOptions,
  "settings.get": getSettings,
} as const;
