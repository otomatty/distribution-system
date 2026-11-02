/**
 * テストデータの投入で使うもの：業務 DB（読むため）、ユースケースの実行、日付と時刻、乱数。
 * 書き込みはすべて本物のユースケース（コマンド）を通す。在庫・引当・状態・採番・操作履歴は、
 * 画面から操作したときと同じ規則で記録される。
 */
import type { z } from "zod";

import { addDays, toBusinessDate } from "../../domain/dates";
import type { Result } from "../../domain/result";
import type { CommandDef, QueryDef } from "../../usecases/core";
import type { Db } from "../db/client";
import { employeeEmail, type SeedEmployeeKey } from "./names";
import { randomFor, type Random } from "./random";
import { SEED, type SeedScale } from "./scale";

/** 業務 DB（Durable Object）が用意する、投入のための入口 */
export interface SeedHost {
  /** 判断に使う値を読むため（書き込みには使わない） */
  readonly db: Db;
  /**
   * 社員（メールアドレス。"system" はシステム、"admin" は最初の管理者）として、at の時刻にコマンドを実行する。
   * renderDocuments が false なら、発行した帳票の PDF 化を予約しない
   */
  command<S extends z.ZodType, O>(
    def: CommandDef<S, O>,
    input: z.input<S>,
    actor: string,
    at: Date,
    renderDocuments: boolean,
  ): Result<O>;
  /** システムとして、at の時刻に照会する */
  query<S extends z.ZodType, O>(def: QueryDef<S, O>, input: z.input<S>, at: Date): Result<O>;
}

/** 投入する期間（今日を含めて scale.days 日分） */
export interface SeedPeriod {
  readonly scale: SeedScale;
  readonly from: string;
  readonly today: string;
  /** この日以降に発行した帳票だけ PDF を作り、メールで送る（それより前は索引だけ） */
  readonly renderFrom: string;
}

export function seedPeriod(scale: SeedScale, today: string): SeedPeriod {
  return {
    scale,
    from: addDays(today, -(scale.days - 1)),
    today,
    renderFrom: addDays(today, 1 - scale.renderDays),
  };
}

/** 日本時間の業務日・時刻を UTC の時刻にする */
export function jst(date: string, hour: number, minute = 0, second = 0): Date {
  const [y = 0, m = 1, d = 1] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hour - 9, minute, second));
}

/** 曜日（0 = 日曜） */
export function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** 1日の中で操作の時刻を少しずつ進める（同じ時刻に操作が重ならないように） */
export class DayClock {
  private seconds = 0;

  constructor(
    readonly date: string,
    private readonly hour: number,
  ) {}

  next(): Date {
    this.seconds += 7;
    return jst(this.date, this.hour, Math.floor(this.seconds / 60) % 60, this.seconds % 60);
  }
}

/** 取引を作る1日 */
export interface SeedDay {
  readonly date: string;
  /** 期間の始まりからの日数（0 から） */
  readonly index: number;
  /** 投入の最終日（今日）。今日の出荷・入荷の一部は、画面で操作できるように残しておく */
  readonly isToday: boolean;
}

/** 暦日の通し番号（発注の間隔などを決めるのに使う） */
export function dayNumber(date: string): number {
  return Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 86_400_000);
}

export type SeedActor = SeedEmployeeKey | "admin" | "system";

function actorEmail(actor: SeedActor): string {
  if (actor === "system") return "system";
  if (actor === "admin") return "admin";
  return employeeEmail(actor);
}

export class SeedSession {
  commands = 0;
  rejected = 0;
  readonly rejections: string[] = [];

  constructor(
    readonly host: SeedHost,
    readonly period: SeedPeriod,
  ) {}

  private readonly seen = new Set<string>();

  get db(): Db {
    return this.host.db;
  }

  /** key が初めてなら true（1回の依頼の中で、1つだけ特別に扱うもの） */
  once(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  /** 対象ごとの乱数（種は固定） */
  random(...keys: readonly (string | number)[]): Random {
    return randomFor(SEED, ...keys);
  }

  /**
   * コマンドを実行する。業務エラーなら何も記録されないので、件数と理由を数えて undefined を返す
   * （投入は続ける。理由は投入の結果に出る）。
   */
  run<S extends z.ZodType, O>(
    def: CommandDef<S, O>,
    input: z.input<S>,
    actor: SeedActor,
    at: Date,
    label: string,
  ): O | undefined {
    this.commands += 1;
    const render = toBusinessDate(at) >= this.period.renderFrom;
    const r = this.host.command(def, input, actorEmail(actor), at, render);
    if (r.ok) return r.value;
    this.rejected += 1;
    if (this.rejections.length < 20) {
      const fields = (r.error.fields ?? []).map((f) => `${f.field}:${f.message}`);
      const extra = [...fields, ...(r.error.details ?? []).slice(0, 3)].join(", ");
      this.rejections.push(`${label}：${r.error.message}${extra ? `（${extra}）` : ""}`);
    }
    return undefined;
  }

  /** 照会を実行する（システムとして） */
  ask<S extends z.ZodType, O>(def: QueryDef<S, O>, input: z.input<S>, at: Date): O | undefined {
    const r = this.host.query(def, input, at);
    return r.ok ? r.value : undefined;
  }
}
