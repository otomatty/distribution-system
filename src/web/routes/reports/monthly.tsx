/**
 * 売上・仕入の集計（要件定義書 3.13 の Should、5章 /reports）：月別に、販売先別・仕入先別・商品別で表示する。
 * 金額は照会（reports.monthly）で計算し、ここでは表示するだけ。絞り込みは表の部分（#results）だけを差し替える。
 */
import { Hono } from "hono";

import { REPORT_VIEW_LABELS, REPORT_VIEWS, type ReportView } from "../../../domain/reports";
import type { MonthlyReport } from "../../../usecases/reports/monthly";
import { exportCsv } from "../../csv-exports";
import { formKey, readForm, str } from "../../form";
import { paths, type Query } from "../../paths";
import type { AppEnv } from "../../types";
import { runQuery } from "../../usecase";
import {
  Alert,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Pagination,
  Select,
  toFormErrors,
} from "../../views/components";
import { CsvButton } from "../../views/csv-button";
import { yen } from "../../views/format";
import { Layout } from "../../views/layout";

export const reportRoutes = new Hono<AppEnv>();

const PAGE_SIZE = 50;

const VIEW_OPTIONS = REPORT_VIEWS.map((v) => ({ value: v, label: REPORT_VIEW_LABELS[v] }));

/** URL のクエリ・CSV のフォームから、集計の条件を作る（名前は画面と CSV で共通） */
function filterFrom(get: (name: string) => string) {
  const view: ReportView = REPORT_VIEWS.find((v) => v === get("view")) ?? "sales_customer";
  const text = (name: string) => get(name).trim() || undefined;
  return { view, from: text("from"), to: text("to"), q: text("q") };
}

type Filter = ReturnType<typeof filterFrom>;

function filterQuery(f: Filter): Query {
  return { view: f.view === "sales_customer" ? undefined : f.view, from: f.from, to: f.to, q: f.q };
}

/** 2026-01 → 2026年1月 */
function monthLabel(month: string): string {
  return `${month.slice(0, 4)}年${Number(month.slice(5, 7))}月`;
}

function Basis() {
  return (
    <details class="card report-basis">
      <summary>集計の基準</summary>
      <ul>
        <li>
          売上：発送日の月に、発送した受注の明細の金額（単価 ×
          数量を明細ごとに端数処理）と送料などを計上し、返品伝票の金額を返品日の月に差し引きます。
        </li>
        <li>
          仕入：入荷日の月に、入荷の受入数 ×
          単価を計上し、仕入返品の金額を返品日の月に差し引きます。仕入先請求書の送料と差額は含めません。
        </li>
        <li>
          金額はすべて税抜（円）です。取り消した発送・入荷・返品伝票・仕入返品は含めません。メーカー直の受注・発注も含めます。
        </li>
        <li>
          送料などは商品に割り振れないため、商品別・仕入先別の売上には含めません（販売先別と、月ごとの売上の合計には含めます）。
        </li>
        <li>売上（仕入先別）は、売れた商品の仕入先ごとにまとめた売上です。</li>
      </ul>
    </details>
  );
}

function Summary(props: { report: MonthlyReport }) {
  const { summary } = props.report;
  return (
    <section class="card">
      <h2>月ごとの売上と仕入</h2>
      <div class="table-wrap">
        <table class="table report-summary">
          <thead>
            <tr>
              <th scope="col">月</th>
              <th scope="col" class="num">
                売上（税抜）
              </th>
              <th scope="col" class="num">
                仕入（税抜）
              </th>
            </tr>
          </thead>
          <tbody>
            {summary.months.map((m) => (
              <tr>
                <th scope="row">{monthLabel(m.month)}</th>
                <td class="num">{yen(m.sales)}</td>
                <td class="num">{yen(m.purchases)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot class="totals">
            <tr class="grand-total">
              <th scope="row">合計</th>
              <td class="num">{yen(summary.sales)}</td>
              <td class="num">{yen(summary.purchases)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

function Breakdown(props: { report: MonthlyReport; query: Query }) {
  const { report } = props;
  const { months } = report.period;
  const nameHeader =
    report.axis === "customer" ? "販売先" : report.axis === "supplier" ? "仕入先" : "商品";
  return (
    <section class="card">
      <h2>{REPORT_VIEW_LABELS[report.view]}</h2>
      {report.measure === "sales" && !report.includesCharges ? (
        <p class="hint">
          送料などは商品に割り振れないため含めていません（上の月ごとの売上には含めます）。
        </p>
      ) : null}
      {report.rows.total === 0 ? (
        <EmptyState message="条件に合う取引はありません" />
      ) : (
        <div class="table-wrap">
          <table class="table report-table">
            <thead>
              <tr>
                <th scope="col" class="sticky-col">
                  {nameHeader}
                </th>
                {months.map((m) => (
                  <th scope="col" class="num">
                    {monthLabel(m)}
                  </th>
                ))}
                <th scope="col" class="num">
                  合計
                </th>
              </tr>
            </thead>
            <tbody>
              {report.rows.rows.map((r) => (
                <tr>
                  <th scope="row" class="sticky-col">
                    {r.code ? <span class="muted small">{r.code} </span> : null}
                    {r.name}
                  </th>
                  {r.amounts.map((a) => (
                    <td class="num">{yen(a)}</td>
                  ))}
                  <td class="num">
                    <strong>{yen(r.total)}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot class="totals">
              <tr class="grand-total">
                <th scope="row" class="sticky-col">
                  合計（{report.rows.total}件）
                </th>
                {report.totals.map((t) => (
                  <td class="num">{yen(t)}</td>
                ))}
                <td class="num">{yen(report.grandTotal)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <Pagination
        page={report.rows.page}
        pageSize={report.rows.pageSize}
        total={report.rows.total}
        href={(p) => paths.reports({ ...props.query, page: p })}
      />
    </section>
  );
}

reportRoutes.get("/", async (c) => {
  const f = filterFrom((name) => c.req.query(name) ?? "");
  const page = Math.max(1, Number(c.req.query("page") ?? "1") || 1);
  const result = await runQuery(c, "reports.monthly", { ...f, page, pageSize: PAGE_SIZE });
  const query = filterQuery(f);
  const errors = result.ok ? {} : toFormErrors(result.error);
  // 期間を指定しなかったときは、実際に集計した期間を入力欄に出す
  const from = result.ok ? result.value.period.from : f.from;
  const to = result.ok ? result.value.period.to : f.to;
  return c.html(
    <Layout title="売上・仕入の集計" actor={c.get("actor")} current={paths.reports()}>
      <PageHeader title="売上・仕入の集計" />
      <form
        class="filters"
        method="get"
        action={paths.reports()}
        hx-get={paths.reports()}
        hx-target="#results"
        hx-select="#results"
        hx-swap="outerHTML"
        hx-push-url="true"
        hx-trigger="input changed delay:300ms from:input[name=q], change"
      >
        <Field label="表示" name="view">
          <Select name="view" value={f.view} options={VIEW_OPTIONS} />
        </Field>
        <Field label="期間（から）" name="from" error={errors["from"]}>
          <Input name="from" type="month" value={from} error={errors["from"]} />
        </Field>
        <Field label="期間（まで）" name="to" error={errors["to"]}>
          <Input name="to" type="month" value={to} error={errors["to"]} />
        </Field>
        <div class="field wide">
          <label for="f-q">名前・コードで絞り込み</label>
          <Input name="q" type="search" value={f.q} />
        </div>
        <noscript>
          <button type="submit" class="btn btn-secondary">
            集計
          </button>
        </noscript>
      </form>
      <Basis />
      <section id="results">
        {result.ok ? (
          <>
            <div class="toolbar">
              <p class="muted">
                {monthLabel(result.value.period.from)}〜{monthLabel(result.value.period.to)}
                （税抜・円）
              </p>
              <CsvButton action={paths.reportsCsv()} filters={query} />
            </div>
            <Summary report={result.value} />
            <Breakdown report={result.value} query={query} />
          </>
        ) : (
          <Alert kind="error">{result.error.message}</Alert>
        )}
      </section>
    </Layout>,
  );
});

reportRoutes.post("/csv", async (c) => {
  const form = await readForm(c);
  return exportCsv(
    c,
    "reports",
    filterFrom((name) => str(form, name)),
    formKey(form),
  );
});
