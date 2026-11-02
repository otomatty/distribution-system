import type { PurchasingStores } from "../../../../usecases/purchasing/stores";
import type { Db } from "../../client";
import { purchaseOrderStore } from "./purchase-orders";
import { purchaseReturnStore } from "./purchase-returns";
import { receiptStore } from "./receipts";
import { supplierInvoiceStore } from "./supplier-invoices";

/** 仕入（発注・入荷・仕入返品・仕入先請求書・支払）のポートの実装をまとめる */
export function createPurchasingStores(db: Db): PurchasingStores {
  return {
    purchaseOrders: purchaseOrderStore(db),
    receipts: receiptStore(db),
    purchaseReturns: purchaseReturnStore(db),
    supplierInvoices: supplierInvoiceStore(db),
  };
}
