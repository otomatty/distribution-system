/** 仕入（発注・入荷・仕入返品・仕入先請求書・支払）のユースケース。追加したら下の一覧に1行ずつ登録する */
import { purchasingDashboard, receiptsDueToday } from "./dashboard";
import { makerDirectDraft, makerDirectPlan } from "./maker-direct";
import {
  cancelPurchaseOrder,
  confirmPurchaseOrder,
  createPurchaseOrder,
  getPurchaseOrder,
  listPurchaseOrders,
  previewPurchaseOrder,
  updatePurchaseOrder,
  updatePurchaseOrderMemo,
} from "./purchase-orders";
import { createPurchaseReturn } from "./purchase-returns";
import { cancelPurchaseReceipt, receivingSchedule, recordPurchaseReceipt } from "./receipts";
import {
  cancelSupplierInvoiceCommand,
  cancelSupplierPaymentCommand,
  createSupplierInvoice,
  getSupplierInvoice,
  listPayables,
  listSupplierInvoices,
  payableBalancesQuery,
  payBulkSupplierInvoices,
  paySupplierInvoiceCommand,
  previewSupplierInvoice,
  supplierInvoiceCandidates,
} from "./supplier-invoices";

export const purchasingCommands = {
  "purchaseOrders.create": createPurchaseOrder,
  "purchaseOrders.update": updatePurchaseOrder,
  "purchaseOrders.confirm": confirmPurchaseOrder,
  "purchaseOrders.cancel": cancelPurchaseOrder,
  "purchaseOrders.updateMemo": updatePurchaseOrderMemo,
  "receipts.record": recordPurchaseReceipt,
  "receipts.cancel": cancelPurchaseReceipt,
  "purchaseReturns.create": createPurchaseReturn,
  "supplierInvoices.create": createSupplierInvoice,
  "supplierInvoices.cancel": cancelSupplierInvoiceCommand,
  "supplierInvoices.pay": paySupplierInvoiceCommand,
  "supplierInvoices.payBulk": payBulkSupplierInvoices,
  "supplierInvoices.cancelPayment": cancelSupplierPaymentCommand,
} as const;

export const purchasingQueries = {
  "purchaseOrders.list": listPurchaseOrders,
  "purchaseOrders.get": getPurchaseOrder,
  "purchaseOrders.preview": previewPurchaseOrder,
  "purchaseOrders.makerDirectPlan": makerDirectPlan,
  "purchaseOrders.makerDirectDraft": makerDirectDraft,
  "receipts.schedule": receivingSchedule,
  "receipts.dueToday": receiptsDueToday,
  "supplierInvoices.list": listSupplierInvoices,
  "supplierInvoices.get": getSupplierInvoice,
  "supplierInvoices.candidates": supplierInvoiceCandidates,
  "supplierInvoices.preview": previewSupplierInvoice,
  "payables.list": listPayables,
  "payables.balances": payableBalancesQuery,
  "purchasing.dashboard": purchasingDashboard,
} as const;
