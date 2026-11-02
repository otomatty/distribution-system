/**
 * エラーの記録と通知（要件定義書 7章）：重大なエラーは管理者にメールで知らせ、同じエラーは1時間に1回まで。
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { businessDb } from "../../src/infra/do/client";
import { errorFingerprint, reportCritical } from "../../src/infra/observability/notify";
import { ADMIN_EMAIL, as, createEmployee } from "./helpers";

describe("重大なエラーの通知", () => {
  it("数字や ID だけが違うエラーは同じものとみなす", () => {
    expect(
      errorFingerprint(
        "job failed",
        new Error("timeout after 300ms for 01JABCDEFGHJKMNPQRSTVWXYZ0"),
      ),
    ).toBe(
      errorFingerprint(
        "job failed",
        new Error("timeout after 5000ms for 01JZZZZZZZZZZZZZZZZZZZZZZZ"),
      ),
    );
    expect(errorFingerprint("a", "x")).not.toBe(errorFingerprint("b", "x"));
  });

  it("有効な管理者に知らせ、同じエラーは1時間に1回まで", async () => {
    const admin2 = await createEmployee(["admin"], "二人目の管理者");
    const db = businessDb(env);
    const first = await db.claimErrorNotification("test|boom", 3_600_000);
    expect(first).toEqual(expect.arrayContaining([ADMIN_EMAIL, admin2]));
    expect(await db.claimErrorNotification("test|boom", 3_600_000)).toEqual([]);
    expect(await db.claimErrorNotification("test|other", 3_600_000)).not.toEqual([]);
    // 時間がたてば、もう一度知らせる
    expect(await db.claimErrorNotification("test|boom", 0)).not.toEqual([]);
    // 通知（開発環境ではログに出す）に失敗しても、例外にしない
    await expect(reportCritical(env, "test event", new Error("boom"))).resolves.toBeUndefined();
  });

  it("URL の ID が長すぎるなどの照会の誤りは、エラーではなく「見つからない」にする", async () => {
    const user = await createEmployee(["sales"]);
    const long = "x".repeat(70);
    expect((await as(user).get(`/documents/${long}`)).status).toBe(404);
    expect((await as(user).get(`/jobs/${long}`)).status).toBe(404);
  });
});
