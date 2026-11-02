/** 請求と入金（請求書・締め処理・返品・返還請求書・入金と消込・売掛・販売先廃棄・集計）の画面のルート。app.tsx から "/" に取り付ける */
import { Hono } from "hono";

import type { AppEnv } from "../../types";
import { disposalRoutes } from "./disposals";
import { invoiceRoutes } from "./invoices";
import { receiptRoutes } from "./receipts";
import { receivableRoutes } from "./receivables";
import { salesReturnRoutes } from "./returns";

export const billingRoutes = new Hono<AppEnv>();

billingRoutes.route("/invoices", invoiceRoutes);
billingRoutes.route("/sales-returns", salesReturnRoutes);
billingRoutes.route("/receipts", receiptRoutes);
billingRoutes.route("/receivables", receivableRoutes);
billingRoutes.route("/disposals", disposalRoutes);
