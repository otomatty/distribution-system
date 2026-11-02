import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// テストはすべて Workers の実行環境（Miniflare）の上で動かす。
// D1（ログイン情報）のマイグレーションは各テストの前に適用する（tests/setup.ts）。
const authMigrations = await readD1Migrations("./drizzle/auth");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ENVIRONMENT: "test",
          BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0000",
          GOOGLE_CLIENT_ID: "test-client-id",
          GOOGLE_CLIENT_SECRET: "test-client-secret",
          TEST_AUTH_MIGRATIONS: authMigrations,
        },
      },
    }),
  ],
  test: {
    include: ["src/**/*.test.{ts,tsx}", "tests/integration/**/*.test.{ts,tsx}"],
    setupFiles: ["./tests/setup.ts"],
    coverage: {
      provider: "istanbul",
      include: ["src/domain/**", "src/usecases/**"],
      exclude: ["**/*.test.ts", "**/index.ts"],
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
});
