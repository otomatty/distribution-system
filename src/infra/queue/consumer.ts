/**
 * Queues の処理。業務 DB の jobs（outbox）に登録された非同期処理を実行する。
 * 処理の種類ごとの実装は jobs/ にあり、下の jobDefinitions に登録する。
 *
 * 失敗したときの扱い：
 * - 再試行しない失敗（InfraError の permanent）と、再試行を使い切った失敗は「失敗」として記録する。
 *   処理状況・帳票の画面には利用者向けの文言だけを出し、詳しい内容は構造化ログに残す
 * - 想定外の例外で失敗が確定したら、管理者にメールで知らせる（同じエラーは1時間に1回まで）
 * - それ以外は時間をおいて再試行する
 */
import { z } from "zod";

import { JOB_TYPES, type JobType } from "../../domain/jobs";
import { businessDb } from "../do/client";
import { InfraError, isPermanent, userMessage } from "../errors";
import { errorFields, log } from "../observability/log";
import { reportCritical } from "../observability/notify";
import type { RegisteredJob } from "./job";
import { bulkDocumentsJob } from "./jobs/bulk-documents";
import { exportCsvJob } from "./jobs/export-csv";
import { renderDocumentJob } from "./jobs/render-document";
import { sendDocumentJob } from "./jobs/send-document";

/** 処理の種類 → 実装。機能を追加するときはここに登録する */
export const jobDefinitions: Partial<Record<JobType, RegisteredJob>> = {
  render_document: renderDocumentJob,
  send_document: sendDocumentJob,
  bulk_documents: bulkDocumentsJob,
  export_csv: exportCsvJob,
};

/** 試行の上限（wrangler.jsonc の max_retries は3なので、最初の1回と合わせて4回まで届く。余裕をみて3回で打ち切る） */
export const MAX_ATTEMPTS = 3;

/** 再試行までの待ち時間（秒）。1回目の失敗は30秒、2回目は2分 */
export function retryDelaySeconds(attempts: number): number {
  return attempts <= 1 ? 30 : 120;
}

const messageBody = z.object({ jobId: z.string().min(1).max(64) });

function isJobType(value: string): value is JobType {
  return (JOB_TYPES as readonly string[]).includes(value);
}

export async function handleJobBatch(batch: MessageBatch, env: Env): Promise<void> {
  const db = businessDb(env);
  for (const message of batch.messages) {
    const body = messageBody.safeParse(message.body);
    if (!body.success) {
      log("error", "invalid queue message", { messageId: message.id });
      message.ack();
      continue;
    }
    const { jobId } = body.data;
    const job = await db.jobStart(jobId);
    if (!job) {
      message.ack();
      continue;
    }
    const definition = isJobType(job.type) ? jobDefinitions[job.type] : undefined;
    if (!definition) {
      log("error", "unknown job type", { jobId, type: job.type });
      await db.jobFail(jobId, `不明な処理の種類です（${job.type}）`);
      message.ack();
      continue;
    }
    const base = {
      job,
      env,
      db,
      progress: async (done: number, total?: number) => {
        await db.jobProgress(jobId, done, total);
      },
    };
    try {
      const outcome = await definition.run(base);
      await db.jobSucceed(jobId, outcome.resultKey ?? null, outcome.resultName ?? null);
      message.ack();
    } catch (e) {
      const final = isPermanent(e) || message.attempts >= MAX_ATTEMPTS;
      const fields = {
        jobId,
        type: job.type,
        attempts: message.attempts,
        final,
        ...errorFields(e),
        ...(e instanceof InfraError ? { detail: e.detail } : {}),
      };
      if (!final) {
        log("warn", "job failed; will retry", fields);
        message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
        continue;
      }
      const reason = userMessage(e);
      try {
        await definition.fail(base, reason);
      } catch (hookError) {
        log("error", "job failure hook failed", { jobId, ...errorFields(hookError) });
      }
      await db.jobFail(jobId, reason);
      if (e instanceof InfraError) log("error", "job failed", fields);
      else await reportCritical(env, "job failed", e, fields);
      message.ack();
    }
  }
}
