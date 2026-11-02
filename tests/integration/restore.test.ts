/**
 * 業務 DB を特定の時点に戻す（要件定義書 7章 可用性とバックアップ。手順は docs/operations.md 3章）。
 *
 * Durable Object の Point-in-Time Recovery（ctx.storage.getBookmarkForTime・onNextSessionRestoreBookmark）と
 * ctx.abort は手元の実行環境（Miniflare）では使えない（「storage back-end does not implement point-in-time recovery」）。
 * そのため、画面と業務 DB の Durable Object の結合テストでは「この環境では使えない」と断ることを確かめ、
 * 予約・記録・戻ったことの記録は、PointInTimeRecovery を差し替えて infra/do/restore.ts を直接確かめる。
 * 実際に戻ることは検証環境で試す（docs/operations.md 3章）。
 */
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { monotonicFactory } from "ulid";
import { describe, expect, it } from "vitest";

import { formatJstDateTime } from "../../src/domain/dates";
import type { Result } from "../../src/domain/result";
import * as schema from "../../src/infra/db/schema";
import type { ActorRef } from "../../src/infra/do/actor-ref";
import { businessDb } from "../../src/infra/do/client";
import {
  completeRestore,
  getRestore,
  scheduleRestore,
  type PointInTimeRecovery,
  type RestoreDeps,
} from "../../src/infra/do/restore";
import { restoreRecordKey } from "../../src/infra/storage/files";
import type { Actor } from "../../src/usecases/core";
import type { RestorePreview } from "../../src/usecases/platform/restore";
import { unwrap, unwrapErr } from "../support/result";
import { uniqueName } from "./fixtures";
import { as, createEmployee, newKey, systemCommand, systemQuery } from "./helpers";

const ulid = monotonicFactory();

const ACTOR: Actor = {
  employeeId: "restore-admin",
  name: "復元 太郎",
  email: "restore-admin@example.co.jp",
  roles: ["admin"],
};

/** 差し替えた Point-in-Time Recovery（呼ばれた内容を記録する） */
function fakeRecovery(options: { failBookmark?: boolean } = {}) {
  const calls: string[] = [];
  const recovery: PointInTimeRecovery = {
    currentBookmark: () => Promise.resolve("bm-current"),
    bookmarkForTime: (at) => {
      if (options.failBookmark) return Promise.reject(new Error("not implemented"));
      calls.push(`forTime:${at.toISOString()}`);
      return Promise.resolve(`bm-${at.getTime()}`);
    },
    restoreOnNextSession: (bookmark) => {
      calls.push(`restore:${bookmark}`);
      return Promise.resolve(`undo-of-${bookmark}`);
    },
    restart: (reason) => calls.push(`restart:${reason}`),
  };
  return { recovery, calls };
}

/** 業務 DB の Durable Object の中で、差し替えた Point-in-Time Recovery を使って fn を実行する */
function inBusinessDb<T>(
  deps: Partial<Omit<RestoreDeps, "db" | "nextId">>,
  fn: (d: RestoreDeps) => Promise<T>,
): Promise<T> {
  return runInDurableObject(businessDb(env), (_instance, state) =>
    fn({
      db: drizzle(state.storage, { schema }),
      files: env.FILES,
      recovery: fakeRecovery().recovery,
      environment: "staging",
      unlockUntil: undefined,
      now: new Date(),
      nextId: () => ulid(),
      ...deps,
    }),
  );
}

function restoreAudits(id: string) {
  return runInDurableObject(businessDb(env), (_instance, state) =>
    drizzle(state.storage, { schema })
      .select()
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.entityType, "business_db"),
          eq(schema.auditLogs.action, "point_in_time_restore"),
        ),
      )
      .all()
      .filter((r) => r.afterJson?.includes(id)),
  );
}

/** 戻ったことにする（戻した時刻より後に書いた、依頼の操作履歴が消える） */
function simulateRewind(id: string) {
  return runInDurableObject(businessDb(env), (_instance, state) => {
    const db = drizzle(state.storage, { schema });
    for (const row of db.select().from(schema.auditLogs).all()) {
      if (row.afterJson?.includes(id) && row.afterJson.includes('"scheduled"')) {
        db.delete(schema.auditLogs).where(eq(schema.auditLogs.id, row.id)).run();
      }
    }
  });
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

function preview(email: string, targetAt: string) {
  const ref: ActorRef = { kind: "dev", email };
  return businessDb(env).query("restore.preview", { targetAt }, ref) as Promise<
    Result<Result<RestorePreview>>
  >;
}

describe("業務 DB の復元：権限と確認", () => {
  it("管理者だけが使える（画面・照会・業務 DB の操作・メニュー）", async () => {
    const admin = await createEmployee(["admin"]);
    const other = await createEmployee(["purchasing", "sales", "accounting"]);
    expect((await as(other).get("/admin/restore")).status).toBe(403);
    expect((await as(other).post("/admin/restore", { _key: newKey() })).status).toBe(403);
    expect(unwrapErr(await preview(other, formatJstDateTime(minutesAgo(5)))).code).toBe(
      "forbidden",
    );
    const ref: ActorRef = { kind: "dev", email: other };
    const db = businessDb(env);
    const input = { targetAt: formatJstDateTime(minutesAgo(5)), confirmation: "", reason: "x" };
    expect(unwrapErr(await db.restoreToPointInTime(ref, input, newKey())).code).toBe("forbidden");
    expect(unwrapErr(await db.completeRestore(ref, newKey())).code).toBe("forbidden");
    expect(unwrapErr(await db.restoreHistory(ref)).code).toBe("forbidden");
    expect(unwrapErr(await db.restoreRecord(ref, newKey())).code).toBe("forbidden");
    expect(await (await as(other).get("/")).text()).not.toContain('href="/admin/restore"');
    expect(await (await as(admin).get("/")).text()).toContain('href="/admin/restore"');
  });

  it("戻す日時を選ぶと、戻すと失われる操作と、確認に入力する日時を出す", async () => {
    const admin = await createEmployee(["admin"]);
    const target = minutesAgo(2);
    const name = uniqueName("復元で消える取引先");
    await systemCommand("partners.create", { name, kana: "フクゲン", isSupplier: true });
    const text = formatJstDateTime(target);
    const p = unwrap(unwrap(await preview(admin, text)));
    expect(p.confirmationText).toBe(text);
    expect(p.targetAt).toBe(new Date(text.replace(" ", "T") + "+09:00").toISOString());
    expect(p.operationsAfter).toBeGreaterThanOrEqual(2);
    expect(p.recentOperations.length).toBeLessThanOrEqual(20);
    expect(p.recentOperations.map((o) => o.command)).toContain("partners.create");

    const page = await as(admin).get(
      `/admin/restore?at=${encodeURIComponent(text.replace(" ", "T"))}`,
    );
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(`確認のため、戻す日時「${text}」を入力してください`);
    expect(html).toContain(`name="targetAt" value="${text}"`);
    expect(html).toContain("件</strong>");
    expect(html).toContain("この環境（test）では、管理者の確認だけで戻せます");
    expect(html).toContain("これまでの復元");
  });

  it("未来・30日より前・読めない日時は戻せない", async () => {
    const admin = await createEmployee(["admin"]);
    const future = unwrapErr(unwrap(await preview(admin, formatJstDateTime(minutesAgo(-10)))));
    expect(future.fields).toEqual([
      { field: "targetAt", message: "今より前の日時を指定してください" },
    ]);
    const old = unwrapErr(unwrap(await preview(admin, formatJstDateTime(minutesAgo(31 * 1440)))));
    expect(old.message).toContain("過去30日以内");
    const bad = unwrapErr(unwrap(await preview(admin, "きのう")));
    expect(bad.message).toContain("2026-11-02 09:15:00");
    const page = await as(admin).get("/admin/restore?at=2020-01-01T00:00");
    expect(await page.text()).toContain("過去30日以内");
  });

  it("確認の日時・理由・受付番号がなければ戻さない", async () => {
    const admin = await createEmployee(["admin"]);
    const text = formatJstDateTime(minutesAgo(3));
    const wrong = await as(admin).post("/admin/restore", {
      targetAt: text,
      confirmation: "2000-01-01 00:00:00",
      reason: "誤操作の取消",
      _key: newKey(),
    });
    expect(wrong.status).toBe(422);
    const html = await wrong.text();
    expect(html).toContain("確認の日時が戻す日時と一致しません");
    expect(html).toContain(`確認のため「${text}」と入力してください`);
    const noReason = await as(admin).post("/admin/restore", {
      targetAt: text,
      confirmation: text,
      reason: " ",
      _key: newKey(),
    });
    expect(noReason.status).toBe(422);
    const noKey = await as(admin).post("/admin/restore", {
      targetAt: text,
      confirmation: text,
      reason: "誤操作の取消",
    });
    expect(noKey.status).toBe(422);
    expect(await noKey.text()).toContain("受付番号がないため");
  });

  it("手元の実行環境では Point-in-Time Recovery を使えないので、そう伝えて何も変えない", async () => {
    const admin = await createEmployee(["admin"]);
    const text = formatJstDateTime(minutesAgo(3));
    const key = newKey();
    const res = await as(admin).post("/admin/restore", {
      targetAt: text,
      confirmation: text,
      reason: "結合テスト",
      _key: key,
    });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("この環境では特定の時点への復元を使えません");
    expect(await getRestore(env.FILES, key)).toBeNull();
    expect(await restoreAudits(key)).toEqual([]);
    const ref: ActorRef = { kind: "dev", email: admin };
    expect(unwrapErr(await businessDb(env).completeRestore(ref, key)).code).toBe("not_found");
    expect(unwrap(await businessDb(env).restoreRecord(ref, key))).toBeNull();
    expect((await as(admin).get(`/admin/restore/${key}`)).status).toBe(404);
  });
});

describe("業務 DB の復元：予約と記録（Point-in-Time Recovery を差し替える）", () => {
  it("戻す時刻のブックマークで予約し、R2・操作履歴に依頼を残してから作り直す。同じ番号の再送信は予約し直さない", async () => {
    const id = newKey();
    const target = minutesAgo(10);
    const fake = fakeRecovery();
    const record = unwrap(
      await inBusinessDb({ recovery: fake.recovery }, (d) =>
        scheduleRestore(d, { id, target, reason: "誤って取消した", actor: ACTOR }),
      ),
    );
    expect(record).toMatchObject({
      id,
      status: "scheduled",
      environment: "staging",
      targetAt: target.toISOString(),
      requestedBy: { employeeId: ACTOR.employeeId, name: ACTOR.name, email: ACTOR.email },
      reason: "誤って取消した",
      targetBookmark: `bm-${target.getTime()}`,
      previousBookmark: "bm-current",
      undoBookmark: `undo-of-bm-${target.getTime()}`,
      completedAt: null,
    });
    // 予約と作り直しの間をあけない（記録を残した直後に作り直す）
    expect(fake.calls).toEqual([
      `forTime:${target.toISOString()}`,
      `restore:bm-${target.getTime()}`,
      `restart:point-in-time restore ${id}`,
    ]);
    expect(await getRestore(env.FILES, id)).toEqual(record);
    const audits = await restoreAudits(id);
    expect(audits.map((a) => [a.employeeId, a.command, a.entityId])).toEqual([
      [ACTOR.employeeId, "businessDb.restore", "main"],
    ]);
    expect(JSON.parse(audits[0]?.afterJson ?? "{}")).toMatchObject({ status: "scheduled" });

    const again = fakeRecovery();
    const second = unwrap(
      await inBusinessDb({ recovery: again.recovery }, (d) =>
        scheduleRestore(d, { id, target: minutesAgo(1), reason: "二重送信", actor: ACTOR }),
      ),
    );
    expect(second).toEqual(record);
    expect(again.calls).toEqual([]);
  });

  it("戻るまでは pending、戻った後は操作履歴に1回だけ残し、R2 の記録を「戻した」にする", async () => {
    const id = newKey();
    unwrap(
      await inBusinessDb({}, (d) =>
        scheduleRestore(d, { id, target: minutesAgo(5), reason: "訓練", actor: ACTOR }),
      ),
    );
    const pending = unwrap(await inBusinessDb({}, (d) => completeRestore(d, ACTOR, id)));
    expect(pending.status).toBe("pending");

    await simulateRewind(id);
    const done = unwrap(await inBusinessDb({}, (d) => completeRestore(d, ACTOR, id)));
    expect(done.status).toBe("restored");
    expect(done.record.status).toBe("restored");
    expect(done.record.completedAt).not.toBeNull();
    expect((await getRestore(env.FILES, id))?.status).toBe("restored");
    const again = unwrap(await inBusinessDb({}, (d) => completeRestore(d, ACTOR, id)));
    expect(again.status).toBe("restored");
    const audits = await restoreAudits(id);
    expect(audits.map((a) => a.afterJson?.includes('"status":"restored"'))).toEqual([true]);
    expect(
      unwrapErr(await inBusinessDb({}, (d) => completeRestore(d, ACTOR, "unknown-id"))).code,
    ).toBe("not_found");
  });

  it("画面に、これまでの復元と記録を出し、戻ったかを確かめられる", async () => {
    const admin = await createEmployee(["admin"]);
    const id = newKey();
    const reason = uniqueName("画面の訓練");
    unwrap(
      await inBusinessDb({}, (d) =>
        scheduleRestore(d, { id, target: minutesAgo(5), reason, actor: ACTOR }),
      ),
    );
    const list = await (await as(admin).get("/admin/restore")).text();
    expect(list).toContain(reason);
    expect(list).toContain(`href="/admin/restore/${id}"`);
    expect(list).toContain("予約のまま");

    const detail = await (await as(admin).get(`/admin/restore/${id}`)).text();
    expect(detail).toContain("まだ戻ったことを確かめられていません");
    expect(detail).toContain(`undo-of-bm-`);
    const stillPending = await as(admin).post(`/admin/restore/${id}/complete`, { _key: newKey() });
    expect(stillPending.status).toBe(303);
    expect(await (await as(admin).get(`/admin/restore/${id}`)).text()).toContain("予約のまま");

    await simulateRewind(id);
    await as(admin).post(`/admin/restore/${id}/complete`, { _key: newKey() });
    const restored = await (await as(admin).get(`/admin/restore/${id}`)).text();
    expect(restored).toContain("の状態に戻しました");
    const audits = await restoreAudits(id);
    const employees = await systemQuery("employees.list", {});
    expect(audits.map((a) => a.employeeId)).toEqual([employees.find((e) => e.email === admin)?.id]);
    expect((await as(admin).post("/admin/restore/unknown-id/complete", {})).status).toBe(404);
  });

  it("本番では RESTORE_UNLOCK_UNTIL がなければ断り、あれば予約する", async () => {
    const now = new Date();
    const request = { id: newKey(), target: minutesAgo(5), reason: "本番", actor: ACTOR };
    const fake = fakeRecovery();
    const locked = unwrapErr(
      await inBusinessDb({ environment: "production", recovery: fake.recovery, now }, (d) =>
        scheduleRestore(d, request),
      ),
    );
    expect(locked.code).toBe("forbidden");
    expect(locked.message).toContain("RESTORE_UNLOCK_UNTIL");
    expect(fake.calls).toEqual([]);
    const unlockUntil = new Date(now.getTime() + 3_600_000).toISOString();
    const opened = unwrap(
      await inBusinessDb({ environment: "production", unlockUntil, now }, (d) =>
        scheduleRestore(d, request),
      ),
    );
    expect(opened.environment).toBe("production");
  });

  it("ブックマークを取れない、記録を残せないときは戻さない（予約は取り消す）", async () => {
    const id = newKey();
    const unavailable = unwrapErr(
      await inBusinessDb({ recovery: fakeRecovery({ failBookmark: true }).recovery }, (d) =>
        scheduleRestore(d, { id, target: minutesAgo(5), reason: "x", actor: ACTOR }),
      ),
    );
    expect(unavailable.code).toBe("invalid_state");
    expect(await getRestore(env.FILES, id)).toBeNull();

    const fake = fakeRecovery();
    const brokenFiles = {
      get: () => Promise.resolve(null),
      put: () => Promise.reject(new Error("R2 is down")),
    } as unknown as R2Bucket;
    const notRecorded = unwrapErr(
      await inBusinessDb({ recovery: fake.recovery, files: brokenFiles }, (d) =>
        scheduleRestore(d, { id, target: minutesAgo(5), reason: "x", actor: ACTOR }),
      ),
    );
    expect(notRecorded.message).toContain("復元を取り消しました");
    expect(fake.calls.some((c) => c.startsWith("restart:"))).toBe(false);
    expect(fake.calls.filter((c) => c.startsWith("restore:"))).toEqual([
      expect.stringMatching(/^restore:bm-/),
      expect.stringMatching(/^restore:undo-of-bm-/),
    ]);
    expect(await restoreAudits(id)).toEqual([]);
  });

  it("壊れた記録や、R2 のキーに使えない ID は読まない", async () => {
    const id = newKey();
    await env.FILES.put(restoreRecordKey(id), JSON.stringify({ id, broken: true }));
    expect(await getRestore(env.FILES, id)).toBeNull();
    expect(await getRestore(env.FILES, "../etc")).toBeNull();
    const admin = await createEmployee(["admin"]);
    const ref: ActorRef = { kind: "dev", email: admin };
    const history = unwrap(await businessDb(env).restoreHistory(ref));
    expect(history.map((r) => r.id)).not.toContain(id);
  });
});
