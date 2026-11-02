/**
 * 日次の定期処理（要件定義書 7章 可用性とバックアップ）。Cron（03:00 日本時間）から呼ぶ。
 * - 業務データ全体を JSON にし、gzip で圧縮して R2 の backups/<YYYY-MM-DD>.json.gz に保存する
 *   （テーブルごとに少しずつ読み、RPC の大きさの上限を超えないようにする）
 * - 保存期間を過ぎたバックアップを消す（直近30日は毎日の分、それより前は月初の分を7年）
 * - 30日より古い受付番号（冪等キー）を消す
 * バックアップの成否は処理状況（jobs の backup）に記録し、管理者のダッシュボードに出す。
 * 復元の手順は docs/operations.md。
 */
import { expiredBackupDates } from "../../domain/backups";
import { toBusinessDate } from "../../domain/dates";
import type { BusinessDb } from "../do/business-db";
import { businessDb } from "../do/client";
import { userMessage } from "../errors";
import { log } from "../observability/log";
import { BACKUPS_PREFIX, backupDateOf, backupKey, putFile } from "../storage/files";

const ROWS_PER_READ = 2000;
const IDEMPOTENCY_KEY_DAYS = 30;

export interface BackupResult {
  readonly key: string;
  readonly fileName: string;
  readonly tables: number;
  readonly rows: number;
  readonly bytes: number;
}

/** 業務 DB の全テーブルを書き出して R2 に保存する */
export async function writeBackup(
  env: Env,
  db: DurableObjectStub<BusinessDb>,
  now: Date,
): Promise<BackupResult> {
  const date = toBusinessDate(now);
  const gzip = new CompressionStream("gzip");
  const writer = gzip.writable.getWriter();
  const compressed = new Response(gzip.readable).arrayBuffer();
  const encoder = new TextEncoder();
  const write = (text: string) => writer.write(encoder.encode(text));

  const tables = await db.backupTables();
  let rows = 0;
  await write(
    `{"format":"distribution-system-backup","version":1,"createdAt":${JSON.stringify(now.toISOString())},"tables":{`,
  );
  for (const [i, table] of tables.entries()) {
    await write(`${i === 0 ? "" : ","}${JSON.stringify(table)}:[`);
    let after = 0;
    let first = true;
    for (;;) {
      const page = await db.backupRows(table, after, ROWS_PER_READ);
      if (page.rows.length > 0) {
        await write((first ? "" : ",") + page.rows.map((r) => JSON.stringify(r)).join(","));
        first = false;
        rows += page.rows.length;
      }
      if (page.lastRowid === null) break;
      after = page.lastRowid;
    }
    await write("]");
  }
  await write("}}");
  await writer.close();
  const body = await compressed;

  const key = backupKey(date);
  const fileName = `backup-${date}.json.gz`;
  await putFile(env.FILES, key, body, { contentType: "application/gzip", fileName });
  return { key, fileName, tables: tables.length, rows, bytes: body.byteLength };
}

/** 保存期間を過ぎたバックアップを消す。消した件数を返す */
export async function pruneBackups(bucket: R2Bucket, today: string): Promise<number> {
  const keysByDate = new Map<string, string>();
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({
      prefix: BACKUPS_PREFIX,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const object of listed.objects) {
      const date = backupDateOf(object.key);
      if (date) keysByDate.set(date, object.key);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
  const expired = expiredBackupDates([...keysByDate.keys()], today).flatMap((d) => {
    const key = keysByDate.get(d);
    return key === undefined ? [] : [key];
  });
  for (let i = 0; i < expired.length; i += 1000) {
    await bucket.delete(expired.slice(i, i + 1000));
  }
  return expired.length;
}

/** 毎日の定期処理。どれかが失敗したら最後に例外にする（Cron の失敗としてログと通知に残す） */
export async function dailyMaintenance(env: Env, now = new Date()): Promise<void> {
  const db = businessDb(env);
  const today = toBusinessDate(now);
  const failures: unknown[] = [];

  const jobId = await db.systemJobStart("backup", { date: today });
  try {
    const result = await writeBackup(env, db, now);
    await db.jobProgress(jobId, result.tables, result.tables);
    await db.jobSucceed(jobId, result.key, result.fileName);
    log("info", "backup written", { ...result });
  } catch (e) {
    await db.jobFail(jobId, userMessage(e));
    failures.push(e);
  }

  try {
    const pruned = await pruneBackups(env.FILES, today);
    const before = new Date(now.getTime() - IDEMPOTENCY_KEY_DAYS * 86_400_000).toISOString();
    const purged = await db.purgeIdempotencyKeys(before);
    log("info", "daily cleanup done", { prunedBackups: pruned, purgedIdempotencyKeys: purged });
  } catch (e) {
    failures.push(e);
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, "daily maintenance failed");
  }
}
