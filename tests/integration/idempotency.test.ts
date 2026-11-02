/**
 * 受付番号（冪等キー）の必須化（要件定義書 7章 倉庫の通信、AGENTS.md 4章 データの変更）。
 * 画面からの操作は受付番号がなければ業務 DB が受け付けず、内部の処理だけが internalCommand で省ける。
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { ActorRef, InternalActorRef } from "../../src/infra/do/actor-ref";
import { businessDb } from "../../src/infra/do/client";
import { unwrap, unwrapErr } from "../support/result";
import { as, createEmployee, newKey, systemQuery } from "./helpers";

const partnerForm = {
  kana: "ウケツケ",
  honorific: "御中",
  isSupplier: "on",
  deliveryDays: "0",
  defaultSendMethod: "none",
};

describe("受付番号（冪等キー）", () => {
  it("画面から受付番号なしで送った操作は受け付けず、何も登録しない", async () => {
    const user = await createEmployee(["purchasing"]);
    const name = `受付番号なし${newKey().slice(0, 8)}`;
    const missing = await as(user).hx("/partners/new", { ...partnerForm, name });
    expect(missing.headers.get("HX-Redirect")).toBeNull();
    expect(await missing.text()).toContain("受付番号がないため、操作を受け付けませんでした");
    const empty = await as(user).hx("/partners/new", { ...partnerForm, name, _key: "  " });
    expect(await empty.text()).toContain("受付番号がないため");
    expect((await systemQuery("partners.list", { q: name, page: 1 })).total).toBe(0);

    const accepted = await as(user).hx("/partners/new", { ...partnerForm, name, _key: newKey() });
    expect(accepted.headers.get("HX-Redirect")).toMatch(/^\/partners\/[0-9A-Z]{26}\?notice=/);
    expect((await systemQuery("partners.list", { q: name, page: 1 })).total).toBe(1);
  });

  it("業務 DB は受付番号のない・空の・長すぎる操作を受け付けない", async () => {
    const user = await createEmployee(["purchasing"]);
    const db = businessDb(env);
    const ref: ActorRef = { kind: "dev", email: user };
    const input = { name: "直接の呼び出し", kana: "チョクセツ", isSupplier: true };
    expect(unwrapErr(await db.command("partners.create", input, ref, "")).code).toBe("validation");
    expect(
      unwrapErr(await db.command("partners.create", input, ref, "x".repeat(129))).message,
    ).toContain("受付番号がない");
    // RPC の境界では型に関係なく確かめる（JavaScript から null を渡された場合）
    const nullKey: unknown = null;
    expect(unwrapErr(await db.command("partners.create", input, ref, nullKey as string)).code).toBe(
      "validation",
    );
    expect((await systemQuery("partners.list", { q: "直接の呼び出し", page: 1 })).total).toBe(0);
  });

  it("受付番号なしの実行（internalCommand）は、画面の操作者では使えない", async () => {
    const user = await createEmployee(["admin"]);
    const db = businessDb(env);
    const input = { name: "内部の処理", kana: "ナイブ", isSupplier: true };
    const devRef: unknown = { kind: "dev", email: user };
    const denied = unwrapErr(
      await db.internalCommand("partners.create", input, devRef as InternalActorRef),
    );
    expect(denied.code).toBe("forbidden");
    const authRef: unknown = { kind: "auth", userId: "someone" };
    expect(
      unwrapErr(await db.internalCommand("partners.create", input, authRef as InternalActorRef))
        .code,
    ).toBe("forbidden");
    expect((await systemQuery("partners.list", { q: "内部の処理", page: 1 })).total).toBe(0);

    unwrap(await db.internalCommand("partners.create", input, { kind: "system" }));
    const employee = (await systemQuery("employees.list", {})).find((e) => e.email === user);
    unwrap(
      await db.internalCommand(
        "partners.create",
        { ...input, name: "内部の処理（社員）" },
        { kind: "employee", employeeId: employee?.id ?? "" },
      ),
    );
    expect((await systemQuery("partners.list", { q: "内部の処理", page: 1 })).total).toBe(2);
  });
});
