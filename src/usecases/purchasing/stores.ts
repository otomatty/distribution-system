import type { PurchaseOrderStore } from "./purchase-orders.port";
import type { PurchaseReturnStore } from "./purchase-returns.port";
import type { ReceiptStore } from "./receipts.port";
import type { SupplierInvoiceStore } from "./supplier-invoices.port";

/** 仕入（発注・入荷・仕入返品・仕入先請求書・支払）のポート。実装は infra/db/stores/purchasing */
export interface PurchasingStores {
  readonly purchaseOrders: PurchaseOrderStore;
  readonly receipts: ReceiptStore;
  readonly purchaseReturns: PurchaseReturnStore;
  readonly supplierInvoices: SupplierInvoiceStore;
}
