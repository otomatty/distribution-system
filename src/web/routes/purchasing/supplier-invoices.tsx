/**
 * 仕入先請求書（要件定義書 3.7）：一覧・登録（仕入先を起点に入荷を選んで突き合わせる）・詳細（支払、支払の取消、取消）。
 * 登録画面では、チェックのたびにシステムの計算額と請求額の差額をその場で計算し直す。
 */
import { Hono, type Context } from "hono";

import { isBusinessDate, toBusinessDate } from "../../../domain/dates";
import { TAX_CATEGORY_LABELS } from "../../../domain/money";
import type { DomainError } from "../../../domain/result";
import type {
  InvoiceCandidates,
  SupplierInvoiceView,
} from "../../../usecases/purchasing/supplier-invoices";
import { exportCsv } from "../../csv-exports";
import { formKey, int, intOrNull, readForm, str, strs, type FormData_ } from "../../form";
import { NOTICES, redirectTo } from "../../http";
import { hasPermission } from "../../middleware";
import { paths, type Query } from "../../paths";
import type { AppEnv } from "../../types";
import { runCommand, runQuery } from "../../usecase";
import {
  Alert,
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
import { dateTime, rate, yen } from "../../views/format";
import { Layout } from "../../views/layout";
import { INVOICE_STATUS_OPTIONS, SupplierInvoiceStatusBadge } from "../../views/purchasing";

export const supplierInvoiceRoutes = new Hono<AppEnv>();

const STATUSES = ["unpaid", "paid", "cancelled"] as const;

const SI_NOTICES: Readonly<Record<string, string>> = {
  ...NOTICES,
  created: "仕入先請求書を登録しました",
  paid: "支払を記録しました",
  paymentCancelled: "支払を取り消しました",
  cancelled: "仕入先請求書を取り消しました。結びつけていた入荷は、別の請求書に入れ直せます",
};

async function supplierOptions(c: Context<AppEnv>): Promise<Option[]> {
  const suppliers = await runQuery(c, "partners.options", { role: "supplier" });
  return suppliers.map((s) => ({ value: s.id, label: s.name }));
}

// ---- 一覧 ---------------------------------------------------------------------

function filterFrom(get: (name: string) => string) {
  const text = (name: string) => get(name).trim() || undefined;
  return {
    status: STATUSES.find((s) => s === get("status")),
    supplierId: text("supplierId"),
    from: text("from"),
    to: text("to"),
    q: text("q"),
  };
}

supplierInvoiceRoutes.get("/", async (c) => {
  const f = filterFrom((name) => c.req.query(name) ?? "");
  const page = Math.max(1, Number(c.req.query("page") ?? "1") || 1);
  const [result, suppliers] = await Promise.all([
    runQuery(c, "supplierInvoices.list", { ...f, page, pageSize: 50 }),
    supplierOptions(c),
  ]);
  const query: Query = { ...f };
  const canManage = hasPermission(c.get("actor").roles, "supplierInvoices.manage");
  return c.html(
    <Layout title="仕入先請求書" actor={c.get("actor")} current={paths.supplierInvoices()}>
      <PageHeader
        title="仕入先請求書"
        actions={
          <>
            <a class="btn btn-secondary" href={paths.payables()}>
              支払予定
            </a>
            {canManage ? (
              <a class="btn btn-primary" href={paths.supplierInvoiceNew()}>
                仕入先請求書を登録
              </a>
            ) : null}
          </>
        }
      />
      <form
        class="filters"
        method="get"
        action={paths.supplierInvoices()}
        hx-get={paths.supplierInvoices()}
        hx-target="#results"
        hx-select="#results"
        hx-swap="outerHTML"
        hx-push-url="true"
        hx-trigger="input changed delay:300ms from:input[name=q], change"
      >
        <div class="field wide">
          <label for="f-q">請求書番号・仕入先で検索</label>
          <Input name="q" type="search" value={f.q} />
        </div>
        <Field label="状態" name="status">
          <Select name="status" value={f.status} options={INVOICE_STATUS_OPTIONS} empty="すべて" />
        </Field>
        <Field label="仕入先" name="supplierId">
          <Select name="supplierId" value={f.supplierId} options={suppliers} empty="すべて" />
        </Field>
        <Field label="請求日（から）" name="from">
          <Input name="from" type="date" value={f.from} />
        </Field>
        <Field label="請求日（まで）" name="to">
          <Input name="to" type="date" value={f.to} />
        </Field>
        <noscript>
          <button type="submit" class="btn btn-secondary">
            検索
          </button>
        </noscript>
      </form>
      <section id="results">
        <div class="toolbar">
          <CsvButton action={paths.supplierInvoicesCsv()} filters={query} />
        </div>
        {result.rows.length === 0 ? (
          <EmptyState message="条件に合う仕入先請求書はありません" />
        ) : (
          <InvoiceTable rows={result.rows} />
        )}
        <Pagination
          page={result.page}
          pageSize={result.pageSize}
          total={result.total}
          href={(p) => paths.supplierInvoices({ ...query, page: p })}
        />
      </section>
    </Layout>,
  );
});

export function InvoiceTable(props: {
  rows: readonly SupplierInvoiceView["invoice"][];
  selectable?: boolean;
}) {
  return (
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            {props.selectable ? (
              <th>
                <span class="sr-only">選ぶ</span>
              </th>
            ) : null}
            <th>仕入先</th>
            <th>請求書番号</th>
            <th>請求日</th>
            <th>支払予定日</th>
            <th>状態</th>
            <th class="num">請求額</th>
            <th class="num">差額</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((i) => (
            <tr>
              {props.selectable ? (
                <td>
                  <input
                    type="checkbox"
                    name="invoice"
                    value={`${i.id}:${i.version}`}
                    aria-label={`${i.supplierName} ${i.invoiceNumber ?? ""}を選ぶ`}
                  />
                </td>
              ) : null}
              <td>{i.supplierName}</td>
              <td class="nowrap">
                <a href={paths.supplierInvoice(i.id)}>{i.invoiceNumber ?? "（番号なし）"}</a>
              </td>
              <td class="nowrap">{i.invoiceDate}</td>
              <td class="nowrap">{i.paymentDueOn ?? "未定"}</td>
              <td>
                <SupplierInvoiceStatusBadge status={i.status} />
              </td>
              <td class="num">{yen(i.invoicedAmount)}</td>
              <td class={i.difference === 0 ? "num" : "num text-danger"}>
                {i.difference === 0 ? "" : yen(i.difference)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

supplierInvoiceRoutes.post("/csv", async (c) => {
  const form = await readForm(c);
  return exportCsv(
    c,
    "supplierInvoices",
    filterFrom((name) => str(form, name)),
    formKey(form),
  );
});

// ---- 登録 ---------------------------------------------------------------------

interface InvoiceValues {
  readonly supplierId: string;
  readonly invoiceNumber: string;
  readonly invoiceDate: string;
  readonly invoicedAmount: string;
  readonly shippingFee: string;
  readonly differenceReason: string;
  readonly paymentDueOn: string;
  readonly memo: string;
  readonly receiptIds: ReadonlySet<string>;
  readonly returnIds: ReadonlySet<string>;
}

function valuesFromForm(form: FormData_): InvoiceValues {
  return {
    supplierId: str(form, "supplierId"),
    invoiceNumber: str(form, "invoiceNumber"),
    invoiceDate: str(form, "invoiceDate"),
    invoicedAmount: str(form, "invoicedAmount"),
    shippingFee: str(form, "shippingFee"),
    differenceReason: str(form, "differenceReason"),
    paymentDueOn: str(form, "paymentDueOn"),
    memo: str(form, "memo"),
    receiptIds: new Set(strs(form, "receiptIds")),
    returnIds: new Set(strs(form, "returnIds")),
  };
}

/** 「1,234」の形の円（マイナスも可）。空は null、不正なら NaN */
function yenOrNull(text: string): number | null {
  const t = text.replaceAll(",", "").trim();
  if (t === "") return null;
  return /^-?\d{1,10}$/.test(t) ? Number(t) : Number.NaN;
}

function previewInput(v: InvoiceValues) {
  const invoiced = yenOrNull(v.invoicedAmount);
  const shipping = yenOrNull(v.shippingFee);
  return {
    supplierId: v.supplierId,
    invoiceDate: isBusinessDate(v.invoiceDate) ? v.invoiceDate : toBusinessDate(new Date()),
    receiptIds: [...v.receiptIds],
    returnIds: [...v.returnIds],
    // 入力途中の不正な値は 0 / 未入力として計算する（登録のときに検証する）
    shippingFee: shipping !== null && Number.isInteger(shipping) && shipping >= 0 ? shipping : 0,
    invoicedAmount: invoiced !== null && Number.isInteger(invoiced) ? invoiced : null,
  };
}

type Preview = Awaited<ReturnType<typeof preview>>;

async function preview(c: Context<AppEnv>, v: InvoiceValues) {
  return runQuery(c, "supplierInvoices.preview", previewInput(v));
}

/** 計算額と差額（チェックや金額を変えるたびに、この欄だけを差し替える） */
function Summary(props: { preview: Preview }) {
  const p = props.preview;
  const a = p.amounts;
  return (
    <div
      id="si-summary"
      class="card"
      hx-post={paths.supplierInvoicePreview()}
      hx-trigger="change from:#si-form, input changed delay:400ms from:#si-form"
      hx-include="#si-form"
      hx-swap="outerHTML"
      aria-live="polite"
    >
      <h3>計算額と差額</h3>
      {p.error ? <p class="field-error">{p.error}</p> : null}
      {a ? (
        <table class="table totals-table">
          <tbody>
            <tr>
              <th>入荷 {p.receiptCount}件（受入数 × 単価、税抜）</th>
              <td class="num">{yen(a.receiptsSubtotal)}</td>
            </tr>
            <tr>
              <th>仕入返品 {p.returnCount}件（税抜）</th>
              <td class="num">−{yen(a.returnsSubtotal)}</td>
            </tr>
            {a.summary.groups.map((g) => (
              <tr>
                <th>
                  {rate(g.rateBps)}対象（{TAX_CATEGORY_LABELS[g.category]}） {yen(g.subtotal)}{" "}
                  の消費税
                </th>
                <td class="num">{yen(g.tax)}</td>
              </tr>
            ))}
            <tr>
              <th>送料（税込）</th>
              <td class="num">{yen(a.shippingFee)}</td>
            </tr>
            <tr>
              <th>システムの計算額（税込）</th>
              <td class="num" id="si-computed">
                <strong>{yen(a.computedAmount)}</strong>
              </td>
            </tr>
            <tr class={p.difference !== null && p.difference !== 0 ? "row-warning" : undefined}>
              <th>差額（請求額 − 計算額）</th>
              <td class="num" id="si-difference">
                <strong>
                  {p.difference === null ? "請求額を入力してください" : yen(p.difference)}
                </strong>
              </td>
            </tr>
          </tbody>
        </table>
      ) : null}
      {p.difference !== null && p.difference !== 0 ? (
        <p class="hint">差額があります。登録するには「差額の理由」を入力してください。</p>
      ) : null}
      {p.suggestedDueOn ? (
        <p class="hint">
          取引条件からの支払予定日：{p.suggestedDueOn}（支払予定日が空なら、この日にします）
        </p>
      ) : null}
    </div>
  );
}

function InvoiceForm(props: {
  values: InvoiceValues;
  candidates: InvoiceCandidates;
  preview: Preview;
  errors: FormErrors;
  error?: DomainError | null;
}) {
  const v = props.values;
  const e = props.errors;
  const { candidates } = props;
  return (
    <form
      id="si-form"
      method="post"
      action={paths.supplierInvoiceNew()}
      hx-post={paths.supplierInvoiceNew()}
      hx-target="this"
      hx-swap="outerHTML"
      class="form"
    >
      <ErrorSummary error={props.error} />
      <FormKey />
      <input type="hidden" name="supplierId" value={v.supplierId} />
      <fieldset>
        <legend>請求書</legend>
        <div class="grid-4">
          <Field label="請求書番号" name="invoiceNumber" error={e["invoiceNumber"]}>
            <Input name="invoiceNumber" value={v.invoiceNumber} maxlength={50} />
          </Field>
          <Field label="請求日" name="invoiceDate" required error={e["invoiceDate"]}>
            <Input name="invoiceDate" type="date" value={v.invoiceDate} />
          </Field>
          <Field
            label="請求額（税込・円）"
            name="invoicedAmount"
            required
            error={e["invoicedAmount"]}
          >
            <Input name="invoicedAmount" value={v.invoicedAmount} inputmode="numeric" />
          </Field>
          <Field label="送料（税込・円）" name="shippingFee" error={e["shippingFee"]}>
            <Input name="shippingFee" value={v.shippingFee} inputmode="numeric" />
          </Field>
        </div>
      </fieldset>
      <fieldset>
        <legend>請求の対象の入荷</legend>
        {candidates.period ? (
          <p class="hint">
            締め期間（{candidates.period.from}〜{candidates.period.to}）の入荷を選んであります。
          </p>
        ) : (
          <p class="hint">
            この仕入先は締め日が未設定です。請求書に載っている入荷を選んでください。
          </p>
        )}
        {e["receiptIds"] ? <p class="field-error">{e["receiptIds"]}</p> : null}
        {candidates.receipts.length === 0 ? (
          <p class="muted">請求書に結びついていない入荷はありません</p>
        ) : (
          <table class="table">
            <thead>
              <tr>
                <th>
                  <span class="sr-only">選ぶ</span>
                </th>
                <th>入荷番号</th>
                <th>入荷日</th>
                <th>発注番号</th>
                <th class="num">金額（税抜）</th>
              </tr>
            </thead>
            <tbody>
              {candidates.receipts.map((r) => (
                <tr>
                  <td>
                    <input
                      type="checkbox"
                      id={`receipt-${r.id}`}
                      name="receiptIds"
                      value={r.id}
                      checked={v.receiptIds.has(r.id)}
                    />
                  </td>
                  <td class="nowrap">
                    <label for={`receipt-${r.id}`}>{r.number}</label>
                  </td>
                  <td class="nowrap">{r.receivedOn}</td>
                  <td class="nowrap">
                    <a href={paths.purchaseOrder(r.purchaseOrderId)}>{r.purchaseOrderNumber}</a>
                  </td>
                  <td class="num">{yen(r.subtotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {candidates.returns.length > 0 ? (
          <>
            <h3>差し引く仕入返品</h3>
            <table class="table">
              <thead>
                <tr>
                  <th>
                    <span class="sr-only">選ぶ</span>
                  </th>
                  <th>返品番号</th>
                  <th>返品日</th>
                  <th>発注番号</th>
                  <th class="num">返品額（税抜）</th>
                </tr>
              </thead>
              <tbody>
                {candidates.returns.map((r) => (
                  <tr>
                    <td>
                      <input
                        type="checkbox"
                        id={`return-${r.id}`}
                        name="returnIds"
                        value={r.id}
                        checked={v.returnIds.has(r.id)}
                      />
                    </td>
                    <td class="nowrap">
                      <label for={`return-${r.id}`}>{r.number}</label>
                    </td>
                    <td class="nowrap">{r.returnedOn}</td>
                    <td class="nowrap">{r.purchaseOrderNumber ?? ""}</td>
                    <td class="num">−{yen(r.subtotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : null}
      </fieldset>
      <Summary preview={props.preview} />
      <div class="grid-2">
        <Field label="差額の理由" name="differenceReason" error={e["differenceReason"]}>
          <TextArea name="differenceReason" value={v.differenceReason} rows={2} />
        </Field>
        <Field
          label="支払予定日"
          name="paymentDueOn"
          error={e["paymentDueOn"]}
          hint="空なら取引条件から計算します"
        >
          <Input name="paymentDueOn" type="date" value={v.paymentDueOn} />
        </Field>
      </div>
      <Field label="メモ" name="memo" error={e["memo"]}>
        <TextArea name="memo" value={v.memo} rows={2} />
      </Field>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">
          登録する
        </button>
      </div>
    </form>
  );
}

supplierInvoiceRoutes.get("/new", async (c) => {
  const actor = c.get("actor");
  if (!hasPermission(actor.roles, "supplierInvoices.manage")) {
    return c.html(
      <Layout title="仕入先請求書の登録" actor={actor} current={paths.supplierInvoices()}>
        <PageHeader title="仕入先請求書の登録" />
        <Alert kind="warning">仕入先請求書を登録する権限がありません。</Alert>
      </Layout>,
    );
  }
  const supplierId = c.req.query("supplierId") ?? "";
  const invoiceDate = c.req.query("invoiceDate") || toBusinessDate(new Date());
  const candidates = supplierId
    ? await runQuery(c, "supplierInvoices.candidates", { supplierId, invoiceDate })
    : null;
  if (!candidates) {
    const suppliers = await supplierOptions(c);
    return c.html(
      <Layout title="仕入先請求書の登録" actor={actor} current={paths.supplierInvoices()}>
        <PageHeader title="仕入先請求書の登録" />
        <form class="form" method="get" action={paths.supplierInvoiceNew()}>
          <div class="grid-2">
            <Field label="仕入先" name="supplierId" required>
              <Select
                name="supplierId"
                value={supplierId}
                options={suppliers}
                empty="選んでください"
              />
            </Field>
            <Field
              label="請求日"
              name="invoiceDate"
              hint="締め日のある仕入先は、この日の時点で締め終わっている期間の入荷を選んだ状態で開きます"
            >
              <Input name="invoiceDate" type="date" value={invoiceDate} />
            </Field>
          </div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary">
              次へ
            </button>
          </div>
        </form>
      </Layout>,
    );
  }
  const values: InvoiceValues = {
    supplierId,
    invoiceNumber: "",
    invoiceDate,
    invoicedAmount: "",
    shippingFee: "0",
    differenceReason: "",
    paymentDueOn: "",
    memo: "",
    receiptIds: new Set(candidates.receipts.filter((r) => r.inPeriod).map((r) => r.id)),
    returnIds: new Set(candidates.returns.filter((r) => r.inPeriod).map((r) => r.id)),
  };
  return c.html(
    <Layout title="仕入先請求書の登録" actor={actor} current={paths.supplierInvoices()}>
      <PageHeader title={`仕入先請求書の登録（${candidates.supplier.name}）`}>
        <p>
          <a href={paths.supplierInvoiceNew()}>仕入先・請求日を選び直す</a>
        </p>
      </PageHeader>
      <InvoiceForm
        values={values}
        candidates={candidates}
        preview={await preview(c, values)}
        errors={{}}
      />
    </Layout>,
  );
});

supplierInvoiceRoutes.post("/preview", async (c) => {
  const form = await readForm(c);
  return c.html(<Summary preview={await preview(c, valuesFromForm(form))} />);
});

supplierInvoiceRoutes.post("/new", async (c) => {
  const form = await readForm(c);
  const v = valuesFromForm(form);
  const result = await runCommand(
    c,
    "supplierInvoices.create",
    {
      supplierId: v.supplierId,
      invoiceNumber: v.invoiceNumber,
      invoiceDate: v.invoiceDate,
      invoicedAmount: yenOrNull(v.invoicedAmount) ?? Number.NaN,
      shippingFee: yenOrNull(v.shippingFee) ?? 0,
      differenceReason: v.differenceReason,
      paymentDueOn: v.paymentDueOn,
      memo: v.memo,
      receiptIds: [...v.receiptIds],
      returnIds: [...v.returnIds],
    },
    formKey(form),
  );
  if (result.ok)
    return redirectTo(c, paths.supplierInvoice(result.value.id, { notice: "created" }));
  const [candidates, p] = await Promise.all([
    runQuery(c, "supplierInvoices.candidates", {
      supplierId: v.supplierId,
      invoiceDate: isBusinessDate(v.invoiceDate) ? v.invoiceDate : toBusinessDate(new Date()),
    }),
    preview(c, v),
  ]);
  if (!candidates) return c.text("仕入先が見つかりません", 404);
  return c.html(
    <InvoiceForm
      values={v}
      candidates={candidates}
      preview={p}
      errors={toFormErrors(result.error)}
      error={result.error}
    />,
  );
});

// ---- 詳細・支払・取消 -------------------------------------------------------------

function PayForm(props: {
  view: SupplierInvoiceView;
  error?: DomainError | null;
  values?: { paidOn: string; amount: string; memo: string };
}) {
  const i = props.view.invoice;
  const v = props.values ?? {
    paidOn: toBusinessDate(new Date()),
    amount: String(i.invoicedAmount),
    memo: "",
  };
  const e = props.error ? toFormErrors(props.error) : {};
  return (
    <form
      id="si-pay"
      method="post"
      action={paths.supplierInvoicePay(i.id)}
      hx-post={paths.supplierInvoicePay(i.id)}
      hx-target="this"
      hx-swap="outerHTML"
      class="form card"
    >
      <h2>支払を記録</h2>
      <ErrorSummary error={props.error} />
      <FormKey />
      <Version value={i.version} />
      <div class="grid-3">
        <Field label="支払日" name="paidOn" required error={e["paidOn"]}>
          <Input name="paidOn" type="date" value={v.paidOn} />
        </Field>
        <Field label="支払額（円）" name="amount" required error={e["amount"]}>
          <Input name="amount" value={v.amount} inputmode="numeric" />
        </Field>
        <Field label="メモ" name="memo" error={e["memo"]}>
          <Input name="memo" value={v.memo} />
        </Field>
      </div>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">
          支払済みにする
        </button>
      </div>
    </form>
  );
}

function ReasonForm(props: {
  id: string;
  action: string;
  title: string;
  button: string;
  version: number;
  error?: DomainError | null | undefined;
}) {
  return (
    <details class="card" id={props.id} open={props.error ? true : undefined}>
      <summary>{props.title}</summary>
      <form
        method="post"
        action={props.action}
        hx-post={props.action}
        hx-target={`#${props.id}`}
        hx-swap="outerHTML"
        class="form"
      >
        <ErrorSummary error={props.error} />
        <FormKey />
        <Version value={props.version} />
        <Field label="理由" name={`${props.id}-reason`} required>
          <textarea id={`f-${props.id}-reason`} name="reason" rows={2}></textarea>
        </Field>
        <div class="form-actions">
          <button type="submit" class="btn btn-danger">
            {props.button}
          </button>
        </div>
      </form>
    </details>
  );
}

function CancelPaymentForm(props: { view: SupplierInvoiceView; error?: DomainError | null }) {
  return (
    <ReasonForm
      id="si-cancel-payment"
      action={paths.supplierInvoiceCancelPayment(props.view.invoice.id)}
      title="支払を取り消す"
      button="支払を取り消す"
      version={props.view.invoice.version}
      error={props.error}
    />
  );
}

function CancelInvoiceForm(props: { view: SupplierInvoiceView; error?: DomainError | null }) {
  return (
    <ReasonForm
      id="si-cancel"
      action={paths.supplierInvoiceCancel(props.view.invoice.id)}
      title="仕入先請求書を取り消す"
      button="取り消す"
      version={props.view.invoice.version}
      error={props.error}
    />
  );
}

supplierInvoiceRoutes.get("/:id", async (c) => {
  const view = await runQuery(c, "supplierInvoices.get", { id: c.req.param("id") });
  if (!view) return c.notFound();
  const i = view.invoice;
  const title = `仕入先請求書 ${i.invoiceNumber ?? "（番号なし）"}`;
  const notice = SI_NOTICES[c.req.query("notice") ?? ""];
  return c.html(
    <Layout title={title} actor={c.get("actor")} current={paths.supplierInvoices()}>
      <PageHeader
        title={title}
        actions={
          <a class="btn btn-secondary" href={paths.payables()}>
            支払予定
          </a>
        }
      >
        <p>
          {i.supplierName} <SupplierInvoiceStatusBadge status={i.status} />
        </p>
      </PageHeader>
      {notice ? <Alert kind="success">{notice}</Alert> : null}
      <section class="card">
        <DescriptionList
          items={[
            ["仕入先", <a href={paths.partner(i.supplierId)}>{i.supplierName}</a>],
            ["請求日", i.invoiceDate],
            ["請求額", yen(i.invoicedAmount)],
            ["送料", yen(i.shippingFee)],
            ["計算額", yen(i.computedAmount)],
            [
              "差額",
              i.difference === 0 ? (
                "なし"
              ) : (
                <span class="text-danger">
                  {yen(i.difference)}（理由：{i.differenceReason ?? ""}）
                </span>
              ),
            ],
            ["支払予定日", i.paymentDueOn ?? "未定"],
            ["メモ", i.memo ? <span class="pre">{i.memo}</span> : null],
            ["登録", `${dateTime(i.createdAt)} ${i.createdByName ?? ""}`],
            ["取消の理由", i.cancelReason],
          ]}
        />
      </section>
      <section class="card">
        <h2>請求の対象</h2>
        <table class="table">
          <thead>
            <tr>
              <th>入荷・返品</th>
              <th>日付</th>
              <th>発注番号</th>
              <th class="num">金額（税抜）</th>
            </tr>
          </thead>
          <tbody>
            {view.receipts.map((r) => (
              <tr>
                <td>入荷 {r.number}</td>
                <td>{r.receivedOn}</td>
                <td>
                  <a href={paths.purchaseOrder(r.purchaseOrderId)}>{r.purchaseOrderNumber}</a>
                </td>
                <td class="num">{yen(r.subtotal)}</td>
              </tr>
            ))}
            {view.returns.map((r) => (
              <tr>
                <td>仕入返品 {r.number}</td>
                <td>{r.returnedOn}</td>
                <td>
                  {r.purchaseOrderId ? (
                    <a href={paths.purchaseOrder(r.purchaseOrderId)}>{r.purchaseOrderNumber}</a>
                  ) : null}
                </td>
                <td class="num">−{yen(r.subtotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {view.amounts ? (
          <table class="table totals-table">
            <tbody>
              {view.amounts.summary.groups.map((g) => (
                <tr>
                  <th>
                    {rate(g.rateBps)}対象 {yen(g.subtotal)}
                  </th>
                  <td class="num">消費税 {yen(g.tax)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>
      {view.actions.pay ? <PayForm view={view} /> : null}
      {view.payments.length > 0 ? (
        <section class="card">
          <h2>支払の記録</h2>
          <table class="table">
            <thead>
              <tr>
                <th>支払日</th>
                <th class="num">支払額</th>
                <th>メモ</th>
                <th>記録</th>
              </tr>
            </thead>
            <tbody>
              {view.payments.map((p) => (
                <tr class={p.cancelled ? "muted" : undefined}>
                  <td>
                    {p.paidOn}
                    {p.cancelled ? `（取消：${p.cancelReason ?? ""}）` : ""}
                  </td>
                  <td class="num">{yen(p.amount)}</td>
                  <td>{p.memo ?? ""}</td>
                  <td class="small">
                    {dateTime(p.createdAt)} {p.createdByName ?? ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
      {view.actions.cancelPayment ? <CancelPaymentForm view={view} /> : null}
      {view.actions.cancel ? <CancelInvoiceForm view={view} /> : null}
    </Layout>,
  );
});

supplierInvoiceRoutes.post("/:id/pay", async (c) => {
  const id = c.req.param("id");
  const form = await readForm(c);
  const values = {
    paidOn: str(form, "paidOn"),
    amount: str(form, "amount"),
    memo: str(form, "memo"),
  };
  const result = await runCommand(
    c,
    "supplierInvoices.pay",
    {
      id,
      version: int(form, "version"),
      paidOn: values.paidOn,
      amount: intOrNull(form, "amount") ?? Number.NaN,
      memo: values.memo,
    },
    formKey(form),
  );
  if (result.ok) return redirectTo(c, paths.supplierInvoice(id, { notice: "paid" }));
  const view = await runQuery(c, "supplierInvoices.get", { id });
  if (!view) return c.notFound();
  return c.html(<PayForm view={view} error={result.error} values={values} />);
});

supplierInvoiceRoutes.post("/:id/cancel-payment", async (c) => {
  const id = c.req.param("id");
  const form = await readForm(c);
  const result = await runCommand(
    c,
    "supplierInvoices.cancelPayment",
    { id, version: int(form, "version"), reason: str(form, "reason") },
    formKey(form),
  );
  if (result.ok) return redirectTo(c, paths.supplierInvoice(id, { notice: "paymentCancelled" }));
  const view = await runQuery(c, "supplierInvoices.get", { id });
  if (!view) return c.notFound();
  return c.html(<CancelPaymentForm view={view} error={result.error} />);
});

supplierInvoiceRoutes.post("/:id/cancel", async (c) => {
  const id = c.req.param("id");
  const form = await readForm(c);
  const result = await runCommand(
    c,
    "supplierInvoices.cancel",
    { id, version: int(form, "version"), reason: str(form, "reason") },
    formKey(form),
  );
  if (result.ok) return redirectTo(c, paths.supplierInvoice(id, { notice: "cancelled" }));
  const view = await runQuery(c, "supplierInvoices.get", { id });
  if (!view) return c.notFound();
  return c.html(<CancelInvoiceForm view={view} error={result.error} />);
});
