import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import { login, unique } from "./helpers";
import { registerSupplier } from "./masters-helpers";

const HEADERS = [
  "商品コード",
  "JAN",
  "商品名",
  "仕入先",
  "ジャンル",
  "温度帯",
  "税区分",
  "仕入単位",
  "販売単位",
  "入数",
  "仕入価格（仕入単位あたり・税抜・円）",
  "卸単価（販売単位あたり・税抜・円）",
  "発注時に仕入価格を入力する",
  "最低ロット（仕入・仕入単位）",
  "最低ロット（販売・販売単位）",
  "リードタイム（日）",
  "発注点を管理する",
  "発注点在庫数（販売単位）",
  "送料条件（仕入）",
  "送料条件（販売）",
  "備考",
];

/** BOM 付き UTF-8 の CSV（Excel の「CSV UTF-8」） */
function csvFile(rows: Record<string, string>[]): Buffer {
  const lines = [HEADERS, ...rows.map((r) => HEADERS.map((h) => r[h] ?? ""))].map((cells) =>
    cells.map((c) => (/[",\r\n]/.test(c) ? `"${c.replaceAll('"', '""')}"` : c)).join(","),
  );
  const bom = String.fromCodePoint(0xfeff);
  return Buffer.from(`${bom}${lines.join("\r\n")}\r\n`, "utf8");
}

test("商品の CSV 一括登録：ひな形をダウンロードし、問題のある行を直してから、まとめて登録する", async ({
  page,
}) => {
  page.on("dialog", (dialog) => void dialog.accept());
  await login(page);
  const supplier = await registerSupplier(page);
  const first = unique("E2E取込せんべい");
  const second = unique("E2E取込まんじゅう");

  await page.goto("/items");
  await page.getByRole("link", { name: "CSV で一括登録" }).click();
  await expect(page.getByRole("heading", { name: "商品の CSV 一括登録" })).toBeVisible();

  // ひな形は登録画面と同じ見出しの CSV
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "ひな形（CSV）をダウンロード" }).click(),
  ]);
  const template = await readFile(await download.path());
  expect(template.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  expect(template.subarray(3).toString("utf8").trim()).toBe(HEADERS.join(","));

  const good = {
    商品名: first,
    仕入先: supplier,
    温度帯: "常温",
    税区分: "軽減",
    仕入単位: "ケース",
    販売単位: "袋",
    入数: "20",
    "仕入価格（仕入単位あたり・税抜・円）": "3000",
    "卸単価（販売単位あたり・税抜・円）": "180",
  };
  // 1回目：2行目に問題がある（入数が0、税区分が空）→ どちらも登録しない
  const file = page.getByLabel("CSV ファイル");
  await file.setInputFiles({
    name: "商品.csv",
    mimeType: "text/csv",
    buffer: csvFile([good, { ...good, 商品名: second, 入数: "0", 税区分: "" }]),
  });
  await page.getByRole("button", { name: "ファイルを確かめる（まだ登録しません）" }).click();
  const result = page.locator("#import-result");
  await expect(result).toContainText("問題のある行 1 件");
  await expect(result).toContainText("入数：入数は1以上で入力してください");
  await expect(result).toContainText("税区分：税区分を選んでください");
  await expect(result.getByRole("button", { name: /件を登録し/ })).toHaveCount(0);

  // 2回目：直したファイルを確かめて登録する
  await file.setInputFiles({
    name: "商品.csv",
    mimeType: "text/csv",
    buffer: csvFile([good, { ...good, 商品名: second, 入数: "12" }]),
  });
  await page.getByRole("button", { name: "ファイルを確かめる（まだ登録しません）" }).click();
  await expect(result).toContainText("新規 2 件・更新 0 件");
  await result.getByRole("button", { name: "2 件を登録し、0 件を更新する" }).click();
  await expect(result).toContainText("商品を 2 件登録し、0 件更新しました");

  await result.getByRole("link", { name: "商品の一覧を見る" }).click();
  await page.getByLabel("商品名・コード・JAN で検索").fill("E2E取込");
  await expect(page.locator("#results")).toContainText(first);
  await expect(page.locator("#results")).toContainText(second);
});
