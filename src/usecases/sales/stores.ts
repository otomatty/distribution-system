import type { SalesOrderStore } from "./orders.port";
import type { ShipmentStore } from "./shipments.port";

/** 販売（受注・引当・分割・発送・納品書）のポート。実装は infra/db/stores/sales */
export interface SalesStores {
  readonly salesOrders: SalesOrderStore;
  readonly shipments: ShipmentStore;
}
