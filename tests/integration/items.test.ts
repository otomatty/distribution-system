import { describe, expect, it } from "vitest";

import {
  addInitialStock,
  createGenre,
  createItem,
  createLocation,
  createSupplier,
  uniqueName,
} from "./fixtures";
import { as, createEmployee, newKey, systemCommand, systemQuery } from "./helpers";

function itemForm(supplierId: string, overrides: Record<string, string> = {}) {
  return {
    code: "",
    jan: "",
    name: uniqueName("画面テスト商品"),
    supplierId,
    genreId: "",
    temperatureZone: "chilled",
    taxCategory: "reduced",
    purchaseUnitName: "ケース",
    salesUnitName: "個",
    unitsPerPurchaseUnit: "24",
    purchasePriceCenti: "2400",
    salesPriceCenti: "123.45",
    purchaseMinLot: "1",
    salesMinLot: "6",
    leadTimeDays: "3",
    reorderPoint: "10",
    memo: "",
    _key: newKey(),
    ...overrides,
  };
}

describe("商品マスタの画面", () => {
  it("仕入担当は商品を登録でき、商品コードを空にすると自動で採番する", async () => {
    const user = await createEmployee(["purchasing"]);
    const supplierId = await createSupplier();
    const form = itemForm(supplierId, { reorderEnabled: "on", jan: "4901234567894" });
    const res = await as(user).hx("/items/new", form);
    expect(res.status).toBe(204);
    const location = res.headers.get("HX-Redirect") ?? "";
    expect(location).toMatch(/^\/items\/[0-9A-Z]{26}\?notice=created$/);
    const id = location.slice("/items/".length, location.indexOf("?"));
    const item = await systemQuery("items.get", { id });
    expect(item?.code).toMatch(/^IT\d{6}$/);
    expect(item?.salesPriceCenti).toBe(12_345);
    expect(item?.purchasePriceCenti).toBe(240_000);
    expect(item?.temperatureZone).toBe("chilled");
    expect(item?.reorderEnabled).toBe(true);
    expect(item?.leadTimeDays).toBe(3);
    const html = await (await as(user).get(location)).text();
    expect(html).toContain(form.name);
    expect(html).toContain("¥123.45");
    expect(html).toContain("冷蔵");
  });

  it("自動採番は手で入力したコードと重ならない", async () => {
    const supplierId = await createSupplier();
    const first = await createItem(supplierId);
    const next = `IT${String(Number(first.code.slice(2)) + 1).padStart(6, "0")}`;
    await createItem(supplierId, { code: next });
    const third = await createItem(supplierId);
    expect(third.code).not.toBe(next);
    expect(third.code).toMatch(/^IT\d{6}$/);
  });

  it("商品コードの重複・JAN の桁数とチェックディジット・価格の形式を項目ごとに示す", async () => {
    const user = await createEmployee(["purchasing"]);
    const supplierId = await createSupplier();
    const existing = await createItem(supplierId);
    const dup = await as(user).hx("/items/new", itemForm(supplierId, { code: existing.code }));
    expect(await dup.text()).toContain("この商品コードはすでに使われています");
    const digits = await as(user).hx("/items/new", itemForm(supplierId, { jan: "12345" }));
    expect(await digits.text()).toContain("JAN は8桁または13桁の数字で入力してください");
    const check = await as(user).hx("/items/new", itemForm(supplierId, { jan: "4901234567890" }));
    expect(await check.text()).toContain("JAN のチェックディジットが正しくありません");
    const price = await as(user).hx(
      "/items/new",
      itemForm(supplierId, { salesPriceCenti: "12.345", taxCategory: "" }),
    );
    const html = await price.text();
    expect(html).toContain("卸単価は小数第2位までの数字で入力してください");
    expect(html).toContain("税区分を選んでください");
    const code = await as(user).hx("/items/new", itemForm(supplierId, { code: "あいう" }));
    expect(await code.text()).toContain("商品コードは英数字");
  });

  it("仕入先でない取引先・取引終了の仕入先・存在しないジャンルは選べない", async () => {
    const customer = await systemCommand("partners.create", {
      name: uniqueName("販売先"),
      kana: "ハンバイサキ",
      isCustomer: true,
    });
    const user = await createEmployee(["purchasing"]);
    const res = await as(user).hx("/items/new", itemForm(customer.id));
    expect(await res.text()).toContain("仕入先を選んでください");
    const supplierId = await createSupplier();
    const genre = await as(user).hx("/items/new", itemForm(supplierId, { genreId: "NOPE" }));
    expect(await genre.text()).toContain("ジャンルが見つかりません");

    const archivedGenre = await createGenre();
    await systemCommand("genres.archive", { id: archivedGenre, version: 1, archived: true });
    const ag = await as(user).hx("/items/new", itemForm(supplierId, { genreId: archivedGenre }));
    expect(await ag.text()).toContain("取引終了のジャンルは選べません");

    const archived = await createSupplier();
    const partner = await systemQuery("partners.get", { id: archived });
    await systemCommand("partners.archive", {
      id: archived,
      version: partner?.version ?? 1,
      archived: true,
    });
    const as2 = await as(user).hx("/items/new", itemForm(archived));
    expect(await as2.text()).toContain("取引終了の仕入先は選べません");
  });

  it("受注・出荷担当は商品を登録できない（権限）", async () => {
    const user = await createEmployee(["sales"]);
    const supplierId = await createSupplier();
    const res = await as(user).hx("/items/new", itemForm(supplierId));
    expect(await res.text()).toContain("この操作を行う権限がありません");
    // 閲覧はできる
    expect((await as(user).get("/items")).status).toBe(200);
  });

  it("同じ受付番号で2回送信しても1件だけ登録される", async () => {
    const user = await createEmployee(["admin"]);
    const supplierId = await createSupplier();
    const form = itemForm(supplierId);
    const first = await as(user).hx("/items/new", form);
    const second = await as(user).hx("/items/new", form);
    expect(second.headers.get("HX-Redirect")).toBe(first.headers.get("HX-Redirect"));
    const list = await systemQuery("items.list", { q: form.name, page: 1 });
    expect(list.total).toBe(1);
  });

  it("編集は版番号で競合を検出し、取引終了の仕入先のままでも保存できる", async () => {
    const user = await createEmployee(["purchasing"]);
    const supplierId = await createSupplier();
    const item = await createItem(supplierId);
    const editForm = await (await as(user).get(`/items/${item.id}/edit`)).text();
    expect(editForm).toContain(item.code);
    const ok = await as(user).hx(
      `/items/${item.id}/edit`,
      itemForm(supplierId, { code: item.code, name: "編集後の名前", version: "1" }),
    );
    expect(ok.status).toBe(204);
    const stale = await as(user).hx(
      `/items/${item.id}/edit`,
      itemForm(supplierId, { code: item.code, name: "古い画面から", version: "1" }),
    );
    expect(await stale.text()).toContain("ほかの人が先に更新しました");
    const blank = await as(user).hx(
      `/items/${item.id}/edit`,
      itemForm(supplierId, { code: "", version: "2" }),
    );
    expect(await blank.text()).toContain("商品コードを入力してください");
    const badSupplier = await as(user).hx(
      `/items/${item.id}/edit`,
      itemForm("NOPE", { code: item.code, version: "2" }),
    );
    expect(await badSupplier.text()).toContain("仕入先を選んでください");
    const other = await createItem(supplierId);
    const dup = await as(user).hx(
      `/items/${item.id}/edit`,
      itemForm(supplierId, { code: other.code, version: "2" }),
    );
    expect(await dup.text()).toContain("この商品コードはすでに使われています");

    const partner = await systemQuery("partners.get", { id: supplierId });
    await systemCommand("partners.archive", {
      id: supplierId,
      version: partner?.version ?? 1,
      archived: true,
    });
    const keep = await as(user).hx(
      `/items/${item.id}/edit`,
      itemForm(supplierId, { code: item.code, name: "取引終了後の編集", version: "2" }),
    );
    expect(keep.status).toBe(204);
    expect((await as(user).get(`/items/${item.id}/edit`)).status).toBe(200);
    expect((await as(user).get("/items/NOPE/edit")).status).toBe(404);
    expect((await as(user).get("/items/NOPE")).status).toBe(404);
    const missing = await as(user).hx(
      "/items/NOPE/edit",
      itemForm(supplierId, { code: "X1", version: "1" }),
    );
    expect(await missing.text()).toContain("商品が見つかりません");
  });

  it("一覧は商品名・コード・JAN・ジャンル・仕入先で絞り込め、取扱終了は既定で出さない", async () => {
    const user = await createEmployee(["sales"]);
    const supplierId = await createSupplier();
    const genreId = await createGenre();
    const a = await createItem(supplierId, { jan: "4912345678904", genreId });
    const b = await createItem(supplierId);
    await systemCommand("items.discontinue", { id: b.id, version: 1, discontinued: true });

    const byJan = await (await as(user).get("/items?q=4912345678904")).text();
    expect(byJan).toContain(a.name);
    const byGenre = await (await as(user).get(`/items?genreId=${genreId}`)).text();
    expect(byGenre).toContain(a.name);
    expect(byGenre).not.toContain(b.name);
    const bySupplier = await (await as(user).get(`/items?supplierId=${supplierId}`)).text();
    expect(bySupplier).toContain(a.name);
    expect(bySupplier).not.toContain(b.name);
    const withDiscontinued = await (
      await as(user).get(`/items?supplierId=${supplierId}&discontinued=1`)
    ).text();
    expect(withDiscontinued).toContain(b.name);
    expect(withDiscontinued).toContain("取扱終了");
  });

  it("取扱終了とその取消、使われていない商品の削除、使われた商品は削除できない", async () => {
    const user = await createEmployee(["purchasing"]);
    const supplierId = await createSupplier();
    const item = await createItem(supplierId);
    const detail = await (await as(user).get(`/items/${item.id}`)).text();
    expect(detail).toContain("取扱終了にする");
    const off = await as(user).post(`/items/${item.id}/discontinue`, {
      version: "1",
      discontinued: "true",
      _key: newKey(),
    });
    expect(off.status).toBe(303);
    expect(off.headers.get("Location")).toBe(`/items/${item.id}?notice=discontinued`);
    expect((await systemQuery("items.get", { id: item.id }))?.discontinued).toBe(true);
    const stale = await as(user).post(`/items/${item.id}/discontinue`, {
      version: "1",
      discontinued: "false",
      _key: newKey(),
    });
    expect(stale.status).toBe(409);
    const on = await as(user).post(`/items/${item.id}/discontinue`, {
      version: "2",
      discontinued: "false",
      _key: newKey(),
    });
    expect(on.headers.get("Location")).toBe(`/items/${item.id}?notice=resumed`);

    const unused = await createItem(supplierId);
    const unusedDetail = await (await as(user).get(`/items/${unused.id}`)).text();
    expect(unusedDetail).toMatch(
      /action="\/items\/[0-9A-Z]{26}\/delete"[\s\S]*?name="version" value="1"/,
    );
    // 開いた後にほかの人が更新していたら、古い版番号での削除は競合にする
    await systemCommand("items.discontinue", { id: unused.id, version: 1, discontinued: false });
    const staleDelete = await as(user).hx(`/items/${unused.id}/delete`, {
      version: "1",
      _key: newKey(),
    });
    expect(staleDelete.status).toBe(409);
    expect(await staleDelete.text()).toContain("ほかの人が先に更新しました");
    expect(await systemQuery("items.get", { id: unused.id })).not.toBeNull();
    const del = await as(user).hx(`/items/${unused.id}/delete`, { version: "2", _key: newKey() });
    expect(del.headers.get("HX-Redirect")).toBe("/items?notice=deleted");
    expect(await systemQuery("items.get", { id: unused.id })).toBeNull();

    const locationId = await createLocation();
    await addInitialStock(locationId, [{ itemId: item.id, quantity: 3 }]);
    const used = await as(user).hx(`/items/${item.id}/delete`, { version: "3", _key: newKey() });
    expect(used.status).toBe(409);
    expect(await used.text()).toContain("取引や在庫で使われた商品は削除できません");
    const usedPlain = await as(user).post(`/items/${item.id}/delete`, {
      version: "3",
      _key: newKey(),
    });
    expect(await usedPlain.text()).toContain("取扱終了");
    const missing = await as(user).post("/items/NOPE/discontinue", {
      version: "1",
      discontinued: "true",
      _key: newKey(),
    });
    expect(missing.status).toBe(409);
    const missingDelete = await as(user).hx("/items/NOPE/delete", {
      version: "1",
      _key: newKey(),
    });
    expect(await missingDelete.text()).toContain("商品が見つかりません");
  });
});

describe("商品選択ダイアログ（GET /items/picker）", () => {
  it("コード・名前・JAN で検索し、仕入先で絞り込み、取扱終了を除く", async () => {
    const user = await createEmployee(["sales"]);
    const supplierA = await createSupplier();
    const supplierB = await createSupplier();
    const tag = uniqueName("ピッカー");
    const a = await createItem(supplierA, { name: `${tag}チョコ`, jan: "4901234567894" });
    const b = await createItem(supplierB, { name: `${tag}クッキー` });
    const c = await createItem(supplierA, { name: `${tag}終了品` });
    await systemCommand("items.discontinue", { id: c.id, version: 1, discontinued: true });

    const res = await as(user).get(`/items/picker?pickerId=po-picker&q=${encodeURIComponent(tag)}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="po-picker-results"');
    expect(html).toContain(a.name);
    expect(html).toContain(b.name);
    expect(html).not.toContain(c.name);
    expect(html).toContain('name="itemIds"');

    const bySupplier = await (
      await as(user).get(
        `/items/picker?pickerId=po-picker&q=${encodeURIComponent(tag)}&supplierId=${supplierA}`,
      )
    ).text();
    expect(bySupplier).toContain(a.name);
    expect(bySupplier).not.toContain(b.name);

    const byCode = await (await as(user).get(`/items/picker?pickerId=p1&q=${a.code}`)).text();
    expect(byCode).toContain(a.name);

    const empty = await (await as(user).get("/items/picker?pickerId=p1&q=該当なしの検索語")).text();
    expect(empty).toContain("条件に合う商品はありません");
  });

  it("選択済みの商品は検索し直しても先頭にチェックした状態で残る", async () => {
    const user = await createEmployee(["purchasing"]);
    const supplierId = await createSupplier();
    const tag = uniqueName("選択済み");
    const kept = await createItem(supplierId, { name: `${tag}A` });
    await createItem(supplierId, { name: `${tag}B` });
    const html = await (
      await as(user).get(
        `/items/picker?pickerId=p1&q=${encodeURIComponent(`${tag}B`)}&itemIds=${kept.id}`,
      )
    ).text();
    const keptAt = html.indexOf(kept.name);
    expect(keptAt).toBeGreaterThan(0);
    expect(keptAt).toBeLessThan(html.indexOf(`${tag}B`));
    expect(html).toMatch(new RegExp(`value="${kept.id}" checked`));
  });

  it("pickerId が不正なら 400", async () => {
    const user = await createEmployee(["sales"]);
    const res = await as(user).get('/items/picker?pickerId="><script>');
    expect(res.status).toBe(400);
  });
});
