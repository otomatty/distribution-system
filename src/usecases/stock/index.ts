/** 在庫（台帳・在庫操作・棚卸）のユースケース。追加したら下の一覧に1行ずつ登録する */
import { createStockOperation, getStockOperation, listStockOperations } from "./operations";
import {
  describeShortages,
  exportStock,
  getItemStock,
  getStockLevels,
  listLedger,
  listReorderAlerts,
  listStock,
} from "./queries";
import { createStocktake, stocktakeSheet } from "./stocktaking";

export const stockCommands = {
  "stockOperations.create": createStockOperation,
  "stocktakes.create": createStocktake,
} as const;

export const stockQueries = {
  "stock.list": listStock,
  "stock.export": exportStock,
  "stock.item": getItemStock,
  "stock.ledger": listLedger,
  "stock.levels": getStockLevels,
  "stock.shortages": describeShortages,
  "stock.reorderAlerts": listReorderAlerts,
  "stockOperations.list": listStockOperations,
  "stockOperations.get": getStockOperation,
  "stocktakes.sheet": stocktakeSheet,
} as const;
