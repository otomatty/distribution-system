import { describe, expect, it } from "vitest";

import { uniqueName } from "./fixtures";
import { as, createEmployee, newKey, systemCommand, systemQuery } from "./helpers";

describe("保管場所の画面", () => {
  it("管理者は連絡先つきで登録・編集・取引終了ができる", async () => {
    const admin = await createEmployee(["admin"]);
    const name = uniqueName("第二倉庫");
    const res = await as(admin).hx("/masters/locations/new", {
      name,
      postalCode: "022-0002",
      phone: "0192-00-0000",
      mainContact: "phone",
      displayOrder: "2",
      _key: newKey(),
    });
    expect(res.headers.get("HX-Redirect")).toBe("/masters/locations?notice=created");
    const list = await (await as(admin).get("/masters/locations")).text();
    expect(list).toContain(name);
    const rows = await systemQuery("locations.list", {});
    const created = rows.find((l) => l.name === name);
    expect(created?.postalCode).toBe("0220002");
    expect(created?.mainContact).toBe("phone");
    const id = created?.id ?? "";

    const edit = await as(admin).hx(`/masters/locations/${id}`, {
      name: `${name}改`,
      displayOrder: "1",
      version: "1",
      _key: newKey(),
    });
    expect(edit.headers.get("HX-Redirect")).toBe(`/masters/locations/${id}?notice=updated`);
    const stale = await as(admin).hx(`/masters/locations/${id}`, {
      name: `${name}改2`,
      version: "1",
      _key: newKey(),
    });
    expect(await stale.text()).toContain("ほかの人が先に更新しました");

    const archive = await as(admin).post(`/masters/locations/${id}/archive`, {
      version: "2",
      archived: "true",
      _key: newKey(),
    });
    expect(archive.headers.get("Location")).toBe(`/masters/locations/${id}?notice=archived`);
    const options = await systemQuery("locations.options", {});
    expect(options.some((o) => o.id === id)).toBe(false);
    const withArchived = await (await as(admin).get("/masters/locations?archived=1")).text();
    expect(withArchived).toContain("取引終了");
    const again = await as(admin).post(`/masters/locations/${id}/archive`, {
      version: "2",
      archived: "false",
      _key: newKey(),
    });
    expect(again.status).toBe(409);
    const restore = await as(admin).post(`/masters/locations/${id}/archive`, {
      version: "3",
      archived: "false",
      _key: newKey(),
    });
    expect(restore.headers.get("Location")).toBe(`/masters/locations/${id}?notice=unarchived`);
    expect((await systemQuery("locations.options", {})).some((o) => o.id === id)).toBe(true);
  });

  it("連絡先の形式と名前の重複を検証する", async () => {
    const admin = await createEmployee(["admin"]);
    const bad = await as(admin).hx("/masters/locations/new", {
      name: uniqueName("倉庫"),
      postalCode: "12",
      _key: newKey(),
    });
    expect(await bad.text()).toContain("郵便番号は7桁の数字で入力してください");
    const name = uniqueName("重複倉庫");
    await systemCommand("locations.create", { name });
    const dup = await as(admin).hx("/masters/locations/new", { name, _key: newKey() });
    expect(await dup.text()).toContain("同じ名前の保管場所がすでにあります");
    const other = await systemCommand("locations.create", { name: uniqueName("別の倉庫") });
    const dupEdit = await as(admin).hx(`/masters/locations/${other.id}`, {
      name,
      version: "1",
      _key: newKey(),
    });
    expect(await dupEdit.text()).toContain("同じ名前の保管場所がすでにあります");
  });

  it("保管場所は管理者だけが編集できる（仕入担当は閲覧だけ）", async () => {
    const purchasing = await createEmployee(["purchasing"]);
    const res = await as(purchasing).hx("/masters/locations/new", {
      name: uniqueName("倉庫"),
      _key: newKey(),
    });
    expect(await res.text()).toContain("この操作を行う権限がありません");
    const created = await systemCommand("locations.create", {
      name: uniqueName("閲覧倉庫"),
      address: "大船渡市",
    });
    const detail = await (await as(purchasing).get(`/masters/locations/${created.id}`)).text();
    expect(detail).toContain("大船渡市");
    expect(detail).not.toContain("保存する");
    const missing = await as(purchasing).get("/masters/locations/NOPE");
    expect(missing.status).toBe(404);
    const archive = await as(purchasing).post(`/masters/locations/${created.id}/archive`, {
      version: "1",
      archived: "true",
      _key: newKey(),
    });
    expect(archive.status).toBe(409);
  });

  it("存在しない保管場所の更新・取引終了はエラー", async () => {
    const admin = await createEmployee(["admin"]);
    const res = await as(admin).hx("/masters/locations/NOPE", {
      name: "x",
      version: "1",
      _key: newKey(),
    });
    expect(await res.text()).toContain("保管場所が見つかりません");
    const archive = await as(admin).post("/masters/locations/NOPE/archive", {
      version: "1",
      archived: "true",
      _key: newKey(),
    });
    expect(await archive.text()).toContain("保管場所が見つかりません");
  });
});

describe("ジャンル・払い出し先店舗の画面", () => {
  it("仕入担当はジャンルを登録・編集できる。受注・出荷担当はできない", async () => {
    const purchasing = await createEmployee(["purchasing"]);
    const sales = await createEmployee(["sales"]);
    const name = uniqueName("焼き菓子");
    const res = await as(purchasing).hx("/masters/genres/new", {
      name,
      displayOrder: "3",
      _key: newKey(),
    });
    expect(res.headers.get("HX-Redirect")).toBe("/masters/genres?notice=created");
    const genre = (await systemQuery("genres.list", {})).find((g) => g.name === name);
    expect(genre?.displayOrder).toBe(3);
    const id = genre?.id ?? "";
    const page = await (await as(purchasing).get(`/masters/genres/${id}`)).text();
    expect(page).toContain("保存する");

    const denied = await as(sales).hx("/masters/genres/new", {
      name: uniqueName("和菓子"),
      _key: newKey(),
    });
    expect(await denied.text()).toContain("この操作を行う権限がありません");
    const view = await (await as(sales).get(`/masters/genres/${id}`)).text();
    expect(view).not.toContain("保存する");

    const edit = await as(purchasing).hx(`/masters/genres/${id}`, {
      name: `${name}改`,
      displayOrder: "1",
      version: "1",
      _key: newKey(),
    });
    expect(edit.headers.get("HX-Redirect")).toBe(`/masters/genres/${id}?notice=updated`);
    const stale = await as(purchasing).hx(`/masters/genres/${id}`, {
      name: `${name}改2`,
      displayOrder: "1",
      version: "1",
      _key: newKey(),
    });
    expect(await stale.text()).toContain("ほかの人が先に更新しました");
    const badOrder = await as(purchasing).hx("/masters/genres/new", {
      name: uniqueName("順"),
      displayOrder: "x",
      _key: newKey(),
    });
    expect(await badOrder.text()).toContain("表示順は数字で入力してください");
    const off = await as(purchasing).post(`/masters/genres/${id}/archive`, {
      version: "2",
      archived: "true",
      _key: newKey(),
    });
    expect(off.headers.get("Location")).toBe(`/masters/genres/${id}?notice=archived`);
    const on = await as(purchasing).post(`/masters/genres/${id}/archive`, {
      version: "3",
      archived: "false",
      _key: newKey(),
    });
    expect(on.headers.get("Location")).toBe(`/masters/genres/${id}?notice=unarchived`);
    expect((await as(purchasing).get("/masters/genres/NOPE")).status).toBe(404);
    const missing = await as(purchasing).hx("/masters/genres/NOPE", {
      name: "x",
      version: "1",
      _key: newKey(),
    });
    expect(await missing.text()).toContain("ジャンルが見つかりません");
  });

  it("払い出し先店舗は管理者だけが登録でき、同じ名前は登録できない", async () => {
    const admin = await createEmployee(["admin"]);
    const purchasing = await createEmployee(["purchasing"]);
    const name = uniqueName("駅前店");
    const res = await as(admin).hx("/masters/stores/new", { name, _key: newKey() });
    expect(res.headers.get("HX-Redirect")).toBe("/masters/stores?notice=created");
    const dup = await as(admin).hx("/masters/stores/new", { name, _key: newKey() });
    expect(await dup.text()).toContain("同じ名前の払い出し先店舗がすでにあります");
    const denied = await as(purchasing).hx("/masters/stores/new", {
      name: uniqueName("店"),
      _key: newKey(),
    });
    expect(await denied.text()).toContain("この操作を行う権限がありません");

    const store = (await systemQuery("retailStores.list", {})).find((s) => s.name === name);
    const id = store?.id ?? "";
    const other = await systemCommand("retailStores.create", { name: uniqueName("別の店") });
    const dupEdit = await as(admin).hx(`/masters/stores/${other.id}`, {
      name,
      version: "1",
      _key: newKey(),
    });
    expect(await dupEdit.text()).toContain("同じ名前の払い出し先店舗がすでにあります");
    const archive = await as(admin).post(`/masters/stores/${id}/archive`, {
      version: "1",
      archived: "true",
      _key: newKey(),
    });
    expect(archive.headers.get("Location")).toBe(`/masters/stores/${id}?notice=archived`);
    expect((await systemQuery("retailStores.options", {})).some((o) => o.id === id)).toBe(false);
    const list = await (await as(admin).get("/masters/stores?archived=1")).text();
    expect(list).toContain(name);
    const stale = await as(admin).post(`/masters/stores/${id}/archive`, {
      version: "1",
      archived: "false",
      _key: newKey(),
    });
    expect(stale.status).toBe(409);
    const missing = await as(admin).post("/masters/stores/NOPE/archive", {
      version: "1",
      archived: "true",
      _key: newKey(),
    });
    expect(await missing.text()).toContain("払い出し先店舗が見つかりません");
  });

  it("一覧が空のときは案内を出す", async () => {
    const admin = await createEmployee(["admin"]);
    const html = await (await as(admin).get("/masters/stores")).text();
    expect(html).toContain("払い出し先店舗");
  });
});
