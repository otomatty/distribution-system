import type { Context } from "hono";

import type { AppEnv } from "./types";

export function isHtmx(c: Context<AppEnv>): boolean {
  return c.req.header("HX-Request") === "true";
}

/** 処理の後の画面遷移。htmx からの要求には HX-Redirect、通常のフォーム送信には 303 を返す */
export function redirectTo(c: Context<AppEnv>, url: string): Response {
  if (isHtmx(c)) {
    c.header("HX-Redirect", url);
    return c.body(null, 204);
  }
  return c.redirect(url, 303);
}

/** 操作の後に一覧などへ戻るとき、画面上部に出すお知らせ */
export const NOTICES: Readonly<Record<string, string>> = {
  created: "登録しました",
  updated: "更新しました",
  deleted: "削除しました",
  archived: "取引終了にしました",
  unarchived: "取引終了を取り消しました",
};
