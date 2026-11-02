import type { DisposalStore } from "./disposals.port";
import type { InvoiceStore } from "./invoices.port";
import type { CustomerPaymentStore } from "./payments.port";
import type { SalesReturnStore } from "./returns.port";

/** 請求と入金（請求書・締め処理・返品・返還請求書・入金と消込・売掛・販売先廃棄・集計）のポート。実装は infra/db/stores/billing */
export interface BillingStores {
  readonly invoices: InvoiceStore;
  readonly salesReturns: SalesReturnStore;
  readonly customerPayments: CustomerPaymentStore;
  readonly disposals: DisposalStore;
}
