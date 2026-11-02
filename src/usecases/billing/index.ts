/** 請求と入金（請求書・締め処理・返品・返還請求書・入金と消込・売掛・販売先廃棄・集計）のユースケース。追加したら下の一覧に1行ずつ登録する */
import {
  cancelDisposalCommand,
  createDisposal,
  disposalRates,
  getDisposal,
  listDisposals,
  shippedItemsForCustomer,
} from "./disposals";
import {
  billingDashboard,
  cancelInvoiceCommand,
  closeInvoices,
  draftInvoice,
  getInvoice,
  issueInvoiceCommand,
  listClosingCandidates,
  listInvoices,
  listUnbilled,
  reissueInvoice,
} from "./invoices";
import {
  allocateCustomerPayment,
  cancelAllocationCommand,
  cancelCustomerPayment,
  createCustomerPayment,
  getCustomerPayment,
  listCustomerPayments,
  listOpenInvoices,
  listReceivables,
  listReceiptSchedule,
} from "./payments";
import {
  cancelSalesReturnCommand,
  createSalesReturn,
  getSalesReturn,
  issueCreditNote,
  orderReturns,
} from "./returns";

export const billingCommands = {
  "invoices.issue": issueInvoiceCommand,
  "invoices.close": closeInvoices,
  "invoices.cancel": cancelInvoiceCommand,
  "invoices.reissue": reissueInvoice,
  "salesReturns.create": createSalesReturn,
  "salesReturns.cancel": cancelSalesReturnCommand,
  "creditNotes.issue": issueCreditNote,
  "customerPayments.create": createCustomerPayment,
  "customerPayments.allocate": allocateCustomerPayment,
  "customerPayments.cancel": cancelCustomerPayment,
  "paymentAllocations.cancel": cancelAllocationCommand,
  "disposals.create": createDisposal,
  "disposals.cancel": cancelDisposalCommand,
} as const;

export const billingQueries = {
  "invoices.list": listInvoices,
  "invoices.get": getInvoice,
  "invoices.unbilled": listUnbilled,
  "invoices.draft": draftInvoice,
  "invoices.closing": listClosingCandidates,
  "billing.dashboard": billingDashboard,
  "salesReturns.forOrder": orderReturns,
  "salesReturns.get": getSalesReturn,
  "customerPayments.list": listCustomerPayments,
  "customerPayments.get": getCustomerPayment,
  "customerPayments.openInvoices": listOpenInvoices,
  "receivables.balances": listReceivables,
  "receivables.schedule": listReceiptSchedule,
  "disposals.list": listDisposals,
  "disposals.get": getDisposal,
  "disposals.shippedItems": shippedItemsForCustomer,
  "disposals.rates": disposalRates,
} as const;
