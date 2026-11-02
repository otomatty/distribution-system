/**
 * テストデータの量（要件定義書 7章 規模と性能、9章 テストデータ）。
 * - small：本番と同じくらいのマスタと、本番と同じ頻度の取引を約3か月分（毎日の開発用）
 * - full：本番の約5倍（商品 2,500、取引先 1,000、受注 約11万件・発注 約4万件を3年分）。速度の確認用
 * - tiny：結合テスト用（数十件）
 */
import type { SeedScaleName } from "./request";

export interface SeedScale {
  readonly name: SeedScaleName;
  /** 取引先の数（仕入先だけ・販売先だけ・両方） */
  readonly suppliers: number;
  readonly customers: number;
  readonly both: number;
  readonly items: number;
  /** 取引を作る日数（今日を含めて過去へ） */
  readonly days: number;
  /** 平日1日あたりの受注の件数（土曜は半分、日曜は休み） */
  readonly salesOrdersPerWeekday: number;
  /** 1回の依頼で投入する取引先・商品の数と日数（1回の依頼が長くなりすぎないように分ける） */
  readonly partnersPerChunk: number;
  readonly itemsPerChunk: number;
  readonly daysPerChunk: number;
  /** 帳票の PDF を作る日数（今日から過去へ。それより前の帳票は索引だけで、必要なら画面から作る） */
  readonly renderDays: number;
}

export const SEED_SCALE_DEFS: Readonly<Record<SeedScaleName, SeedScale>> = {
  tiny: {
    name: "tiny",
    suppliers: 5,
    customers: 10,
    both: 2,
    items: 40,
    days: 75,
    salesOrdersPerWeekday: 5,
    partnersPerChunk: 100,
    itemsPerChunk: 100,
    daysPerChunk: 40,
    renderDays: 0,
  },
  small: {
    name: "small",
    suppliers: 60,
    customers: 120,
    both: 20,
    items: 500,
    days: 92,
    salesOrdersPerWeekday: 27,
    partnersPerChunk: 200,
    itemsPerChunk: 500,
    daysPerChunk: 14,
    renderDays: 2,
  },
  full: {
    name: "full",
    suppliers: 300,
    customers: 600,
    both: 100,
    items: 2500,
    days: 1095,
    salesOrdersPerWeekday: 135,
    partnersPerChunk: 250,
    itemsPerChunk: 500,
    daysPerChunk: 7,
    renderDays: 2,
  },
};

/** すべての投入で同じ種を使う（変えるとデータが変わる） */
export const SEED = 20_261_102;
