import { expect, test, type Page } from "@playwright/test";

import { login } from "./helpers";
import { registerItem, registerLocation, registerSupplier } from "./masters-helpers";

/** 商品選択ダイアログで商品を検索して追加する */
async function pickItem(page: Page, itemName: string): Promise<void> {
  await page.getByRole("button", { name: "商品を追加" }).click();
  const dialog = page.getByRole("dialog", { name: "商品を選ぶ" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("商品名・商品コード・JAN で検索").fill(itemName);
  const row = dialog.getByRole("row", { name: new RegExp(itemName) });
  await row.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "選んだ商品を追加" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#op-lines")).toContainText(itemName);
}

test("在庫操作で初期在庫を入れ、別の保管場所へ移動できる @tablet", async ({ page }) => {
  await login(page);
  const supplier = await registerSupplier(page);
  const itemName = await registerItem(page, supplier, "E2E在庫商品");
  const from = await registerLocation(page);
  const to = await registerLocation(page);

  // 初期在庫（調整）
  await page.goto("/stock/operations/new");
  await expect(page.locator("body")).toHaveClass(/touch/);
  await page.getByLabel(/^保管場所/).selectOption({ label: from });
  await page.getByLabel(/^理由/).selectOption("initial");
  await pickItem(page, itemName);
  const quantity = page.getByLabel(`${itemName}の数量`, { exact: true });
  await quantity.fill("10");
  await page.getByRole("button", { name: `${itemName}の数量を1つ増やす` }).click();
  await expect(quantity).toHaveValue("11");
  await page.getByRole("button", { name: "調整を記録する" }).click();
  await expect(page.getByRole("heading", { name: /^調整 SOP-\d{4}-\d{6}$/ })).toBeVisible();
  await expect(page.getByText("+11")).toBeVisible();
  await expect(page.getByText("初期在庫")).toBeVisible();

  // 移動元の在庫を超える移動はエラーになり、足りない商品と数を表示する
  await page.goto("/stock/operations/new?kind=transfer");
  await page.getByLabel(/^移動元/).selectOption({ label: from });
  await page.getByLabel(/^移動先/).selectOption({ label: to });
  await pickItem(page, itemName);
  await page.getByLabel(`${itemName}の数量`, { exact: true }).fill("20");
  await page.getByRole("button", { name: "移動を記録する" }).click();
  await expect(page.getByText("在庫が足りないため記録できませんでした")).toBeVisible();
  await expect(page.locator(".shortage-table")).toContainText(itemName);

  // 入力は残っているので、数を直して記録し直す
  await page.getByLabel(`${itemName}の数量`, { exact: true }).fill("4");
  await page.getByRole("button", { name: "移動を記録する" }).click();
  await expect(page.getByRole("heading", { name: /^移動 SOP-/ })).toBeVisible();
  await expect(page.getByText(`${from} → ${to}`)).toBeVisible();

  // 在庫一覧に保管場所ごとの在庫が出る
  await page.goto(`/stock?q=${encodeURIComponent(itemName)}`);
  const results = page.locator("#results");
  await expect(results.getByRole("row", { name: new RegExp(from) })).toContainText("7");
  await expect(results.getByRole("row", { name: new RegExp(to) })).toContainText("4");
});

test("在庫操作の入力途中の内容は、開き直しても残る @tablet", async ({ page }) => {
  await login(page);
  const supplier = await registerSupplier(page);
  const itemName = await registerItem(page, supplier, "E2E下書き商品");
  const location = await registerLocation(page);

  await page.goto("/stock/operations/new?kind=adjustment");
  await page.getByLabel(/^保管場所/).selectOption({ label: location });
  await page.getByLabel(/^理由/).selectOption("initial");
  await pickItem(page, itemName);
  await page.getByLabel(`${itemName}の数量`, { exact: true }).fill("6");
  // 下書きの保存（入力から少し後）を待ってから開き直す
  await page.waitForTimeout(800);
  await page.reload();
  await expect(page.getByText("前回の入力途中の内容を復元しました")).toBeVisible();
  await expect(page.getByLabel(`${itemName}の数量`, { exact: true })).toHaveValue("6");
  await expect(page.getByLabel(/^理由/)).toHaveValue("initial");
  await page.getByRole("button", { name: "調整を記録する" }).click();
  await expect(page.getByRole("heading", { name: /^調整 SOP-/ })).toBeVisible();
  await expect(page.getByText("+6")).toBeVisible();
});
