/**
 * 入金の登録・消込（要件定義書 3.11、5章 入金の登録・消込）。
 * 入金（入金日・入金額・方法・メモ）を記録し、その販売先の未入金・一部入金の請求書に消し込む。
 * 差額は振込手数料・値引き・その他として処理できる。入金の一覧・詳細（後からの消込、消込の取消、入金の取消）。
 * 返還請求書の返還額（請求書で差し引けない返品を精算したもの）も入金（相殺）として一覧・詳細に「返還請求書の返還額」と出し、
 * 請求書に消し込むか、残りを返金済みにする（返金の取消もできる）。入金の登録画面では、販売先の返還額の残りを知らせる。
 */
import { Hono, type Context } from "hono";
import type { Child } from "hono/jsx";

import { PAYMENT_METHOD_LABELS, type PaymentMethod } from "../../../domain/billing";
import { toBusinessDate } from "../../../domain/dates";
import type { DomainError } from "../../../domain/result";
import { ALLOCATION_ADJUSTMENT_LABELS, type AllocationAdjustmentKind } from "../../../domain/sales";
import type { OpenInvoice, PaymentListItem, PaymentView } from "../../../usecases/billing/payments";
import { exportCsv } from "../../csv-exports";
import { choice, formKey, readForm, str, strs, type FormData_ } from "../../form";
import { isHtmx, redirectTo } from "../../http";
import { hasPermission } from "../../middleware";
import { paths, type Query } from "../../paths";
import type { AppEnv } from "../../types";
import { queryAs, runCommand, runQuery } from "../../usecase";
import { InvoiceStatusBadge, paymentMethodLabel } from "../../views/billing";
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

export const receiptRoutes = new Hono<AppEnv>();

const RECEIPT_NOTICES: Readonly<Record<string, string>> = {
  created: "入金を記録しました",
  allocated: "請求書に消し込みました",
  allocation_cancelled: "消込を取り消しました。請求書の残高を戻しました",
  cancelled: "入金を取り消しました。消込もまとめて取り消しました",
  refunded: "返還額の残りを返金済みにしました",
  refund_cancelled: "返金を取り消しました。返金した額は返還額の残りに戻りました",
};

/** 返還請求書の返還額の印（一覧・詳細・入金の登録画面で同じ文言） */
const CREDIT_LABEL = "返還請求書の返還額";

function CreditBadge() {
  return <Badge kind="info">{CREDIT_LABEL}</Badge>;
}

const METHODS: readonly PaymentMethod[] = ["transfer", "cash", "offset", "other"];
const METHOD_OPTIONS: Option[] = METHODS.map((m) => ({
  value: m,
  label: PAYMENT_METHOD_LABELS[m],
}));
const KINDS: readonly AllocationAdjustmentKind[] = ["bank_fee", "discount", "other"];
const KIND_OPTIONS: Option[] = KINDS.map((k) => ({
  value: k,
  label: ALLOCATION_ADJUSTMENT_LABELS[k],
}));

async function customerOptions(c: Context<AppEnv>): Promise<Option[]> {
  const customers = await runQuery(c, "partners.options", { role: "customer" });
  return customers.map((p) => ({ value: p.id, label: p.name }));
}

/** 「1,234」形式の円。空欄は 0、数字でなければ NaN（ユースケースの検証でエラーになる） */
function yenText(text: string): number {
  const t = text.replaceAll(",", "").trim();
  if (t === "") return 0;
  return /^\d{1,10}$/.test(t) ? Number(t) : Number.NaN;
}

// ---- 一覧 ---------------------------------------------------------------------

function filterFrom(get: (name: string) => string) {
  const text = (name: string) => get(name).trim() || undefined;
  return {
    customerId: text("customerId"),
    receivedFrom: text("receivedFrom"),
    receivedTo: text("receivedTo"),
    unallocated: get("unallocated") === "1",
    credit: get("credit") === "1",
    includeCancelled: get("includeCancelled") === "1",
  };
}

type Filter = ReturnType<typeof filterFrom>;

function filterQuery(f: Filter): Query {
  return {
    ...f,
    unallocated: f.unallocated ? 1 : undefined,
    credit: f.credit ? 1 : undefined,
    includeCancelled: f.includeCancelled ? 1 : undefined,
  };
}

receiptRoutes.get("/", async (c) => {
  const filter = filterFrom((name) => c.req.query(name) ?? "");
  const page = Math.max(1, Number(c.req.query("page") ?? "1") || 1);
  const [result, customers] = await Promise.all([
    queryAs(c.env, c.get("actorRef"), "customerPayments.list", { ...filter, page, pageSize: 50 }),
    customerOptions(c),
  ]);
  const query = filterQuery(filter);
  const canManage = hasPermission(c.get("actor").roles, "payments.manage");
  return c.html(
    <Layout title="入金" actor={c.get("actor")} current={paths.customerReceipts()}>
      <PageHeader
        title="入金"
        actions={
          <>
            <a class="btn btn-secondary" href={paths.receivables()}>
              売掛残高・入金予定
            </a>
            {canManage ? (
              <a class="btn btn-primary" href={paths.customerReceiptNew()}>
                入金を記録
              </a>
            ) : null}
          </>
        }
      />
      <form
        class="filters"
        method="get"
        action={paths.customerReceipts()}
        hx-get={paths.customerReceipts()}
        hx-target="#results"
        hx-select="#results"
        hx-swap="outerHTML"
        hx-push-url="true"
        hx-trigger="change"
      >
        <Field label="販売先" name="customerId">
          <Select name="customerId" value={filter.customerId} options={customers} empty="すべて" />
        </Field>
        <Field label="入金日（から）" name="receivedFrom">
          <Input name="receivedFrom" type="date" value={filter.receivedFrom} />
        </Field>
        <Field label="入金日（まで）" name="receivedTo">
          <Input name="receivedTo" type="date" value={filter.receivedTo} />
        </Field>
        <Checkbox
          name="unallocated"
          value="1"
          label="未消込の残高がある入金だけ"
          checked={filter.unallocated}
        />
        <Checkbox name="credit" value="1" label={`${CREDIT_LABEL}だけ`} checked={filter.credit} />
        <Checkbox
          name="includeCancelled"
          value="1"
          label="取り消した入金も表示する"
          checked={filter.includeCancelled}
        />
        <noscript>
          <button type="submit" class="btn btn-secondary">
            検索
          </button>
        </noscript>
      </form>
      <section id="results">
        <div class="toolbar">
          <CsvButton action={paths.customerReceiptsCsv()} filters={query} />
        </div>
        {!result.ok ? (
          <Alert kind="error">{result.error.message}</Alert>
        ) : result.value.rows.length === 0 ? (
          <EmptyState message="条件に合う入金はありません" />
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>入金日</th>
                  <th>販売先</th>
                  <th>方法</th>
                  <th class="num">入金額</th>
                  <th class="num">消込済み</th>
                  <th class="num">未消込</th>
                  <th>メモ</th>
                </tr>
              </thead>
              <tbody>
                {result.value.rows.map((p) => (
                  <tr class={p.cancelled ? "row-muted" : undefined}>
                    <td class="nowrap">
                      <a href={paths.customerReceipt(p.id)}>{p.receivedOn}</a>
                      {p.cancelled ? (
                        <>
                          {" "}
                          <Badge>取消</Badge>
                        </>
                      ) : null}
                    </td>
                    <td>{p.customerName}</td>
                    <td>
                      {paymentMethodLabel(p.method)}
                      {p.salesReturnId ? (
                        <>
                          {" "}
                          <CreditBadge />
                        </>
                      ) : null}
                    </td>
                    <td class="num">{yen(p.amount)}</td>
                    <td class="num">{yen(p.allocatedAmount)}</td>
                    <td class="num">
                      {p.unallocated > 0 ? <strong>{yen(p.unallocated)}</strong> : yen(0)}
                    </td>
                    <td class="small">{p.memo ?? ""}</td>
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
            href={(p) => paths.customerReceipts({ ...query, page: p })}
          />
        ) : null}
      </section>
    </Layout>,
  );
});

receiptRoutes.post("/csv", async (c) => {
  const form = await readForm(c);
  return exportCsv(
    c,
    "customerPayments",
    filterFrom((name) => str(form, name)),
    formKey(form),
  );
});

// ---- 消込の表 -------------------------------------------------------------------

interface AllocationDraft {
  readonly amount: string;
  readonly adjustment: string;
  readonly kind: string;
}

function allocationDrafts(form: FormData_): Map<string, AllocationDraft> {
  const amounts = strs(form, "allocAmount");
  const adjustments = strs(form, "allocAdjustment");
  const kinds = strs(form, "allocKind");
  return new Map(
    strs(form, "allocInvoice").map((ref, i) => [
      ref.slice(0, ref.lastIndexOf(":")),
      { amount: amounts[i] ?? "", adjustment: adjustments[i] ?? "", kind: kinds[i] ?? "" },
    ]),
  );
}

function allocationsInput(form: FormData_) {
  const amounts = strs(form, "allocAmount");
  const adjustments = strs(form, "allocAdjustment");
  const kinds = strs(form, "allocKind");
  return strs(form, "allocInvoice").map((ref, i) => {
    const at = ref.lastIndexOf(":");
    const kind = KINDS.find((k) => k === kinds[i]) ?? null;
    return {
      invoiceId: ref.slice(0, at),
      version: Number(ref.slice(at + 1)) || 0,
      amount: yenText(amounts[i] ?? ""),
      adjustment: yenText(adjustments[i] ?? ""),
      adjustmentKind: kind,
    };
  });
}

/**
 * 販売先の返還請求書の返還額のうち、残り（請求書に充てていない・返金していない額）のあるもの。
 * 入金の登録画面で、入金を記録しなくても返還額から請求書に消し込めることを知らせる
 */
function CustomerCredits(props: { credits: readonly PaymentListItem[] }) {
  if (props.credits.length === 0) return null;
  return (
    <Alert kind="info">
      <p>
        <CreditBadge />{" "}
        この販売先には、請求書に充てられる返還請求書の返還額があります。返還額の画面から請求書に消し込めます。
      </p>
      <ul class="credit-list">
        {props.credits.map((p) => (
          <li>
            {p.receivedOn}　{p.salesReturnNumber ? `返品伝票 ${p.salesReturnNumber}　` : ""}残り{" "}
            <strong>{yen(p.unallocated)}</strong>（返還額 {yen(p.amount)}）{" "}
            <a href={paths.customerReceipt(p.id)}>返還額から消し込む・返金済みにする</a>
          </li>
        ))}
      </ul>
    </Alert>
  );
}

/** 消込の対象の請求書と、充てる額・差額の入力（行の並びは支払期限の早い順） */
function AllocationTable(props: {
  invoices: readonly OpenInvoice[];
  values?: ReadonlyMap<string, AllocationDraft> | undefined;
  errors?: FormErrors;
  customerChosen: boolean;
  /** 販売先の返還額の残り（入金の登録画面だけ） */
  credits?: readonly PaymentListItem[] | undefined;
}) {
  return (
    <div id="allocation-table">
      {props.credits ? <CustomerCredits credits={props.credits} /> : null}
      <AllocationRows
        invoices={props.invoices}
        values={props.values}
        errors={props.errors}
        customerChosen={props.customerChosen}
      />
    </div>
  );
}

function AllocationRows(props: {
  invoices: readonly OpenInvoice[];
  values?: ReadonlyMap<string, AllocationDraft> | undefined;
  errors?: FormErrors | undefined;
  customerChosen: boolean;
}) {
  const errors = props.errors ?? {};
  if (!props.customerChosen)
    return <p class="muted">販売先を選ぶと、消し込める請求書を表示します。</p>;
  if (props.invoices.length === 0)
    return (
      <p class="muted">
        消し込める（未入金・一部入金の）請求書はありません。入金は未消込として記録し、後で消し込めます。
      </p>
    );
  return (
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>請求書</th>
            <th>発行日</th>
            <th>支払期限</th>
            <th class="num">合計</th>
            <th class="num">残高</th>
            <th>入金から充てる額</th>
            <th>差額</th>
            <th>差額の区分</th>
          </tr>
        </thead>
        <tbody>
          {props.invoices.map((inv, i) => {
            const v = props.values?.get(inv.id);
            const e = (field: string) => errors[`allocations.${i}.${field}`];
            return (
              <tr class={inv.overdue ? "row-danger" : undefined}>
                <td class="nowrap">
                  <input type="hidden" name="allocInvoice" value={`${inv.id}:${inv.version}`} />
                  <a href={paths.invoice(inv.id)}>{inv.number}</a>{" "}
                  <InvoiceStatusBadge status={inv.status} overdue={inv.overdue} />
                  {e("invoiceId") ? <p class="field-error">{e("invoiceId")}</p> : null}
                </td>
                <td class="nowrap">{inv.issuedOn}</td>
                <td class="nowrap">{inv.dueOn ?? ""}</td>
                <td class="num">{yen(inv.total)}</td>
                <td class="num">{yen(inv.outstanding)}</td>
                <td>
                  <input
                    name="allocAmount"
                    type="text"
                    inputmode="numeric"
                    value={v?.amount ?? ""}
                    aria-label={`${inv.number}に入金から充てる額（残高 ${inv.outstanding}円）`}
                    aria-invalid={e("amount") ? "true" : undefined}
                  />
                  {e("amount") ? <p class="field-error">{e("amount")}</p> : null}
                </td>
                <td>
                  <input
                    name="allocAdjustment"
                    type="text"
                    inputmode="numeric"
                    value={v?.adjustment ?? ""}
                    aria-label={`${inv.number}の差額`}
                    aria-invalid={e("adjustment") ? "true" : undefined}
                  />
                  {e("adjustment") ? <p class="field-error">{e("adjustment")}</p> : null}
                </td>
                <td>
                  <select
                    name="allocKind"
                    aria-label={`${inv.number}の差額の区分`}
                    aria-invalid={e("adjustmentKind") ? "true" : undefined}
                  >
                    <option value="">（なし）</option>
                    {KIND_OPTIONS.map((o) => (
                      <option value={o.value} selected={o.value === v?.kind}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  {e("adjustmentKind") ? <p class="field-error">{e("adjustmentKind")}</p> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p class="hint">
        充てる額と差額の合計は、請求書の残高までにしてください。入金が請求より多い場合、残りは未消込として残り、後で消し込めます。
      </p>
    </div>
  );
}

// ---- 登録 ---------------------------------------------------------------------

interface PaymentValues {
  readonly customerId: string;
  readonly receivedOn: string;
  readonly amount: string;
  readonly method: string;
  readonly memo: string;
}

function NewForm(props: {
  values: PaymentValues;
  customers: readonly Option[];
  invoices: readonly OpenInvoice[];
  credits: readonly PaymentListItem[];
  drafts?: ReadonlyMap<string, AllocationDraft> | undefined;
  error?: DomainError | undefined;
  errors?: FormErrors;
}) {
  const errors = props.errors ?? {};
  const today = toBusinessDate(new Date());
  return (
    <form
      id="receipt-form"
      class="form"
      method="post"
      action={paths.customerReceiptNew()}
      hx-post={paths.customerReceiptNew()}
      hx-target="this"
      hx-swap="outerHTML"
    >
      <ErrorSummary error={props.error} />
      <FormKey />
      <div class="grid-2">
        <Field label="販売先" name="customerId" required error={errors["customerId"]}>
          <select
            id="f-customerId"
            name="customerId"
            hx-get={paths.customerReceiptInvoices()}
            hx-trigger="change"
            hx-target="#allocation-table"
            hx-swap="outerHTML"
            aria-invalid={errors["customerId"] ? "true" : undefined}
          >
            <option value="">（選ぶ）</option>
            {props.customers.map((o) => (
              <option value={o.value} selected={o.value === props.values.customerId}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="入金日" name="receivedOn" required error={errors["receivedOn"]}>
          <Input
            name="receivedOn"
            type="date"
            value={props.values.receivedOn}
            max={today}
            error={errors["receivedOn"]}
          />
        </Field>
        <Field label="入金額（円）" name="amount" required error={errors["amount"]}>
          <Input
            name="amount"
            inputmode="numeric"
            value={props.values.amount}
            error={errors["amount"]}
          />
        </Field>
        <Field label="方法" name="method" required>
          <Select name="method" value={props.values.method} options={METHOD_OPTIONS} />
        </Field>
      </div>
      <Field label="メモ" name="memo">
        <TextArea name="memo" rows={2} value={props.values.memo} />
      </Field>
      <h2>請求書への消込</h2>
      <AllocationTable
        invoices={props.invoices}
        values={props.drafts}
        errors={errors}
        customerChosen={props.values.customerId !== ""}
        credits={props.credits}
      />
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">
          入金を記録する
        </button>
        <a class="btn btn-secondary" href={paths.customerReceipts()}>
          やめる
        </a>
      </div>
    </form>
  );
}

async function openInvoices(c: Context<AppEnv>, customerId: string): Promise<OpenInvoice[]> {
  if (!customerId) return [];
  const r = await queryAs(c.env, c.get("actorRef"), "customerPayments.openInvoices", {
    customerId,
  });
  return r.ok ? r.value : [];
}

/** 販売先の、残りのある返還請求書の返還額 */
async function openCredits(c: Context<AppEnv>, customerId: string): Promise<PaymentListItem[]> {
  if (!customerId) return [];
  const r = await queryAs(c.env, c.get("actorRef"), "customerPayments.list", {
    customerId,
    unallocated: true,
    credit: true,
    page: 1,
    pageSize: 50,
  });
  return r.ok ? [...r.value.rows] : [];
}

function newPage(c: Context<AppEnv>, body: Child, status: 200 | 409 = 200) {
  return c.html(
    <Layout title="入金の記録" actor={c.get("actor")} current={paths.customerReceipts()}>
      <PageHeader title="入金の記録と消込" />
      {body}
    </Layout>,
    status,
  );
}

receiptRoutes.get("/new", async (c) => {
  if (!hasPermission(c.get("actor").roles, "payments.manage"))
    return newPage(c, <Alert kind="warning">入金を記録する権限がありません。</Alert>);
  const customerId = c.req.query("customerId") ?? "";
  const [customers, invoices, credits] = await Promise.all([
    customerOptions(c),
    openInvoices(c, customerId),
    openCredits(c, customerId),
  ]);
  return newPage(
    c,
    <NewForm
      values={{
        customerId,
        receivedOn: toBusinessDate(new Date()),
        amount: "",
        method: "transfer",
        memo: "",
      }}
      customers={customers}
      invoices={invoices}
      credits={credits}
    />,
  );
});

receiptRoutes.get("/new/invoices", async (c) => {
  const customerId = c.req.query("customerId") ?? "";
  const [invoices, credits] = await Promise.all([
    openInvoices(c, customerId),
    openCredits(c, customerId),
  ]);
  return c.html(
    <AllocationTable invoices={invoices} customerChosen={customerId !== ""} credits={credits} />,
  );
});

receiptRoutes.post("/new", async (c) => {
  const form = await readForm(c);
  const values: PaymentValues = {
    customerId: str(form, "customerId"),
    receivedOn: str(form, "receivedOn"),
    amount: str(form, "amount"),
    method: str(form, "method"),
    memo: str(form, "memo"),
  };
  const result = await runCommand(
    c,
    "customerPayments.create",
    {
      customerId: values.customerId,
      receivedOn: values.receivedOn,
      amount: yenText(values.amount) || Number.NaN,
      method: choice(form, "method", METHODS, "transfer"),
      memo: values.memo,
      allocations: allocationsInput(form),
    },
    formKey(form),
  );
  if (result.ok)
    return redirectTo(c, paths.customerReceipt(result.value.id, { notice: "created" }));
  const [customers, invoices, credits] = await Promise.all([
    customerOptions(c),
    openInvoices(c, values.customerId),
    openCredits(c, values.customerId),
  ]);
  const body = (
    <NewForm
      values={values}
      customers={customers}
      invoices={invoices}
      credits={credits}
      drafts={allocationDrafts(form)}
      error={result.error}
      errors={toFormErrors(result.error)}
    />
  );
  if (isHtmx(c)) return c.html(body);
  return newPage(c, body, 409);
});

// ---- 詳細 ---------------------------------------------------------------------

function DetailBody(props: {
  view: PaymentView;
  canManage: boolean;
  notice?: string | undefined;
  error?: DomainError | undefined;
  drafts?: ReadonlyMap<string, AllocationDraft> | undefined;
}) {
  const { payment, allocations, refunds } = props.view;
  const errors = props.error ? toFormErrors(props.error) : {};
  const credit = payment.salesReturnId !== null;
  const today = toBusinessDate(new Date());
  return (
    <div id="receipt-detail">
      <PageHeader
        title={`${credit ? CREDIT_LABEL : "入金"} ${payment.receivedOn} ${payment.customerName}`}
      >
        <p>
          {credit ? <CreditBadge /> : null} {payment.cancelled ? <Badge>取消</Badge> : null}
        </p>
      </PageHeader>
      {props.notice ? <Alert kind="success">{props.notice}</Alert> : null}
      <ErrorSummary error={props.error} />
      {credit ? (
        <Alert kind="info">
          請求書で差し引けない返品を返還請求書で精算した返還額です。未消込の間は売掛残高を減らします。
          請求書に消し込むか、販売先に返したら残りを返金済みにしてください（返金した額は売掛残高を減らしません）。
        </Alert>
      ) : null}
      <section class="card">
        <DescriptionList
          items={[
            ["販売先", payment.customerName],
            [credit ? "発行日" : "入金日", payment.receivedOn],
            [credit ? "返還額（税込）" : "入金額", yen(payment.amount)],
            ["方法", paymentMethodLabel(payment.method)],
            ...(payment.salesReturnId
              ? ([
                  [
                    "返品伝票",
                    <a href={paths.salesReturn(payment.salesReturnId)}>
                      {payment.salesReturnNumber ?? "返品伝票を開く"}
                    </a>,
                  ],
                ] as const)
              : []),
            ["消込済み", yen(props.view.allocatedAmount)],
            ...(credit ? ([["返金済み", yen(props.view.refundedAmount)]] as const) : []),
            ["未消込", yen(props.view.unallocated)],
            ["メモ", payment.memo ? <span class="pre">{payment.memo}</span> : null],
            ["記録", `${dateTime(payment.createdAt)} ${payment.createdByName ?? ""}`],
          ]}
        />
      </section>
      <section class="card">
        <h2>消込</h2>
        {allocations.length === 0 ? (
          <p class="muted">まだ消し込んでいません。</p>
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>請求書</th>
                  <th class="num">入金から</th>
                  <th class="num">差額</th>
                  <th>差額の区分</th>
                  <th>記録</th>
                  <th>
                    <span class="sr-only">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {allocations.map((a) => (
                  <tr class={a.cancelled ? "row-muted" : undefined}>
                    <td class="nowrap">
                      <a href={paths.invoice(a.invoiceId)}>{a.invoiceNumber}</a>{" "}
                      <InvoiceStatusBadge status={a.invoiceStatus} />
                    </td>
                    <td class="num">{yen(a.amount)}</td>
                    <td class="num">{a.adjustment > 0 ? yen(a.adjustment) : ""}</td>
                    <td>
                      {a.adjustmentKind ? ALLOCATION_ADJUSTMENT_LABELS[a.adjustmentKind] : ""}
                    </td>
                    <td class="small">{dateTime(a.createdAt)}</td>
                    <td>
                      {a.cancelled ? (
                        <Badge>取消</Badge>
                      ) : props.canManage ? (
                        <form
                          method="post"
                          action={paths.allocationCancel(a.id)}
                          hx-post={paths.allocationCancel(a.id)}
                          hx-target="#receipt-detail"
                          hx-swap="outerHTML"
                          hx-confirm={`${a.invoiceNumber} への消込（${yen(a.settled)}）を取り消します。よろしいですか？`}
                        >
                          <FormKey />
                          <Version value={a.version} />
                          <button type="submit" class="btn btn-secondary btn-sm">
                            消込を取り消す
                          </button>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {props.canManage && !payment.cancelled && props.view.unallocated > 0 ? (
        <section class="card">
          <h2>残り（{yen(props.view.unallocated)}）を消し込む</h2>
          <form
            method="post"
            action={paths.customerReceiptAllocate(payment.id)}
            hx-post={paths.customerReceiptAllocate(payment.id)}
            hx-target="#receipt-detail"
            hx-swap="outerHTML"
            class="form"
          >
            <FormKey />
            <Version value={payment.version} />
            <AllocationTable
              invoices={props.view.openInvoices}
              values={props.drafts}
              errors={errors}
              customerChosen
            />
            {props.view.openInvoices.length > 0 ? (
              <div class="form-actions">
                <button type="submit" class="btn btn-primary">
                  消し込む
                </button>
              </div>
            ) : null}
          </form>
        </section>
      ) : null}
      {credit ? (
        <section class="card">
          <h2>返金</h2>
          {refunds.length === 0 ? (
            <p class="muted">返金していません。</p>
          ) : (
            <div class="table-wrap">
              <table class="table">
                <thead>
                  <tr>
                    <th>返金日</th>
                    <th class="num">返金額</th>
                    <th>メモ</th>
                    <th>記録</th>
                    <th>
                      <span class="sr-only">操作</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {refunds.map((r) => (
                    <tr class={r.cancelled ? "row-muted" : undefined}>
                      <td class="nowrap">{r.refundedOn}</td>
                      <td class="num">{yen(r.amount)}</td>
                      <td class="small">{r.memo ?? ""}</td>
                      <td class="small">
                        {dateTime(r.createdAt)}
                        <div class="muted">{r.createdByName ?? ""}</div>
                      </td>
                      <td>
                        {r.cancelled ? (
                          <>
                            <Badge>取消</Badge>
                            <div class="muted small">{r.cancelReason ?? ""}</div>
                          </>
                        ) : props.canManage ? (
                          <details class="disclosure">
                            <summary class="btn btn-secondary btn-sm">返金を取り消す</summary>
                            <form
                              method="post"
                              action={paths.refundCancel(r.id)}
                              hx-post={paths.refundCancel(r.id)}
                              hx-target="#receipt-detail"
                              hx-swap="outerHTML"
                              hx-confirm={`${r.refundedOn} の返金（${yen(r.amount)}）を取り消します。返金した額は返還額の残りに戻ります。よろしいですか？`}
                            >
                              <FormKey />
                              <Version value={r.version} />
                              <Field label="取り消す理由" name={`refund-reason-${r.id}`} required>
                                <textarea
                                  id={`f-refund-reason-${r.id}`}
                                  name="reason"
                                  rows={2}
                                  maxlength={500}
                                ></textarea>
                              </Field>
                              <button type="submit" class="btn btn-danger">
                                返金を取り消す
                              </button>
                            </form>
                          </details>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {props.canManage && props.view.refundable ? (
            <form
              method="post"
              action={paths.customerReceiptRefund(payment.id)}
              hx-post={paths.customerReceiptRefund(payment.id)}
              hx-target="#receipt-detail"
              hx-swap="outerHTML"
              hx-confirm={`返還額の残り ${yen(props.view.unallocated)} を返金済みにします。よろしいですか？`}
              class="form"
            >
              <h3>残り（{yen(props.view.unallocated)}）を返金済みにする</h3>
              <FormKey />
              <Version value={payment.version} />
              <div class="grid-2">
                <Field label="返金日" name="refundedOn" required error={errors["refundedOn"]}>
                  <Input
                    name="refundedOn"
                    type="date"
                    value={today}
                    min={payment.receivedOn}
                    max={today}
                    error={errors["refundedOn"]}
                  />
                </Field>
                <Field label="メモ" name="refundMemo" hint="振込先・方法など">
                  <textarea id="f-refundMemo" name="memo" rows={2} maxlength={500}></textarea>
                </Field>
              </div>
              <div class="form-actions">
                <button type="submit" class="btn btn-primary">
                  残りを返金済みにする
                </button>
              </div>
            </form>
          ) : null}
        </section>
      ) : null}
      {credit && !payment.cancelled ? (
        <section class="card">
          <h2>返還額の取消</h2>
          <p class="muted">
            返還額は、返品伝票の画面で返還請求書を取り消すと取り消されます（消込・返金があるうちは取り消せません）。
            {payment.salesReturnId ? (
              <>
                {" "}
                <a href={paths.salesReturnCreditNote(payment.salesReturnId)}>
                  返品伝票の返還請求書へ
                </a>
              </>
            ) : null}
          </p>
        </section>
      ) : null}
      {props.canManage && !payment.cancelled && props.view.cancellable ? (
        <section class="card">
          <h2>入金の取消</h2>
          <form
            method="post"
            action={paths.customerReceiptCancel(payment.id)}
            hx-post={paths.customerReceiptCancel(payment.id)}
            hx-target="#receipt-detail"
            hx-swap="outerHTML"
            hx-confirm={`この入金（${yen(payment.amount)}）を取り消します。消込 ${allocations.filter((a) => !a.cancelled).length} 件もまとめて取り消し、請求書の残高を戻します。よろしいですか？`}
          >
            <FormKey />
            <Version value={payment.version} />
            <Field label="取り消す理由" name="reason" required>
              <TextArea name="reason" rows={2} />
            </Field>
            <button type="submit" class="btn btn-danger">
              入金を取り消す
            </button>
          </form>
        </section>
      ) : null}
    </div>
  );
}

async function detailBody(
  c: Context<AppEnv>,
  id: string,
  extra: {
    notice?: string | undefined;
    error?: DomainError | undefined;
    drafts?: ReadonlyMap<string, AllocationDraft> | undefined;
  } = {},
) {
  const view = await runQuery(c, "customerPayments.get", { id });
  if (!view) return null;
  return (
    <DetailBody
      view={view}
      canManage={hasPermission(c.get("actor").roles, "payments.manage")}
      notice={extra.notice}
      error={extra.error}
      drafts={extra.drafts}
    />
  );
}

receiptRoutes.get("/:id", async (c) => {
  const body = await detailBody(c, c.req.param("id"), {
    notice: RECEIPT_NOTICES[c.req.query("notice") ?? ""],
  });
  if (!body) return c.notFound();
  return c.html(
    <Layout title="入金" actor={c.get("actor")} current={paths.customerReceipts()}>
      {body}
    </Layout>,
  );
});

async function afterAction(
  c: Context<AppEnv>,
  id: string,
  result: { ok: true } | { ok: false; error: DomainError },
  notice: string,
  drafts?: ReadonlyMap<string, AllocationDraft>,
) {
  if (result.ok && !isHtmx(c)) return redirectTo(c, paths.customerReceipt(id, { notice }));
  const body = await detailBody(
    c,
    id,
    result.ok ? { notice: RECEIPT_NOTICES[notice] } : { error: result.error, drafts },
  );
  if (!body) return c.notFound();
  if (isHtmx(c)) return c.html(body);
  return c.html(
    <Layout title="入金" actor={c.get("actor")} current={paths.customerReceipts()}>
      {body}
    </Layout>,
    409,
  );
}

receiptRoutes.post("/allocations/:id/cancel", async (c) => {
  const form = await readForm(c);
  const result = await runCommand(
    c,
    "paymentAllocations.cancel",
    { allocationId: c.req.param("id"), version: Number(str(form, "version")) || 0 },
    formKey(form),
  );
  if (result.ok) return afterAction(c, result.value.paymentId, result, "allocation_cancelled");
  return c.text(result.error.message, result.error.code === "forbidden" ? 403 : 409);
});

receiptRoutes.post("/:id/allocate", async (c) => {
  const id = c.req.param("id");
  const form = await readForm(c);
  const result = await runCommand(
    c,
    "customerPayments.allocate",
    {
      paymentId: id,
      version: Number(str(form, "version")) || 0,
      allocations: allocationsInput(form),
    },
    formKey(form),
  );
  return afterAction(c, id, result, "allocated", allocationDrafts(form));
});

receiptRoutes.post("/refunds/:id/cancel", async (c) => {
  const form = await readForm(c);
  const result = await runCommand(
    c,
    "customerRefunds.cancel",
    {
      refundId: c.req.param("id"),
      version: Number(str(form, "version")) || 0,
      reason: str(form, "reason"),
    },
    formKey(form),
  );
  if (result.ok) return afterAction(c, result.value.paymentId, result, "refund_cancelled");
  return c.text(result.error.message, result.error.code === "forbidden" ? 403 : 409);
});

receiptRoutes.post("/:id/refund", async (c) => {
  const id = c.req.param("id");
  const form = await readForm(c);
  const result = await runCommand(
    c,
    "customerPayments.refund",
    {
      paymentId: id,
      version: Number(str(form, "version")) || 0,
      refundedOn: str(form, "refundedOn"),
      memo: str(form, "memo"),
    },
    formKey(form),
  );
  return afterAction(c, id, result, "refunded");
});

receiptRoutes.post("/:id/cancel", async (c) => {
  const id = c.req.param("id");
  const form = await readForm(c);
  const result = await runCommand(
    c,
    "customerPayments.cancel",
    { paymentId: id, version: Number(str(form, "version")) || 0, reason: str(form, "reason") },
    formKey(form),
  );
  return afterAction(c, id, result, "cancelled");
});
