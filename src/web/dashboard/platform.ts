/** ダッシュボードの「帳票と処理」の欄（送付の失敗、処理中・失敗した処理、管理者には PDF 化とバックアップ） */
import { ROLES } from "../../domain/roles";
import { paths } from "../paths";
import { runQuery } from "../usecase";
import { dateTime } from "../views/format";
import type { DashboardItem, DashboardSection } from "./types";

export const platformSection: DashboardSection = {
  id: "platform",
  title: "帳票と処理",
  roles: ROLES,
  async load(c) {
    const [documents, jobs] = await Promise.all([
      runQuery(c, "documents.attention", {}),
      runQuery(c, "jobs.attention", {}),
    ]);
    const items: DashboardItem[] = [
      {
        label: "送付に失敗した帳票",
        count: documents.failedSends,
        href: paths.documents({ sendStatus: "failed" }),
        attention: true,
      },
      {
        label: "処理中の一括 PDF・CSV",
        count: jobs.active,
        href: paths.jobs({ status: "active" }),
      },
      {
        label: "失敗した処理（7日間）",
        count: jobs.failed,
        href: paths.jobs({ status: "failed" }),
        attention: true,
      },
    ];
    if (documents.failedRenders !== null) {
      items.push({
        label: "PDF の作成に失敗した帳票",
        count: documents.failedRenders,
        href: paths.documents({ renderStatus: "failed" }),
        attention: true,
      });
    }
    if (jobs.backup) {
      items.push({
        label: "日次バックアップの異常",
        count: jobs.backup.needsAttention ? 1 : 0,
        href: paths.jobs(),
        attention: true,
        note: jobs.backup.lastSucceededAt
          ? `最後の成功：${dateTime(jobs.backup.lastSucceededAt)}`
          : "まだ成功していません",
      });
    }
    return items;
  },
};
