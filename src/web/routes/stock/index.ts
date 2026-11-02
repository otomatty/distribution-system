/** 在庫（台帳・在庫操作・棚卸）の画面のルート。app.tsx から "/" に取り付ける */
import { Hono } from "hono";

import type { AppEnv } from "../../types";

export const stockRoutes = new Hono<AppEnv>();
