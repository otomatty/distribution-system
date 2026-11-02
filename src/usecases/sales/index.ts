/** 販売（受注・引当・分割・発送・納品書）のユースケース。追加したら下の一覧に1行ずつ登録する */
import { salesDashboard } from "./dashboard";
import {
  cancelSalesOrderCommand,
  createSalesOrder,
  defaultShipDate,
  getLinkedPurchaseOrders,
  getSalesOrder,
  listSalesOrders,
  previewSalesOrder,
  splitSalesOrder,
  updateSalesOrder,
} from "./orders";
import {
  bulkDeliveryNotes,
  bulkShip,
  cancelShipmentCommand,
  checkBulkShipment,
  deliveryNoteDefaultDate,
  listUnbilledShipments,
  shippingList,
  shipSalesOrderCommand,
} from "./shipments";

export const salesCommands = {
  "salesOrders.create": createSalesOrder,
  "salesOrders.update": updateSalesOrder,
  "salesOrders.cancel": cancelSalesOrderCommand,
  "salesOrders.split": splitSalesOrder,
  "shipments.ship": shipSalesOrderCommand,
  "shipments.cancel": cancelShipmentCommand,
  "shipments.bulkShip": bulkShip,
  "deliveryNotes.bulkPdf": bulkDeliveryNotes,
} as const;

export const salesQueries = {
  "salesOrders.list": listSalesOrders,
  "salesOrders.get": getSalesOrder,
  "salesOrders.linkedPurchaseOrders": getLinkedPurchaseOrders,
  "salesOrders.preview": previewSalesOrder,
  "salesOrders.defaultShipDate": defaultShipDate,
  "shipping.list": shippingList,
  "shipping.check": checkBulkShipment,
  "shipments.unbilled": listUnbilledShipments,
  "shipments.deliveryNoteDate": deliveryNoteDefaultDate,
  "sales.dashboard": salesDashboard,
} as const;
