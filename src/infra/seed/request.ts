/**
 * テストデータの投入の依頼と結果（scripts/seed.mjs → /dev/seed → 業務 DB の seed）。
 * 開発環境とテストでだけ受け付ける（ENVIRONMENT が development / test）。
 */
import { z } from "zod";

import { isBusinessDate } from "../../domain/dates";

export const SEED_SCALES = ["tiny", "small", "full"] as const;
export type SeedScaleName = (typeof SEED_SCALES)[number];

const today = z.string().refine(isBusinessDate, "日付は YYYY-MM-DD で指定してください").optional();
const scale = z.enum(SEED_SCALES).default("small");

export const seedRequestSchema = z.discriminatedUnion("action", [
  /** 投入の手順と、手順ごとの回数（1回の依頼で実行する単位）を返す */
  z.object({ action: z.literal("plan"), scale, today }),
  /** 手順の1回分を実行する */
  z.object({
    action: z.literal("run"),
    scale,
    today,
    step: z.string().max(50),
    chunk: z.number().int().min(0).max(100_000),
  }),
  /** 業務データをすべて消して、初期の状態（自社設定・税率表・最初の管理者）に戻す */
  z.object({ action: z.literal("reset") }),
  /** 在庫・引当・状態・採番の整合を確かめる */
  z.object({ action: z.literal("verify") }),
]);

export type SeedRequest = z.output<typeof seedRequestSchema>;

export interface SeedStepPlan {
  readonly name: string;
  readonly label: string;
  readonly chunks: number;
}

export interface SeedPlanResult {
  readonly action: "plan";
  readonly scale: SeedScaleName;
  readonly from: string;
  readonly today: string;
  readonly steps: readonly SeedStepPlan[];
}

export interface SeedRunResult {
  readonly action: "run";
  readonly step: string;
  readonly chunk: number;
  /** 実行したユースケースの数 */
  readonly commands: number;
  /** 業務エラーで記録しなかった操作の数と、最初のいくつかの理由 */
  readonly rejected: number;
  readonly rejections: readonly string[];
  readonly label: string;
}

export interface SeedCheck {
  readonly name: string;
  readonly ok: boolean;
  /** 合わなかった件数（ok なら 0） */
  readonly mismatches: number;
  readonly sample: readonly string[];
}

export interface SeedVerifyResult {
  readonly action: "verify";
  readonly ok: boolean;
  readonly checks: readonly SeedCheck[];
  readonly counts: Readonly<Record<string, number>>;
}

export type SeedResult =
  | SeedPlanResult
  | SeedRunResult
  | { readonly action: "reset" }
  | SeedVerifyResult;
