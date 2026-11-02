/** ダッシュボード（要件定義書 3.13）。役割ごとの「今日やること」 */
import { Hono } from "hono";

import { paths } from "../paths";
import type { AppEnv } from "../types";
import { PageHeader } from "../views/components";
import { Layout } from "../views/layout";

export const dashboardRoutes = new Hono<AppEnv>();

dashboardRoutes.get("/", (c) => {
  const actor = c.get("actor");
  return c.html(
    <Layout title="ダッシュボード" actor={actor} current={paths.home()}>
      <PageHeader title="ダッシュボード" />
      <p>{actor.name} さん、おつかれさまです。</p>
    </Layout>,
  );
});
