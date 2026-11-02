/**
 * 帳票・非同期処理の結合テストの補助。
 * - issueDocument：帳票の発行（ctx.documents.issue と同じ実装を、業務 DB のトランザクションの中で呼ぶ）。
 *   帳票を発行するユースケース（発注・発送・請求）は他の区分が追加するため、ここでは直接呼ぶ
 * - runJobs：Queues の処理を動かす（テストでは自動で配らない。vitest.config.ts）
 * - testTemplate：テスト用の帳票のテンプレート（スナップショットのスキーマで検証する）
 */
import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  runInDurableObject,
  type QueueResult,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { monotonicFactory } from "ulid";
import { z } from "zod";

import type { DocumentType } from "../../src/domain/documents";
import type { Result } from "../../src/domain/result";
import * as schema from "../../src/infra/db/schema";
import { inList } from "../../src/infra/db/sql-helpers";
import { businessDb } from "../../src/infra/do/client";
import { documentPort, jobPort } from "../../src/infra/do/document-port";
import type { IssueDocumentInput } from "../../src/usecases/core";
import type { CommandInput, CommandName } from "../../src/usecases/registry";
import { DocumentTitle } from "../../src/web/views/documents/parts";
import { defineTemplate, documentTemplates } from "../../src/web/views/documents/registry";
import worker from "../../src/worker";
import { systemCommand } from "./helpers";

const ulid = monotonicFactory();
let counter = 0;

/** 業務 DB の SQLite を直接読む（テストの確認用） */
export function readDb<T>(fn: (db: DrizzleSqliteDODatabase<typeof schema>) => T): Promise<T> {
  return runInDurableObject(businessDb(env), (_instance, state) =>
    fn(drizzle(state.storage, { schema })),
  );
}

/** テスト用の帳票の内容（発行するユースケースの側で定義するスナップショットのスキーマの例） */
export const testSnapshot = z.object({
  title: z.string(),
  partnerName: z.string(),
  lines: z.array(z.object({ name: z.string(), amount: z.number().int() })),
  total: z.number().int(),
});

export const testTemplate = defineTemplate({
  schema: testSnapshot,
  render: (data, meta) => (
    <>
      <DocumentTitle title={data.title} />
      <p>
        {data.partnerName} 御中 / {meta.number}
      </p>
      <table class="doc-table">
        <tbody>
          {data.lines.map((l) => (
            <tr>
              <td>{l.name}</td>
              <td class="num">{l.amount}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p class="doc-total">合計 {data.total}</p>
    </>
  ),
});

/** テストの間だけテンプレートを登録する。戻り値を呼ぶと元に戻す */
export function useTestTemplates(types: readonly DocumentType[]): () => void {
  for (const t of types) documentTemplates[t] = testTemplate;
  return () => {
    for (const t of types) delete documentTemplates[t];
  };
}

export async function createTestPartner(
  fields: { name?: string; email?: string | null; defaultSendMethod?: "email" | "none" } = {},
): Promise<string> {
  counter += 1;
  const created = await systemCommand("partners.create", {
    name: fields.name ?? `帳票テスト商店${counter}`,
    kana: `チョウヒョウテスト${counter}`,
    isSupplier: true,
    isCustomer: true,
    email: fields.email === undefined ? "order@example.com" : fields.email,
    defaultSendMethod: fields.defaultSendMethod ?? "email",
  });
  return created.id;
}

export interface IssuedDocument {
  readonly documentId: string;
  readonly number: string;
  /** 発行と同時に登録された PDF 化の処理 */
  readonly jobIds: readonly string[];
}

/** 帳票を発行する（ctx.documents.issue と同じ。PDF 化の処理が登録される） */
export async function issueDocument(
  input: Partial<IssueDocumentInput> & { readonly partnerId: string },
): Promise<IssuedDocument> {
  counter += 1;
  const number = input.number ?? `PO-2026-${String(counter).padStart(6, "0")}`;
  const full: IssueDocumentInput = {
    documentType: "purchase_order",
    entityId: `entity-${counter}`,
    transactionDate: "2026-11-02",
    amount: 10800,
    snapshot: {
      title: "テスト帳票",
      partnerName: "帳票テスト商店",
      lines: [{ name: "りんごゼリー", amount: 10800 }],
      total: 10800,
    },
    ...input,
    number,
  };
  return runInDurableObject(businessDb(env), (_instance, state) => {
    const db = drizzle(state.storage, { schema });
    const meta = { at: new Date().toISOString(), by: "system" };
    const created: string[] = [];
    const documentId = db.transaction((tx) => {
      const jobs = jobPort(tx, meta, () => ulid(), created);
      return documentPort(tx, meta, () => ulid(), jobs).issue(full);
    });
    return { documentId, number, jobIds: created };
  });
}

/** システムの操作者でユースケースを呼び、結果（成功か業務エラーか）をそのまま返す */
export async function systemCommandResult<N extends CommandName>(
  name: N,
  input: CommandInput<N>,
): Promise<Result<unknown>> {
  return businessDb(env).command(name, input, { kind: "system" }, null);
}

/** 指定した処理（job）を Queues から届いたものとして処理する */
export async function runJobs(
  jobIds: readonly string[],
  options: { env?: Env; attempts?: number } = {},
): Promise<QueueResult> {
  const batch = createMessageBatch(
    "distribution-jobs-dev",
    jobIds.map((jobId, i) => ({
      id: `msg-${i}-${jobId}`,
      timestamp: new Date(),
      attempts: options.attempts ?? 1,
      body: { jobId },
    })),
  );
  const ctx = createExecutionContext();
  await worker.queue(batch, options.env ?? env);
  return getQueueResult(batch, ctx);
}

/** まだ終わっていない処理（種類を指定すればその種類だけ） */
export async function pendingJobIds(type?: string): Promise<string[]> {
  const rows = await readDb((db) =>
    db
      .select({ id: schema.jobs.id, type: schema.jobs.type })
      .from(schema.jobs)
      .where(inList(schema.jobs.status, ["pending", "queued", "running"]))
      .all(),
  );
  return rows.filter((r) => type === undefined || r.type === type).map((r) => r.id);
}

/** 終わっていない処理をすべて動かす */
export async function runPendingJobs(options: { env?: Env } = {}): Promise<QueueResult> {
  return runJobs(await pendingJobIds(), options);
}

export async function jobRow(id: string) {
  return readDb((db) => db.query.jobs.findFirst({ where: (j, { eq }) => eq(j.id, id) }));
}

export async function documentRow(id: string) {
  return readDb((db) => db.query.documents.findFirst({ where: (d, { eq }) => eq(d.id, id) }));
}

export async function sendRows(documentId: string) {
  return readDb((db) =>
    db.query.documentSends.findMany({
      where: (s, { eq }) => eq(s.documentId, documentId),
      orderBy: (s, { asc }) => [asc(s.id)],
    }),
  );
}

/** Email Service の代わり（送信を記録する。fail を渡すとそのエラーで失敗する） */
export function fakeEmail(fail?: { code: string; message?: string }) {
  const sent: { to: unknown; subject: unknown; attachments: unknown }[] = [];
  const binding = {
    send(message: { to: unknown; subject: unknown; attachments?: unknown }) {
      if (fail) {
        const e = Object.assign(new Error(fail.message ?? fail.code), { code: fail.code });
        return Promise.reject(e);
      }
      sent.push({ to: message.to, subject: message.subject, attachments: message.attachments });
      return Promise.resolve({ messageId: `msg-${sent.length}` });
    },
  };
  return { binding: binding as unknown as SendEmail, sent };
}
