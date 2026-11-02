/**
 * 操作履歴の検索（要件定義書 7章 セキュリティ：状態を変える操作はすべて、誰が・いつ・何を・
 * 変更前後の値を記録し、管理者が検索できる）。管理者だけが使う。
 */
import { Hono } from "hono";

import {
  AUDIT_ACTION_LABELS,
  AUDIT_ENTITY_LABELS,
  auditLabel,
  type AuditChanges,
} from "../../../domain/audit";
import type { DomainError } from "../../../domain/result";
import type { AuditLogEntry } from "../../../usecases/platform/audit-logs";
import { requirePermission } from "../../middleware";
import { paths, type Query } from "../../paths";
import type { AppEnv } from "../../types";
import { queryAs, runQuery } from "../../usecase";
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
import { dateTime } from "../../views/format";
import { Layout } from "../../views/layout";

export const auditLogRoutes = new Hono<AppEnv>();

auditLogRoutes.use("*", requirePermission("platform.admin"));

const byLabel = (labels: Readonly<Record<string, string>>) =>
  Object.entries(labels)
    .map(([value, label]) => ({ value, label }))
    .toSorted((a, b) => a.label.localeCompare(b.label, "ja"));

const ENTITY_OPTIONS = byLabel(AUDIT_ENTITY_LABELS);
const ACTION_OPTIONS = byLabel(AUDIT_ACTION_LABELS);

/** 対象の画面（ある場合だけリンクにする） */
const ENTITY_LINKS: Readonly<Record<string, (id: string) => string>> = {
  purchase_order: paths.purchaseOrder,
  supplier_invoice: paths.supplierInvoice,
  sales_order: paths.salesOrder,
  invoice: paths.invoice,
  sales_return: paths.salesReturn,
  customer_payment: paths.customerReceipt,
  disposal: paths.disposal,
  stock_operation: paths.stockOperation,
  item: paths.item,
  partner: paths.partner,
  location: paths.location,
  retail_store: paths.store,
  genre: paths.genre,
  employee: paths.employee,
  document: paths.document,
  job: paths.job,
};

/** URL のクエリから検索条件を作る（名前は画面のフォームと同じ） */
function filterFrom(get: (name: string) => string) {
  const text = (name: string) => get(name).trim() || undefined;
  return {
    dateFrom: text("dateFrom"),
    dateTo: text("dateTo"),
    employeeId: text("employeeId"),
    entityType: text("entityType"),
    target: text("target"),
    action: text("action"),
  };
}

function FilterError(props: { error: DomainError }) {
  const fields = props.error.fields ?? [];
  return (
    <Alert kind="error">
      <strong>{props.error.message}</strong>
      {fields.length > 0 ? (
        <ul>
          {fields.map((f) => (
            <li>{f.message}</li>
          ))}
        </ul>
      ) : null}
    </Alert>
  );
}

/** 項目ごとの変更前後（少なければ開いたまま、多ければ畳んで出す） */
function Changes(props: { changes: AuditChanges }) {
  const { changes, omitted } = props.changes;
  if (changes.length === 0) return <span class="muted">（記録なし）</span>;
  return (
    <details class="disclosure" open={changes.length <= 5}>
      <summary>{changes.length + omitted} 項目</summary>
      <table class="table">
        <thead>
          <tr>
            <th>項目</th>
            <th>変更前</th>
            <th>変更後</th>
          </tr>
        </thead>
        <tbody>
          {changes.map((c) => (
            <tr>
              <td class="nowrap small">{c.path === "" ? "値" : c.path}</td>
              <td class="pre">{c.before ?? <span class="muted">—</span>}</td>
              <td class="pre">{c.after ?? <span class="muted">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {omitted > 0 ? <p class="hint">ほか {omitted} 項目は省きました</p> : null}
    </details>
  );
}

function Target(props: { row: AuditLogEntry }) {
  const link = ENTITY_LINKS[props.row.entityType];
  return (
    <>
      <div>{auditLabel(AUDIT_ENTITY_LABELS, props.row.entityType)}</div>
      <div class="small">
        {link ? (
          <a href={link(props.row.entityId)}>{props.row.entityId}</a>
        ) : (
          <span class="muted">{props.row.entityId}</span>
        )}
      </div>
    </>
  );
}

function ResultsTable(props: { rows: readonly AuditLogEntry[] }) {
  return (
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>日時</th>
            <th>操作した人</th>
            <th>対象</th>
            <th>操作</th>
            <th>変更前後</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((r) => (
            <tr>
              <td class="nowrap">{dateTime(r.occurredAt)}</td>
              <td>{r.employeeName ?? <span class="muted">{r.employeeId}</span>}</td>
              <td>
                <Target row={r} />
              </td>
              <td>
                <div>{auditLabel(AUDIT_ACTION_LABELS, r.action)}</div>
                <div class="small muted">{r.command}</div>
              </td>
              <td>
                <Changes changes={r.changes} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

auditLogRoutes.get("/", async (c) => {
  const filter = filterFrom((name) => c.req.query(name) ?? "");
  const page = Math.max(1, Number(c.req.query("page") ?? "1") || 1);
  const result = await queryAs(c.env, c.get("actorRef"), "auditLogs.search", {
    ...filter,
    page,
    pageSize: 50,
  });
  if (!result.ok && result.error.code !== "validation") {
    return c.text(result.error.message, result.error.code === "forbidden" ? 403 : 400);
  }
  const errors = result.ok ? {} : toFormErrors(result.error);
  const employees = await runQuery(c, "employees.list", {});
  const employeeOptions = [
    ...employees.map((e) => ({ value: e.id, label: e.active ? e.name : `${e.name}（無効）` })),
    { value: "system", label: "システム" },
  ];
  const query: Query = { ...filter };
  return c.html(
    <Layout title="操作履歴" actor={c.get("actor")} current={paths.auditLogs()}>
      <PageHeader title="操作履歴">
        <p class="muted">
          状態を変えた操作を、誰が・いつ・何を・変更前後の値で探せます（新しい順）。
        </p>
      </PageHeader>
      <form
        class="filters"
        method="get"
        action={paths.auditLogs()}
        hx-get={paths.auditLogs()}
        hx-target="#results"
        hx-select="#results"
        hx-swap="outerHTML"
        hx-push-url="true"
        hx-trigger="change, input changed delay:400ms from:input[type=search]"
      >
        <Field label="日付（から）" name="dateFrom" error={errors["dateFrom"]}>
          <Input name="dateFrom" type="date" value={filter.dateFrom} />
        </Field>
        <Field label="日付（まで）" name="dateTo" error={errors["dateTo"]}>
          <Input name="dateTo" type="date" value={filter.dateTo} />
        </Field>
        <Field label="操作した人" name="employeeId">
          <Select
            name="employeeId"
            value={filter.employeeId ?? ""}
            options={employeeOptions}
            empty="すべて"
          />
        </Field>
        <Field label="対象" name="entityType">
          <Select
            name="entityType"
            value={filter.entityType ?? ""}
            options={ENTITY_OPTIONS}
            empty="すべて"
          />
        </Field>
        <Field
          label="対象の番号・ID"
          name="target"
          error={errors["target"]}
          hint="PO-2026-000123 などの番号、商品コード、ID"
        >
          <Input name="target" type="search" value={filter.target} maxlength={100} />
        </Field>
        <Field label="操作" name="action">
          <Select
            name="action"
            value={filter.action ?? ""}
            options={ACTION_OPTIONS}
            empty="すべて"
          />
        </Field>
        <noscript>
          <button type="submit" class="btn btn-secondary">
            検索
          </button>
        </noscript>
      </form>
      <section id="results">
        {result.ok ? null : <FilterError error={result.error} />}
        {!result.ok || result.value.rows.length === 0 ? (
          <EmptyState message="条件に合う操作履歴はありません" />
        ) : (
          <ResultsTable rows={result.value.rows} />
        )}
        {result.ok ? (
          <Pagination
            page={result.value.page}
            pageSize={result.value.pageSize}
            total={result.value.total}
            href={(p) => paths.auditLogs({ ...query, page: p })}
          />
        ) : null}
      </section>
    </Layout>,
  );
});
