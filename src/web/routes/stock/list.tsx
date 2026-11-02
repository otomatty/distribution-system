/** 在庫一覧（要件定義書 3.4）：商品×保管場所の現在庫・引当数・出荷可能数。CSV 出力つき */
import { Hono, type Context } from "hono";

import { exportCsv } from "../../csv-exports";
import { formKey, readForm, str } from "../../form";
import { hasPermission } from "../../middleware";
import { paths } from "../../paths";
import type { AppEnv } from "../../types";
import { runQuery } from "../../usecase";
import {
  Badge,
  Checkbox,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Pagination,
  Select,
} from "../../views/components";
import { CsvButton } from "../../views/csv-button";
import { qty } from "../../views/format";
import { Layout } from "../../views/layout";

export const stockListRoutes = new Hono<AppEnv>();

/** URL のクエリ・CSV のフォームから、絞り込み条件を作る（名前は画面と CSV で共通） */
function filterFrom(get: (name: string) => string) {
  return {
    q: get("q"),
    locationId: get("locationId"),
    genreId: get("genreId"),
    belowReorder: get("reorder") === "1",
  };
}

function filterFromQuery(c: Context<AppEnv>) {
  return filterFrom((name) => c.req.query(name) ?? "");
}

function queryOf(f: ReturnType<typeof filterFromQuery>) {
  return {
    q: f.q,
    locationId: f.locationId,
    genreId: f.genreId,
    reorder: f.belowReorder ? 1 : undefined,
  };
}

function usecaseFilter(f: ReturnType<typeof filterFromQuery>) {
  return {
    q: f.q,
    locationId: f.locationId || undefined,
    genreId: f.genreId || undefined,
    belowReorder: f.belowReorder,
  };
}

stockListRoutes.get("/", async (c) => {
  const f = filterFromQuery(c);
  const page = Math.max(1, Number(c.req.query("page") ?? "1") || 1);
  const [result, locations, genres] = await Promise.all([
    runQuery(c, "stock.list", { ...usecaseFilter(f), page, pageSize: 100 }),
    runQuery(c, "locations.options", {}),
    runQuery(c, "genres.options", {}),
  ]);
  const canManage = hasPermission(c.get("actor").roles, "stock.manage");
  const href = (p: number) => paths.stock({ ...queryOf(f), page: p });
  return c.html(
    <Layout title="在庫一覧" actor={c.get("actor")} current={paths.stock()}>
      <PageHeader
        title="在庫一覧"
        actions={
          canManage ? (
            <a class="btn btn-primary" href={paths.stockOperationNew()}>
              在庫操作
            </a>
          ) : null
        }
      >
        <p class="hint">
          出荷可能数 = 現在庫 − 引当数。発注点割れは「出荷可能数 + 入荷予定数 &lt;
          発注点在庫数」の商品です。
        </p>
      </PageHeader>
      <form
        class="filters"
        method="get"
        action={paths.stock()}
        hx-get={paths.stock()}
        hx-target="#results"
        hx-select="#results"
        hx-swap="outerHTML"
        hx-push-url="true"
        hx-trigger="input changed delay:300ms from:input[name=q], change"
      >
        <div class="field wide">
          <label for="f-q">商品名・コード・JAN で検索</label>
          <Input name="q" type="search" value={f.q} />
        </div>
        <Field label="保管場所" name="locationId">
          <Select
            name="locationId"
            value={f.locationId}
            options={locations.map((l) => ({ value: l.id, label: l.name }))}
            empty="すべて"
          />
        </Field>
        <Field label="ジャンル" name="genreId">
          <Select
            name="genreId"
            value={f.genreId}
            options={genres.map((g) => ({ value: g.id, label: g.name }))}
            empty="すべて"
          />
        </Field>
        <Checkbox name="reorder" value="1" label="発注点割れだけ" checked={f.belowReorder} />
        <noscript>
          <button type="submit" class="btn btn-secondary">
            検索
          </button>
        </noscript>
      </form>
      <section id="results">
        <div class="toolbar">
          <CsvButton action={paths.stockCsv()} filters={queryOf(f)} />
        </div>
        {result.rows.length === 0 ? (
          <EmptyState message="条件に合う在庫はありません" />
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>商品コード</th>
                  <th>商品名</th>
                  <th>保管場所</th>
                  <th class="num">現在庫</th>
                  <th class="num">引当数</th>
                  <th class="num">出荷可能数</th>
                  <th class="num">入荷予定数</th>
                  <th>状態</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r) => (
                  <tr class={r.belowReorderPoint ? "row-warning" : undefined}>
                    <td class="nowrap">{r.itemCode}</td>
                    <td>
                      <a href={paths.stockItem(r.itemId, { locationId: r.locationId })}>
                        {r.itemName}
                      </a>
                      {r.genreName ? <div class="muted small">{r.genreName}</div> : null}
                    </td>
                    <td>{r.locationName}</td>
                    <td class="num">
                      {qty(r.onHand)}
                      <span class="muted small">{r.salesUnitName}</span>
                    </td>
                    <td class="num">{qty(r.allocated)}</td>
                    <td class={r.available < 0 ? "num text-danger" : "num"}>{qty(r.available)}</td>
                    <td class="num">{r.incoming > 0 ? qty(r.incoming) : ""}</td>
                    <td>
                      {r.belowReorderPoint ? <Badge kind="warning">発注点割れ</Badge> : null}{" "}
                      {r.available < 0 ? <Badge kind="danger">引当超過</Badge> : null}{" "}
                      {r.discontinued ? <Badge>取扱終了</Badge> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination
          page={result.page}
          pageSize={result.pageSize}
          total={result.total}
          href={href}
        />
      </section>
    </Layout>,
  );
});

/**
 * 在庫一覧の CSV（一覧と同じ絞り込み）。BOM 付き UTF-8、日本語の列名。
 * 件数が多い（2,000件を超える）と非同期で作り、処理状況の画面へ移る（csv-exports.ts の stock）
 */
stockListRoutes.post("/csv", async (c) => {
  const form = await readForm(c);
  return exportCsv(c, "stock", usecaseFilter(filterFrom((name) => str(form, name))), formKey(form));
});
