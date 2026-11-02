import { expect, test } from "@playwright/test";

import { login } from "./helpers";
import { registerItem, registerLocation, registerSupplier } from "./masters-helpers";
import { createAndConfirmOrder } from "./purchasing-helpers";

test("発注を作成して確定し、タブレットで分納の入荷を記録する @tablet", async ({ page }) => {
  await login(page);
  const supplier = await registerSupplier(page);
  const itemName = await registerItem(page, supplier, "E2E発注商品");
  const location = await registerLocation(page);
  const number = await createAndConfirmOrder(page, supplier, itemName, location, "5");

  // 入荷予定一覧（タブレット）から入荷確認へ
  await page.goto("/receiving");
  await expect(page.locator("body")).toHaveClass(/touch/);
  await page.getByRole("link", { name: new RegExp(number) }).click();
  // 「−」「＋」は画面の補助スクリプト（defer）で動くので、読み込みが終わるまで待つ
  await page.waitForURL(/\/receiving\/[0-9A-Z]{26}$/);
  await expect(page.getByRole("heading", { name: `入荷確認 ${number}` })).toBeVisible();

  // 1回目：5ケースのうち2ケースだけ届いた（＋ボタンでも増減できる）
  const accepted = page.getByLabel(`${itemName}の受入数`, { exact: true });
  await expect(accepted).toHaveValue("5");
  await accepted.fill("1");
  await page.getByRole("button", { name: `${itemName}の受入数を1つ増やす` }).click();
  await expect(accepted).toHaveValue("2");
  await page.getByRole("button", { name: "入荷を記録する" }).click();
  await expect(page.getByText("残りの商品は次の入荷で記録します（分納）")).toBeVisible();
  await expect(page.getByLabel(`${itemName}の受入数`, { exact: true })).toHaveValue("3");

  // 2回目：残りの3ケース
  await page.getByRole("button", { name: "入荷を記録する" }).click();
  await expect(page.getByText("この発注は入荷済みになりました")).toBeVisible();
  await expect(page.getByRole("cell", { name: /^RC-\d{4}-\d{6}$/ })).toHaveCount(2);

  // 在庫は 5 ケース × 24 個
  await page.goto(`/stock?q=${encodeURIComponent(itemName)}`);
  await expect(
    page.locator("#results").getByRole("row", { name: new RegExp(location) }),
  ).toContainText("120");
  await page.goto("/purchase-orders");
  await expect(
    page.locator("#results").getByRole("row", { name: new RegExp(number) }),
  ).toContainText("入荷済み");
});

test("仕入先請求書を差額の理由つきで登録し、支払う", async ({ page }) => {
  await login(page);
  const supplier = await registerSupplier(page);
  const itemName = await registerItem(page, supplier, "E2E請求商品");
  const location = await registerLocation(page);
  const number = await createAndConfirmOrder(page, supplier, itemName, location, "2");
  await page.getByRole("link", { name: "入荷を記録" }).click();
  await page.getByRole("button", { name: "入荷を記録する" }).click();
  await expect(page.getByText("この発注は入荷済みになりました")).toBeVisible();
  const receipt = (
    (await page
      .getByText(/RC-\d{4}-\d{6}/)
      .first()
      .textContent()) ?? ""
  ).trim();

  // 発注詳細から、仕入先を起点にした登録画面へ
  await page.goto("/purchase-orders");
  await page.getByRole("link", { name: number }).click();
  await page.getByRole("link", { name: "仕入先請求書を登録" }).click();
  await expect(page.getByText("締め日が未設定です")).toBeVisible();

  // 入荷を選ぶと、計算額（2,400円 × 2 + 税 8% = 5,184円）をその場で計算する
  await page.getByLabel(receipt).check();
  await expect(page.locator("#si-computed")).toHaveText("¥5,184");
  await page.getByLabel(/^請求額/).fill("5200");
  await page.getByLabel(/^請求額/).press("Tab");
  await expect(page.locator("#si-difference")).toHaveText("¥16");
  await expect(page.getByText("差額があります")).toBeVisible();

  await page.getByLabel(/^請求書番号/).fill("INV-9001");
  await page.getByRole("button", { name: "登録する" }).click();
  await expect(page.getByText("差額の理由を入力してください").first()).toBeVisible();
  await page.getByLabel("差額の理由").fill("先方の送料込み");
  await page.getByRole("button", { name: "登録する" }).click();
  await expect(page.getByRole("heading", { name: "仕入先請求書 INV-9001" })).toBeVisible();
  await expect(page.getByText("先方の送料込み")).toBeVisible();

  // 支払う
  await page.getByRole("button", { name: "支払済みにする" }).click();
  await expect(page.getByText("支払を記録しました")).toBeVisible();
  await page.goto("/purchase-orders");
  await expect(
    page.locator("#results").getByRole("row", { name: new RegExp(number) }),
  ).toContainText("支払済み");
});
