import { expect, test } from "@playwright/test";

import { login } from "./helpers";
import { registerItem, registerLocation, registerSupplier } from "./masters-helpers";
import { addStock, registerCustomer, registerSalesOrder } from "./sales-helpers";

test("発送リストで一括発送し、在庫が足りない受注は外して続け、納品書を一括 PDF にする @tablet", async ({
  page,
}) => {
  await login(page);
  const supplier = await registerSupplier(page);
  const itemName = await registerItem(page, supplier, "E2E発送商品");
  const location = await registerLocation(page);
  const first = await registerCustomer(page, "E2E販売先A");
  const second = await registerCustomer(page, "E2E販売先B");
  await addStock(page, location, itemName, 5);
  // 5個のうち、1件目で3個を使うと2件目（4個）は足りない
  const a = await registerSalesOrder(page, { customer: first, location, itemName, quantity: 3 });
  const b = await registerSalesOrder(page, { customer: second, location, itemName, quantity: 4 });

  await page.goto("/shipping");
  await expect(page.locator("body")).toHaveClass(/touch/);
  await page.getByLabel("保管場所").selectOption({ label: location });
  await expect(page).toHaveURL(/locationId=/);
  const matrix = page.locator(".shipping-matrix");
  await expect(matrix).toContainText(first);
  await expect(matrix).toContainText(second);
  const row = matrix.getByRole("row", { name: new RegExp(itemName) });
  await expect(row).toContainText("7個");
  // 商品名の列は横にスクロールしても固定
  await expect(matrix.locator("th.sticky-col").first()).toHaveCSS("position", "sticky");

  // 一括発送：初期はすべて選択。確認で件数と在庫が足りない受注を示す
  await expect(page.getByRole("checkbox", { name: new RegExp(a) })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: new RegExp(b) })).toBeChecked();
  await page.getByRole("button", { name: "選んだ受注を一括発送する…" }).click();
  const panel = page.getByRole("region", { name: "一括発送の確認" });
  await expect(panel).toContainText("在庫が足りない受注が 1 件あります");
  await expect(panel).toContainText(b);
  await expect(panel.getByRole("link", { name: "中止" })).toBeVisible();
  await panel
    .getByRole("button", { name: "在庫が足りない 1 件を外して続ける（1 件を発送）" })
    .click();
  await expect(
    page.getByText("1 件を発送しました（在庫が足りない 1 件は外しました）"),
  ).toBeVisible();
  // 外した受注は発送リストに残る
  await expect(page.getByText("受注 1 件・販売先 1 件（発送済み 1 件）")).toBeVisible();

  // 発送した受注の納品書を一括で PDF にする（処理状況へ移る）
  await page.getByRole("button", { name: "発送した 1 件の納品書を一括で PDF にする" }).click();
  await expect(page).toHaveURL(/\/jobs\?notice=bulk$/);
  await expect(page.getByText("一括 PDF の作成を受け付けました")).toBeVisible();
});
