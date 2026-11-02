import type { Context } from "hono";

import type { Role } from "../../domain/roles";
import type { AppEnv } from "../types";

/** ダッシュボードの1項目（件数と、絞り込み済みの一覧への URL） */
export interface DashboardItem {
  readonly label: string;
  readonly count: number;
  /** 絞り込み済みの一覧（paths のヘルパーで作る） */
  readonly href: string;
  /** 0件でないときに目立たせる（失敗・期限切れなど） */
  readonly attention?: boolean;
  /** 補足（最終の成功日時など） */
  readonly note?: string;
}

/** ダッシュボードの欄。区分ごとに作り、sections.ts の一覧に登録する */
export interface DashboardSection {
  readonly id: string;
  readonly title: string;
  /** この欄を表示する役割（管理者はすべての欄を見る） */
  readonly roles: readonly Role[];
  /** 欄に出す項目を読む。件数はユースケース（照会）で数え、画面では計算しない */
  load(c: Context<AppEnv>): Promise<readonly DashboardItem[]>;
}
