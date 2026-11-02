import type { Page } from "@playwright/test";

export const ADMIN_EMAIL = "admin@example.co.jp";

/** 開発用ログイン（ENVIRONMENT が development のときだけ使える） */
export async function login(page: Page, email = ADMIN_EMAIL): Promise<void> {
  await page.goto("/dev/login");
  await page.getByLabel("メールアドレス").fill(email);
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  await page.waitForURL("/");
}

/** テストごとに重ならない名前 */
export function unique(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}`;
}
