/**
 * ログイン（Better Auth + Google）。会社の Google Workspace のドメインに限定し、
 * 管理者が事前登録した社員だけがセッションを持てる（要件定義書 2章）。
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/d1";

import * as authSchema from "./schema";

/** 社員の登録状況を業務 DB に問い合わせる口 */
export interface EmployeeDirectory {
  canSignIn(email: string): Promise<boolean>;
  link(email: string, authUserId: string): Promise<boolean>;
  isActive(authUserId: string): Promise<boolean>;
}

export function createAuth(env: Env, directory: EmployeeDirectory) {
  return betterAuth({
    appName: "流通管理システム",
    baseURL: env.APP_ORIGIN,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(drizzle(env.AUTH_DB, { schema: authSchema }), {
      provider: "sqlite",
      schema: authSchema,
    }),
    emailAndPassword: { enabled: false },
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        // Workspace のドメインの検証済みの hd クレームがないアカウントは拒否される
        hd: env.WORKSPACE_DOMAIN,
        prompt: "select_account",
      },
    },
    session: {
      // セッションの確認を署名付き Cookie にキャッシュして、毎回の D1 アクセスを省く。
      // 社員の無効化は業務 DB 側で毎回判定するので、即座に効く。
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },
    trustedOrigins: [env.APP_ORIGIN],
    onAPIError: { errorURL: "/no-access" },
    databaseHooks: {
      user: {
        create: {
          // 未登録の人にはユーザーもセッションも作らない
          before: async (user) =>
            (await directory.canSignIn(user.email)) ? { data: user } : false,
          after: async (user) => {
            await directory.link(user.email, user.id);
          },
        },
      },
      session: {
        create: {
          before: async (session) =>
            (await directory.isActive(session.userId)) ? { data: session } : false,
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
