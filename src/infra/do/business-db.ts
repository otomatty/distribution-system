/**
 * 業務 DB の Durable Object。ユースケースはすべてここで、1つのトランザクションとして実行する。
 * 1つのオブジェクト（名前 "main"）に業務データをまとめるので、処理は順番に実行され、
 * 在庫の引当や採番が競合しない（要件定義書 8章）。
 */
import { DurableObject } from "cloudflare:workers";
import { and, asc, eq, inArray, is, lt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { monotonicFactory } from "ulid";
import type { z } from "zod";

import { toBusinessDate, yearOf } from "../../domain/dates";
import { formatDocumentNumber, sequenceKey } from "../../domain/numbering";
import { err, type Result } from "../../domain/result";
import { can, ROLES } from "../../domain/roles";
import type { Actor, CommandDef, JobType, QueryDef, UsecaseContext } from "../../usecases/core";
import { commands, queries } from "../../usecases/registry";
import { auditInsert, type Db } from "../db/client";
import { businessMigrations } from "../db/migrations/business.generated";
import * as schema from "../db/schema";
import { createStores } from "../db/stores";
import { bootstrapSettings } from "../db/stores/masters/settings";
import { errorFields, log } from "../observability/log";
import { isDevAuthAllowed, type ActorRef } from "./actor-ref";

const commandMap = new Map<string, CommandDef<z.ZodType, unknown>>(Object.entries(commands));
const queryMap = new Map<string, QueryDef<z.ZodType, unknown>>(Object.entries(queries));

const SYSTEM_ACTOR: Actor = {
  employeeId: "system",
  name: "システム",
  email: "system",
  roles: [...ROLES],
};

/** 業務エラーでトランザクションを取り消すための目印 */
class Rollback extends Error {
  constructor(readonly result: Result<unknown>) {
    super("rollback");
  }
}

/** 保存しておいた処理結果（JSON）を読み戻す */
function isStoredResult(value: unknown): value is Result<unknown> {
  return (
    typeof value === "object" && value !== null && "ok" in value && typeof value.ok === "boolean"
  );
}

export interface ActorSummary {
  readonly employeeId: string;
  readonly name: string;
  readonly email: string;
  readonly roles: readonly string[];
}

export interface JobRecord {
  readonly id: string;
  readonly type: string;
  /** JSON 文字列。処理側でスキーマ検証してから使う */
  readonly payloadJson: string;
  readonly status: string;
  readonly progress: number;
  readonly total: number;
  readonly resultKey: string | null;
  readonly resultName: string | null;
  readonly error: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
}

function zodFields(error: z.ZodError): { field: string; message: string }[] {
  return error.issues.map((i) => ({ field: i.path.map(String).join("."), message: i.message }));
}

export class BusinessDb extends DurableObject<Env> {
  private readonly db: Db;
  private readonly ulid = monotonicFactory();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { schema });
    void ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, businessMigrations);
      this.bootstrap();
    });
  }

  private bootstrap(): void {
    const at = new Date().toISOString();
    bootstrapSettings(this.db, at);
    const anyEmployee = this.db
      .select({ id: schema.employees.id })
      .from(schema.employees)
      .limit(1)
      .get();
    if (!anyEmployee && this.env.INITIAL_ADMIN_EMAIL) {
      this.db
        .insert(schema.employees)
        .values({
          id: this.ulid(),
          email: this.env.INITIAL_ADMIN_EMAIL.toLowerCase(),
          name: "管理者",
          roles: ["admin"],
          active: true,
          authUserId: null,
          ...auditInsert({ at, by: "system" }),
        })
        .run();
    }
  }

  // ---- 操作者 ----------------------------------------------------------------

  private resolveActorSync(ref: ActorRef): Actor | undefined {
    if (ref.kind === "system") return SYSTEM_ACTOR;
    const stores = createStores(this.db);
    let employee;
    if (ref.kind === "auth") {
      employee = stores.employees.findByAuthUserId(ref.userId);
    } else {
      if (!isDevAuthAllowed(this.env.ENVIRONMENT)) return undefined;
      employee = stores.employees.findByEmail(ref.email);
    }
    if (!employee || !employee.active) return undefined;
    return {
      employeeId: employee.id,
      name: employee.name,
      email: employee.email,
      roles: employee.roles,
    };
  }

  /** 画面のレイアウト（メニューの出し分け）用に、操作者の情報を返す */
  resolveActor(ref: ActorRef): ActorSummary | null {
    const actor = this.resolveActorSync(ref);
    return actor
      ? {
          employeeId: actor.employeeId,
          name: actor.name,
          email: actor.email,
          roles: [...actor.roles],
        }
      : null;
  }

  // ---- ログイン（Better Auth のフックから呼ぶ） ----------------------------------

  /** 管理者が事前登録した有効な社員だけがログインできる */
  authCanSignIn(email: string): boolean {
    const e = createStores(this.db).employees.findByEmail(email);
    return e !== undefined && e.active;
  }

  /** 初回ログインで Google アカウント（Better Auth のユーザー）と社員を紐づける */
  authLinkUser(email: string, authUserId: string): boolean {
    const stores = createStores(this.db);
    const e = stores.employees.findByEmail(email);
    if (!e || !e.active) return false;
    if (e.authUserId === authUserId) return true;
    const at = new Date().toISOString();
    return this.db.transaction((tx) => {
      const ok = createStores(tx).employees.update(
        e.id,
        e.version,
        { authUserId },
        { at, by: "system" },
      );
      tx.insert(schema.auditLogs)
        .values({
          id: this.ulid(),
          occurredAt: at,
          employeeId: e.id,
          command: "auth.link",
          entityType: "employee",
          entityId: e.id,
          action: "link_auth_user",
          beforeJson: JSON.stringify({ authUserId: e.authUserId }),
          afterJson: JSON.stringify({ authUserId }),
        })
        .run();
      return ok;
    });
  }

  authIsActive(authUserId: string): boolean {
    const e = createStores(this.db).employees.findByAuthUserId(authUserId);
    return e !== undefined && e.active;
  }

  // ---- ユースケースの実行 --------------------------------------------------------

  private context(db: Db, actor: Actor, command: string, createdJobs: string[]): UsecaseContext {
    const now = new Date();
    const at = now.toISOString();
    const meta = { at, by: actor.employeeId };
    const enqueue = (type: JobType, payload: Record<string, unknown>, total = 0): string => {
      const id = this.ulid();
      db.insert(schema.jobs)
        .values({
          id,
          type,
          payloadJson: JSON.stringify(payload),
          status: "pending",
          total,
          ...auditInsert(meta),
        })
        .run();
      createdJobs.push(id);
      return id;
    };
    return {
      actor,
      command,
      clock: { now: () => now, today: () => toBusinessDate(now) },
      ids: { next: () => this.ulid() },
      stores: createStores(db),
      audit: {
        record: (entry) => {
          db.insert(schema.auditLogs)
            .values({
              id: this.ulid(),
              occurredAt: at,
              employeeId: actor.employeeId,
              command,
              entityType: entry.entityType,
              entityId: entry.entityId,
              action: entry.action,
              beforeJson: entry.before === undefined ? null : JSON.stringify(entry.before),
              afterJson: entry.after === undefined ? null : JSON.stringify(entry.after),
            })
            .run();
        },
      },
      sequences: {
        next: (kind, businessDate) => {
          const year = yearOf(businessDate);
          const key = sequenceKey(kind, year);
          const row = db.select().from(schema.sequences).where(eq(schema.sequences.key, key)).get();
          const value = row?.nextValue ?? 1;
          if (row) {
            db.update(schema.sequences)
              .set({ nextValue: value + 1 })
              .where(eq(schema.sequences.key, key))
              .run();
          } else {
            db.insert(schema.sequences)
              .values({ key, nextValue: value + 1 })
              .run();
          }
          return formatDocumentNumber(kind, year, value);
        },
      },
      jobs: { enqueue },
      documents: {
        issue: (input) => {
          const id = this.ulid();
          db.insert(schema.documents)
            .values({
              id,
              documentType: input.documentType,
              number: input.number,
              entityId: input.entityId,
              partnerId: input.partnerId,
              transactionDate: input.transactionDate,
              amount: input.amount,
              snapshotJson: JSON.stringify(input.snapshot),
              r2Key: null,
              status: "pending",
              ...auditInsert(meta),
            })
            .run();
          enqueue("render_document", { documentId: id });
          return id;
        },
        cancel: (documentId) => {
          db.update(schema.documents)
            .set({
              cancelled: true,
              updatedAt: at,
              updatedBy: actor.employeeId,
              version: sql`${schema.documents.version} + 1`,
            })
            .where(eq(schema.documents.id, documentId))
            .run();
        },
        sendEmail: (documentId, recipient) => {
          const id = this.ulid();
          const jobId = enqueue("send_document", { sendId: id });
          db.insert(schema.documentSends)
            .values({
              id,
              documentId,
              method: "email",
              recipient,
              status: "pending",
              jobId,
              ...auditInsert(meta),
            })
            .run();
          return id;
        },
        recordManualSend: (documentId, note) => {
          const id = this.ulid();
          db.insert(schema.documentSends)
            .values({
              id,
              documentId,
              method: "manual",
              recipient: null,
              status: "sent",
              sentAt: at,
              note,
              ...auditInsert(meta),
            })
            .run();
          return id;
        },
      },
    };
  }

  /**
   * 状態を変える操作を実行する。
   * 受付番号（冪等キー）が処理済みなら、前回の結果をそのまま返す（二重送信の防止）。
   */
  async command(
    name: string,
    input: unknown,
    actorRef: ActorRef,
    idempotencyKey: string | null,
  ): Promise<Result<unknown>> {
    const def = commandMap.get(name);
    if (!def) return err("not_found", "不明な操作です");
    const actor = this.resolveActorSync(actorRef);
    if (!actor) return err("unauthenticated", "ログインし直してください");
    if (!can(actor.roles, def.permission))
      return err("forbidden", "この操作を行う権限がありません");
    const parsed = def.input.safeParse(input);
    if (!parsed.success)
      return err("validation", "入力内容を確認してください", { fields: zodFields(parsed.error) });

    if (idempotencyKey) {
      const done = this.db
        .select()
        .from(schema.idempotencyKeys)
        .where(eq(schema.idempotencyKeys.key, idempotencyKey))
        .get();
      if (done) {
        if (done.command !== name || done.employeeId !== actor.employeeId) {
          return err("conflict", "この操作はすでに受け付けられています。画面を開き直してください");
        }
        const previous: unknown = JSON.parse(done.resultJson);
        if (isStoredResult(previous)) return previous;
        return err("conflict", "前回の処理結果を読み込めませんでした。画面を開き直してください");
      }
    }

    const createdJobs: string[] = [];
    let result: Result<unknown>;
    try {
      result = this.db.transaction((tx) => {
        const r = def.run(this.context(tx, actor, name, createdJobs), parsed.data);
        if (!r.ok) throw new Rollback(r);
        if (idempotencyKey) {
          tx.insert(schema.idempotencyKeys)
            .values({
              key: idempotencyKey,
              command: name,
              employeeId: actor.employeeId,
              resultJson: JSON.stringify(r),
              createdAt: new Date().toISOString(),
            })
            .run();
        }
        return r;
      });
    } catch (e) {
      if (e instanceof Rollback) return e.result;
      log("error", "command failed", { command: name, ...errorFields(e) });
      throw e;
    }
    if (createdJobs.length > 0) await this.dispatchJobs(createdJobs);
    return result;
  }

  /** 読み取り専用の操作を実行する */
  query(name: string, input: unknown, actorRef: ActorRef): Result<unknown> {
    const def = queryMap.get(name);
    if (!def) return err("not_found", "不明な照会です");
    const actor = this.resolveActorSync(actorRef);
    if (!actor) return err("unauthenticated", "ログインし直してください");
    if (!can(actor.roles, def.permission))
      return err("forbidden", "この情報を見る権限がありません");
    const parsed = def.input.safeParse(input);
    if (!parsed.success)
      return err("validation", "条件を確認してください", { fields: zodFields(parsed.error) });
    const now = new Date();
    const value = def.run(
      {
        actor,
        command: name,
        clock: { now: () => now, today: () => toBusinessDate(now) },
        ids: { next: () => this.ulid() },
        stores: createStores(this.db),
      },
      parsed.data,
    );
    return { ok: true, value };
  }

  // ---- 非同期処理（outbox） ------------------------------------------------------

  private async dispatchJobs(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      try {
        await this.env.JOBS.send({ jobId: id });
        this.db
          .update(schema.jobs)
          .set({ status: "queued" })
          .where(and(eq(schema.jobs.id, id), eq(schema.jobs.status, "pending")))
          .run();
      } catch (e) {
        log("warn", "job dispatch failed; will retry", { jobId: id, ...errorFields(e) });
        await this.ctx.storage.setAlarm(Date.now() + 60_000);
      }
    }
  }

  /** 送れなかった非同期処理を再送する */
  override async alarm(): Promise<void> {
    const threshold = new Date(Date.now() - 30_000).toISOString();
    const pending = this.db
      .select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(and(eq(schema.jobs.status, "pending"), lt(schema.jobs.createdAt, threshold)))
      .orderBy(asc(schema.jobs.createdAt))
      .limit(100)
      .all();
    await this.dispatchJobs(pending.map((p) => p.id));
  }

  private toJobRecord(r: typeof schema.jobs.$inferSelect): JobRecord {
    return {
      id: r.id,
      type: r.type,
      payloadJson: r.payloadJson,
      status: r.status,
      progress: r.progress,
      total: r.total,
      resultKey: r.resultKey,
      resultName: r.resultName,
      error: r.error,
      createdBy: r.createdBy,
      createdAt: r.createdAt,
    };
  }

  /** Queues の処理を始める。すでに終わっていれば null */
  jobStart(id: string): JobRecord | null {
    const r = this.db.select().from(schema.jobs).where(eq(schema.jobs.id, id)).get();
    if (!r || r.status === "succeeded") return null;
    const at = new Date().toISOString();
    this.db
      .update(schema.jobs)
      .set({ status: "running", attempts: r.attempts + 1, startedAt: at, updatedAt: at })
      .where(eq(schema.jobs.id, id))
      .run();
    return this.toJobRecord({ ...r, status: "running" });
  }

  jobProgress(id: string, progress: number): void {
    this.db
      .update(schema.jobs)
      .set({ progress, updatedAt: new Date().toISOString() })
      .where(eq(schema.jobs.id, id))
      .run();
  }

  jobSucceed(id: string, resultKey: string | null, resultName: string | null): void {
    const at = new Date().toISOString();
    this.db
      .update(schema.jobs)
      .set({
        status: "succeeded",
        resultKey,
        resultName,
        finishedAt: at,
        updatedAt: at,
        error: null,
      })
      .where(eq(schema.jobs.id, id))
      .run();
  }

  jobFail(id: string, message: string): void {
    const at = new Date().toISOString();
    this.db
      .update(schema.jobs)
      .set({ status: "failed", error: message, finishedAt: at, updatedAt: at })
      .where(eq(schema.jobs.id, id))
      .run();
  }

  /** 処理状況の一覧（本人が依頼したもの。管理者はすべて） */
  listJobs(actorRef: ActorRef, ids?: readonly string[]): Result<JobRecord[]> {
    const actor = this.resolveActorSync(actorRef);
    if (!actor) return err("unauthenticated", "ログインし直してください");
    const conds = [];
    if (!actor.roles.includes("admin")) conds.push(eq(schema.jobs.createdBy, actor.employeeId));
    if (ids && ids.length > 0) conds.push(inArray(schema.jobs.id, [...ids]));
    const rows = this.db
      .select()
      .from(schema.jobs)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(asc(schema.jobs.createdAt))
      .limit(200)
      .all();
    return { ok: true, value: rows.toReversed().map((r) => this.toJobRecord(r)) };
  }

  /** バックアップ用に全テーブルを書き出す */
  exportAll(): Record<string, unknown[]> {
    const out: Record<string, unknown[]> = {};
    for (const [key, table] of Object.entries(schema)) {
      if (is(table, SQLiteTable)) out[key] = this.db.select().from(table).all();
    }
    return out;
  }
}
