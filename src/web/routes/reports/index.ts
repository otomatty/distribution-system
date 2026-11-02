/** 集計（売上・仕入の月別の集計）の画面のルート。app.tsx から "/" に取り付ける */
import { Hono } from "hono";

import type { AppEnv } from "../../types";
import { reportRoutes } from "./monthly";

export const reportsRoutes = new Hono<AppEnv>();

reportsRoutes.route("/reports", reportRoutes);
