/**
 * 開発・テスト用の入口：テストデータの投入（scripts/seed.mjs から呼ぶ。要件定義書 9章）。
 * 開発用ログインと同じく、ENVIRONMENT が development / test のときだけ使える（本番・検証環境では 404）。
 * 業務 DB の側でも同じ条件を確かめる（BusinessDb.seed）。
 */
import { Hono } from "hono";

import { isDevAuthAllowed } from "../../infra/do/actor-ref";
import { businessDb } from "../../infra/do/client";
import { seedRequestSchema } from "../../infra/seed/request";
import type { AppEnv } from "../types";

export const devRoutes = new Hono<AppEnv>();

devRoutes.post("/dev/seed", async (c) => {
  if (!isDevAuthAllowed(c.env.ENVIRONMENT)) return c.notFound();
  const body: unknown = await c.req.json().catch(() => null);
  const parsed = seedRequestSchema.safeParse(body);
  if (!parsed.success)
    return c.json(
      { ok: false, error: { code: "validation", message: "依頼の内容が正しくありません" } },
      400,
    );
  const result = await businessDb(c.env).seed(parsed.data);
  return c.json(result, result.ok ? 200 : 400);
});
