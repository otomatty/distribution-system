/** 仕入（発注・入荷・仕入返品・仕入先請求書・支払）の画面のルート。app.tsx から "/" に取り付ける */
import { Hono } from "hono";

import type { AppEnv } from "../../types";
import { payableRoutes } from "./payables";
import { purchaseOrderRoutes } from "./purchase-orders";
import { receivingRoutes } from "./receiving";
import { supplierInvoiceRoutes } from "./supplier-invoices";

export const purchasingRoutes = new Hono<AppEnv>();

purchasingRoutes.route("/purchase-orders", purchaseOrderRoutes);
purchasingRoutes.route("/receiving", receivingRoutes);
purchasingRoutes.route("/supplier-invoices", supplierInvoiceRoutes);
purchasingRoutes.route("/payables", payableRoutes);
