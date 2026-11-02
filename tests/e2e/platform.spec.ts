import { expect, test } from "@playwright/test";

import { login } from "./helpers";

test("ダッシュボードから処理状況と帳票の検索に移り、絞り込みを URL に残せる", async ({ page }) => {
  // 画面は CSP（default-src 'self'）に違反しない（埋め込みのスクリプトやスタイルを使わない）
  const violations: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && message.text().includes("Content Security Policy")) {
      violations.push(message.text());
    }
  });

  await login(page);
  await expect(page.getByRole("heading", { name: "今日やること" })).toBeVisible();
  await expect(page.getByText("送付に失敗した帳票")).toBeVisible();
  await expect(page.getByText("日次バックアップの異常")).toBeVisible();

  await page.getByRole("link", { name: /失敗した処理/ }).click();
  await expect(page).toHaveURL(/\/jobs\?status=failed$/);
  await expect(page.getByRole("heading", { name: "処理状況" })).toBeVisible();

  await page.getByRole("link", { name: "帳票の検索" }).click();
  await expect(page.getByRole("heading", { name: "帳票の検索" })).toBeVisible();
  await page.getByLabel("番号").fill("PO-2099-");
  await expect(page).toHaveURL(/number=PO-2099-/);
  await expect(page.locator("#results")).toContainText("条件に合う帳票はありません");
  await page.getByLabel("種類").selectOption({ label: "請求書" });
  await expect(page).toHaveURL(/documentType=invoice/);

  expect(violations).toEqual([]);
});
