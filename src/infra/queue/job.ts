/** 非同期処理の定義の型。処理の種類ごとの実装は infra/queue/jobs/ にあり、consumer.ts の一覧に登録する。 */
import type { z } from "zod";

import type { BusinessDb, JobRecord } from "../do/business-db";
import { InfraError } from "../errors";

export interface JobOutcome {
  /** 結果のファイル（R2 の保存先と、ダウンロードするときの名前） */
  readonly resultKey?: string | null;
  readonly resultName?: string | null;
}

export interface JobContext<P> {
  readonly job: JobRecord;
  /** スキーマで検証済みの内容 */
  readonly payload: P;
  readonly env: Env;
  readonly db: DurableObjectStub<BusinessDb>;
  /** 進み具合を記録する（total は件数が途中で分かったときに渡す） */
  readonly progress: (done: number, total?: number) => Promise<void>;
}

export interface JobDefinition<S extends z.ZodType> {
  /** job の内容（payload）のスキーマ。合わなければ再試行せずに失敗にする */
  readonly payload: S;
  run(ctx: JobContext<z.output<S>>): Promise<JobOutcome>;
  /** 失敗が確定したとき（再試行を使い切った、または再試行しない失敗）。送付履歴を失敗にするなど */
  onFailed?(ctx: JobContext<z.output<S>>, message: string): Promise<void>;
}

/** 種類によらない形にした処理（consumer.ts の一覧に並べるため） */
export interface RegisteredJob {
  run(base: Omit<JobContext<unknown>, "payload">): Promise<JobOutcome>;
  fail(base: Omit<JobContext<unknown>, "payload">, message: string): Promise<void>;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parsePayload<S extends z.ZodType>(schema: S, job: JobRecord): z.output<S> {
  const parsed = schema.safeParse(safeJson(job.payloadJson));
  if (!parsed.success) {
    throw new InfraError("処理の内容が正しくありません（管理者に連絡してください）", true, {
      issues: parsed.error.issues.map((i) => i.message),
    });
  }
  return parsed.data;
}

export function defineJob<S extends z.ZodType>(def: JobDefinition<S>): RegisteredJob {
  return {
    run(base) {
      return def.run({ ...base, payload: parsePayload(def.payload, base.job) });
    },
    async fail(base, message) {
      if (!def.onFailed) return;
      const parsed = def.payload.safeParse(safeJson(base.job.payloadJson));
      if (parsed.success) await def.onFailed({ ...base, payload: parsed.data }, message);
    },
  };
}
