import { expect, type Page } from "@playwright/test";

import { unique } from "./helpers";

/** 商品選択ダイアログで商品を検索して、明細（target）に追加する */
export async function pickItem(page: Page, itemName: string, target: string): Promise<void> {
  await page.getByRole("button", { name: "商品を追加" }).click();
  const dialog = page.getByRole("dialog", { name: "商品を選ぶ" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("商品名・商品コード・JAN で検索").fill(itemName);
  await dialog
    .getByRole("row", { name: new RegExp(itemName) })
    .getByRole("checkbox")
    .check();
  await dialog.getByRole("button", { name: "選んだ商品を追加" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(target)).toContainText(itemName);
}

/** 販売先を画面から登録して、その名前を返す */
export async function registerCustomer(page: Page, prefix = "E2E販売先"): Promise<string> {
  const name = unique(prefix);
  await page.goto("/partners/new");
  await page.getByLabel("名称").fill(name);
  await page.getByLabel("読み仮名").fill(`イーツーイーハンバイサキ${name.slice(-4)}`);
  await page.getByRole("checkbox", { name: "販売先" }).check();
  await page.getByRole("button", { name: "登録する" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  return name;
}

/** 在庫操作（調整・初期在庫）で在庫を入れる */
export async function addStock(
  page: Page,
  location: string,
  itemName: string,
  quantity: number,
): Promise<void> {
  await page.goto("/stock/operations/new?kind=adjustment");
  await page.getByLabel(/^保管場所/).selectOption({ label: location });
  await page.getByLabel(/^理由/).selectOption("initial");
  await pickItem(page, itemName, "#op-lines");
  await page.getByLabel(`${itemName}の数量`, { exact: true }).fill(String(quantity));
  await page.getByRole("button", { name: "調整を記録する" }).click();
  await expect(page.getByRole("heading", { name: /^調整 SOP-/ })).toBeVisible();
}

/** 受注を画面から登録して、受注番号を返す（受注日・出荷予定日は指定がなければ今日） */
export async function registerSalesOrder(
  page: Page,
  order: {
    customer: string;
    location: string;
    itemName: string;
    quantity: number;
    orderedOn?: string;
    shipPlannedOn?: string;
  },
): Promise<string> {
  await page.goto("/sales-orders/new");
  await page.getByLabel(/^販売先/).selectOption({ label: order.customer });
  await page.getByLabel(/^出荷元の保管場所/).selectOption({ label: order.location });
  if (order.orderedOn) {
    // 受注日を変えると明細を計算し直す（その応答を待ってから商品を足す）
    const recalc = page.waitForResponse((r) => r.url().includes("/sales-orders/form/recalc"));
    await page.getByLabel(/^受注日/).fill(order.orderedOn);
    await page.getByLabel(/^受注日/).blur();
    await recalc;
  }
  await pickItem(page, order.itemName, "#so-lines");
  const quantity = page.getByLabel(`${order.itemName}の数量`, { exact: true });
  await quantity.fill(String(order.quantity));
  await quantity.blur();
  if (order.shipPlannedOn) {
    // 販売先を選ぶと出荷予定日の欄を初期値で差し替えるので、最後に入れて値を確かめる
    const shipDate = page.getByLabel(/^出荷予定日/);
    await shipDate.fill(order.shipPlannedOn);
    await shipDate.blur();
    await expect(shipDate).toHaveValue(order.shipPlannedOn);
  }
  await page.getByRole("button", { name: "登録する" }).click();
  const heading = page.getByRole("heading", { name: /^受注 SO-\d{4}-\d{6}$/ });
  await expect(heading).toBeVisible();
  return (await heading.textContent())?.replace("受注 ", "") ?? "";
}
