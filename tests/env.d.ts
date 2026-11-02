// テストだけで使うバインディング（vitest.config.ts で設定する）
import type { D1Migration } from "cloudflare:test";

declare global {
  interface __BaseEnv_Env {
    TEST_AUTH_MIGRATIONS?: D1Migration[];
  }
}
