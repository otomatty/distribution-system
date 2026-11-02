/**
 * ユースケースの共通の型。ユースケースは業務 DB（Durable Object）の中で、
 * 1つのトランザクションとして同期的に実行される（AGENTS.md 2章）。
 */
import type { z } from "zod";

import type { DocumentKind } from "../domain/numbering";
import type { Result } from "../domain/result";
import type { Permission, Role } from "../domain/roles";
import type { Stores } from "./ports";

export interface Actor {
  readonly employeeId: string;
  readonly name: string;
  readonly email: string;
  readonly roles: readonly Role[];
}

export interface Clock {
  /** 現在時刻（UTC） */
  now(): Date;
  /** 日本時間の業務日（YYYY-MM-DD） */
  today(): string;
}

export interface IdGenerator {
  next(): string;
}

export interface AuditEntry {
  readonly entityType: string;
  readonly entityId: string;
  readonly action: string;
  readonly before?: unknown;
  readonly after?: unknown;
}

export interface AuditPort {
  record(entry: AuditEntry): void;
}

export interface SequencePort {
  /** 種別×年ごとの次の番号を採番して、整形済みの番号を返す */
  next(kind: DocumentKind, businessDate: string): string;
}

export type JobType =
  | "render_document"
  | "send_document"
  | "bulk_documents"
  | "export_csv"
  | "backup";

export interface JobPort {
  /** 非同期処理を登録する（コミット後に Queues へ送られる）。job の ID を返す */
  enqueue(type: JobType, payload: Record<string, unknown>, total?: number): string;
}

/** 帳票の種類（電子帳簿保存法の検索対象） */
export type DocumentType = "purchase_order" | "delivery_note" | "invoice" | "credit_note";

export interface IssueDocumentInput {
  readonly documentType: DocumentType;
  /** 画面と帳票に出す番号（PO-2026-000123 など） */
  readonly number: string;
  /** 元の伝票（発注・発送・請求書・返品伝票）の ID */
  readonly entityId: string;
  readonly partnerId: string;
  /** 取引年月日（業務日） */
  readonly transactionDate: string;
  /** 税込の合計（円） */
  readonly amount: number;
  /**
   * 帳票に載せる内容。発行時点の値を JSON で保存し、PDF 化と再ダウンロードに使う。
   * 型は発行するユースケースの側で zod のスキーマとして定義し、帳票のテンプレートで検証する。
   */
  readonly snapshot: unknown;
}

export interface DocumentPort {
  /** 帳票を発行する。索引に登録し、PDF 化を予約する（コミット後に Queues で処理）。帳票の ID を返す */
  issue(input: IssueDocumentInput): string;
  /** 帳票を取消済みにする（PDF と索引は残す） */
  cancel(documentId: string): void;
  /** 帳票をメールで送る（送付履歴を登録し、送信を予約する）。送付履歴の ID を返す */
  sendEmail(documentId: string, recipient: string): string;
  /** FAX など、システムの外で送ったことを記録する */
  recordManualSend(documentId: string, note: string | null): string;
}

export interface UsecaseContext {
  readonly actor: Actor;
  readonly command: string;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly audit: AuditPort;
  readonly sequences: SequencePort;
  readonly jobs: JobPort;
  readonly documents: DocumentPort;
  readonly stores: Stores;
}

/** 状態を変える操作 */
export interface CommandDef<S extends z.ZodType, O> {
  readonly permission: Permission;
  readonly input: S;
  run(ctx: UsecaseContext, input: z.output<S>): Result<O>;
}

/** 読み取り専用の操作で使えるもの（書き込みの手段は渡さない） */
export type QueryContext = Omit<UsecaseContext, "audit" | "sequences" | "jobs" | "documents">;

/** 読み取り専用の操作 */
export interface QueryDef<S extends z.ZodType, O> {
  readonly permission: Permission;
  readonly input: S;
  run(ctx: QueryContext, input: z.output<S>): O;
}

export function defineCommand<S extends z.ZodType, O>(def: CommandDef<S, O>): CommandDef<S, O> {
  return def;
}

export function defineQuery<S extends z.ZodType, O>(def: QueryDef<S, O>): QueryDef<S, O> {
  return def;
}

/** 楽観ロック用の版番号の不一致 */
export const STALE_VERSION_MESSAGE =
  "ほかの人が先に更新しました。画面を開き直してから、もう一度操作してください";
