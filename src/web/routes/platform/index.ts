/** 共通の仕組み（帳票・送付・処理状況・CSV・バックアップ・ダッシュボード）の画面のルート。app.tsx から "/" に取り付ける */
import { Hono } from "hono";

import type { AppEnv } from "../../types";

export const platformRoutes = new Hono<AppEnv>();
