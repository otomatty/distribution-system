/** マスタの画面のルート。app.tsx から "/" に取り付ける */
import { Hono } from "hono";

import type { AppEnv } from "../../types";
import { partnerRoutes } from "./partners";

export const mastersRoutes = new Hono<AppEnv>();

mastersRoutes.route("/partners", partnerRoutes);
