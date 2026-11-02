import { defineConfig } from "drizzle-kit";

// 業務 DB（Durable Objects の SQLite）のマイグレーション。
// 生成後に scripts/build-migrations.mjs が Worker から読み込める TS モジュールに変換する。
export default defineConfig({
  dialect: "sqlite",
  driver: "durable-sqlite",
  schema: "./src/infra/db/schema/index.ts",
  out: "./drizzle/business",
});
