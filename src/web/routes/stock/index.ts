/** 在庫（台帳・在庫操作・棚卸）の画面のルート。app.tsx から "/" に取り付ける */
import { Hono } from "hono";

import type { AppEnv } from "../../types";
import { stockLedgerRoutes } from "./ledger";
import { stockListRoutes } from "./list";
import { stockOperationRoutes } from "./operations";
import { stocktakingRoutes } from "./stocktaking";

export const stockRoutes = new Hono<AppEnv>();

// /stock/:itemId より先に、固定の URL を取り付ける
stockRoutes.route("/stock/operations", stockOperationRoutes);
stockRoutes.route("/stock/stocktaking", stocktakingRoutes);
stockRoutes.route("/stock", stockListRoutes);
stockRoutes.route("/stock", stockLedgerRoutes);
