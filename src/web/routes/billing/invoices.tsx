/**
 * 請求書（要件定義書 3.10、5章 請求書一覧・詳細、締め処理）。
 * 一覧（絞り込み・CSV）、未請求の発送と発送ごとの発行、締め処理（確認してから1つのトランザクションで一括発行、一括 PDF）、
 * 詳細（明細・税率ごとの合計・消込・帳票と送付、取消と再発行）。
 */
import { Hono, type Context } from "hono";
import type { Child } from "hono/jsx";

import { toBusinessDate } from "../../../domain/dates";
import type { DomainError } from "../../../domain/result";
import { INVOICE_STATUS_LABELS, ALLOCATION_ADJUSTMENT_LABELS } from "../../../domain/sales";
import type {
  ClosingCandidate,
  ClosingSelection,
  InvoiceDraft,
  InvoiceView,
  IssuedInvoice,
} from "../../../usecases/billing/invoices";
import { exportCsv } from "../../csv-exports";
import { formKey, readForm, str, strs, type FormData_ } from "../../form";
import { isHtmx, NOTICES, redirectTo } from "../../http";
import { hasPermission } from "../../middleware";
import { paths, type Query } from "../../paths";
import type { AppEnv } from "../../types";
import { queryAs, runCommand, runQuery } from "../../usecase";
import {
  DocumentLinks,
  InvoiceLinesTable,
  InvoiceStatusBadge,
  paymentMethodLabel,
} from "../../views/billing";
import {
  Alert,
  Badge,
  Checkbox,
  DescriptionList,
  EmptyState,
  ErrorSummary,
  Field,
  FormKey,
  Input,
  PageHeader,
  Pagination,
  Select,
  TextArea,
  toFormErrors,
  Version,
  type FormErrors,
  type Option,
} from "../../views/components";
import { CsvButton } from "../../views/csv-button";
import { dateTime, yen } from "../../views/format";
import { Layout } from "../../views/layout";

export const invoiceRoutes = new Hono<AppEnv>();

const INVOICE_NOTICES: Readonly<Record<string, string>> = {
  ...NOTICES,
  issued: "請求書を発行しました（PDF はこの後に作成します）",
  cancelled: "請求書を取り消しました。対象の発送・返品伝票は未請求に戻りました",
  reissued: "請求書を取り消して再発行しました（PDF はこの後に作成します）",
};

const STATUS_OPTIONS: Option[] = [
  { value: "open", label: "未入金・一部入金" },
  ...(["unpaid", "partial", "paid", "cancelled"] as const).map((s) => ({
    value: s,
    label: INVOICE_STATUS_LABELS[s],
  })),
];

const STATUSES = ["open", "unpaid", "partial", "paid", "cancelled"] as const;

async function customerOptions(c: Context<AppEnv>): Promise<Option[]> {
  const customers = await runQuery(c, "partners.options", { role: "customer" });
  return customers.map((p) => ({ value: p.id, label: p.name }));
}

/** 「ID:版番号」の形の値（チェックボックスや hidden で発送・返品伝票を版番号つきで送る） */
function ref(id: string, version: number): string {
  return `${id}:${version}`;
}

function parseRefs(values: readonly string[]): { id: string; version: number }[] {
  return values.flatMap((v) => {
    const i = v.lastIndexOf(":");
    const version = Number(v.slice(i + 1));
    return i > 0 && Number.isInteger(version) ? [{ id: v.slice(0, i), version }] : [];
  });
}

// ---- 一覧 ---------------------------------------------------------------------

function filterFrom(get: (name: string) => string) {
  const text = (name: string) => get(name).trim() || undefined;
  return {
    status: STATUSES.find((s) => s === get("status")),
    customerId: text("customerId"),
    issuedFrom: text("issuedFrom"),
    issuedTo: text("issuedTo"),
    q: text("q"),
    overdue: get("overdue") === "1",
    sendFailed: get("sendFailed") === "1",
  };
}

type Filter = ReturnType<typeof filterFrom>;

function filterQuery(f: Filter): Query {
  return { ...f, overdue: f.overdue ? 1 : undefined, sendFailed: f.sendFailed ? 1 : undefined };
}

invoiceRoutes.get("/", async (c) => {
  const filter = filterFrom((name) => c.req.query(name) ?? "");
  const page = Math.max(1, Number(c.req.query("page") ?? "1") || 1);
  const [result, customers] = await Promise.all([
    queryAs(c.env, c.get("actorRef"), "invoices.list", { ...filter, page, pageSize: 50 }),
    customerOptions(c),
  ]);
  const query = filterQuery(filter);
  const canManage = hasPermission(c.get("actor").roles, "invoices.manage");
  const notice = INVOICE_NOTICES[c.req.query("notice") ?? ""];
  return c.html(
    <Layout title="請求書一覧" actor={c.get("actor")} current={paths.invoices()}>
      <PageHeader
        title="請求書一覧"
        actions={
          <>
            <a class="btn btn-secondary" href={paths.invoiceNew()}>
              未請求の発送{canManage ? "から発行" : ""}
            </a>
            <a
              class={canManage ? "btn btn-primary" : "btn btn-secondary"}
              href={paths.invoiceClosing()}
            >
              締め処理
            </a>
          </>
        }
      />
      {notice ? <Alert kind="success">{notice}</Alert> : null}
      <form
        class="filters"
        method="get"
        action={paths.invoices()}
        hx-get={paths.invoices()}
        hx-target="#results"
        hx-select="#results"
        hx-swap="outerHTML"
        hx-push-url="true"
        hx-trigger="input changed delay:300ms from:input[name=q], change"
      >
        <Field label="請求書番号" name="q">
          <Input name="q" type="search" value={filter.q} />
        </Field>
        <Field label="状態" name="status">
          <Select name="status" value={filter.status} options={STATUS_OPTIONS} empty="すべて" />
        </Field>
        <Field label="販売先" name="customerId">
          <Select name="customerId" value={filter.customerId} options={customers} empty="すべて" />
        </Field>
        <Field label="発行日（から）" name="issuedFrom">
          <Input name="issuedFrom" type="date" value={filter.issuedFrom} />
        </Field>
        <Field label="発行日（まで）" name="issuedTo">
          <Input name="issuedTo" type="date" value={filter.issuedTo} />
        </Field>
        <Checkbox
          name="overdue"
          value="1"
          label="支払期限を過ぎたものだけ"
          checked={filter.overdue}
        />
        <Checkbox
          name="sendFailed"
          value="1"
          label="送付に失敗したものだけ"
          checked={filter.sendFailed}
        />
        <noscript>
          <button type="submit" class="btn btn-secondary">
            検索
          </button>
        </noscript>
      </form>
      <section id="results">
        <div class="toolbar">
          <CsvButton action={paths.invoicesCsv()} filters={query} />
        </div>
        {!result.ok ? (
          <Alert kind="error">{result.error.message}</Alert>
        ) : result.value.rows.length === 0 ? (
          <EmptyState message="条件に合う請求書はありません" />
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>請求書番号</th>
                  <th>状態</th>
                  <th>販売先</th>
                  <th>発行日</th>
                  <th>締め期間</th>
                  <th>支払期限</th>
                  <th class="num">合計（税込）</th>
                  <th class="num">残高</th>
                  <th>帳票</th>
                </tr>
              </thead>
              <tbody>
                {result.value.rows.map((i) => (
                  <tr
                    class={
                      i.overdue ? "row-danger" : i.status === "cancelled" ? "row-muted" : undefined
                    }
                  >
                    <td class="nowrap">
                      <a href={paths.invoice(i.id)}>{i.number}</a>
                    </td>
                    <td>
                      <InvoiceStatusBadge status={i.status} overdue={i.overdue} />
                    </td>
                    <td>{i.customerName}</td>
                    <td class="nowrap">{i.issuedOn}</td>
                    <td class="nowrap small">
                      {i.periodFrom && i.periodTo ? `${i.periodFrom}〜${i.periodTo}` : "発送ごと"}
                    </td>
                    <td class="nowrap">{i.dueOn ?? ""}</td>
                    <td class="num">{yen(i.total)}</td>
                    <td class="num">{i.status === "cancelled" ? "" : yen(i.outstanding)}</td>
                    <td class="small">
                      {i.document ? (
                        <a href={paths.document(i.document.documentId)}>
                          {i.document.lastSendStatus === "failed"
                            ? "送付失敗"
                            : i.document.lastSendStatus === "sent"
                              ? "送付済み"
                              : "未送付"}
                        </a>
                      ) : null}
                    </td>
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
            href={(p) => paths.invoices({ ...query, page: p })}
          />
        ) : null}
      </section>
    </Layout>,
  );
});

invoiceRoutes.post("/csv", async (c) => {
  const form = await readForm(c);
  return exportCsv(
    c,
    "invoices",
    filterFrom((name) => str(form, name)),
    formKey(form),
  );
});

// ---- 未請求の発送と、発送ごとの発行 ------------------------------------------------------

function UnbilledPage(props: {
  c: Context<AppEnv>;
  customerId: string | undefined;
  billing: "per_shipment" | "closing" | undefined;
  page: number;
  customers: readonly Option[];
  result: Awaited<ReturnType<typeof queryAs<"invoices.unbilled">>>;
  canManage: boolean;
}) {
  const { result } = props;
  const query = { customerId: props.customerId, billing: props.billing };
  return (
    <Layout title="未請求の発送" actor={props.c.get("actor")} current={paths.invoices()}>
      <PageHeader
        title="未請求の発送"
        actions={
          <a class="btn btn-secondary" href={paths.invoiceClosing()}>
            締め処理
          </a>
        }
      >
        <p class="muted">
          締め日のない販売先は、発送ごとに請求書を発行します。締め日のある販売先は締め処理でまとめて発行します。
        </p>
      </PageHeader>
      <form
        class="filters"
        method="get"
        action={paths.invoiceNew()}
        hx-get={paths.invoiceNew()}
        hx-target="#results"
        hx-select="#results"
        hx-swap="outerHTML"
        hx-push-url="true"
        hx-trigger="change"
      >
        <Field label="販売先" name="customerId">
          <Select
            name="customerId"
            value={props.customerId}
            options={props.customers}
            empty="すべて"
          />
        </Field>
        <Field label="請求の方法" name="billing">
          <Select
            name="billing"
            value={props.billing}
            options={[
              { value: "per_shipment", label: "発送ごと（締め日なし）" },
              { value: "closing", label: "締め処理（締め日あり）" },
            ]}
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
        {!result.ok ? (
          <Alert kind="error">{result.error.message}</Alert>
        ) : result.value.rows.length === 0 ? (
          <EmptyState message="未請求の発送はありません" />
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>発送日</th>
                  <th>納品書番号</th>
                  <th>受注番号</th>
                  <th>販売先</th>
                  <th class="num">金額（税込）</th>
                  <th>請求</th>
                </tr>
              </thead>
              <tbody>
                {result.value.rows.map((s) => (
                  <tr>
                    <td class="nowrap">{s.shippedOn}</td>
                    <td class="nowrap">{s.deliveryNoteNumber}</td>
                    <td class="nowrap">
                      <a href={paths.salesOrder(s.salesOrderId)}>{s.salesOrderNumber}</a>
                    </td>
                    <td>{s.customerName}</td>
                    <td class="num">{yen(s.total)}</td>
                    <td>
                      {s.billing === "closing" ? (
                        <a href={paths.invoiceClosing({ customerId: s.customerId })}>
                          締め処理で発行
                        </a>
                      ) : props.canManage ? (
                        <a
                          class="btn btn-primary btn-sm"
                          href={paths.invoiceNew({ shipmentId: s.shipmentId })}
                        >
                          請求書を発行
                        </a>
                      ) : (
                        "発送ごと"
                      )}
                    </td>
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
            href={(p) => paths.invoiceNew({ ...query, page: p })}
          />
        ) : null}
      </section>
    </Layout>
  );
}

/** 見積もり（明細と税率ごとの合計）。載せる返品伝票を選び直すと、この部分だけを差し替える */
function DraftPreview(props: { draft: InvoiceDraft }) {
  const { draft } = props;
  return (
    <div id="invoice-preview" aria-live="polite">
      {draft.preview ? (
        <InvoiceLinesTable
          lines={draft.preview.lines}
          totals={{
            taxSummary: draft.preview.summary.groups,
            subtotal: draft.preview.summary.subtotal,
            tax: draft.preview.summary.tax,
            total: draft.preview.summary.total,
          }}
        />
      ) : (
        <Alert kind="warning">{draft.previewError ?? "請求書にできません"}</Alert>
      )}
    </div>
  );
}

function IssueForm(props: {
  draft: InvoiceDraft;
  values: { issuedOn: string; dueOn: string };
  error?: DomainError | undefined;
  errors?: FormErrors;
}) {
  const { draft } = props;
  const s = draft.shipment;
  const errors = props.errors ?? {};
  const selected = new Set(draft.selectedReturnIds);
  return (
    <form
      id="issue-form"
      class="form"
      method="post"
      action={paths.invoiceNew()}
      hx-post={paths.invoiceNew()}
      hx-target="this"
      hx-swap="outerHTML"
    >
      <ErrorSummary error={props.error} />
      <FormKey />
      <input type="hidden" name="shipmentId" value={s.shipmentId} />
      <input type="hidden" name="version" value={String(s.shipmentVersion)} />
      <section class="card">
        <DescriptionList
          items={[
            ["販売先", `${draft.customer.name} ${draft.customer.honorific}`],
            ["発送日", s.shippedOn],
            ["納品書番号", s.deliveryNoteNumber],
            ["受注番号", <a href={paths.salesOrder(s.salesOrderId)}>{s.salesOrderNumber}</a>],
          ]}
        />
      </section>
      {draft.returns.length > 0 ? (
        <fieldset
          class="card"
          hx-post={paths.invoiceNewPreview()}
          hx-trigger="change"
          hx-include="closest form"
          hx-target="#invoice-preview"
          hx-swap="outerHTML"
        >
          <legend>未請求の返品伝票（マイナスの明細として載せる）</legend>
          {draft.returns.map((r) => (
            <label class="checkbox">
              <input
                type="checkbox"
                name="returnRef"
                value={ref(r.id, r.version)}
                checked={selected.has(r.id)}
              />{" "}
              {r.number}（{r.returnedOn}・受注 {r.salesOrderNumber}）
            </label>
          ))}
          <input type="hidden" name="returnsShown" value="1" />
        </fieldset>
      ) : null}
      <section class="card">
        <h2>明細と金額</h2>
        <DraftPreview draft={draft} />
      </section>
      <div class="grid-2">
        <Field label="発行日" name="issuedOn" required error={errors["issuedOn"]}>
          <Input
            name="issuedOn"
            type="date"
            value={props.values.issuedOn}
            error={errors["issuedOn"]}
          />
        </Field>
        <Field
          label="支払期限"
          name="dueOn"
          error={errors["dueOn"]}
          hint="締め日のない販売先は取引条件がないので、必要なら入力してください"
        >
          <Input name="dueOn" type="date" value={props.values.dueOn} error={errors["dueOn"]} />
        </Field>
      </div>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary" disabled={draft.preview === null}>
          請求書を発行する
        </button>
        <a class="btn btn-secondary" href={paths.invoiceNew()}>
          やめる
        </a>
      </div>
    </form>
  );
}

function selectedReturnIds(form: FormData_): string[] | undefined {
  // 返品伝票の欄がない（未請求の返品がない）ときは、すべて（＝なし）を載せる
  if (str(form, "returnsShown") !== "1") return undefined;
  return parseRefs(strs(form, "returnRef")).map((r) => r.id);
}

async function issuePage(c: Context<AppEnv>, shipmentId: string) {
  const draft = await runQuery(c, "invoices.draft", { shipmentId });
  const canManage = hasPermission(c.get("actor").roles, "invoices.manage");
  const today = toBusinessDate(new Date());
  return c.html(
    <Layout title="請求書の発行" actor={c.get("actor")} current={paths.invoices()}>
      <PageHeader title="請求書の発行（発送ごと）" />
      {!draft ? (
        <Alert kind="warning">
          この発送はすでに請求書に載っているか、取り消されています。
          <a href={paths.invoiceNew()}>未請求の発送に戻る</a>
        </Alert>
      ) : draft.closing ? (
        <Alert kind="info">
          {draft.customer.name} は締め日のある販売先です。
          <a href={paths.invoiceClosing({ customerId: draft.customer.id })}>締め処理</a>
          でまとめて発行してください。
        </Alert>
      ) : !canManage ? (
        <Alert kind="warning">請求書を発行する権限がありません。</Alert>
      ) : (
        <IssueForm draft={draft} values={{ issuedOn: today, dueOn: "" }} />
      )}
    </Layout>,
  );
}

invoiceRoutes.get("/new", async (c) => {
  const shipmentId = c.req.query("shipmentId");
  if (shipmentId) return issuePage(c, shipmentId);
  const customerId = c.req.query("customerId") || undefined;
  const billingParam = c.req.query("billing");
  const billing =
    billingParam === "per_shipment" || billingParam === "closing" ? billingParam : undefined;
  const page = Math.max(1, Number(c.req.query("page") ?? "1") || 1);
  const [result, customers] = await Promise.all([
    queryAs(c.env, c.get("actorRef"), "invoices.unbilled", {
      customerId,
      billing,
      page,
      pageSize: 50,
    }),
    customerOptions(c),
  ]);
  return c.html(
    <UnbilledPage
      c={c}
      customerId={customerId}
      billing={billing}
      page={page}
      customers={customers}
      result={result}
      canManage={hasPermission(c.get("actor").roles, "invoices.manage")}
    />,
  );
});

invoiceRoutes.post("/new/preview", async (c) => {
  const form = await readForm(c);
  const draft = await runQuery(c, "invoices.draft", {
    shipmentId: str(form, "shipmentId"),
    returnIds: selectedReturnIds(form),
  });
  if (!draft) return c.html(<Alert kind="warning">この発送はもう請求書にできません。</Alert>);
  return c.html(<DraftPreview draft={draft} />);
});

invoiceRoutes.post("/new", async (c) => {
  const form = await readForm(c);
  const shipmentId = str(form, "shipmentId");
  const values = { issuedOn: str(form, "issuedOn"), dueOn: str(form, "dueOn") };
  const result = await runCommand(
    c,
    "invoices.issue",
    {
      shipmentId,
      version: Number(str(form, "version")) || 0,
      returns: parseRefs(strs(form, "returnRef")),
      issuedOn: values.issuedOn,
      dueOn: values.dueOn,
    },
    formKey(form),
  );
  if (result.ok) return redirectTo(c, paths.invoice(result.value.id, { notice: "issued" }));
  const draft = await runQuery(c, "invoices.draft", {
    shipmentId,
    returnIds: selectedReturnIds(form),
  });
  const body = draft ? (
    <IssueForm
      draft={draft}
      values={values}
      error={result.error}
      errors={toFormErrors(result.error)}
    />
  ) : (
    <Alert kind="error">{result.error.message}</Alert>
  );
  if (isHtmx(c)) return c.html(body);
  return c.html(
    <Layout title="請求書の発行" actor={c.get("actor")} current={paths.invoices()}>
      <PageHeader title="請求書の発行（発送ごと）" />
      {body}
    </Layout>,
    409,
  );
});

// ---- 締め処理 -------------------------------------------------------------------

function candidateTotal(c: ClosingCandidate): string {
  return c.summary ? yen(c.summary.total) : "—";
}

function ClosingTable(props: { candidates: readonly ClosingCandidate[]; canManage: boolean }) {
  return (
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>発行する</th>
            <th>販売先</th>
            <th>締め期間</th>
            <th class="num">発送</th>
            <th class="num">返品</th>
            <th class="num">請求額（税込）</th>
            <th>支払期限</th>
            <th>状況</th>
          </tr>
        </thead>
        <tbody>
          {props.candidates.map((c) => {
            const issuable = c.issuable;
            return (
              <tr class={c.error ? "row-warning" : !c.ready ? "row-muted" : undefined}>
                <td>
                  {props.canManage ? (
                    <input
                      class="big-check"
                      type="checkbox"
                      name="customerId"
                      value={c.customerId}
                      checked={issuable}
                      disabled={!issuable}
                      aria-label={`${c.customerName}の請求書を発行する`}
                    />
                  ) : null}
                </td>
                <td>{c.customerName}</td>
                <td class="nowrap">
                  {c.periodFrom}〜{c.periodTo}
                  <div class="muted small">
                    {c.closingDay === 31 ? "月末" : `${c.closingDay}日`}締め
                  </div>
                </td>
                <td class="num">{c.shipments.length}</td>
                <td class="num">{c.returns.length}</td>
                <td class="num">{candidateTotal(c)}</td>
                <td class="nowrap">{c.dueOn}</td>
                <td>
                  {c.error ? (
                    <span class="text-danger small">{c.error}</span>
                  ) : c.ready ? (
                    <Badge kind="warning">締め処理待ち</Badge>
                  ) : (
                    <Badge>締め日前</Badge>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ClosingResults(props: {
  candidates: readonly ClosingCandidate[];
  canManage: boolean;
  panel?: Child;
}) {
  const today = toBusinessDate(new Date());
  return (
    <section id="closing-results">
      {props.panel ?? null}
      {props.candidates.length === 0 ? (
        <EmptyState message="締め処理を待っている販売先はありません" />
      ) : (
        <form
          id="closing-form"
          method="post"
          action={paths.invoiceClosingConfirm()}
          hx-post={paths.invoiceClosingConfirm()}
          hx-target="#closing-panel"
          hx-swap="innerHTML"
        >
          <ClosingTable candidates={props.candidates} canManage={props.canManage} />
          {props.canManage ? (
            <>
              <Field
                label="発行日"
                name="issuedOn"
                hint="空欄なら販売先ごとの締め日を発行日にします"
              >
                <Input name="issuedOn" type="date" max={today} />
              </Field>
              <div class="form-actions">
                <button type="submit" class="btn btn-primary btn-lg">
                  選んだ販売先の請求書を発行する…
                </button>
              </div>
            </>
          ) : (
            <p class="muted">請求書を発行する権限がありません。</p>
          )}
        </form>
      )}
      <div id="closing-panel" aria-live="polite"></div>
    </section>
  );
}

function ClosingConfirm(props: {
  selection: ClosingSelection;
  issuedOn: string;
  error?: DomainError | undefined;
}) {
  const { targets, total } = props.selection;
  const n = targets.length;
  return (
    <div class="card confirm-panel" role="region" aria-label="締め処理の確認">
      <h2>締め処理の確認</h2>
      <ErrorSummary error={props.error} />
      {n === 0 ? (
        <>
          <p>発行できる販売先が選ばれていません。</p>
          <a class="btn btn-secondary btn-lg" href={paths.invoiceClosing()}>
            中止
          </a>
        </>
      ) : (
        <form
          method="post"
          action={paths.invoiceClosingRun()}
          hx-post={paths.invoiceClosingRun()}
          hx-target="#closing-results"
          hx-swap="outerHTML"
        >
          <FormKey />
          <input type="hidden" name="issuedOn" value={props.issuedOn} />
          {targets.map((t) => (
            <>
              <input type="hidden" name="customerId" value={t.customerId} />
              <input
                type="hidden"
                name={`period-${t.customerId}`}
                value={`${t.periodFrom}/${t.periodTo}`}
              />
              {t.shipments.map((s) => (
                <input
                  type="hidden"
                  name={`shipment-${t.customerId}`}
                  value={ref(s.id, s.version)}
                />
              ))}
              {t.returns.map((r) => (
                <input type="hidden" name={`return-${t.customerId}`} value={ref(r.id, r.version)} />
              ))}
            </>
          ))}
          <p class="confirm-count">
            <strong>{n} 件</strong>
            の請求書を発行します（請求額の合計 {yen(total)}
            ）。発行した請求書は、取消と再発行でしか直せません。
          </p>
          <ul class="small">
            {targets.map((t) => (
              <li>
                {t.customerName}：{t.periodFrom}〜{t.periodTo}、発送 {t.shipments.length} 件
                {t.returns.length > 0 ? `・返品 ${t.returns.length} 件` : ""}、{candidateTotal(t)}
              </li>
            ))}
          </ul>
          <p class="small">発行日：{props.issuedOn || "販売先ごとの締め日"}</p>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary btn-lg">
              {n} 件の請求書を発行する
            </button>
            <a class="btn btn-secondary btn-lg" href={paths.invoiceClosing()}>
              中止
            </a>
          </div>
        </form>
      )}
    </div>
  );
}

function BulkPdfButton(props: { invoiceIds: readonly string[]; name: string; label: string }) {
  if (props.invoiceIds.length === 0) return null;
  return (
    <form method="post" action={paths.invoicesBulkPdf()} class="inline">
      <FormKey />
      <input type="hidden" name="name" value={props.name} />
      {props.invoiceIds.map((id) => (
        <input type="hidden" name="invoiceId" value={id} />
      ))}
      <button type="submit" class="btn btn-secondary btn-lg">
        {props.label}
      </button>
    </form>
  );
}

function ClosedPanel(props: { issued: readonly IssuedInvoice[] }) {
  return (
    <div class="card" role="status">
      <Alert kind="success">
        {props.issued.length} 件の請求書を発行しました：
        {props.issued.map((i) => `${i.number}（${i.customerName}・${yen(i.total)}）`).join("、")}
      </Alert>
      <ul class="small">
        {props.issued.map((i) => (
          <li>
            <a href={paths.invoice(i.id)}>{i.number}</a> {i.customerName}
          </li>
        ))}
      </ul>
      <BulkPdfButton
        invoiceIds={props.issued.map((i) => i.id)}
        name={`請求書_${toBusinessDate(new Date())}`}
        label={`発行した ${props.issued.length} 件の請求書を一括で PDF にする`}
      />
    </div>
  );
}

async function closingCandidates(c: Context<AppEnv>, customerId?: string) {
  return (await runQuery(c, "invoices.closing", { customerId })).candidates;
}

/** 締め処理の候補と、選んだ販売先のうち締め処理できるもの・請求額の合計 */
async function closingSelection(c: Context<AppEnv>, selected: readonly string[]) {
  const r = await runQuery(c, "invoices.closing", { selected: [...selected] });
  return { candidates: r.candidates, selection: r.selection ?? { targets: [], total: 0 } };
}

invoiceRoutes.get("/closing", async (c) => {
  const customerId = c.req.query("customerId") || undefined;
  const candidates = await closingCandidates(c, customerId);
  const canManage = hasPermission(c.get("actor").roles, "invoices.manage");
  return c.html(
    <Layout title="締め処理" actor={c.get("actor")} current={paths.invoices()}>
      <PageHeader title="締め処理">
        <p class="muted">
          締め日のある販売先ごとに、最も古い未請求の発送の締め期間をまとめて請求書にします（繰越なし）。
          締め日までの未請求の返品伝票はマイナスの明細として載せます。
        </p>
      </PageHeader>
      {customerId ? (
        <p>
          <a href={paths.invoiceClosing()}>すべての販売先を表示する</a>
        </p>
      ) : null}
      <ClosingResults candidates={candidates} canManage={canManage} />
    </Layout>,
  );
});

invoiceRoutes.post("/closing/confirm", async (c) => {
  const form = await readForm(c);
  const { selection } = await closingSelection(c, strs(form, "customerId"));
  const panel = <ClosingConfirm selection={selection} issuedOn={str(form, "issuedOn")} />;
  if (isHtmx(c)) return c.html(panel);
  return c.html(
    <Layout title="締め処理" actor={c.get("actor")} current={paths.invoices()}>
      <PageHeader title="締め処理" />
      {panel}
    </Layout>,
  );
});

function targetsFrom(form: FormData_) {
  return strs(form, "customerId").map((customerId) => {
    const [periodFrom = "", periodTo = ""] = str(form, `period-${customerId}`).split("/");
    return {
      customerId,
      periodFrom,
      periodTo,
      shipments: parseRefs(strs(form, `shipment-${customerId}`)),
      returns: parseRefs(strs(form, `return-${customerId}`)),
    };
  });
}

invoiceRoutes.post("/closing/run", async (c) => {
  const form = await readForm(c);
  const targets = targetsFrom(form);
  const result = await runCommand(
    c,
    "invoices.close",
    { issuedOn: str(form, "issuedOn"), targets },
    formKey(form),
  );
  const { candidates, selection } = await closingSelection(
    c,
    targets.map((t) => t.customerId),
  );
  const canManage = hasPermission(c.get("actor").roles, "invoices.manage");
  const panel = result.ok ? (
    <ClosedPanel issued={result.value.issued} />
  ) : (
    <ClosingConfirm selection={selection} issuedOn={str(form, "issuedOn")} error={result.error} />
  );
  const body = <ClosingResults candidates={candidates} canManage={canManage} panel={panel} />;
  if (isHtmx(c)) return c.html(body);
  return c.html(
    <Layout title="締め処理" actor={c.get("actor")} current={paths.invoices()}>
      <PageHeader title="締め処理" />
      {body}
    </Layout>,
    result.ok ? 200 : 409,
  );
});

invoiceRoutes.post("/bulk-pdf", async (c) => {
  const form = await readForm(c);
  const result = await runCommand(
    c,
    "jobs.bulkDocuments",
    { documentType: "invoice", entityIds: strs(form, "invoiceId"), name: str(form, "name") },
    formKey(form),
  );
  if (!result.ok) return c.text(result.error.message, 400);
  return redirectTo(c, paths.jobs({ notice: "bulk" }));
});

// ---- 詳細 ---------------------------------------------------------------------

const ACTION_FIELD_LABELS: Readonly<Record<string, string>> = {
  reason: "理由",
  issuedOn: "発行日",
  dueOn: "支払期限",
};

function withFieldMessages(error: DomainError): DomainError {
  const fields = error.fields ?? [];
  if (fields.length === 0) return { code: error.code, message: error.message };
  return {
    code: error.code,
    message: error.message,
    details: fields.map((f) => `${ACTION_FIELD_LABELS[f.field] ?? f.field}：${f.message}`),
  };
}

function DetailBody(props: {
  view: InvoiceView;
  canManage: boolean;
  canAllocate: boolean;
  notice?: string | undefined;
  error?: DomainError | undefined;
}) {
  const { invoice: inv, actions } = props.view;
  return (
    <div id="invoice-detail">
      <PageHeader
        title={`請求書 ${inv.number}`}
        actions={
          actions.allocate && props.canAllocate ? (
            <a
              class="btn btn-primary"
              href={paths.customerReceiptNew({ customerId: inv.customerId })}
            >
              入金を記録して消し込む
            </a>
          ) : null
        }
      >
        <p>
          <InvoiceStatusBadge status={inv.status} overdue={props.view.overdue} />{" "}
          <Badge>{props.view.kind === "closing" ? "月締め" : "発送ごと"}</Badge>
        </p>
      </PageHeader>
      {props.notice ? <Alert kind="success">{props.notice}</Alert> : null}
      <ErrorSummary error={props.error ? withFieldMessages(props.error) : null} />
      <section class="card">
        <DescriptionList
          items={[
            ["販売先", inv.customerName],
            ["発行日", inv.issuedOn],
            [
              "締め期間",
              inv.periodFrom && inv.periodTo ? `${inv.periodFrom}〜${inv.periodTo}` : null,
            ],
            ["支払期限", inv.dueOn],
            ["合計（税込）", yen(inv.total)],
            ["消込済み（入金と差額）", yen(inv.allocated)],
            ["残高", inv.status === "cancelled" ? null : yen(props.view.outstanding)],
            [
              "再発行の元",
              inv.reissuedFromId ? (
                <a href={paths.invoice(inv.reissuedFromId)}>{inv.reissuedFromNumber}</a>
              ) : null,
            ],
            [
              "再発行した請求書",
              inv.reissuedTo.length > 0 ? (
                <>
                  {inv.reissuedTo.map((r) => (
                    <a href={paths.invoice(r.id)}>{r.number}</a>
                  ))}
                </>
              ) : null,
            ],
            ["取消の理由", inv.cancelReason],
            ["発行", dateTime(inv.createdAt)],
          ]}
        />
      </section>
      <section class="card">
        <h2>帳票と送付</h2>
        <DocumentLinks document={props.view.document} label="請求書" />
      </section>
      <section class="card">
        <h2>明細</h2>
        <InvoiceLinesTable lines={inv.lines} totals={inv} />
      </section>
      <section class="card">
        <h2>載せた発送と返品伝票</h2>
        {inv.shipments.length === 0 && inv.returns.length === 0 ? (
          <p class="muted">
            {inv.status === "cancelled"
              ? "取り消したので、対象の発送・返品伝票は未請求に戻っています。"
              : "—"}
          </p>
        ) : (
          <ul>
            {inv.shipments.map((s) => (
              <li>
                {s.shippedOn} 納品書 {s.deliveryNoteNumber}（受注{" "}
                <a href={paths.salesOrder(s.salesOrderId)}>{s.salesOrderNumber}</a>）
              </li>
            ))}
            {inv.returns.map((r) => (
              <li>
                {r.returnedOn} 返品伝票 <a href={paths.salesReturn(r.id)}>{r.number}</a>
                {r.creditNoteNumber ? `（返還請求書 ${r.creditNoteNumber}）` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section class="card">
        <h2>入金の消込</h2>
        {inv.allocations.length === 0 ? (
          <p class="muted">消込はありません。</p>
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>入金日</th>
                  <th>方法</th>
                  <th class="num">入金から</th>
                  <th class="num">差額</th>
                  <th>差額の区分</th>
                  <th>入金</th>
                </tr>
              </thead>
              <tbody>
                {inv.allocations.map((a) => (
                  <tr class={a.cancelled ? "row-muted" : undefined}>
                    <td class="nowrap">{a.receivedOn}</td>
                    <td>
                      {paymentMethodLabel(a.method)}
                      {a.salesReturnId ? (
                        <>
                          {" "}
                          <Badge kind="info">返還請求書の返還額</Badge>
                        </>
                      ) : null}
                    </td>
                    <td class="num">{yen(a.amount)}</td>
                    <td class="num">{a.adjustment > 0 ? yen(a.adjustment) : ""}</td>
                    <td>
                      {a.adjustmentKind ? ALLOCATION_ADJUSTMENT_LABELS[a.adjustmentKind] : ""}
                    </td>
                    <td>
                      <a href={paths.customerReceipt(a.paymentId)}>入金を開く</a>
                      {a.cancelled ? (
                        <>
                          {" "}
                          <Badge>取消</Badge>
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {props.canManage && inv.status !== "cancelled" ? (
        <section class="card">
          <h2>取消と再発行</h2>
          {props.view.cancelBlocker ? (
            <Alert kind="info">{props.view.cancelBlocker}</Alert>
          ) : (
            <div class="grid-2">
              <form
                method="post"
                action={paths.invoiceCancel(inv.id)}
                hx-post={paths.invoiceCancel(inv.id)}
                hx-target="#invoice-detail"
                hx-swap="outerHTML"
                hx-confirm={`請求書 ${inv.number} を取り消します。対象の発送 ${inv.shipments.length} 件・返品伝票 ${inv.returns.length} 件は未請求に戻り、帳票は取消済みになります。よろしいですか？`}
              >
                <h3>取り消す</h3>
                <FormKey />
                <Version value={inv.version} />
                <Field label="取り消す理由" name="reason" required>
                  <TextArea name="reason" rows={2} />
                </Field>
                <button type="submit" class="btn btn-danger">
                  請求書を取り消す
                </button>
              </form>
              <form
                method="post"
                action={paths.invoiceReissue(inv.id)}
                hx-post={paths.invoiceReissue(inv.id)}
                hx-target="#invoice-detail"
                hx-swap="outerHTML"
                hx-confirm={`請求書 ${inv.number} を取り消し、同じ発送・返品伝票で新しい番号の請求書を発行します。よろしいですか？`}
              >
                <h3>取り消して再発行する</h3>
                <p class="hint">宛名・自社情報は今の設定で作り直します。</p>
                <FormKey />
                <Version value={inv.version} />
                <Field label="理由" name="reissue-reason" required>
                  <textarea id="f-reissue-reason" name="reason" rows={2} maxlength={500}></textarea>
                </Field>
                <Field label="発行日" name="reissue-issuedOn">
                  <input id="f-reissue-issuedOn" name="issuedOn" type="date" value={inv.issuedOn} />
                </Field>
                {props.view.kind === "per_shipment" ? (
                  <Field label="支払期限" name="reissue-dueOn">
                    <input id="f-reissue-dueOn" name="dueOn" type="date" value={inv.dueOn ?? ""} />
                  </Field>
                ) : (
                  <p class="hint">支払期限は取引条件から計算し直します。</p>
                )}
                <button type="submit" class="btn btn-secondary">
                  取り消して再発行する
                </button>
              </form>
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}

async function detailBody(
  c: Context<AppEnv>,
  id: string,
  extra: { notice?: string | undefined; error?: DomainError | undefined } = {},
) {
  const view = await runQuery(c, "invoices.get", { id });
  if (!view) return null;
  const roles = c.get("actor").roles;
  return (
    <DetailBody
      view={view}
      canManage={hasPermission(roles, "invoices.manage")}
      canAllocate={hasPermission(roles, "payments.manage")}
      notice={extra.notice}
      error={extra.error}
    />
  );
}

invoiceRoutes.get("/:id", async (c) => {
  const body = await detailBody(c, c.req.param("id"), {
    notice: INVOICE_NOTICES[c.req.query("notice") ?? ""],
  });
  if (!body) return c.notFound();
  return c.html(
    <Layout title="請求書詳細" actor={c.get("actor")} current={paths.invoices()}>
      {body}
    </Layout>,
  );
});

async function afterAction(
  c: Context<AppEnv>,
  id: string,
  result: { ok: true } | { ok: false; error: DomainError },
  notice: string,
) {
  if (result.ok && !isHtmx(c)) return redirectTo(c, paths.invoice(id, { notice }));
  const body = await detailBody(
    c,
    id,
    result.ok ? { notice: INVOICE_NOTICES[notice] } : { error: result.error },
  );
  if (!body) return c.notFound();
  if (isHtmx(c)) return c.html(body);
  return c.html(
    <Layout title="請求書詳細" actor={c.get("actor")} current={paths.invoices()}>
      {body}
    </Layout>,
    409,
  );
}

invoiceRoutes.post("/:id/cancel", async (c) => {
  const id = c.req.param("id");
  const form = await readForm(c);
  const result = await runCommand(
    c,
    "invoices.cancel",
    { id, version: Number(str(form, "version")) || 0, reason: str(form, "reason") },
    formKey(form),
  );
  return afterAction(c, id, result, "cancelled");
});

invoiceRoutes.post("/:id/reissue", async (c) => {
  const id = c.req.param("id");
  const form = await readForm(c);
  const result = await runCommand(
    c,
    "invoices.reissue",
    {
      id,
      version: Number(str(form, "version")) || 0,
      reason: str(form, "reason"),
      issuedOn: str(form, "issuedOn"),
      dueOn: str(form, "dueOn"),
    },
    formKey(form),
  );
  if (result.ok) return redirectTo(c, paths.invoice(result.value.id, { notice: "reissued" }));
  return afterAction(c, id, result, "reissued");
});
