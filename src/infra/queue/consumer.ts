/**
 * Queues の処理。業務 DB の jobs（outbox）に登録された非同期処理を実行する。
 * 処理の種類ごとのハンドラーは handlers に登録する。
 */
import type { JobRecord } from "../do/business-db";
import { businessDb } from "../do/client";
import { errorFields, log } from "../observability/log";

export interface JobOutcome {
  readonly resultKey?: string | null;
  readonly resultName?: string | null;
}

export type JobHandler = (
  job: JobRecord,
  env: Env,
  progress: (n: number) => Promise<void>,
) => Promise<JobOutcome>;

/** 処理の種類 → ハンドラー。機能を追加するときはここに登録する */
export const handlers: Partial<Record<string, JobHandler>> = {};

export async function handleJobBatch(
  batch: MessageBatch<{ jobId: string }>,
  env: Env,
): Promise<void> {
  const db = businessDb(env);
  for (const message of batch.messages) {
    const { jobId } = message.body;
    const job = await db.jobStart(jobId);
    if (!job) {
      message.ack();
      continue;
    }
    const handler = handlers[job.type];
    if (!handler) {
      await db.jobFail(jobId, `不明な処理の種類です: ${job.type}`);
      message.ack();
      continue;
    }
    try {
      const outcome = await handler(job, env, async (n) => {
        await db.jobProgress(jobId, n);
      });
      await db.jobSucceed(jobId, outcome.resultKey ?? null, outcome.resultName ?? null);
      message.ack();
    } catch (e) {
      log("error", "job failed", { jobId, type: job.type, ...errorFields(e) });
      const last = message.attempts >= 3;
      if (last) {
        await db.jobFail(jobId, e instanceof Error ? e.message : String(e));
        message.ack();
      } else {
        message.retry({ delaySeconds: 30 });
      }
    }
  }
}
