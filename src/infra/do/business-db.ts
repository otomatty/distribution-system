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
import { z } from "zod";

import { toBusinessDate, yearOf } from "../../domain/dates";
import type { DocumentType, RenderStatus, SendMethod, SendStatus } from "../../domain/documents";
import { formatDocumentNumber, sequenceKey } from "../../domain/numbering";
import { confirmsRestore, restoreConfirmationText } from "../../domain/restore";
import { err, type Result } from "../../domain/result";
import { can, ROLES } from "../../domain/roles";
import type { Actor, CommandDef, JobType, QueryDef, UsecaseContext } from "../../usecases/core";
import { previewRestore } from "../../usecases/platform/restore";
import { commands, queries } from "../../usecases/registry";
import { requiredText } from "../../usecases/schemas";
import { auditInsert, type Db } from "../db/client";
import { businessMigrations } from "../db/migrations/business.generated";
import * as schema from "../db/schema";
import { inList } from "../db/sql-helpers";
import { createStores } from "../db/stores";
import { bootstrapSettings } from "../db/stores/masters/settings";
import { errorFields, log } from "../observability/log";
import {
  isDevAuthAllowed,
  isInternalActorRef,
  type ActorRef,
  type InternalActorRef,
} from "./actor-ref";
import { documentPort, jobPort } from "./document-port";
import {
  completeRestore,
  durableObjectRecovery,
  getRestore,
  isRestoreId,
  listRestores,
  scheduleRestore,
  type PointInTimeRecovery,
  type RestoreDeps,
  type RestoreProgress,
  type RestoreRecord,
} from "./restore";

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

/** 特定の時点への復元の入力（戻す日時は照会 restore.preview で確かめる） */
const restoreInput = z.object({
  targetAt: z.string().max(40),
  confirmation: z.string().max(40),
  reason: requiredText(500),
});

/** 受付番号（冪等キー）がないか、形が正しくない操作の文言 */
const MISSING_KEY_MESSAGE =
  "受付番号がないため、操作を受け付けませんでした。画面を開き直してから、もう一度操作してください";

/** 受付番号（画面のフォームが crypto.randomUUID() で作る）。空や長すぎるものは受け付けない */
function isIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= 128;
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
  private readonly recovery: PointInTimeRecovery;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { schema });
    this.recovery = durableObjectRecovery(ctx);
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

  private context(db: Db, actor: Actor, command: string, createdJobs: string[]): UsecaseContext {
    const now = new Date();
    const at = now.toISOString();
    const meta = { at, by: actor.employeeId };
    const nextId = () => this.ulid();
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
      jobs,
      documents: documentPort(db, meta, nextId, jobs),
    };
  }

  /**
   * 状態を変える操作を実行する（画面からの操作）。受付番号（冪等キー）は必須で、
   * ないものは受け付けない。処理済みの番号なら、前回の結果をそのまま返す（二重送信の防止）。
   */
  async command(
    name: string,
    input: unknown,
    actorRef: ActorRef,
    idempotencyKey: string,
  ): Promise<Result<unknown>> {
    // RPC の境界なので、型に関係なく中身を確かめる
    if (!isIdempotencyKey(idempotencyKey)) return err("validation", MISSING_KEY_MESSAGE);
    return this.execute(name, input, actorRef, idempotencyKey);
  }

  /**
   * 受付番号なしで、状態を変える操作を実行する。画面を通らない内部の処理（Cron・Queues の処理、
   * 開発用のテストデータの投入、テストの準備）だけが使う。画面からの操作は必ず command を使う。
   * 操作者はブラウザからの入力では作らないもの（system・employee）に限る。
   */
  async internalCommand(
    name: string,
    input: unknown,
    actorRef: InternalActorRef,
  ): Promise<Result<unknown>> {
    // RPC の境界なので、型に関係なく中身を確かめる（画面の操作者で受付番号を省けないように）
    if (!isInternalActorRef(actorRef)) return err("forbidden", MISSING_KEY_MESSAGE);
    return this.execute(name, input, actorRef, null);
  }

  private async execute(
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
    return this.runQueryDef(def, name, input, actorRef);
  }

  /** 照会の定義を、権限の判定と入力の検証をしてから実行する */
  private runQueryDef<S extends z.ZodType, O>(
    def: QueryDef<S, O>,
    name: string,
    input: unknown,
    actorRef: ActorRef,
  ): Result<O> {
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

  // ---- 特定の時点への復元（管理者だけ。手順は docs/operations.md 3章） ----------------------

  private restoreDeps(): RestoreDeps {
    return {
      db: this.db,
      files: this.env.FILES,
      recovery: this.recovery,
      environment: this.env.ENVIRONMENT,
      unlockUntil: this.env.RESTORE_UNLOCK_UNTIL,
      now: new Date(),
      nextId: () => this.ulid(),
    };
  }

  /** 共通の仕組みの管理者（platform.admin）だけを通す */
  private platformAdmin(actorRef: ActorRef): Result<Actor> {
    const actor = this.resolveActorSync(actorRef);
    if (!actor) return err("unauthenticated", "ログインし直してください");
    if (!can(actor.roles, "platform.admin")) {
      return err("forbidden", "この操作を行う権限がありません");
    }
    return { ok: true, value: actor };
  }

  /**
   * 業務 DB を指定した時刻の状態に戻すよう予約する（戻るのは restartForRestore で作り直した後）。
   * 権限と時刻は照会 restore.preview で確かめ、確認の入力（戻す日時）と本番の鍵（RESTORE_UNLOCK_UNTIL）も確かめる。
   * requestId は画面のフォームの受付番号（同じ番号の再送信は、前の依頼の記録を返す）
   */
  async restoreToPointInTime(
    actorRef: ActorRef,
    input: unknown,
    requestId: string,
  ): Promise<Result<RestoreRecord>> {
    if (!isRestoreId(requestId)) return err("validation", MISSING_KEY_MESSAGE);
    const parsed = restoreInput.safeParse(input);
    if (!parsed.success)
      return err("validation", "入力内容を確認してください", { fields: zodFields(parsed.error) });
    const preview = this.runQueryDef(
      previewRestore,
      "restore.preview",
      { targetAt: parsed.data.targetAt },
      actorRef,
    );
    if (!preview.ok) return preview;
    if (!preview.value.ok) return preview.value;
    const target = new Date(preview.value.value.targetAt);
    if (!confirmsRestore(target, parsed.data.confirmation)) {
      const message = `確認のため「${restoreConfirmationText(target)}」と入力してください`;
      return err("validation", "確認の日時が戻す日時と一致しません", {
        fields: [{ field: "confirmation", message }],
      });
    }
    const actor = this.platformAdmin(actorRef);
    if (!actor.ok) return actor;
    return scheduleRestore(this.restoreDeps(), {
      id: requestId,
      target,
      reason: parsed.data.reason,
      actor: actor.value,
    });
  }

  /**
   * 予約した復元のために Durable Object を作り直す（ctx.abort）。成功すると、この呼び出しは例外で終わる。
   * 次に開いたときに、予約した時点の状態に戻る
   */
  async restartForRestore(actorRef: ActorRef, requestId: string): Promise<Result<true>> {
    const actor = this.platformAdmin(actorRef);
    if (!actor.ok) return actor;
    const record = await getRestore(this.env.FILES, requestId);
    if (!record) return err("not_found", "復元の記録が見つかりません");
    if (record.status !== "scheduled") return err("invalid_state", "この復元は終わっています");
    log("warn", "restarting business db for point-in-time restore", {
      restoreId: record.id,
      by: actor.value.employeeId,
    });
    this.recovery.restart(`point-in-time restore ${record.id}`);
    return { ok: true, value: true };
  }

  /** 戻った業務 DB に、戻したことを操作履歴として残す。まだ戻っていなければ pending を返す */
  async completeRestore(actorRef: ActorRef, requestId: string): Promise<Result<RestoreProgress>> {
    const actor = this.platformAdmin(actorRef);
    if (!actor.ok) return actor;
    return completeRestore(this.restoreDeps(), actor.value, requestId);
  }

  /** 復元の記録（R2 にあるので、業務 DB を戻しても消えない） */
  async restoreRecord(
    actorRef: ActorRef,
    requestId: string,
  ): Promise<Result<RestoreRecord | null>> {
    const actor = this.platformAdmin(actorRef);
    if (!actor.ok) return actor;
    return { ok: true, value: await getRestore(this.env.FILES, requestId) };
  }

  /** これまでの復元の記録（新しい順） */
  async restoreHistory(actorRef: ActorRef): Promise<Result<RestoreRecord[]>> {
    const actor = this.platformAdmin(actorRef);
    if (!actor.ok) return actor;
    return { ok: true, value: await listRestores(this.env.FILES) };
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
