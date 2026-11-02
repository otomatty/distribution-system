/** 共通の仕組み（帳票・送付・処理状況・CSV・バックアップ・ダッシュボード）の画面のルート。app.tsx から "/" に取り付ける */
import { Hono } from "hono";

import type { AppEnv } from "../../types";
import { auditLogRoutes } from "./audit-logs";
import { documentRoutes } from "./documents";
import { jobRoutes } from "./jobs";

export const platformRoutes = new Hono<AppEnv>();

platformRoutes.route("/documents", documentRoutes);
platformRoutes.route("/jobs", jobRoutes);
platformRoutes.route("/audit-logs", auditLogRoutes);
