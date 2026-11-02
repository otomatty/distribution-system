/**
 * URL を生成するヘルパー。hx-get / hx-post や href に文字列を直書きしない（AGENTS.md 4章）。
 * パスは機能の区分ごとのファイルに追加する。
 */
import { billingPaths } from "./billing";
import { corePaths } from "./core";
import { mastersPaths } from "./masters";
import { platformPaths } from "./platform";
import { purchasingPaths } from "./purchasing";
import { salesPaths } from "./sales";
import { stockPaths } from "./stock";

export type { Query } from "./query";

export const paths = {
  ...corePaths,
  ...mastersPaths,
  ...stockPaths,
  ...purchasingPaths,
  ...salesPaths,
  ...billingPaths,
  ...platformPaths,
};
