/**
 * 支払予定一覧と買掛残高（要件定義書 3.7）。
 * - 支払予定一覧：支払の残っている（未払い・一部支払の）仕入先請求書（支払予定日の順）と、請求額・支払済み・残りの合計。
 *   状態で絞り込める。チェックで選んで、それぞれの残りの額を一括で支払える（1つのトランザクション）
 * - 買掛残高：仕入先別・月別の月末の残高（請求額 − 支払額）。どちらも CSV で出力できる
 */
import { Hono, type Context } from "hono";

import { toBusinessDate } from "../../../domain/dates";
import {
  OPEN_SUPPLIER_INVOICE_STATUSES,
  SUPPLIER_INVOICE_STATUS_LABELS,
} from "../../../domain/purchasing";
import type { DomainError } from "../../../domain/result";
import { csvResponse, type CsvValue } from "../../csv";
import { exportCsv } from "../../csv-exports";
import { formKey, readForm, str, strs } from "../../form";
import { hasPermission } from "../../middleware";
import { paths, type Query } from "../../paths";
import type { AppEnv } from "../../types";
import { runCommand, runQuery } from "../../usecase";
import {
  Alert,
  Checkbox,
  EmptyState,
  ErrorSummary,
  Field,
  FormKey,
  Input,
  PageHeader,
  Pagination,
  Select,
  type Option,
} from "../../views/components";
import { CsvButton } from "../../views/csv-button";
import { yen } from "../../views/format";
import { Layout } from "../../views/layout";
import { InvoiceTable } from "./supplier-invoices";

export const payableRoutes = new Hono<AppEnv>();

const STATUS_OPTIONS: Option[] = OPEN_SUPPLIER_INVOICE_STATUSES.map((s) => ({
  value: s,
  label: SUPPLIER_INVOICE_STATUS_LABELS[s],
}));

function filterFrom(get: (name: string) => string) {
  const text = (name: string) => get(name).trim() || undefined;
  return {
    status: OPEN_SUPPLIER_INVOICE_STATUSES.find((s) => s === get("status")),
    supplierId: text("supplierId"),
    dueFrom: text("dueFrom"),
    dueTo: text("dueTo"),
    overdue: get("overdue") === "1",
  };
}

type Filter = ReturnType<typeof filterFrom>;

function filterQuery(f: Filter): Query {
  return { ...f, overdue: f.overdue ? 1 : undefined };
}

async function supplierOptions(c: Context<AppEnv>): Promise<Option[]> {
  const suppliers = await runQuery(c, "partners.options", { role: "supplier" });
  return suppliers.map((s) => ({ value: s.id, label: s.name }));
}

function Tabs(props: { current: "list" | "balances" }) {
  return (
    <nav class="tabs" aria-label="支払">
      <a href={paths.payables()} aria-current={props.current === "list" ? "page" : undefined}>
        支払予定
      </a>
      <a
        href={paths.payableBalances()}
        aria-current={props.current === "balances" ? "page" : undefined}
      >
        買掛残高（仕入先別・月別）
      </a>
    </nav>
  );
}

async function Results(props: {
  c: Context<AppEnv>;
  filter: Filter;
  page: number;
  result?: { count: number; amount: number } | null;
  error?: DomainError | null;
}) {
  const { c, filter } = props;
  const list = await runQuery(c, "payables.list", { ...filter, page: props.page, pageSize: 100 });
  const query = filterQuery(filter);
  const canPay = hasPermission(c.get("actor").roles, "supplierInvoices.manage");
  return (
    <section id="results">
      {props.result ? (
        <Alert kind="success">
          {props.result.count}件の仕入先請求書の残りの額を支払い、支払済みにしました（合計{" "}
          {yen(props.result.amount)}）
        </Alert>
      ) : null}
      <ErrorSummary error={props.error} />
      <div class="toolbar">
        <p>
          支払の残っている請求書 <strong>{list.totals.count}件</strong>・請求額{" "}
          {yen(list.totals.invoiced)}・支払済み {yen(list.totals.paid)}・残りの合計{" "}
          <strong id="payables-total">{yen(list.totals.remaining)}</strong>
        </p>
        <CsvButton action={paths.payablesCsv()} filters={query} />
      </div>
      {list.rows.length === 0 ? (
        <EmptyState message="条件に合う、支払の残っている仕入先請求書はありません" />
      ) : canPay ? (
        <form
          id="bulk-pay"
          method="post"
          action={paths.payablesBulkPay()}
          hx-post={paths.payablesBulkPay()}
          hx-target="#results"
          hx-swap="outerHTML"
          hx-confirm="選んだ仕入先請求書の残りの額をそれぞれ支払い、支払済みにします（一部支払の請求書は残りの額、請求額が 0 円以下のものは請求額で精算します）。よろしいですか？"
          class="form"
        >
          <FormKey />
          {Object.entries(query).map(([name, value]) =>
            value === undefined || value === null || value === "" ? null : (
              <input type="hidden" name={name} value={String(value)} />
            ),
          )}
          <InvoiceTable rows={list.rows} selectable />
          <div class="inline">
            <Field label="支払日" name="paidOn" required>
              <Input name="paidOn" type="date" value={toBusinessDate(new Date())} />
            </Field>
            <button type="submit" class="btn btn-primary">
              選んだ請求書の残りを支払う
            </button>
          </div>
        </form>
      ) : (
        <InvoiceTable rows={list.rows} />
      )}
      <Pagination
        page={list.page}
        pageSize={list.pageSize}
        total={list.total}
        href={(p) => paths.payables({ ...query, page: p })}
      />
    </section>
  );
}

payableRoutes.get("/", async (c) => {
  const f = filterFrom((name) => c.req.query(name) ?? "");
  const page = Math.max(1, Number(c.req.query("page") ?? "1") || 1);
  const suppliers = await supplierOptions(c);
  return c.html(
    <Layout title="支払予定" actor={c.get("actor")} current={paths.payables()}>
      <PageHeader
        title="支払予定"
        actions={
          <a class="btn btn-secondary" href={paths.supplierInvoices()}>
            仕入先請求書の一覧
          </a>
        }
      />
      <Tabs current="list" />
      <form
        class="filters"
        method="get"
        action={paths.payables()}
        hx-get={paths.payables()}
        hx-target="#results"
        hx-select="#results"
        hx-swap="outerHTML"
        hx-push-url="true"
        hx-trigger="change"
      >
        <Field label="状態" name="status">
          <Select
            name="status"
            value={f.status}
            options={STATUS_OPTIONS}
            empty="未払い・一部支払"
          />
        </Field>
        <Field label="仕入先" name="supplierId">
          <Select name="supplierId" value={f.supplierId} options={suppliers} empty="すべて" />
        </Field>
        <Field label="支払予定日（から）" name="dueFrom">
          <Input name="dueFrom" type="date" value={f.dueFrom} />
        </Field>
        <Field label="支払予定日（まで）" name="dueTo">
          <Input name="dueTo" type="date" value={f.dueTo} />
        </Field>
        <Checkbox name="overdue" value="1" label="支払予定日を過ぎたものだけ" checked={f.overdue} />
        <noscript>
          <button type="submit" class="btn btn-secondary">
            表示
          </button>
        </noscript>
      </form>
      {await Results({ c, filter: f, page })}
    </Layout>,
  );
});

/** 一括支払い。結果（または支払えなかった理由）と、支払った後の一覧を返す */
payableRoutes.post("/pay", async (c) => {
  const form = await readForm(c);
  const f = filterFrom((name) => str(form, name));
  const invoices = strs(form, "invoice").map((v) => {
    const [id = "", version = ""] = v.split(":");
    return { id, version: /^\d+$/.test(version) ? Number(version) : 0 };
  });
  const result = await runCommand(
    c,
    "supplierInvoices.payBulk",
    { invoices, paidOn: str(form, "paidOn"), memo: "" },
    formKey(form),
  );
  return c.html(
    await Results({
      c,
      filter: f,
      page: 1,
      result: result.ok ? { count: result.value.count, amount: result.value.amount } : null,
      error: result.ok ? null : result.error,
    }),
  );
});

payableRoutes.post("/csv", async (c) => {
  const form = await readForm(c);
  return exportCsv(
    c,
    "payables",
    filterFrom((name) => str(form, name)),
    formKey(form),
  );
});

// ---- 買掛残高 -------------------------------------------------------------------

function balanceFilter(c: Context<AppEnv>) {
  const month = (name: string) => {
    const v = c.req.query(name) ?? "";
    return /^\d{4}-(0[1-9]|1[0-2])$/.test(v) ? v : undefined;
  };
  return {
    from: month("from"),
    to: month("to"),
    supplierId: c.req.query("supplierId") || undefined,
  };
}

payableRoutes.get("/balances", async (c) => {
  const f = balanceFilter(c);
  const [data, suppliers] = await Promise.all([
    runQuery(c, "payables.balances", f),
    supplierOptions(c),
  ]);
  return c.html(
    <Layout title="買掛残高" actor={c.get("actor")} current={paths.payables()}>
      <PageHeader title="買掛残高">
        <p class="hint">
          月末の残高 = 前月末の残高 + その月の請求額（請求日の月）−
          その月の支払額（支払日の月）。取り消した請求書と支払は含めません。
        </p>
      </PageHeader>
      <Tabs current="balances" />
      <form
        class="filters"
        method="get"
        action={paths.payableBalances()}
        hx-get={paths.payableBalances()}
        hx-target="#results"
        hx-select="#results"
        hx-swap="outerHTML"
        hx-push-url="true"
        hx-trigger="change"
      >
        <Field label="仕入先" name="supplierId">
          <Select name="supplierId" value={f.supplierId} options={suppliers} empty="すべて" />
        </Field>
        <Field label="月（から）" name="from">
          <Input name="from" type="month" value={f.from ?? data.months[0]} />
        </Field>
        <Field label="月（まで）" name="to">
          <Input name="to" type="month" value={f.to ?? data.months.at(-1)} />
        </Field>
        <noscript>
          <button type="submit" class="btn btn-secondary">
            表示
          </button>
        </noscript>
      </form>
      <section id="results">
        <div class="toolbar">
          <a class="btn btn-secondary btn-sm" href={paths.payableBalancesCsv({ ...f })}>
            CSV 出力
          </a>
        </div>
        {data.rows.length === 0 ? (
          <EmptyState message="この期間の買掛はありません" />
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>仕入先</th>
                  <th class="num">前月末の残高</th>
                  {data.months.map((m) => (
                    <th class="num">{m}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr>
                    <td>
                      <a href={paths.payables({ supplierId: r.supplierId })}>{r.supplierName}</a>
                    </td>
                    <td class="num">{yen(r.opening)}</td>
                    {r.months.map((m) => (
                      <td class="num">
                        <strong>{yen(m.balance)}</strong>
                        <div class="muted small">
                          請求 {yen(m.invoiced)}・支払 {yen(m.paid)}
                        </div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Layout>,
  );
});

/** 買掛残高の CSV（仕入先 × 月の行。小さな表なのでその場で返す） */
payableRoutes.get("/balances.csv", async (c) => {
  const data = await runQuery(c, "payables.balances", balanceFilter(c));
  const rows: CsvValue[][] = data.rows.flatMap((r) =>
    r.months.map((m) => [r.supplierName, m.month, m.invoiced, m.paid, m.balance]),
  );
  return csvResponse(
    c,
    `買掛残高_${toBusinessDate(new Date())}.csv`,
    ["仕入先", "月", "請求額", "支払額", "月末の残高"],
    rows,
  );
});
