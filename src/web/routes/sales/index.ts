/** 販売（受注・引当・分割・発送・納品書）の画面のルート。app.tsx から "/" に取り付ける */
import { Hono } from "hono";

import type { AppEnv } from "../../types";
import { salesOrderRoutes, shipmentRoutes } from "./orders";
import { shippingRoutes } from "./shipping";

export const salesRoutes = new Hono<AppEnv>();

salesRoutes.route("/sales-orders", salesOrderRoutes);
salesRoutes.route("/shipments", shipmentRoutes);
salesRoutes.route("/shipping", shippingRoutes);
