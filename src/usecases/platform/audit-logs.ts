/**
 * 操作履歴の検索（要件定義書 7章 セキュリティ：状態を変える操作はすべて、誰が・いつ・何を・
 * 変更前後の値を記録し、管理者が検索できる）。管理者だけが使える。
 */
import { z } from "zod";

import { auditChanges, parseAuditJson, type AuditChanges } from "../../domain/audit";
import { addDays, startOfBusinessDay } from "../../domain/dates";
import { defineQuery } from "../core";
import { optionalBusinessDate, pageInput, type Page } from "../schemas";
import type { AuditLogFilter, AuditLogRecord } from "./audit-logs.port";

/** システムの処理（Cron・Queues・ログインの連携など）の操作者 */
const SYSTEM_EMPLOYEE_ID = "system";

const optionalCode = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `${max}文字以内で入力してください`)
    .optional()
    .transform((v) => (v === "" ? undefined : v));

const searchInput = pageInput
  .extend({
    dateFrom: optionalBusinessDate,
    dateTo: optionalBusinessDate,
    employeeId: optionalCode(64),
    entityType: optionalCode(64),
    /** 対象の ID、または画面や帳票に出す番号・商品コード */
    target: optionalCode(100),
    action: optionalCode(64),
  })
  .superRefine((v, ctx) => {
    if (v.dateFrom && v.dateTo && v.dateFrom > v.dateTo) {
      ctx.addIssue({
        code: "custom",
        path: ["dateTo"],
        message: "終わりの日付は始まりの日付以降にしてください",
      });
    }
  });

export interface AuditLogEntry extends Omit<AuditLogRecord, "beforeJson" | "afterJson"> {
  /** 項目ごとの変更（表示用） */
  readonly changes: AuditChanges;
}

export const searchAuditLogs = defineQuery({
  permission: "platform.admin",
  input: searchInput,
  run(ctx, input): Page<AuditLogEntry> {
    const filter: AuditLogFilter = {
      from: input.dateFrom ? startOfBusinessDay(input.dateFrom) : undefined,
      until: input.dateTo ? startOfBusinessDay(addDays(input.dateTo, 1)) : undefined,
      employeeId: input.employeeId,
      entityType: input.entityType,
      entityIds: input.target
        ? [...new Set([input.target, ...ctx.stores.auditLogs.idsForNumber(input.target)])]
        : undefined,
      action: input.action,
    };
    const page = ctx.stores.auditLogs.search(filter, input.page, input.pageSize);
    return {
      ...page,
      rows: page.rows.map((r): AuditLogEntry => ({
        id: r.id,
        occurredAt: r.occurredAt,
        employeeId: r.employeeId,
        employeeName: r.employeeName ?? (r.employeeId === SYSTEM_EMPLOYEE_ID ? "システム" : null),
        command: r.command,
        entityType: r.entityType,
        entityId: r.entityId,
        action: r.action,
        changes: auditChanges(parseAuditJson(r.beforeJson), parseAuditJson(r.afterJson)),
      })),
    };
  },
});
