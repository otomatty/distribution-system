/**
 * 売掛残高と入金予定（要件定義書 3.11、5章 売掛残高・入金予定）。
 * - 売掛残高：販売先ごとの請求残高・期限超過・入金の未消込残高・差し引きの残高
 * - 入金予定：未入金・一部入金の請求書を支払期限の順に。期限を過ぎたものを強調する
 * どちらも CSV で出力できる。
 */
import { Hono, type Context } from "hono";

import { exportCsv } from "../../csv-exports";
import { formKey, readForm, str } from "../../form";
import { hasPermission } from "../../middleware";
import { paths, type Query } from "../../paths";
import type { AppEnv } from "../../types";
import { queryAs, runQuery } from "../../usecase";
import { InvoiceStatusBadge } from "../../views/billing";
import {
  Alert,
  Checkbox,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Pagination,
  Select,
  type Option,
} from "../../views/components";
import { CsvButton } from "../../views/csv-button";
import { yen } from "../../views/format";
import { Layout } from "../../views/layout";

export const receivableRoutes = new Hono<AppEnv>();

async function customerOptions(c: Context<AppEnv>): Promise<Option[]> {
  const customers = await runQuery(c, "partners.options", { role: "customer" });
  return customers.map((p) => ({ value: p.id, label: p.name }));
}

function Tabs(props: { current: "balances" | "schedule" }) {
  return (
    <nav class="tabs" aria-label="売掛">
      <a
        href={paths.receivables()}
        aria-current={props.current === "balances" ? "page" : undefined}
      >
        売掛残高
      </a>
      <a
        href={paths.receiptSchedule()}
        aria-current={props.current === "schedule" ? "page" : undefined}
      >
        入金予定
      </a>
    </nav>
  );
}

function Header(props: { c: Context<AppEnv> }) {
  return (
    <PageHeader
      title="売掛残高・入金予定"
      actions={
        hasPermission(props.c.get("actor").roles, "payments.manage") ? (
          <a class="btn btn-primary" href={paths.customerReceiptNew()}>
            入金を記録
          </a>
        ) : null
      }
    >
      <p class="muted">
        売掛残高は、発行した請求書の残高から、まだ請求書に消し込んでいない入金を差し引いた額です（未請求の発送は含みません）。
      </p>
    </PageHeader>
  );
}

// ---- 売掛残高 -------------------------------------------------------------------

function balanceFilter(get: (name: string) => string) {
  return { customerId: get("customerId").trim() || undefined };
}

receivableRoutes.get("/", async (c) => {
  const filter = balanceFilter((name) => c.req.query(name) ?? "");
  const page = Math.max(1, Number(c.req.query("page") ?? "1") || 1);
  const [result, customers] = await Promise.all([
    queryAs(c.env, c.get("actorRef"), "receivables.balances", { ...filter, page, pageSize: 50 }),
    customerOptions(c),
  ]);
  const query: Query = filter;
  return c.html(
    <Layout title="売掛残高" actor={c.get("actor")} current={paths.receivables()}>
      <Header c={c} />
      <Tabs current="balances" />
      <form
        class="filters"
        method="get"
        action={paths.receivables()}
        hx-get={paths.receivables()}
        hx-target="#results"
        hx-select="#results"
        hx-swap="outerHTML"
        hx-push-url="true"
        hx-trigger="change"
      >
        <Field label="販売先" name="customerId">
          <Select name="customerId" value={filter.customerId} options={customers} empty="すべて" />
        </Field>
        <noscript>
          <button type="submit" class="btn btn-secondary">
            検索
          </button>
        </noscript>
      </form>
      <section id="results">
        <div class="toolbar">
          <CsvButton action={paths.receivablesCsv()} filters={query} />
        </div>
        {!result.ok ? (
          <Alert kind="error">{result.error.message}</Alert>
        ) : result.value.rows.length === 0 ? (
          <EmptyState message="売掛残高のある販売先はありません" />
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>販売先</th>
                  <th class="num">請求残高</th>
                  <th class="num">うち期限超過</th>
                  <th class="num">未消込の入金</th>
                  <th class="num">売掛残高</th>
                  <th class="num">未入金の請求書</th>
                  <th>次の支払期限</th>
                </tr>
              </thead>
              <tbody>
                {result.value.rows.map((r) => (
                  <tr class={r.overdue > 0 ? "row-danger" : undefined}>
                    <td>
                      <a href={paths.receiptSchedule({ customerId: r.customerId })}>
                        {r.customerName}
                      </a>
                    </td>
                    <td class="num">{yen(r.billed)}</td>
                    <td class="num">
                      {r.overdue > 0 ? <strong class="text-danger">{yen(r.overdue)}</strong> : ""}
                    </td>
                    <td class="num">
                      {r.unallocated > 0 ? (
                        <a
                          href={paths.customerReceipts({
                            customerId: r.customerId,
                            unallocated: 1,
                          })}
                        >
                          {yen(r.unallocated)}
                        </a>
                      ) : (
                        ""
                      )}
                    </td>
                    <td class="num">
                      <strong>{yen(r.balance)}</strong>
                    </td>
                    <td class="num">
                      {r.openCount}
                      {r.overdueCount > 0 ? `（超過 ${r.overdueCount}）` : ""}
                    </td>
                    <td class="nowrap">{r.nextDueOn ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {result.ok ? (
          <Pagination
            page={result.value.page}
            pageSize={result.value.pageSize}
            total={result.value.total}
            href={(p) => paths.receivables({ ...query, page: p })}
          />
        ) : null}
      </section>
    </Layout>,
  );
});

receivableRoutes.post("/csv", async (c) => {
  const form = await readForm(c);
  return exportCsv(
    c,
    "receivables",
    balanceFilter((name) => str(form, name)),
    formKey(form),
  );
});

// ---- 入金予定 -------------------------------------------------------------------

function scheduleFilter(get: (name: string) => string) {
  return {
    customerId: get("customerId").trim() || undefined,
    dueTo: get("dueTo").trim() || undefined,
    overdue: get("overdue") === "1",
  };
}

receivableRoutes.get("/schedule", async (c) => {
  const filter = scheduleFilter((name) => c.req.query(name) ?? "");
  const page = Math.max(1, Number(c.req.query("page") ?? "1") || 1);
  const [result, customers] = await Promise.all([
    queryAs(c.env, c.get("actorRef"), "receivables.schedule", { ...filter, page, pageSize: 50 }),
    customerOptions(c),
  ]);
  const query: Query = { ...filter, overdue: filter.overdue ? 1 : undefined };
  return c.html(
    <Layout title="入金予定" actor={c.get("actor")} current={paths.receivables()}>
      <Header c={c} />
      <Tabs current="schedule" />
      <form
        class="filters"
        method="get"
        action={paths.receiptSchedule()}
        hx-get={paths.receiptSchedule()}
        hx-target="#results"
        hx-select="#results"
        hx-swap="outerHTML"
        hx-push-url="true"
        hx-trigger="change"
      >
        <Field label="販売先" name="customerId">
          <Select name="customerId" value={filter.customerId} options={customers} empty="すべて" />
        </Field>
        <Field label="支払期限（まで）" name="dueTo">
          <Input name="dueTo" type="date" value={filter.dueTo} />
        </Field>
        <Checkbox name="overdue" value="1" label="期限を過ぎたものだけ" checked={filter.overdue} />
        <noscript>
          <button type="submit" class="btn btn-secondary">
            検索
          </button>
        </noscript>
      </form>
      <section id="results">
        <div class="toolbar">
          <CsvButton action={paths.receiptScheduleCsv()} filters={query} />
        </div>
        {!result.ok ? (
          <Alert kind="error">{result.error.message}</Alert>
        ) : result.value.rows.length === 0 ? (
          <EmptyState message="入金予定の請求書はありません" />
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>支払期限</th>
                  <th>請求書番号</th>
                  <th>状態</th>
                  <th>販売先</th>
                  <th>発行日</th>
                  <th class="num">合計（税込）</th>
                  <th class="num">残高</th>
                </tr>
              </thead>
              <tbody>
                {result.value.rows.map((r) => (
                  <tr class={r.overdue ? "row-danger" : undefined}>
                    <td class="nowrap">
                      {r.overdue ? <strong>{r.dueOn}</strong> : (r.dueOn ?? "（期限なし）")}
                    </td>
                    <td class="nowrap">
                      <a href={paths.invoice(r.id)}>{r.number}</a>
                    </td>
                    <td>
                      <InvoiceStatusBadge status={r.status} overdue={r.overdue} />
                    </td>
                    <td>{r.customerName}</td>
                    <td class="nowrap">{r.issuedOn}</td>
                    <td class="num">{yen(r.total)}</td>
                    <td class="num">{yen(r.outstanding)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {result.ok ? (
          <Pagination
            page={result.value.page}
            pageSize={result.value.pageSize}
            total={result.value.total}
            href={(p) => paths.receiptSchedule({ ...query, page: p })}
          />
        ) : null}
      </section>
    </Layout>,
  );
});

receivableRoutes.post("/schedule/csv", async (c) => {
  const form = await readForm(c);
  return exportCsv(
    c,
    "receiptSchedule",
    scheduleFilter((name) => str(form, name)),
    formKey(form),
  );
});
