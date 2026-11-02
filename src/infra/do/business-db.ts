/**
 * 業務 DB の Durable Object。ユースケースはすべてここで、1つのトランザクションとして実行する。
 * 1つのオブジェクト（名前 "main"）に業務データをまとめるので、処理は順番に実行され、
 * 在庫の引当や採番が競合しない（要件定義書 8章）。
 */
import { DurableObject } from "cloudflare:workers";
import { and, asc, eq, getTableName, is, lt, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { monotonicFactory } from "ulid";
import type { z } from "zod";

import { toBusinessDate, yearOf } from "../../domain/dates";
import type { DocumentType, RenderStatus, SendMethod, SendStatus } from "../../domain/documents";
import { formatDocumentNumber, sequenceKey } from "../../domain/numbering";
import { err, type DomainError, type Result } from "../../domain/result";
import { can, ROLES } from "../../domain/roles";
import type {
  Actor,
  CommandDef,
  JobType,
  QueryContext,
  QueryDef,
  UsecaseContext,
} from "../../usecases/core";
import { commands, queries } from "../../usecases/registry";
import { auditInsert, type Db } from "../db/client";
import { businessMigrations } from "../db/migrations/business.generated";
import * as schema from "../db/schema";
import { inList } from "../db/sql-helpers";
import { createStores } from "../db/stores";
import { bootstrapSettings } from "../db/stores/masters/settings";
import { errorFields, log } from "../observability/log";
import { runSeed } from "../seed";
import { seedRequestSchema, type SeedResult } from "../seed/request";
import type { SeedHost } from "../seed/session";
import { isDevAuthAllowed, type ActorRef } from "./actor-ref";
import { documentPort, jobPort } from "./document-port";

const commandMap = new Map<string, CommandDef<z.ZodType, unknown>>(Object.entries(commands));
const queryMap = new Map<string, QueryDef<z.ZodType, unknown>>(Object.entries(queries));
/** ユースケースの定義 → 名前（テストデータの投入で、操作履歴に名前を残すため） */
const commandNames = new Map<CommandDef<z.ZodType, unknown>, string>(
  Object.entries(commands).map(([name, def]) => [def, name]),
);
const queryNames = new Map<QueryDef<z.ZodType, unknown>, string>(
  Object.entries(queries).map(([name, def]) => [def, name]),
);

export const SEED_FORBIDDEN_MESSAGE = "テストデータの投入は開発環境とテストでだけ使えます";

const SYSTEM_ACTOR: Actor = {
  employeeId: "system",
  name: "システム",
  email: "system",
  roles: [...ROLES],
};

/** 業務エラーでトランザクションを取り消すための目印 */
class Rollback extends Error {
  constructor(readonly error: DomainError) {
    super("rollback");
  }
}

/**
 * ユースケースを実行するときの時刻・ID・帳票の扱い。通常の操作は今の時刻で実行する。
 * 開発用のテストデータ（infra/seed）は、過去の業務日の時刻で同じユースケースを実行する。
 */
export interface RunOptions {
  readonly now: Date;
  readonly nextId: () => string;
  /** false なら帳票の索引だけを登録し、PDF 化を予約しない */
  readonly renderDocuments: boolean;
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

/** 帳票の PDF 化に必要なもの */
export interface DocumentForRender {
  readonly id: string;
  readonly documentType: DocumentType;
  readonly number: string;
  readonly transactionDate: string;
  /** 発行時点の帳票の内容（JSON）。テンプレートのスキーマで検証してから使う */
  readonly snapshotJson: string;
  readonly status: RenderStatus;
  readonly r2Key: string | null;
}

/** メールでの送付に必要なもの */
export interface SendDelivery {
  readonly sendId: string;
  readonly status: SendStatus;
  readonly method: SendMethod;
  readonly recipient: string | null;
  readonly document: {
    readonly id: string;
    readonly documentType: DocumentType;
    readonly number: string;
    readonly status: RenderStatus;
    readonly r2Key: string | null;
    readonly cancelled: boolean;
  };
  readonly partner: { readonly name: string; readonly honorific: string } | null;
  readonly company: {
    readonly name: string;
    readonly email: string | null;
    readonly phone: string | null;
  };
}

export interface BackupRows {
  readonly rows: Record<string, SqlStorageValue>[];
  /** 続きを読むときの rowid。最後まで読んだら null */
  readonly lastRowid: number | null;
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
    } else if (ref.kind === "employee") {
      employee = stores.employees.get(ref.employeeId);
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

  private realtime(): RunOptions {
    return { now: new Date(), nextId: () => this.ulid(), renderDocuments: true };
  }

  private context(
    db: Db,
    actor: Actor,
    command: string,
    createdJobs: string[],
    options: RunOptions,
  ): UsecaseContext {
    const now = options.now;
    const at = now.toISOString();
    const meta = { at, by: actor.employeeId };
    const nextId = options.nextId;
    const jobs = jobPort(db, meta, nextId, createdJobs);
    return {
      actor,
      command,
      clock: { now: () => now, today: () => toBusinessDate(now) },
      ids: { next: nextId },
      stores: createStores(db),
      audit: {
        record: (entry) => {
          db.insert(schema.auditLogs)
            .values({
              id: nextId(),
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
      jobs,
      documents: documentPort(db, meta, nextId, jobs, options.renderDocuments),
    };
  }

  /**
   * 検証済みの入力でユースケースを1つのトランザクションとして実行する。業務エラーなら書き込みをすべて取り消す。
   * 受付番号（冪等キー）があれば、結果と一緒に同じトランザクションで保存する。
   */
  private transact<S extends z.ZodType, O>(
    def: CommandDef<S, O>,
    name: string,
    input: z.output<S>,
    actor: Actor,
    idempotencyKey: string | null,
    options: RunOptions,
    createdJobs: string[],
  ): Result<O> {
    try {
      return this.db.transaction((tx) => {
        const r = def.run(this.context(tx, actor, name, createdJobs, options), input);
        if (!r.ok) throw new Rollback(r.error);
        if (idempotencyKey) {
          tx.insert(schema.idempotencyKeys)
            .values({
              key: idempotencyKey,
              command: name,
              employeeId: actor.employeeId,
              resultJson: JSON.stringify(r),
              createdAt: options.now.toISOString(),
            })
            .run();
        }
        return r;
      });
    } catch (e) {
      if (e instanceof Rollback) return { ok: false, error: e.error };
      log("error", "command failed", { command: name, ...errorFields(e) });
      throw e;
    }
  }

  private queryContext(actor: Actor, name: string, options: RunOptions): QueryContext {
    const now = options.now;
    return {
      actor,
      command: name,
      clock: { now: () => now, today: () => toBusinessDate(now) },
      ids: { next: options.nextId },
      stores: createStores(this.db),
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
    const result = this.transact(
      def,
      name,
      parsed.data,
      actor,
      idempotencyKey,
      this.realtime(),
      createdJobs,
    );
    if (result.ok && createdJobs.length > 0) await this.dispatchJobs(createdJobs);
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
    const value = def.run(this.queryContext(actor, name, this.realtime()), parsed.data);
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

  /** 進み具合。件数（total）が処理の途中で分かった場合は一緒に記録する */
  jobProgress(id: string, progress: number, total?: number): void {
    this.db
      .update(schema.jobs)
      .set({
        progress,
        ...(total === undefined ? {} : { total }),
        updatedAt: new Date().toISOString(),
      })
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

  /** 失敗を記録する。message は画面に出すので、利用者向けの日本語にする（生の例外メッセージは入れない） */
  jobFail(id: string, message: string): void {
    const at = new Date().toISOString();
    this.db
      .update(schema.jobs)
      .set({ status: "failed", error: message, finishedAt: at, updatedAt: at })
      .where(eq(schema.jobs.id, id))
      .run();
  }

  /** Cron などシステムが自分で実行する処理を、処理状況に記録し始める（実行中として登録し、ID を返す） */
  systemJobStart(type: JobType, payload: Record<string, unknown>): string {
    const id = this.ulid();
    const at = new Date().toISOString();
    this.db
      .insert(schema.jobs)
      .values({
        id,
        type,
        payloadJson: JSON.stringify(payload),
        status: "running",
        attempts: 1,
        startedAt: at,
        ...auditInsert({ at, by: SYSTEM_ACTOR.employeeId }),
      })
      .run();
    return id;
  }

  // ---- 帳票の PDF 化と送付（infra/queue から呼ぶ） ----------------------------------

  documentForRender(id: string): DocumentForRender | null {
    const r = this.db
      .select({
        id: schema.documents.id,
        documentType: schema.documents.documentType,
        number: schema.documents.number,
        transactionDate: schema.documents.transactionDate,
        snapshotJson: schema.documents.snapshotJson,
        status: schema.documents.status,
        r2Key: schema.documents.r2Key,
      })
      .from(schema.documents)
      .where(eq(schema.documents.id, id))
      .get();
    return r ?? null;
  }

  /** PDF（開発では HTML）を R2 に保存できたので、作成済みにする */
  documentRendered(id: string, r2Key: string): void {
    const at = new Date().toISOString();
    this.db
      .update(schema.documents)
      .set({
        status: "ready",
        r2Key,
        updatedAt: at,
        updatedBy: SYSTEM_ACTOR.employeeId,
        version: sql`${schema.documents.version} + 1`,
      })
      .where(and(eq(schema.documents.id, id), ne(schema.documents.status, "ready")))
      .run();
  }

  /** PDF を作れなかった（理由は処理の記録 jobs.error に残る） */
  documentRenderFailed(id: string): void {
    const at = new Date().toISOString();
    this.db
      .update(schema.documents)
      .set({
        status: "failed",
        updatedAt: at,
        updatedBy: SYSTEM_ACTOR.employeeId,
        version: sql`${schema.documents.version} + 1`,
      })
      .where(and(eq(schema.documents.id, id), eq(schema.documents.status, "pending")))
      .run();
  }

  /** メールで送るのに必要なもの（送付履歴、帳票、宛名、送り主の自社情報） */
  sendForDelivery(sendId: string): SendDelivery | null {
    const send = this.db
      .select()
      .from(schema.documentSends)
      .where(eq(schema.documentSends.id, sendId))
      .get();
    if (!send) return null;
    const doc = this.db
      .select({
        id: schema.documents.id,
        documentType: schema.documents.documentType,
        number: schema.documents.number,
        status: schema.documents.status,
        r2Key: schema.documents.r2Key,
        cancelled: schema.documents.cancelled,
        partnerId: schema.documents.partnerId,
      })
      .from(schema.documents)
      .where(eq(schema.documents.id, send.documentId))
      .get();
    if (!doc) return null;
    const partner = this.db
      .select({ name: schema.partners.name, honorific: schema.partners.honorific })
      .from(schema.partners)
      .where(eq(schema.partners.id, doc.partnerId))
      .get();
    const company = createStores(this.db).settings.getCompany();
    return {
      sendId: send.id,
      status: send.status,
      method: send.method,
      recipient: send.recipient,
      document: {
        id: doc.id,
        documentType: doc.documentType,
        number: doc.number,
        status: doc.status,
        r2Key: doc.r2Key,
        cancelled: doc.cancelled,
      },
      partner: partner ?? null,
      company: { name: company.name, email: company.email, phone: company.phone },
    };
  }

  documentSendSucceeded(sendId: string): void {
    const at = new Date().toISOString();
    this.db
      .update(schema.documentSends)
      .set({
        status: "sent",
        sentAt: at,
        error: null,
        updatedAt: at,
        updatedBy: SYSTEM_ACTOR.employeeId,
        version: sql`${schema.documentSends.version} + 1`,
      })
      .where(and(eq(schema.documentSends.id, sendId), eq(schema.documentSends.status, "pending")))
      .run();
  }

  /** 送付の失敗を記録する。message は送付履歴とダッシュボードに出す */
  documentSendFailed(sendId: string, message: string): void {
    const at = new Date().toISOString();
    this.db
      .update(schema.documentSends)
      .set({
        status: "failed",
        error: message,
        updatedAt: at,
        updatedBy: SYSTEM_ACTOR.employeeId,
        version: sql`${schema.documentSends.version} + 1`,
      })
      .where(and(eq(schema.documentSends.id, sendId), eq(schema.documentSends.status, "pending")))
      .run();
  }

  // ---- 開発用のテストデータの投入（infra/seed。本番・検証環境では使えない） -----------------------

  /**
   * テストデータの投入の手順を1回分実行する（scripts/seed.mjs → /dev/seed から呼ぶ）。
   * 開発用ログインと同じく、ENVIRONMENT が development / test のときだけ受け付ける。
   */
  async seed(request: unknown): Promise<Result<SeedResult>> {
    if (!isDevAuthAllowed(this.env.ENVIRONMENT)) return err("forbidden", SEED_FORBIDDEN_MESSAGE);
    const parsed = seedRequestSchema.safeParse(request);
    if (!parsed.success)
      return err("validation", "依頼の内容が正しくありません", { fields: zodFields(parsed.error) });
    if (parsed.data.action === "reset") {
      // 業務データ（SQLite のテーブルを含む）をすべて消し、マイグレーションと初期データからやり直す
      await this.ctx.storage.deleteAll();
      await migrate(this.db, businessMigrations);
      this.bootstrap();
      return { ok: true, value: { action: "reset" } };
    }
    const task = parsed.data;
    // 手順の1回分は1つの同期の処理なので、書き込みと「済み」の印は一緒に確定する。
    // wrangler dev の再起動などで応答が届かなくても、やり直しで二重に投入しない
    const doneKey =
      task.action === "run" ? `seed:done:${task.scale}:${task.step}:${task.chunk}` : null;
    const previous = doneKey ? this.ctx.storage.kv.get<SeedResult>(doneKey) : undefined;
    if (previous) return { ok: true, value: previous };
    const createdJobs: string[] = [];
    const result = runSeed(this.seedHost(createdJobs), task, toBusinessDate(new Date()));
    if (result.ok && doneKey) this.ctx.storage.kv.put(doneKey, result.value);
    if (createdJobs.length > 0) await this.dispatchJobs(createdJobs);
    return result;
  }

  /** テストデータの投入で、過去の時刻でユースケースを実行する入口 */
  private seedHost(createdJobs: string[]): SeedHost {
    const ulid = monotonicFactory();
    const actors = new Map<string, Actor | null>();
    const actorFor = (email: string): Actor | null => {
      if (email === "system") return SYSTEM_ACTOR;
      const cached = actors.get(email);
      if (cached !== undefined) return cached;
      const target = email === "admin" ? (this.env.INITIAL_ADMIN_EMAIL ?? "") : email;
      const e = createStores(this.db).employees.findByEmail(target.toLowerCase());
      const actor: Actor | null =
        e && e.active
          ? { employeeId: e.id, name: e.name, email: e.email, roles: e.roles }
          : email === "admin"
            ? SYSTEM_ACTOR
            : null;
      actors.set(email, actor);
      return actor;
    };
    const options = (at: Date, renderDocuments: boolean): RunOptions => ({
      now: at,
      // 過去の時刻の ULID（ID の順が登録の順になる）
      nextId: () => ulid(at.getTime()),
      renderDocuments,
    });
    return {
      db: this.db,
      command: (def, input, actorEmail, at, renderDocuments, key) => {
        const actor = actorFor(actorEmail);
        if (!actor) return err("unauthenticated", `有効な社員 ${actorEmail} が登録されていません`);
        if (!can(actor.roles, def.permission))
          return err("forbidden", "この操作を行う権限がありません");
        const parsed = def.input.safeParse(input);
        if (!parsed.success)
          return err("validation", "入力内容を確認してください", {
            fields: zodFields(parsed.error),
          });
        const name = commandNames.get(def) ?? "seed";
        // 受付番号が処理済みなら実行しない（投入をやり直しても二重に作らない）。1回分の投入は1つの
        // トランザクションで、終わった回は seed:done で飛ばすので、ふつうはここに来ない
        const done = this.db
          .select({ command: schema.idempotencyKeys.command })
          .from(schema.idempotencyKeys)
          .where(eq(schema.idempotencyKeys.key, key))
          .get();
        if (done) return err("duplicate", `受付番号 ${key}（${done.command}）は処理済みです`);
        const jobs: string[] = [];
        const r = this.transact(
          def,
          name,
          parsed.data,
          actor,
          key,
          options(at, renderDocuments),
          jobs,
        );
        if (r.ok) createdJobs.push(...jobs);
        return r;
      },
      query: (def, input, at) => {
        const parsed = def.input.safeParse(input);
        if (!parsed.success) return err("validation", "条件を確認してください");
        const name = queryNames.get(def) ?? "seed";
        const ctx = this.queryContext(SYSTEM_ACTOR, name, options(at, false));
        return { ok: true, value: def.run(ctx, parsed.data) };
      },
    };
  }

  // ---- 定期処理（バックアップ、受付番号の掃除、止まった処理、エラーの通知） ------------------

  /**
   * 時間内に終わらなかった処理（Worker が途中で止まり、結果を記録できなかったもの）を失敗にする。
   * その処理で送っていた帳票の送付も失敗にする（画面から再送できる）。失敗にした件数を返す。
   * 進み具合を記録している処理は updated_at が新しくなるので対象にならない。
   */
  failStaleJobs(before: string, message: string): number {
    const at = new Date().toISOString();
    return this.db.transaction((tx) => {
      const stale = tx
        .select({ id: schema.jobs.id })
        .from(schema.jobs)
        .where(
          and(inList(schema.jobs.status, ["queued", "running"]), lt(schema.jobs.updatedAt, before)),
        )
        .all()
        .map((j) => j.id);
      if (stale.length === 0) return 0;
      tx.update(schema.jobs)
        .set({ status: "failed", error: message, finishedAt: at, updatedAt: at })
        .where(inList(schema.jobs.id, stale))
        .run();
      tx.update(schema.documentSends)
        .set({
          status: "failed",
          error: message,
          updatedAt: at,
          updatedBy: SYSTEM_ACTOR.employeeId,
          version: sql`${schema.documentSends.version} + 1`,
        })
        .where(
          and(
            inList(schema.documentSends.jobId, stale),
            eq(schema.documentSends.status, "pending"),
          ),
        )
        .run();
      return stale.length;
    });
  }

  /** 古い受付番号（冪等キー）を消す。消した件数を返す */
  purgeIdempotencyKeys(before: string): number {
    return this.db
      .delete(schema.idempotencyKeys)
      .where(lt(schema.idempotencyKeys.createdAt, before))
      .returning({ key: schema.idempotencyKeys.key })
      .all().length;
  }

  /** バックアップの対象のテーブル名 */
  backupTables(): string[] {
    return backupTableNames();
  }

  /**
   * バックアップ用に、テーブルの行を rowid の順に少しずつ読む（RPC の大きさの上限を超えないように分ける）。
   * 列名は DB の列名（snake_case）のまま返す。
   */
  backupRows(table: string, afterRowid: number, limit: number): BackupRows {
    if (!backupTableNames().includes(table)) throw new Error(`unknown table: ${table}`);
    const size = Math.max(1, Math.min(limit, 5000));
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT rowid AS "__rowid", * FROM "${table}" WHERE rowid > ? ORDER BY rowid LIMIT ?`,
        afterRowid,
        size,
      )
      .toArray();
    let last: number | null = null;
    const out = rows.map((row) => {
      const { __rowid, ...rest } = row;
      if (typeof __rowid === "number") last = __rowid;
      return rest;
    });
    return { rows: out, lastRowid: rows.length < size ? null : last };
  }

  /**
   * 重大なエラーを管理者にメールで知らせてよいか。同じエラー（fingerprint）は windowMs に1回まで。
   * 知らせてよければ、送り先（有効な管理者のメールアドレス）を返す。知らせないなら空の配列。
   */
  claimErrorNotification(fingerprint: string, windowMs: number): string[] {
    const key = `error-notification:${fingerprint}`;
    const now = Date.now();
    const last = this.ctx.storage.kv.get<number>(key);
    if (typeof last === "number" && now - last < windowMs) return [];
    this.ctx.storage.kv.put(key, now);
    return createStores(this.db)
      .employees.list()
      .filter((e) => e.active && e.roles.includes("admin"))
      .map((e) => e.email);
  }
}

/** バックアップの対象（Drizzle のスキーマにあるテーブル。マイグレーションの記録は含めない） */
function backupTableNames(): string[] {
  return Object.values(schema).flatMap((t) => (is(t, SQLiteTable) ? [getTableName(t)] : []));
}
