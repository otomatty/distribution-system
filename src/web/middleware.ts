import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";

import { can, isRole, type Permission } from "../domain/roles";
import { isDevAuthAllowed, type ActorRef } from "../infra/do/actor-ref";
import { businessDb } from "../infra/do/client";
import { authFor } from "./auth";
import { isHtmx } from "./http";
import { paths } from "./paths";
import type { AppEnv } from "./types";

export const DEV_ACTOR_COOKIE = "dev_actor";

/** ログイン中の社員を読み込む。未ログイン・未登録ならログイン画面へ */
export const requireActor: MiddlewareHandler<AppEnv> = async (c, next) => {
  let ref: ActorRef | null = null;
  const session = await authFor(c.env).api.getSession({ headers: c.req.raw.headers });
  if (session) {
    ref = { kind: "auth", userId: session.user.id };
  } else if (isDevAuthAllowed(c.env.ENVIRONMENT)) {
    const email = getCookie(c, DEV_ACTOR_COOKIE);
    if (email) ref = { kind: "dev", email };
  }
  if (!ref) {
    if (isHtmx(c)) {
      c.header("HX-Redirect", paths.login());
      return c.body(null, 401);
    }
    return c.redirect(paths.login());
  }
  const actor = await businessDb(c.env).resolveActor(ref);
  if (!actor) return c.redirect(paths.noAccess());
  c.set("actorRef", ref);
  c.set("actor", actor);
  await next();
  c.header("Cache-Control", "no-store");
  return undefined;
};

/** 画面の表示に権限が必要な場合（管理者専用の画面など）。操作の権限はユースケースで必ず判定する */
export function requirePermission(permission: Permission): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const roles = c.get("actor").roles.filter(isRole);
    if (!can(roles, permission)) return c.text("この画面を見る権限がありません", 403);
    await next();
    return undefined;
  };
}

export function hasPermission(actorRoles: readonly string[], permission: Permission): boolean {
  return can(actorRoles.filter(isRole), permission);
}

/** 基本的なセキュリティヘッダー */
export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "same-origin");
  c.header("X-Frame-Options", "DENY");
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'; base-uri 'self'",
  );
};
