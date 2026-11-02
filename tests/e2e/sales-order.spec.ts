import { expect, test } from "@playwright/test";

import { login } from "./helpers";
import { registerItem, registerLocation, registerSupplier } from "./masters-helpers";
import { addStock, pickItem, registerCustomer } from "./sales-helpers";

test("受注を商品選択ダイアログで登録し、在庫の警告を見て、受注詳細から発送する", async ({
  page,
}) => {
  // 発送・取消の確認ダイアログ（hx-confirm）は承認する
  page.on("dialog", (dialog) => void dialog.accept());
  const violations: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && message.text().includes("Content Security Policy"))
      violations.push(message.text());
  });
  await login(page);
  const supplier = await registerSupplier(page);
  const itemName = await registerItem(page, supplier, "E2E受注商品");
  const location = await registerLocation(page);
  const customer = await registerCustomer(page);
  await addStock(page, location, itemName, 4);

  // 受注の登録：数量を変えると、その行と合計欄だけを計算し直す
  await page.goto("/sales-orders/new");
  await page.getByLabel(/^販売先/).selectOption({ label: customer });
  await page.getByLabel(/^出荷元の保管場所/).selectOption({ label: location });
  await pickItem(page, itemName, "#so-lines");
  const row = page.locator("#so-lines tr", { hasText: itemName });
  await expect(row).toContainText("4個（現在庫 4）");
  const quantity = page.getByLabel(`${itemName}の数量`, { exact: true });
  await quantity.fill("6");
  await quantity.blur();
  await expect(row).toContainText("出荷可能数（4）を超えています");
  // 123.45円 × 6 = 740.7 → 740円（切り捨て）、軽減税率 8% の消費税 59円
  await expect(row).toContainText("¥740");
  await expect(page.locator("#so-totals")).toContainText("¥799");
  // 「＋」でも増やせる
  await page.getByRole("button", { name: `${itemName}の数量を1つ増やす` }).click();
  await expect(quantity).toHaveValue("7");
  await expect(row).toContainText("¥864");
  await page.getByRole("button", { name: "登録する" }).click();
  await expect(page.getByRole("heading", { name: /^受注 SO-\d{4}-\d{6}$/ })).toBeVisible();
  await expect(page.getByText("受注を登録しました")).toBeVisible();
  await expect(page.getByText("出荷可能数（4）を超えています")).toBeVisible();

  // 在庫が足りないので発送できない（足りない商品と数を表示する）
  await page.getByRole("button", { name: "発送する" }).click();
  await expect(page.getByText("在庫が足りないため記録できませんでした")).toBeVisible();
  await expect(page.locator(".shortage-table")).toContainText(itemName);

  // 数量を直してから発送する
  await page.getByRole("link", { name: "編集" }).click();
  const editQuantity = page.getByLabel(`${itemName}の数量`, { exact: true });
  await editQuantity.fill("4");
  await editQuantity.blur();
  await expect(page.locator("#so-lines")).not.toContainText("を超えています");
  await page.getByRole("button", { name: "保存する" }).click();
  await expect(page.getByText("受注を保存しました")).toBeVisible();
  await page.getByRole("button", { name: "発送する" }).click();
  await expect(page.getByText(/^発送しました/)).toBeVisible();
  await expect(page.getByRole("cell", { name: /^DN-\d{4}-\d{6}$/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "納品書を開く" })).toBeVisible();
  await expect(page.getByRole("button", { name: "発送する" })).toHaveCount(0);

  // 在庫は4個減っている
  await page.goto(`/stock?q=${encodeURIComponent(itemName)}`);
  await expect(
    page.locator("#results").getByRole("row", { name: new RegExp(location) }),
  ).toContainText("0");
  expect(violations).toEqual([]);
});
