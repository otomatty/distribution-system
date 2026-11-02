/** ダッシュボード（要件定義書 3.13）。役割ごとの「今日やること」。欄は web/dashboard/sections.ts に登録する */
import { Hono } from "hono";

import { isRole } from "../../domain/roles";
import { errorFields, log } from "../../infra/observability/log";
import { sectionsFor } from "../dashboard/sections";
import type { DashboardItem, DashboardSection } from "../dashboard/types";
import { paths } from "../paths";
import type { AppEnv } from "../types";
import { Alert, PageHeader } from "../views/components";
import { Layout } from "../views/layout";

export const dashboardRoutes = new Hono<AppEnv>();

function Tile(props: { item: DashboardItem }) {
  const { item } = props;
  const attention = item.attention === true && item.count > 0;
  return (
    <a class={attention ? "stat attention" : "stat"} href={item.href}>
      <div class="label">{item.label}</div>
      <div class="value">{item.count.toLocaleString("ja-JP")}</div>
      {item.note ? <div class="note">{item.note}</div> : null}
    </a>
  );
}

function Section(props: { section: DashboardSection; items: readonly DashboardItem[] | null }) {
  return (
    <section class="dashboard-section" id={`dashboard-${props.section.id}`}>
      <h2>{props.section.title}</h2>
      {props.items === null ? (
        <Alert kind="warning">この欄を読み込めませんでした。画面を開き直してください。</Alert>
      ) : (
        <div class="stats">
          {props.items.map((item) => (
            <Tile item={item} />
          ))}
        </div>
      )}
    </section>
  );
}

dashboardRoutes.get("/", async (c) => {
  const actor = c.get("actor");
  const sections = sectionsFor(actor.roles.filter(isRole));
  const loaded = await Promise.all(
    sections.map(async (section) => {
      try {
        return { section, items: await section.load(c) };
      } catch (e) {
        log("error", "dashboard section failed", { section: section.id, ...errorFields(e) });
        return { section, items: null };
      }
    }),
  );
  return c.html(
    <Layout title="ダッシュボード" actor={actor} current={paths.home()}>
      <PageHeader title="今日やること">
        <p class="muted">{actor.name} さん、おつかれさまです。</p>
      </PageHeader>
      {loaded.map((s) => (
        <Section section={s.section} items={s.items} />
      ))}
    </Layout>,
  );
});
