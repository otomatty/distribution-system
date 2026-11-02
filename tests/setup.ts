// 各テストファイルの前に、ログイン情報（D1）のマイグレーションを適用する
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

await applyD1Migrations(env.AUTH_DB, env.TEST_AUTH_MIGRATIONS ?? []);
