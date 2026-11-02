import { expect, test } from "@playwright/test";

import { login, unique } from "./helpers";

test("取引先を登録して一覧で検索できる", async ({ page }) => {
  await login(page);
  const name = unique("株式会社E2E製菓");
  await page.goto("/partners/new");
  await page.getByLabel("名称").fill(name);
  await page.getByLabel("読み仮名").fill("イーツーイーセイカ");
  await page.getByLabel("仕入先").check();
  await page.getByRole("button", { name: "登録する" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();

  await page.goto("/partners");
  await page.getByLabel("名称・読み仮名・電話で検索").fill(name);
  await expect(page.locator("#results")).toContainText(name);
});
