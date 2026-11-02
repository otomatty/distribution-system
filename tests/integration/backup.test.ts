/**
 * 日次の定期処理（要件定義書 7章）：業務データのバックアップを R2 に保存し、
 * 古いバックアップと受付番号（冪等キー）を掃除する。成否は管理者のダッシュボードに出す。
 */
import { createScheduledController, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { describe, expect, it } from "vitest";

import { addDays, toBusinessDate } from "../../src/domain/dates";
import * as schema from "../../src/infra/db/schema";
import { businessDb } from "../../src/infra/do/client";
import worker from "../../src/worker";
import { ADMIN_EMAIL, as, createEmployee, systemCommand, systemQuery } from "./helpers";
import { readDb } from "./platform-helpers";

const CRON = "0 18 * * *";

async function gunzipJson(body: ArrayBuffer): Promise<unknown> {
  const stream = new Blob([body]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text());
}

async function putIdempotencyKey(key: string, createdAt: string): Promise<void> {
  await runInDurableObject(businessDb(env), (_instance, state) => {
    drizzle(state.storage, { schema })
      .insert(schema.idempotencyKeys)
      .values({ key, command: "test", employeeId: "system", resultJson: "{}", createdAt })
      .run();
  });
}

async function backupJobCount(): Promise<number> {
  const jobs = await readDb((db) => db.select().from(schema.jobs).all());
  return jobs.filter((j) => j.type === "backup").length;
}

describe("日次バックアップ", () => {
  it("管理者には、バックアップがまだない・最後の成功が古いことを知らせる", async () => {
    const none = await systemQuery("jobs.attention", {});
    expect(none.backup).toEqual({ needsAttention: false, lastSucceededAt: null });
    const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
    await runInDurableObject(businessDb(env), (_instance, state) => {
      drizzle(state.storage, { schema })
        .insert(schema.jobs)
        .values({
          id: "00000000000000000000BACKUP",
          type: "backup",
          payloadJson: "{}",
          status: "succeeded",
          createdAt: old,
          createdBy: "system",
          updatedAt: old,
          updatedBy: "system",
        })
        .run();
    });
    const stale = await systemQuery("jobs.attention", {});
    expect(stale.backup).toEqual({ needsAttention: true, lastSucceededAt: old });
    const dashboard = await (await as(ADMIN_EMAIL).get("/")).text();
    expect(dashboard).toMatch(
      /class="stat attention"[^>]*><div class="label">日次バックアップの異常/,
    );
    // 管理者でなければ出さない
    const user = await createEmployee(["sales"]);
    expect(await (await as(user).get("/")).text()).not.toContain("日次バックアップ");
  });

  it("Cron で業務データ全体を gzip の JSON にして R2 に保存し、古いものを掃除する", async () => {
    await systemCommand("partners.create", {
      name: "バックアップテスト商店",
      kana: "バックアップテスト",
      isSupplier: true,
    });
    const now = new Date();
    const today = toBusinessDate(now);
    const old = new Date(now.getTime() - 40 * 86_400_000).toISOString();
    await putIdempotencyKey("old-key", old);
    await putIdempotencyKey("recent-key", now.toISOString());
    // 保存期間：直近30日は毎日、それより前は月初（1日）の分を7年
    const recentDaily = `backups/${addDays(today, -3)}.json.gz`;
    const oldDaily = `backups/${addDays(today, -45)}.json.gz`;
    const monthly = `backups/${today.slice(0, 4)}-01-01.json.gz`;
    const tooOld = `backups/${Number(today.slice(0, 4)) - 8}-01-01.json.gz`;
    for (const key of [recentDaily, oldDaily, monthly, tooOld]) await env.FILES.put(key, "x");

    await worker.scheduled(createScheduledController({ cron: CRON, scheduledTime: now }), env);

    const object = await env.FILES.get(`backups/${today}.json.gz`);
    expect(object?.httpMetadata?.contentType).toBe("application/gzip");
    const backup = await gunzipJson(await object!.arrayBuffer());
    expect(backup).toMatchObject({ format: "distribution-system-backup", version: 1 });
    const tables = (backup as { tables: Record<string, Record<string, unknown>[]> }).tables;
    expect(Object.keys(tables)).toEqual(
      expect.arrayContaining(["partners", "employees", "documents", "jobs", "audit_logs"]),
    );
    expect(tables["partners"]?.some((p) => p["name"] === "バックアップテスト商店")).toBe(true);
    // 列名は DB の列名（snake_case）のまま
    expect(tables["partners"]?.[0]).toHaveProperty("is_supplier");

    expect(await env.FILES.head(recentDaily)).not.toBeNull();
    expect(await env.FILES.head(monthly)).not.toBeNull();
    expect(await env.FILES.head(oldDaily)).toBeNull();
    expect(await env.FILES.head(tooOld)).toBeNull();

    const keys = await readDb((db) => db.select().from(schema.idempotencyKeys).all());
    expect(keys.map((k) => k.key)).toContain("recent-key");
    expect(keys.map((k) => k.key)).not.toContain("old-key");

    // 成否は処理状況と、管理者のダッシュボードに出る
    const attention = await systemQuery("jobs.attention", {});
    expect(attention.backup).toMatchObject({ needsAttention: false });
    expect(attention.backup?.lastSucceededAt).not.toBeNull();
    const jobs = await (await as(ADMIN_EMAIL).get("/jobs")).text();
    expect(jobs).toContain("日次バックアップ");
    expect(jobs).toContain("システム");
  });

  it("知らない cron の式では何もしない", async () => {
    const before = await backupJobCount();
    await worker.scheduled(createScheduledController({ cron: "*/5 * * * *" }), env);
    expect(await backupJobCount()).toBe(before);
  });
});

describe("ダッシュボード", () => {
  it("役割ごとに今日やることを表示し、各項目から絞り込み済みの一覧に移れる", async () => {
    const purchasing = await createEmployee(["purchasing"]);
    const html = await (await as(purchasing).get("/")).text();
    expect(html).toContain("今日やること");
    expect(html).toContain("帳票と処理");
    expect(html).toContain("送付に失敗した帳票");
    expect(html).toContain('href="/documents?sendStatus=failed"');
    expect(html).toContain('href="/jobs?status=failed"');
    // 管理者だけの項目
    expect(html).not.toContain("日次バックアップの異常");
    expect(html).not.toContain("PDF の作成に失敗した帳票");

    const admin = await (await as(ADMIN_EMAIL).get("/")).text();
    expect(admin).toContain("日次バックアップの異常");
    expect(admin).toContain('href="/documents?renderStatus=failed"');
  });
});
