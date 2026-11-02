import type { BillingStores } from "../../../../usecases/billing/stores";
import type { Db } from "../../client";
import { disposalStore } from "./disposals";
import { invoiceStore } from "./invoices";
import { customerPaymentStore } from "./payments";
import { salesReturnStore } from "./returns";

/** 請求と入金（請求書・締め処理・返品・返還請求書・入金と消込・売掛・販売先廃棄・集計）のポートの実装をまとめる */
export function createBillingStores(db: Db): BillingStores {
  return {
    invoices: invoiceStore(db),
    salesReturns: salesReturnStore(db),
    customerPayments: customerPaymentStore(db),
    disposals: disposalStore(db),
  };
}
