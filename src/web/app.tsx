/** Hono アプリ。画面のルートを業務の区分ごとにまとめる。 */
import { Hono, type Context } from "hono";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";

import { reportCritical } from "../infra/observability/notify";
import { authFor } from "./auth";
import { requireActor, securityHeaders } from "./middleware";
import { authRoutes } from "./routes/auth";
import { billingRoutes } from "./routes/billing";
import { dashboardRoutes } from "./routes/dashboard";
import { mastersRoutes } from "./routes/masters";
import { platformRoutes } from "./routes/platform";
import { purchasingRoutes } from "./routes/purchasing";
import { salesRoutes } from "./routes/sales";
import { stockRoutes } from "./routes/stock";
import type { AppEnv } from "./types";
import { QueryError } from "./usecase";

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", securityHeaders);
  // 画面からの POST は Origin を検証する（CSRF 対策）
  app.use(
    "*",
    csrf({
      origin: (origin, c: Context<AppEnv>) =>
        origin === new URL(c.env.APP_ORIGIN).origin || origin === new URL(c.req.url).origin,
    }),
  );

  app.on(["GET", "POST"], "/api/auth/*", (c) => authFor(c.env).handler(c.req.raw));
  app.route("/", authRoutes);

  // ここから下はログインが必要
  app.use("*", requireActor);
  app.route("/", dashboardRoutes);
  app.route("/", mastersRoutes);
  app.route("/", stockRoutes);
  app.route("/", purchasingRoutes);
  app.route("/", salesRoutes);
  app.route("/", billingRoutes);
  app.route("/", platformRoutes);

  app.notFound((c) => c.text("ページが見つかりません", 404));
  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    if (error instanceof QueryError && error.code === "forbidden")
      return c.text(error.message, 403);
    // 想定外のエラーはログに残し、管理者にメールで知らせる（同じエラーは1時間に1回まで）
    const report = reportCritical(c.env, "unhandled error", error, {
      method: c.req.method,
      path: c.req.path,
    });
    try {
      c.executionCtx.waitUntil(report);
    } catch {
      // 実行コンテキストがない場合（テストから直接呼んだときなど）は待たずに続ける
      void report;
    }
    return c.text("エラーが発生しました。時間をおいてもう一度お試しください。", 500);
  });
  return app;
}
