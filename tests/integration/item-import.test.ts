/**
 * 商品の CSV 一括登録（要件定義書 3.2 Should）。すべての行を先に確かめ、問題があれば何も書き込まない。
 * 問題がなければ1つのトランザクションで登録・更新する（受付番号・版番号・操作履歴）。
 */
import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { ITEM_CSV_HEADERS } from "../../src/domain/item-import";
import type { Result } from "../../src/domain/result";
import * as schema from "../../src/infra/db/schema";
import { businessDb } from "../../src/infra/do/client";
import { encodeCsv, type CsvValue } from "../../src/web/csv";
import { unwrap, unwrapErr } from "../support/result";
import { createGenre, createItem, createSupplier, uniqueName } from "./fixtures";
import { as, createEmployee, newKey, ORIGIN, systemCommand, systemQuery } from "./helpers";
import { readDb } from "./platform-helpers";

type Row = Partial<Record<(typeof ITEM_CSV_HEADERS)[number], CsvValue>>;

/** 見出しの順に値を並べた CSV（BOM 付き UTF-8 の文字列） */
function csvOf(rows: readonly Row[]): string {
  return encodeCsv(
    ITEM_CSV_HEADERS,
    rows.map((r) => ITEM_CSV_HEADERS.map((h) => r[h] ?? "")),
  );
}

function row(supplier: string, overrides: Row = {}): Row {
  return {
    商品名: uniqueName("取込テスト菓子"),
    仕入先: supplier,
    温度帯: "冷蔵",
    税区分: "軽減",
    仕入単位: "ケース",
    販売単位: "個",
    入数: 24,
    "仕入価格（仕入単位あたり・税抜・円）": "2,400",
    "卸単価（販売単位あたり・税抜・円）": "123.45",
    ...overrides,
  };
}

function multipart(email: string, path: string, fields: Record<string, string | File>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return exports.default.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      body: form,
      headers: {
        Cookie: `dev_actor=${encodeURIComponent(email)}`,
        Origin: ORIGIN,
        "HX-Request": "true",
      },
      redirect: "manual",
    }),
  );
}

function check(email: string, bytes: Uint8Array | string, name = "商品.csv") {
  return multipart(email, "/items/import/check", { file: new File([bytes], name) });
}

function planTokenOf(html: string): string {
  return /name="planToken" value="([^"]*)"/.exec(html)?.[1] ?? "";
}

function commandAs(
  email: string,
  input: { csv: string; planToken: string },
  key: string = crypto.randomUUID(),
) {
  return businessDb(env).command("items.import", input, { kind: "dev", email }, key) as Promise<
    Result<{ importId: string; created: number; updated: number }>
  >;
}

/** テスト用の Shift_JIS の書き出し（Workers の TextDecoder の対応表を逆に引く） */
function shiftJis(text: string): Uint8Array {
  const decoder = new TextDecoder("shift_jis");
  const table = new Map<string, number[]>();
  for (let b = 0; b < 0x80; b++) table.set(String.fromCharCode(b), [b]);
  const leads = [];
  for (let b = 0x81; b <= 0x9f; b++) leads.push(b);
  for (let b = 0xe0; b <= 0xef; b++) leads.push(b);
  for (const lead of leads) {
    for (let trail = 0x40; trail <= 0xfc; trail++) {
      if (trail === 0x7f) continue;
      const ch = decoder.decode(new Uint8Array([lead, trail]));
      if (ch.length === 1 && !table.has(ch)) table.set(ch, [lead, trail]);
    }
  }
  const out: number[] = [];
  for (const ch of text) {
    const bytes = table.get(ch);
    if (!bytes) throw new Error(`Shift_JIS にない文字です: ${ch}`);
    out.push(...bytes);
  }
  return new Uint8Array(out);
}

async function itemsByName(name: string) {
  return (await systemQuery("items.list", { q: name, includeDiscontinued: true })).rows;
}

describe("商品の CSV 一括登録", () => {
  it("ひな形は商品の登録画面と同じ見出しの BOM 付き UTF-8 の CSV", async () => {
    const user = await createEmployee(["purchasing"]);
    const page = await (await as(user).get("/items/import")).text();
    expect(page).toContain("商品の CSV 一括登録");
    expect(page).toContain('href="/items/import/template.csv"');
    expect(await (await as(user).get("/items")).text()).toContain('href="/items/import"');
    const res = await as(user).get("/items/import/template.csv");
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toContain("filename*=UTF-8''");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes);
    expect(text).toBe(`${ITEM_CSV_HEADERS.join(",")}\r\n`);
    expect(ITEM_CSV_HEADERS).toEqual(
      expect.arrayContaining(["商品コード", "JAN", "商品名", "仕入先", "入数", "備考"]),
    );
  });

  it("確かめる段階では何も書き込まず、登録すると新規・更新を1回でまとめて行い操作履歴を残す", async () => {
    const user = await createEmployee(["purchasing"]);
    const supplierId = await createSupplier();
    const supplier = (await systemQuery("partners.get", { id: supplierId }))?.name ?? "";
    const genreName = uniqueName("取込ジャンル");
    await createGenre(genreName);
    const existing = await createItem(supplierId);
    const code = `CSV-${Date.now().toString(36)}`.toUpperCase();
    const csv = csvOf([
      row(supplier, { 商品コード: code, JAN: "4901234567894", ジャンル: genreName }),
      row(supplier, {
        商品名: "自動採番の菓子",
        発注点を管理する: "する",
        "発注点在庫数（販売単位）": "１０",
      }),
      row(supplier, {
        商品コード: existing.code,
        商品名: `${existing.name}（改）`,
        税区分: "標準税率",
        "卸単価（販売単位あたり・税抜・円）": "¥200",
        備考: "'-値下げ前",
      }),
    ]);
    const res = await check(user, new TextEncoder().encode(csv));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/新規 <strong>2<\/strong> 件・更新 <strong>1<\/strong> 件/);
    expect(html).toContain("文字コード：UTF-8");
    expect(html).toContain("自動で採番");
    expect(html).toContain('<textarea name="csv" hidden="">');
    const planToken = planTokenOf(html);
    expect(planToken).toContain(`${existing.id}@1`);
    // まだ書き込んでいない
    expect(await systemQuery("items.get", { id: existing.id })).toMatchObject({ version: 1 });
    expect(await itemsByName(code)).toEqual([]);

    const key = newKey();
    const done = await multipart(user, "/items/import", {
      _key: key,
      csv: csv.slice(1),
      planToken,
    });
    expect(done.status).toBe(200);
    expect(await done.text()).toContain("商品を 2 件登録し、1 件更新しました");

    const [created] = await itemsByName(code);
    expect(created).toMatchObject({
      code,
      jan: "4901234567894",
      genreName,
      supplierId,
      temperatureZone: "chilled",
      taxCategory: "reduced",
      unitsPerPurchaseUnit: 24,
      purchasePriceCenti: 240_000,
      salesPriceCenti: 12_345,
      purchaseMinLot: 1,
      reorderEnabled: false,
    });
    const [auto] = await itemsByName("自動採番の菓子");
    expect(auto?.code).toMatch(/^IT\d{6}$/);
    expect(auto).toMatchObject({ reorderEnabled: true, reorderPoint: 10 });
    const updated = await systemQuery("items.get", { id: existing.id });
    expect(updated).toMatchObject({
      name: `${existing.name}（改）`,
      taxCategory: "standard",
      salesPriceCenti: 20_000,
      memo: "-値下げ前",
      version: 2,
    });

    const logs = await readDb((db) =>
      db.select().from(schema.auditLogs).where(eq(schema.auditLogs.command, "items.import")).all(),
    );
    const mine = logs.filter((l) => [created?.id, auto?.id, existing.id].includes(l.entityId));
    expect(mine.map((l) => l.action).toSorted()).toEqual(["create", "create", "update"]);
    expect(logs.some((l) => l.entityType === "item_import" && l.action === "import")).toBe(true);

    // 同じ受付番号で送り直しても、もう一度は登録しない
    const again = unwrap(await commandAs(user, { csv, planToken }, key));
    expect(again).toMatchObject({ created: 2, updated: 1 });
    expect(await itemsByName(code)).toHaveLength(1);
  });

  it("問題のある行は行ごとに示し、1行でも問題があれば何も登録しない", async () => {
    const user = await createEmployee(["purchasing"]);
    const supplierId = await createSupplier();
    const supplier = (await systemQuery("partners.get", { id: supplierId }))?.name ?? "";
    const okName = uniqueName("問題なしの菓子");
    const csv = csvOf([
      row(supplier, { 商品名: okName, 商品コード: "DUP-1" }),
      row(supplier, { 商品コード: "DUP-1" }),
      row("存在しない仕入先", { 税区分: "" }),
      row(supplier, {
        温度帯: "ぬるい",
        入数: "0",
        "仕入価格（仕入単位あたり・税抜・円）": "12.345",
      }),
      row(supplier, {
        商品名: "",
        JAN: "12345",
        発注点を管理する: "たぶん",
        ジャンル: "ないジャンル",
      }),
    ]);
    const html = await (await check(user, csv)).text();
    expect(html).toContain("問題のある行 4 件");
    expect(html).toContain("まだどの商品も登録していません");
    expect(html).toContain("商品コード：2行目と同じ商品コードです");
    expect(html).toContain("仕入先：「存在しない仕入先」という仕入先が見つかりません");
    expect(html).toContain("税区分：税区分を選んでください");
    expect(html).toContain("温度帯：「常温」「冷蔵」「冷凍」のどれかにしてください");
    expect(html).toContain("入数：入数は1以上で入力してください");
    expect(html).toContain(
      "仕入価格（仕入単位あたり・税抜・円）：仕入価格は小数第2位までの数字で入力してください",
    );
    expect(html).toContain("商品名：入力してください");
    expect(html).toContain("JAN：JAN は8桁または13桁の数字で入力してください");
    expect(html).toContain("発注点を管理する：「する」か「しない」");
    expect(html).toContain("ジャンル：「ないジャンル」というジャンルが見つかりません");
    expect(html).not.toContain('name="planToken"');

    const result = unwrapErr(await commandAs(user, { csv, planToken: "" }));
    expect(result.code).toBe("validation");
    expect(result.message).toBe("4行に問題があるため、どの商品も登録していません");
    expect(result.details).toContain("3行目：商品コード：2行目と同じ商品コードです");
    expect(await itemsByName(okName)).toEqual([]);
  });

  it("見出しが足りない・知らない列・同じ列が2つ・行がない・行が多すぎる・形式の誤りはファイル全体のエラー", async () => {
    const user = await createEmployee(["purchasing"]);
    const missing = await (
      await check(user, "商品名,仕入先,知らない列,商品名\r\nせんべい,x,y,z\r\n")
    ).text();
    expect(missing).toContain("見出しの行を確かめてください");
    expect(missing).toContain("「知らない列」は商品の項目にない列です");
    expect(missing).toContain("「商品名」の列が2つあります");
    expect(missing).toContain("「税区分」の列がありません");
    expect(await (await check(user, csvOf([]))).text()).toContain("取り込む行がありません");
    expect(await (await check(user, "")).text()).toContain("CSV のファイルを選んでください");
    const broken = await (
      await check(user, `${ITEM_CSV_HEADERS.join(",")}\r\n"閉じていない`)
    ).text();
    expect(broken).toContain("2行目：引用符（&quot;）が閉じていません");
    const many = csvOf(Array.from({ length: 3001 }, () => ({ 商品名: "x" })));
    expect(await (await check(user, many)).text()).toContain("1回に取り込めるのは3,000行までです");
    const big = new Uint8Array(1024 * 1024 + 100 * 1024).fill(0x41);
    const tooBig = await check(user, big);
    expect(tooBig.status).toBe(413);
    expect(await tooBig.text()).toContain("1 MB 以下");
  });

  it("Shift_JIS（Excel の「CSV」）のファイルも読む。全角の数字・見出しの全角と半角の違いは区別しない", async () => {
    const user = await createEmployee(["purchasing"]);
    const supplierId = await createSupplier();
    const supplier = (await systemQuery("partners.get", { id: supplierId }))?.name ?? "";
    const name = uniqueName("シフトジス煎餅");
    const header = ITEM_CSV_HEADERS.map((h) => h.replace("（", "(").replace("）", ")"));
    const values = ITEM_CSV_HEADERS.map(
      (h) =>
        ({
          商品名: name,
          仕入先: supplier,
          税区分: "軽減",
          仕入単位: "箱",
          販売単位: "袋",
          入数: "１２",
          "仕入価格（仕入単位あたり・税抜・円）": "１２００",
          "卸単価（販売単位あたり・税抜・円）": "150",
        })[h] ?? "",
    );
    const text = `${header.join(",")}\r\n${values.join(",")}\r\n`;
    const html = await (await check(user, shiftJis(text))).text();
    expect(html).toContain("文字コード：Shift_JIS");
    expect(html).toMatch(/新規 <strong>1<\/strong> 件/);
    expect(html).toContain(name);
    unwrap(await commandAs(user, { csv: text, planToken: planTokenOf(html) }));
    expect((await itemsByName(name))[0]).toMatchObject({
      unitsPerPurchaseUnit: 12,
      purchasePriceCenti: 120_000,
      purchaseUnitName: "箱",
    });
  });

  it("確かめた後にほかの人が更新した商品があれば、登録を止める（版番号）", async () => {
    const user = await createEmployee(["purchasing"]);
    const supplierId = await createSupplier();
    const supplier = (await systemQuery("partners.get", { id: supplierId }))?.name ?? "";
    const existing = await createItem(supplierId);
    const newName = uniqueName("競合の菓子");
    const csv = csvOf([
      row(supplier, { 商品コード: existing.code, 商品名: "更新後" }),
      row(supplier, { 商品名: newName }),
    ]);
    const checked = await systemQuery("items.importCheck", { csv });
    expect(checked.counts).toEqual({ create: 1, update: 1, error: 0 });
    await systemCommand("items.discontinue", { id: existing.id, version: 1, discontinued: true });
    const res = await multipart(user, "/items/import", {
      _key: newKey(),
      csv,
      planToken: checked.planToken,
    });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain(
      "確かめた後に、ほかの人が同じ商品コードの商品を登録・更新しました",
    );
    expect(await itemsByName(newName)).toEqual([]);
    expect((await systemQuery("items.get", { id: existing.id }))?.name).toBe(existing.name);
  });

  it("取引終了の仕入先は、すでにその仕入先の商品の更新でだけ使える。同じ名前の仕入先が2つあれば区別を求める", async () => {
    const user = await createEmployee(["purchasing"]);
    const supplierId = await createSupplier();
    const supplier = (await systemQuery("partners.get", { id: supplierId }))?.name ?? "";
    const existing = await createItem(supplierId);
    await systemCommand("partners.archive", { id: supplierId, version: 1, archived: true });
    const csv = csvOf([
      row(supplier, { 商品コード: existing.code, 商品名: "取引終了の仕入先の商品" }),
      row(supplier),
    ]);
    const checked = await systemQuery("items.importCheck", { csv });
    expect(checked.rows.map((r) => r.errors.length)).toEqual([0, 1]);
    expect(checked.rows[1]?.errors[0]).toContain("取引終了の仕入先は選べません");

    const twin = uniqueName("同名仕入先");
    await systemCommand("partners.create", { name: twin, kana: "ドウメイ", isSupplier: true });
    await systemCommand("partners.create", { name: twin, kana: "ドウメイ", isSupplier: true });
    const ambiguous = await systemQuery("items.importCheck", { csv: csvOf([row(twin)]) });
    expect(ambiguous.rows[0]?.errors[0]).toContain("名前の仕入先が複数あります");
    void user;
  });

  it("取引終了のジャンルも、すでにそのジャンルの商品の更新では使える", async () => {
    const supplierId = await createSupplier();
    const supplier = (await systemQuery("partners.get", { id: supplierId }))?.name ?? "";
    const genreName = uniqueName("終了ジャンル");
    const genreId = await createGenre(genreName);
    const existing = await createItem(supplierId, { genreId });
    await systemCommand("genres.archive", { id: genreId, version: 1, archived: true });
    const checked = await systemQuery("items.importCheck", {
      csv: csvOf([
        row(supplier, { 商品コード: existing.code, ジャンル: genreName }),
        row(supplier, { ジャンル: genreName }),
      ]),
    });
    expect(checked.rows[0]?.errors).toEqual([]);
    expect(checked.rows[1]?.errors).toEqual(["ジャンル：取引終了のジャンルは選べません"]);
  });

  it("自動の採番は、同じファイルで指定した商品コードと重ならない", async () => {
    const user = await createEmployee(["purchasing"]);
    const supplierId = await createSupplier();
    const supplier = (await systemQuery("partners.get", { id: supplierId }))?.name ?? "";
    const probe = await createItem(supplierId);
    const next = `IT${String(Number(probe.code.slice(2)) + 1).padStart(6, "0")}`;
    const name = uniqueName("採番の菓子");
    const csv = csvOf([row(supplier, { 商品名: name }), row(supplier, { 商品コード: next })]);
    const checked = await systemQuery("items.importCheck", { csv });
    unwrap(await commandAs(user, { csv, planToken: checked.planToken }));
    const [auto] = await itemsByName(name);
    expect(auto?.code).toMatch(/^IT\d{6}$/);
    expect(auto?.code).not.toBe(next);
  });

  it("取り込めるのは仕入担当と管理者", async () => {
    const sales = await createEmployee(["sales"]);
    expect((await as(sales).get("/items/import")).status).toBe(403);
    expect((await check(sales, csvOf([{ 商品名: "x" }]))).status).toBe(403);
    expect(unwrapErr(await commandAs(sales, { csv: "a", planToken: "" })).code).toBe("forbidden");
    const list = await (await as(sales).get("/items")).text();
    expect(list).not.toContain('href="/items/import"');
  });
});
