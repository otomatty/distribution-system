import { expect, test } from "@playwright/test";

import { login } from "./helpers";
import { registerItem, registerSupplier } from "./masters-helpers";

test("商品を登録すると商品コードが自動で採番され、一覧で検索できる", async ({ page }) => {
  await login(page);
  const supplier = await registerSupplier(page);
  const name = await registerItem(page, supplier, "E2Eクッキー");
  await expect(page.getByText("¥123.45／個")).toBeVisible();
  await expect(page.getByText(/IT\d{6}/)).toBeVisible();

  await page.goto("/items");
  await page.getByLabel("商品名・コード・JAN で検索").fill(name);
  await expect(page.locator("#results")).toContainText(name);
  await expect(page.locator("#results")).toContainText(supplier);
  await expect(page).toHaveURL(/q=/);
});

test("商品の入力に誤りがあれば、項目の下にエラーを表示する", async ({ page }) => {
  await login(page);
  await page.goto("/items/new");
  await page.getByLabel(/^JAN/).fill("4901234567890");
  await page.getByRole("button", { name: "登録する" }).click();
  await expect(page.getByText("JAN のチェックディジットが正しくありません")).toBeVisible();
  await expect(page.getByText("仕入先を選んでください")).toBeVisible();
});
