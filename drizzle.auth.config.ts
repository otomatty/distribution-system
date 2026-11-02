import { defineConfig } from "drizzle-kit";

// ログイン情報（D1、Better Auth）のマイグレーション。wrangler d1 migrations apply で適用する。
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/infra/auth/schema.ts",
  out: "./drizzle/auth",
});
