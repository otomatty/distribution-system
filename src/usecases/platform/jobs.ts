/**
 * 処理状況（一括 PDF・大きな CSV・バックアップ）と、その登録（要件定義書 3.9・3.13、5章 処理状況）。
 * 処理そのものは infra/queue で行う。
 */
import { z } from "zod";

import { DOCUMENT_TYPES } from "../../domain/documents";
import { LISTED_JOB_TYPES } from "../../domain/jobs";
import { err, ok } from "../../domain/result";
import { can } from "../../domain/roles";
import { defineCommand, defineQuery, type Actor } from "../core";
import { idSchema } from "../schemas";
import { BULK_DOCUMENTS_MAX, exportCsvPayload, type BulkDocumentsPayload } from "./job-payloads";
import type { JobView } from "./jobs.port";

/** 本人が依頼したものだけを見せる（管理者はすべて） */
function ownerFilter(actor: Actor): string | undefined {
  return can(actor.roles, "platform.admin") ? undefined : actor.employeeId;
}

export const listJobs = defineQuery({
  permission: "view",
  input: z.object({ status: z.enum(["active", "failed"]).optional() }),
  run(ctx, { status }) {
    return ctx.stores.jobs.list(
      { createdBy: ownerFilter(ctx.actor), types: LISTED_JOB_TYPES, status },
      100,
    );
  },
});

export const getJob = defineQuery({
  permission: "view",
  input: z.object({ id: idSchema }),
  run(ctx, { id }): JobView | null {
    const job = ctx.stores.jobs.get(id);
    if (!job || !LISTED_JOB_TYPES.includes(job.type)) return null;
    const owner = ownerFilter(ctx.actor);
    if (owner !== undefined && job.createdBy !== owner) return null;
    return job;
  },
});

const ATTENTION_DAYS = 7;
/** 最後に成功したバックアップがこれより古ければ、管理者に知らせる（毎日 03:00 に動くので2日） */
const BACKUP_STALE_HOURS = 48;

/** ダッシュボード用：処理中・失敗した処理（直近7日）と、管理者には日次バックアップの状況 */
export const jobAttention = defineQuery({
  permission: "view",
  input: z.object({}),
  run(ctx) {
    const now = ctx.clock.now().getTime();
    const since = new Date(now - ATTENTION_DAYS * 86_400_000).toISOString();
    const counts = ctx.stores.jobs.counts(
      { createdBy: ownerFilter(ctx.actor), types: LISTED_JOB_TYPES },
      since,
    );
    if (!can(ctx.actor.roles, "platform.admin")) return { ...counts, backup: null };
    const latest = ctx.stores.jobs.latest("backup");
    const lastSucceeded = ctx.stores.jobs.latest("backup", "succeeded");
    const stale =
      lastSucceeded !== undefined &&
      now - new Date(lastSucceeded.createdAt).getTime() > BACKUP_STALE_HOURS * 3_600_000;
    return {
      ...counts,
      backup: {
        /** 最新のバックアップが失敗した、または成功したものが古い */
        needsAttention: latest?.status === "failed" || stale,
        lastSucceededAt: lastSucceeded?.createdAt ?? null,
      },
    };
  },
});

/**
 * 一括 PDF を登録する。帳票の ID か、元の伝票（発送など）の ID で指定する。
 * 元の伝票で指定した場合は、伝票ごとに取消されていない最新の帳票を使う。
 */
export const enqueueBulkDocuments = defineCommand({
  permission: "view",
  input: z
    .object({
      name: z.string().trim().max(100).optional(),
      documentIds: z.array(idSchema).max(BULK_DOCUMENTS_MAX).default([]),
      documentType: z.enum(DOCUMENT_TYPES).optional(),
      entityIds: z.array(idSchema).max(BULK_DOCUMENTS_MAX).default([]),
    })
    .refine((v) => v.entityIds.length === 0 || v.documentType !== undefined, {
      path: ["documentType"],
      message: "伝票で指定する場合は帳票の種類を指定してください",
    }),
  run(ctx, input) {
    const ids = [
      ...ctx.stores.documents.existingIds(input.documentIds),
      ...(input.documentType
        ? ctx.stores.documents.latestForEntities(input.documentType, input.entityIds)
        : []),
    ];
    const unique = [...new Set(ids)];
    if (unique.length === 0) return err("validation", "PDF にする帳票を選んでください");
    if (unique.length > BULK_DOCUMENTS_MAX) {
      return err("validation", `一度にまとめられるのは${BULK_DOCUMENTS_MAX}件までです`);
    }
    const payload: BulkDocumentsPayload = {
      documentIds: unique,
      name: input.name || `帳票_${ctx.clock.today()}`,
    };
    const jobId = ctx.jobs.enqueue("bulk_documents", payload, unique.length);
    ctx.audit.record({
      entityType: "job",
      entityId: jobId,
      action: "enqueue_bulk_documents",
      after: { count: unique.length, name: payload.name },
    });
    return ok({ jobId, count: unique.length });
  },
});

/** CSV を非同期で出力する（件数が多い一覧の CSV。web/csv-exports.ts の exportCsv から呼ぶ） */
export const enqueueCsvExport = defineCommand({
  permission: "view",
  input: exportCsvPayload,
  run(ctx, payload) {
    const jobId = ctx.jobs.enqueue("export_csv", payload);
    ctx.audit.record({
      entityType: "job",
      entityId: jobId,
      action: "enqueue_csv_export",
      after: { definition: payload.definition },
    });
    return ok({ jobId });
  },
});
