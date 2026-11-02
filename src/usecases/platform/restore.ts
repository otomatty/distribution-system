/**
 * 業務 DB を特定の時点に戻す前の確認（要件定義書 7章 可用性とバックアップ）。管理者だけが使える。
 * 戻す処理そのもの（Durable Object の storage の Point-in-Time Recovery）は非同期で、トランザクションの外で行うため、
 * 業務 DB の Durable Object（infra/do/restore.ts）が、この照会で権限と時刻を確かめてから行う。
 */
import { z } from "zod";

import { parseJstDateTime } from "../../domain/dates";
import { restoreConfirmationText, restoreTargetError } from "../../domain/restore";
import { err, ok, type Result } from "../../domain/result";
import { defineQuery } from "../core";
import type { AuditLogRecord } from "./audit-logs.port";

/** 確認の画面に出す、戻すと失われる操作 */
const RECENT_OPERATIONS = 20;

export interface RestorePreview {
  /** 戻す時刻（UTC の ISO 文字列） */
  readonly targetAt: string;
  /** 確認のために入力してもらう文字列（日本時間の秒まで） */
  readonly confirmationText: string;
  /** 戻す時刻より後の操作（戻すと失われる）の件数と、新しいものから最大20件 */
  readonly operationsAfter: number;
  readonly recentOperations: readonly Omit<AuditLogRecord, "beforeJson" | "afterJson">[];
}

function invalidTarget(message: string): Result<never> {
  return err("validation", message, { fields: [{ field: "targetAt", message }] });
}

export const previewRestore = defineQuery({
  permission: "platform.admin",
  input: z.object({ targetAt: z.string().trim().max(40) }),
  run(ctx, { targetAt }): Result<RestorePreview> {
    const target = parseJstDateTime(targetAt);
    if (!target) return invalidTarget("戻す日時を「2026-11-02 09:15:00」の形で入力してください");
    const problem = restoreTargetError(target, ctx.clock.now());
    if (problem) return invalidTarget(problem);
    const after = ctx.stores.auditLogs.search({ from: target.toISOString() }, 1, RECENT_OPERATIONS);
    return ok({
      targetAt: target.toISOString(),
      confirmationText: restoreConfirmationText(target),
      operationsAfter: after.total,
      recentOperations: after.rows.map((r) => ({
        id: r.id,
        occurredAt: r.occurredAt,
        employeeId: r.employeeId,
        employeeName: r.employeeName,
        command: r.command,
        entityType: r.entityType,
        entityId: r.entityId,
        action: r.action,
      })),
    });
  },
});
