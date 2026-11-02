import { expect, type Page } from "@playwright/test";

/** 発注を作成して確定する（送付しない）。発注番号を返す */
export async function createAndConfirmOrder(
  page: Page,
  supplier: string,
  itemName: string,
  location: string,
  quantity: string,
): Promise<string> {
  await page.goto("/purchase-orders/new");
  await page.getByLabel(/^仕入先/).selectOption({ label: supplier });
  await page.getByRole("button", { name: "次へ" }).click();
  // 画面の補助スクリプト（defer。ダイアログを開く）が動くまで待つ。待たないと「商品を追加」を押しても開かないことがある
  await page.waitForURL(/\/purchase-orders\/new\?supplierId=/);
  await page.getByLabel("保管場所（在庫に入れる）").selectOption({ label: location });

  await page.getByRole("button", { name: "商品を追加" }).click();
  const dialog = page.getByRole("dialog", { name: "この仕入先の商品を選ぶ" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("商品名・商品コード・JAN で検索").fill(itemName);
  await dialog
    .getByRole("row", { name: new RegExp(itemName) })
    .getByRole("checkbox")
    .check();
  await dialog.getByRole("button", { name: "選んだ商品を追加" }).click();
  await expect(dialog).toBeHidden();

  // 数量を変えると、その行の金額と合計をサーバーで計算し直す（2,400円 × 数量、軽減税率 8%）
  const qty = page.getByLabel(`${itemName}の数量（ケース）`);
  await qty.fill(quantity);
  // 入力欄から離れると change で計算し直す（次の入力欄にフォーカスを移さない）
  await qty.blur();
  const subtotal = 2400 * Number(quantity);
  const total = subtotal + Math.floor(subtotal * 0.08);
  await expect(page.locator("#po-total")).toHaveText(`¥${total.toLocaleString("ja-JP")}`);

  await page.getByRole("button", { name: "作成中として保存" }).click();
  const heading = page.getByRole("heading", { name: /^発注 PO-\d{4}-\d{6}$/ });
  await expect(heading).toBeVisible();
  const number = ((await heading.textContent()) ?? "").replace("発注 ", "");

  page.once("dialog", (d) => void d.accept());
  await page.getByLabel("送付方法").selectOption("none");
  await page.getByRole("button", { name: "確定して送付する" }).click();
  await expect(page.getByText("発注を確定しました")).toBeVisible();
  await expect(page.getByText("発注書と送付履歴")).toBeVisible();
  return number;
}
