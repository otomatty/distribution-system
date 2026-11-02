/** 仕入（発注・入荷・仕入返品・仕入先請求書・支払）の画面のルート。app.tsx から "/" に取り付ける */
import { Hono } from "hono";

import type { AppEnv } from "../../types";

export const purchasingRoutes = new Hono<AppEnv>();
