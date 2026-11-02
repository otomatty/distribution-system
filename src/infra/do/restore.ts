/**
 * 業務 DB（Durable Object の SQLite）を特定の時点に戻す（要件定義書 7章 可用性とバックアップ）。手順は docs/operations.md 3章。
 *
 * 1. scheduleRestore：戻す時刻のブックマークを取り、次に開いたときにその状態に戻すよう予約する
 *    （ctx.storage.getBookmarkForTime → ctx.storage.onNextSessionRestoreBookmark）。
 *    依頼の記録を R2（restores/<ID>.json）・操作履歴・ログに残す
 * 2. BusinessDb.restartForRestore：Durable Object を作り直す（ctx.abort）。次に開いたときに戻る
 * 3. completeRestore：戻った業務 DB に、戻したことを操作履歴として残す
 *
 * 業務 DB を戻すと、戻した時刻より後の操作履歴も消える。そのため依頼の記録は R2 とログにも残す（戻しても消えない）。
 * 1 で書いた操作履歴が 3 の時点で消えていれば、戻ったことが分かる（戻した時刻はそれより前なので）。
 *
 * Durable Object の Point-in-Time Recovery は手元（wrangler dev・vitest）では使えないので、
 * storage の API は PointInTimeRecovery の後ろに置き、テストでは差し替える（実際の復元は検証環境で試す）。
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { parseAuditJson } from "../../domain/audit";
import { restoreLockError } from "../../domain/restore";
import { err, ok, type Result } from "../../domain/result";
import type { Actor } from "../../usecases/core";
import type { Db } from "../db/client";
import { auditLogs } from "../db/schema";
import { errorFields, log } from "../observability/log";
import { RESTORES_PREFIX, restoreRecordKey } from "../storage/files";

/** Durable Object の storage の Point-in-Time Recovery（ctx.storage と ctx.abort） */
export interface PointInTimeRecovery {
  currentBookmark(): Promise<string>;
  /** 指定した時刻（過去30日以内）のおよその状態のブックマーク */
  bookmarkForTime(at: Date): Promise<string>;
  /** 次に開いたときに bookmark の状態に戻すよう予約する。戻す直前の状態のブックマーク（取り消し用）を返す */
  restoreOnNextSession(bookmark: string): Promise<string>;
  /** Durable Object を作り直す。呼んだ要求は例外で終わる */
  restart(reason: string): void;
}

export function durableObjectRecovery(ctx: DurableObjectState): PointInTimeRecovery {
  return {
    currentBookmark: () => ctx.storage.getCurrentBookmark(),
    bookmarkForTime: (at) => ctx.storage.getBookmarkForTime(at),
    restoreOnNextSession: (bookmark) => ctx.storage.onNextSessionRestoreBookmark(bookmark),
    restart: (reason) => ctx.abort(reason),
  };
}

/** 復元の ID（画面のフォームの受付番号）。R2 のキーに使うので形を限る */
export function isRestoreId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9A-Za-z-]{8,64}$/.test(value);
}

const restoreRecordSchema = z.object({
  id: z.string(),
  status: z.enum(["scheduled", "restored"]),
  environment: z.string(),
  /** 戻した時刻（UTC） */
  targetAt: z.string(),
  requestedAt: z.string(),
  requestedBy: z.object({ employeeId: z.string(), name: z.string(), email: z.string() }),
  reason: z.string(),
  targetBookmark: z.string(),
  /** 依頼したときの状態のブックマーク */
  previousBookmark: z.string(),
  /** 取り消し用のブックマーク（onNextSessionRestoreBookmark に渡すと、戻す前の状態に戻る） */
  undoBookmark: z.string(),
  completedAt: z.string().nullable(),
});

export type RestoreRecord = z.infer<typeof restoreRecordSchema>;

export async function getRestore(files: R2Bucket, id: string): Promise<RestoreRecord | null> {
  if (!isRestoreId(id)) return null;
  const object = await files.get(restoreRecordKey(id));
  if (!object) return null;
  const parsed = restoreRecordSchema.safeParse(await object.json());
  return parsed.success ? parsed.data : null;
}

async function putRestore(files: R2Bucket, record: RestoreRecord): Promise<void> {
  await files.put(restoreRecordKey(record.id), JSON.stringify(record, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });
}

/** これまでの復元の記録（新しい順、最大 limit 件） */
export async function listRestores(files: R2Bucket, limit = 20): Promise<RestoreRecord[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await files.list({
      prefix: RESTORES_PREFIX,
      ...(cursor === undefined ? {} : { cursor }),
    });
    keys.push(...listed.objects.map((o) => o.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
  const records: RestoreRecord[] = [];
  for (const key of keys) {
    const object = await files.get(key);
    const parsed = restoreRecordSchema.safeParse(object ? await object.json() : null);
    if (parsed.success) records.push(parsed.data);
  }
  return records.toSorted((a, b) => b.requestedAt.localeCompare(a.requestedAt)).slice(0, limit);
}

export interface RestoreDeps {
  readonly db: Db;
  readonly files: R2Bucket;
  readonly recovery: PointInTimeRecovery;
  /** ENVIRONMENT（本番の鍵を確かめる） */
  readonly environment: string;
  /** Secrets の RESTORE_UNLOCK_UNTIL（本番の鍵） */
  readonly unlockUntil: string | undefined;
  readonly now: Date;
  readonly nextId: () => string;
}

export interface RestoreRequest {
  readonly id: string;
  readonly target: Date;
  readonly reason: string;
  readonly actor: Actor;
}

const RESTORE_COMMAND = "businessDb.restore";
const RESTORE_ACTION = "point_in_time_restore";

function recordAudit(deps: RestoreDeps, actor: Actor, before: unknown, after: unknown): void {
  deps.db
    .insert(auditLogs)
    .values({
      id: deps.nextId(),
      occurredAt: deps.now.toISOString(),
      employeeId: actor.employeeId,
      command: RESTORE_COMMAND,
      entityType: "business_db",
      entityId: "main",
      action: RESTORE_ACTION,
      beforeJson: JSON.stringify(before),
      afterJson: JSON.stringify(after),
    })
    .run();
}

/** この復元について書いた操作履歴の状態（scheduled：依頼のときに書いたもの、restored：戻った後に書いたもの） */
function auditStatuses(db: Db, id: string): string[] {
  const rows = db
    .select({ afterJson: auditLogs.afterJson })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.entityType, "business_db"),
        eq(auditLogs.entityId, "main"),
        eq(auditLogs.action, RESTORE_ACTION),
      ),
    )
    .all();
  const entry = z.object({ restoreId: z.string(), status: z.string() });
  return rows.flatMap((r) => {
    const parsed = entry.safeParse(parseAuditJson(r.afterJson));
    return parsed.success && parsed.data.restoreId === id ? [parsed.data.status] : [];
  });
}

/**
 * 戻す時刻のブックマークを取り、次に開いたときに戻すよう予約して、依頼を記録する。
 * 同じ ID の依頼がすでにあれば、何もせずにその記録を返す（二重送信）
 */
export async function scheduleRestore(
  deps: RestoreDeps,
  request: RestoreRequest,
): Promise<Result<RestoreRecord>> {
  const locked = restoreLockError(deps.environment, deps.unlockUntil, deps.now);
  if (locked) return err("forbidden", locked);
  const existing = await getRestore(deps.files, request.id);
  if (existing) return ok(existing);

  let previousBookmark: string;
  let targetBookmark: string;
  let undoBookmark: string;
  try {
    previousBookmark = await deps.recovery.currentBookmark();
    targetBookmark = await deps.recovery.bookmarkForTime(request.target);
    undoBookmark = await deps.recovery.restoreOnNextSession(targetBookmark);
  } catch (e) {
    log("warn", "point-in-time recovery unavailable", { restoreId: request.id, ...errorFields(e) });
    return err(
      "invalid_state",
      "この環境では特定の時点への復元を使えません（手元の開発環境とテストでは使えません）。検証環境で試してください",
    );
  }
  const record: RestoreRecord = {
    id: request.id,
    status: "scheduled",
    environment: deps.environment,
    targetAt: request.target.toISOString(),
    requestedAt: deps.now.toISOString(),
    requestedBy: {
      employeeId: request.actor.employeeId,
      name: request.actor.name,
      email: request.actor.email,
    },
    reason: request.reason,
    targetBookmark,
    previousBookmark,
    undoBookmark,
    completedAt: null,
  };
  try {
    await putRestore(deps.files, record);
    // 戻すと消える記録（取り消し用のブックマークで戻せば残っている）。戻ったかどうかの目印にもする
    recordAudit(
      deps,
      request.actor,
      { bookmark: previousBookmark },
      {
        restoreId: record.id,
        status: "scheduled",
        targetAt: record.targetAt,
        reason: record.reason,
      },
    );
  } catch (e) {
    // 記録を残せないまま戻さない。予約は取り消し用のブックマークで取り消す
    log("error", "point-in-time restore not recorded; cancelling", {
      restoreId: request.id,
      ...errorFields(e),
    });
    await deps.recovery.restoreOnNextSession(undoBookmark);
    return err(
      "invalid_state",
      "復元の記録を残せなかったため、復元を取り消しました。もう一度操作してください",
    );
  }
  log("warn", "point-in-time restore scheduled", { ...record });
  return ok(record);
}

export interface RestoreProgress {
  /** restored：戻った。pending：まだ戻っていない（Durable Object が作り直されていない） */
  readonly status: "restored" | "pending";
  readonly record: RestoreRecord;
}

/** 戻った業務 DB に、戻したことを操作履歴として残す（何度呼んでも1回だけ残す） */
export async function completeRestore(
  deps: RestoreDeps,
  actor: Actor,
  id: string,
): Promise<Result<RestoreProgress>> {
  const record = await getRestore(deps.files, id);
  if (!record) return err("not_found", "復元の記録が見つかりません");
  const statuses = auditStatuses(deps.db, id);
  if (statuses.includes("scheduled")) return ok({ status: "pending", record });
  if (statuses.includes("restored") && record.status === "restored") {
    return ok({ status: "restored", record });
  }
  const completed: RestoreRecord = {
    ...record,
    status: "restored",
    completedAt: record.completedAt ?? deps.now.toISOString(),
  };
  if (!statuses.includes("restored")) {
    recordAudit(
      deps,
      actor,
      { bookmark: record.undoBookmark },
      {
        restoreId: record.id,
        status: "restored",
        targetAt: record.targetAt,
        reason: record.reason,
        requestedAt: record.requestedAt,
        requestedBy: record.requestedBy,
        undoBookmark: record.undoBookmark,
      },
    );
  }
  await putRestore(deps.files, completed);
  log("warn", "point-in-time restore completed", { ...completed });
  return ok({ status: "restored", record: completed });
}
