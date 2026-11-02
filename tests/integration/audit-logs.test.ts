/**
 * 操作履歴の検索（要件定義書 7章 セキュリティ：誰が・いつ・何を・変更前後の値を記録し、管理者が検索できる）。
 */
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { addDays, toBusinessDate } from "../../src/domain/dates";
import type { Result } from "../../src/domain/result";
import { auditLogs } from "../../src/infra/db/schema";
import { businessDb } from "../../src/infra/do/client";
import type { QueryOutput } from "../../src/usecases/registry";
import { unwrap, unwrapErr } from "../support/result";
import { createItem, createLocation, createSupplier, uniqueName } from "./fixtures";
import { as, createEmployee, newKey, systemCommand, systemQuery } from "./helpers";
import { readDb } from "./platform-helpers";
import { createOrder } from "./purchasing-fixtures";

const partnerForm = {
  kana: "ソウサリレキ",
  honorific: "御中",
  isSupplier: "on",
  deliveryDays: "0",
  defaultSendMethod: "none",
};

async function employeeId(email: string): Promise<string> {
  const e = (await systemQuery("employees.list", {})).find((x) => x.email === email);
  if (!e) throw new Error("社員が見つかりません");
  return e.id;
}

async function search(
  email: string,
  input: Record<string, unknown>,
): Promise<Result<QueryOutput<"auditLogs.search">>> {
  const r: Result<unknown> = await businessDb(env).query("auditLogs.search", input, {
    kind: "dev",
    email,
  });
  // RPC を通ると型が unknown になるので、ユースケースの出力の型に戻す
  const typed: unknown = r;
  return typed as Result<QueryOutput<"auditLogs.search">>;
}

describe("操作履歴の検索（/audit-logs）", () => {
  it("管理者だけが使える（画面・ユースケース・メニュー）", async () => {
    const admin = await createEmployee(["admin"]);
    const purchasing = await createEmployee(["purchasing", "sales", "accounting"]);
    expect((await as(purchasing).get("/audit-logs")).status).toBe(403);
    expect(unwrapErr(await search(purchasing, {})).code).toBe("forbidden");
    expect(await (await as(purchasing).get("/")).text()).not.toContain('href="/audit-logs"');

    const page = await as(admin).get("/audit-logs");
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('href="/audit-logs"');
    expect(html).toContain('aria-current="page"');
    // 絞り込みは表の部分だけを差し替え、条件を URL に残す
    expect(html).toContain('hx-get="/audit-logs"');
    expect(html).toContain('hx-push-url="true"');
  });

  it("操作した人・対象・操作・番号で絞り込み、変更前後を項目ごとに出す", async () => {
    const admin = await createEmployee(["admin"]);
    const editor = await createEmployee(["purchasing"], "履歴 花子");
    const name = uniqueName("操作履歴テスト");
    const created = await as(editor).hx("/partners/new", { ...partnerForm, name, _key: newKey() });
    const id = /\/partners\/([0-9A-Z]{26})/.exec(created.headers.get("HX-Redirect") ?? "")?.[1];
    expect(id).toBeDefined();
    const partnerId = id ?? "";
    await as(editor).hx(`/partners/${partnerId}/edit`, {
      ...partnerForm,
      name: `${name}（改）`,
      version: "1",
      _key: newKey(),
    });

    const editorId = await employeeId(editor);
    const mine = unwrap(await search(admin, { employeeId: editorId }));
    expect(mine.total).toBe(2);
    // 新しい順
    expect(mine.rows.map((r) => r.action)).toEqual(["update", "create"]);
    expect(mine.rows[0]).toMatchObject({
      employeeName: "履歴 花子",
      command: "partners.update",
      entityType: "partner",
      entityId: partnerId,
    });
    expect(mine.rows[0]?.changes.changes).toContainEqual({
      path: "name",
      before: name,
      after: `${name}（改）`,
    });

    const updates = unwrap(
      await search(admin, { entityType: "partner", action: "update", target: partnerId }),
    );
    expect(updates.rows.map((r) => r.command)).toEqual(["partners.update"]);
    expect(unwrap(await search(admin, { entityType: "item", target: partnerId })).total).toBe(0);

    // 画面：番号・ID の欄、変更前後の表、対象の画面へのリンク
    const html = await (
      await as(admin).get(`/audit-logs?employeeId=${editorId}&action=update`)
    ).text();
    expect(html).toContain("履歴 花子");
    expect(html).toContain("取引先");
    expect(html).toContain("partners.update");
    expect(html).toContain(`href="/partners/${partnerId}"`);
    expect(html).toContain(`${name}（改）`);
    expect(html).toContain("1件");
  });

  it("画面に出す番号・商品コードで対象を引く", async () => {
    const admin = await createEmployee(["admin"]);
    const supplierId = await createSupplier();
    const locationId = await createLocation();
    const item = await createItem(supplierId);
    const po = await createOrder({
      supplierId,
      locationId,
      lines: [{ itemId: item.id, quantity: 1 }],
    });

    const byNumber = unwrap(await search(admin, { target: po.number }));
    expect(byNumber.rows.map((r) => [r.entityType, r.entityId, r.employeeName])).toEqual([
      ["purchase_order", po.id, "システム"],
    ]);
    const byCode = unwrap(await search(admin, { target: item.code }));
    expect(byCode.rows.map((r) => r.entityId)).toEqual([item.id]);
    expect(unwrap(await search(admin, { target: "PO-1999-999999" })).total).toBe(0);
  });

  it("期間（日本時間の日付）で絞り込み、条件の誤りは画面に出す", async () => {
    const admin = await createEmployee(["admin"]);
    const editor = await createEmployee(["purchasing"]);
    await as(editor).hx("/partners/new", {
      ...partnerForm,
      name: uniqueName("期間テスト"),
      _key: newKey(),
    });
    const editorId = await employeeId(editor);
    const today = toBusinessDate(new Date());
    const inRange = await search(admin, { employeeId: editorId, dateFrom: today, dateTo: today });
    expect(unwrap(inRange).total).toBe(1);
    const before = await search(admin, { employeeId: editorId, dateTo: addDays(today, -1) });
    expect(unwrap(before).total).toBe(0);
    const after = await search(admin, { employeeId: editorId, dateFrom: addDays(today, 1) });
    expect(unwrap(after).total).toBe(0);
    // 空の欄は指定なしとして扱う
    expect(unwrap(await search(admin, { employeeId: editorId, action: "" })).total).toBe(1);

    const wrong = unwrapErr(await search(admin, { dateFrom: today, dateTo: addDays(today, -1) }));
    expect(wrong.code).toBe("validation");
    const page = await as(admin).get(`/audit-logs?dateFrom=${today}&dateTo=${addDays(today, -1)}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("終わりの日付は始まりの日付以降にしてください");
  });

  it("件数が多ければページに分ける", async () => {
    const admin = await createEmployee(["admin"]);
    const editor = await createEmployee(["purchasing"]);
    for (let i = 0; i < 3; i += 1) {
      await as(editor).hx("/partners/new", {
        ...partnerForm,
        name: uniqueName(`ページ${i}`),
        _key: newKey(),
      });
    }
    const editorId = await employeeId(editor);
    const first = unwrap(await search(admin, { employeeId: editorId, page: 1, pageSize: 2 }));
    const second = unwrap(await search(admin, { employeeId: editorId, page: 2, pageSize: 2 }));
    expect([first.total, first.rows.length, second.rows.length]).toEqual([3, 2, 1]);
    expect(new Set([...first.rows, ...second.rows].map((r) => r.id)).size).toBe(3);
  });

  it("社員でない操作者と、読めない記録もそのまま出す", async () => {
    const admin = await createEmployee(["admin"]);
    const entityId = `orphan-${newKey()}`;
    await readDb((db) =>
      db
        .insert(auditLogs)
        .values({
          id: `01ZZZZZZZZZZZZZZZZZZZZZZZZ`,
          occurredAt: new Date().toISOString(),
          employeeId: "retired-employee",
          command: "legacy.import",
          entityType: "legacy",
          entityId,
          action: "legacy_action",
          beforeJson: null,
          afterJson: "not json",
        })
        .run(),
    );
    const r = unwrap(await search(admin, { target: entityId }));
    expect(r.rows[0]).toMatchObject({ employeeId: "retired-employee", employeeName: null });
    expect(r.rows[0]?.changes.changes).toEqual([{ path: "", before: null, after: "not json" }]);
    const html = await (await as(admin).get(`/audit-logs?target=${entityId}`)).text();
    expect(html).toContain("retired-employee");
    expect(html).toContain("legacy_action");
  });

  it("操作した人・操作の索引がある（マイグレーション 0004）", async () => {
    const plans = await runInDurableObject(businessDb(env), (_instance, state) => {
      const indexes = state.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'audit_logs'")
        .toArray()
        .map((r) => r["name"]);
      const plan = state.storage.sql
        .exec(
          "EXPLAIN QUERY PLAN SELECT * FROM audit_logs WHERE employee_id = ? ORDER BY occurred_at DESC LIMIT 50",
          "x",
        )
        .toArray()
        .map((r) => {
          const detail = r["detail"];
          return typeof detail === "string" ? detail : "";
        });
      return { indexes, plan };
    });
    expect(plans.indexes).toEqual(
      expect.arrayContaining(["audit_logs_employee", "audit_logs_action"]),
    );
    expect(plans.plan.join(" ")).toContain("audit_logs_employee");
  });

  it("システムの操作も記録され、操作者は「システム」と出る", async () => {
    const admin = await createEmployee(["admin"]);
    const created = await systemCommand("partners.create", {
      name: uniqueName("システム登録"),
      kana: "システム",
      isSupplier: true,
    });
    const r = unwrap(await search(admin, { target: created.id }));
    expect(r.rows.map((x) => [x.employeeId, x.employeeName, x.action])).toEqual([
      ["system", "システム", "create"],
    ]);
  });
});
