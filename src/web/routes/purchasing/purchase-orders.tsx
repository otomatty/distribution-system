/**
 * 発注（要件定義書 3.5）：一覧（絞り込みと CSV）、作成・編集（商品選択ダイアログ、明細の金額をその場で計算）、
 * 詳細（確定と送付、メモ、取消、入荷の履歴と取消、仕入返品、発注書と送付履歴、仕入先請求書）。
 */
import { Hono, type Context } from "hono";
import type { Child } from "hono/jsx";

import { toBusinessDate } from "../../../domain/dates";
import { RENDER_STATUS_LABELS, SEND_STATUS_LABELS } from "../../../domain/documents";
import { parseYenToCenti, TAX_CATEGORY_LABELS, type TaxSummary } from "../../../domain/money";
import {
  DESTINATION_LABELS,
  ORDER_SEND_METHOD_LABELS,
  type DestinationKind,
} from "../../../domain/purchasing";
import type { DomainError } from "../../../domain/result";
import type { ItemRecord } from "../../../usecases/masters/items.port";
import type { PurchaseOrderView } from "../../../usecases/purchasing/purchase-orders";
import type { ShortageDetail } from "../../../usecases/stock/queries";
import { exportCsv } from "../../csv-exports";
import { choice, formKey, int, readForm, str, strs, type FormData_ } from "../../form";
import { NOTICES, redirectTo } from "../../http";
import { hasPermission } from "../../middleware";
import { paths, type Query } from "../../paths";
import type { AppEnv } from "../../types";
import { runCommand, runQuery } from "../../usecase";
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
import { centiPlain, centiYen, dateTime, qty, rate, yen } from "../../views/format";
import { ItemPicker, ItemPickerButton, pickedItemIds } from "../../views/item-picker";
import { Layout } from "../../views/layout";
import { MakerDirectDraftNote, MakerDirectSupplierChoice } from "../../views/maker-direct";
import {
  destinationText,
  ORDER_STATUS_OPTIONS,
  OrderStatusBadge,
  ReceiptCancelForm,
  SupplierInvoiceStatusBadge,
} from "../../views/purchasing";
import { StockErrorSummary } from "../../views/stock";

export const purchaseOrderRoutes = new Hono<AppEnv>();

const STATUSES = ["draft", "ordered", "received", "paid", "cancelled"] as const;

const PO_NOTICES: Readonly<Record<string, string>> = {
  ...NOTICES,
  created: "作成中の発注を保存しました。内容を確かめてから「確定して送付する」を押してください",
  confirmed: "発注を確定しました",
  sent: "発注を確定しました。発注書はメールで送付します（送付の結果は下の送付履歴に出ます）",
  cancelled: "発注を取り消しました",
  receiptCancelled: "入荷を取り消しました。在庫を打ち消しの行で戻しました",
  returned: "仕入返品を記録しました",
};

// ---- 一覧 ---------------------------------------------------------------------

/** URL のクエリ・CSV のフォームから、一覧の絞り込みの条件を作る（名前は画面と CSV で共通） */
function filterFrom(get: (name: string) => string) {
  const text = (name: string) => get(name).trim() || undefined;
  return {
    status: STATUSES.find((s) => s === get("status")),
    supplierId: text("supplierId"),
    from: text("from"),
    to: text("to"),
    hasMemo: get("memo") === "1",
    q: text("q"),
    overdue: get("overdue") === "1",
  };
}

type Filter = ReturnType<typeof filterFrom>;

function filterQuery(f: Filter): Query {
  return {
    status: f.status,
    supplierId: f.supplierId,
    from: f.from,
    to: f.to,
    memo: f.hasMemo ? 1 : undefined,
    q: f.q,
    overdue: f.overdue ? 1 : undefined,
  };
}

async function supplierOptions(c: Context<AppEnv>): Promise<Option[]> {
  const suppliers = await runQuery(c, "partners.options", { role: "supplier" });
  return suppliers.map((s) => ({ value: s.id, label: s.name }));
}

purchaseOrderRoutes.get("/", async (c) => {
  const f = filterFrom((name) => c.req.query(name) ?? "");
  const page = Math.max(1, Number(c.req.query("page") ?? "1") || 1);
  const [result, suppliers] = await Promise.all([
    runQuery(c, "purchaseOrders.list", { ...f, page, pageSize: 50 }),
    supplierOptions(c),
  ]);
  const query = filterQuery(f);
  const canManage = hasPermission(c.get("actor").roles, "purchaseOrders.manage");
  const notice = PO_NOTICES[c.req.query("notice") ?? ""];
  return c.html(
    <Layout title="発注" actor={c.get("actor")} current={paths.purchaseOrders()}>
      <PageHeader
        title="発注"
        actions={
          <>
            <a class="btn btn-secondary" href={paths.receiving()}>
              入荷予定
            </a>
            {canManage ? (
              <a class="btn btn-primary" href={paths.purchaseOrderNew()}>
                発注を作成
              </a>
            ) : null}
          </>
        }
      />
      {notice ? <Alert kind="success">{notice}</Alert> : null}
      <form
        class="filters"
        method="get"
        action={paths.purchaseOrders()}
        hx-get={paths.purchaseOrders()}
        hx-target="#results"
        hx-select="#results"
        hx-swap="outerHTML"
        hx-push-url="true"
        hx-trigger="input changed delay:300ms from:input[name=q], change"
      >
        <div class="field wide">
          <label for="f-q">番号・商品名・メモで検索</label>
          <Input name="q" type="search" value={f.q} />
        </div>
        <Field label="状態" name="status">
          <Select name="status" value={f.status} options={ORDER_STATUS_OPTIONS} empty="すべて" />
        </Field>
        <Field label="仕入先" name="supplierId">
          <Select name="supplierId" value={f.supplierId} options={suppliers} empty="すべて" />
        </Field>
        <Field label="発注日（から）" name="from">
          <Input name="from" type="date" value={f.from} />
        </Field>
        <Field label="発注日（まで）" name="to">
          <Input name="to" type="date" value={f.to} />
        </Field>
        <Checkbox name="memo" value="1" label="メモのあるものだけ" checked={f.hasMemo} />
        <Checkbox
          name="overdue"
          value="1"
          label="納品希望日を過ぎた未入荷だけ"
          checked={f.overdue}
        />
        <noscript>
          <button type="submit" class="btn btn-secondary">
            検索
          </button>
        </noscript>
      </form>
      <section id="results">
        <div class="toolbar">
          <CsvButton action={paths.purchaseOrdersCsv()} filters={query} />
        </div>
        {result.rows.length === 0 ? (
          <EmptyState message="条件に合う発注はありません" />
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>発注番号</th>
                  <th>状態</th>
                  <th>発注日</th>
                  <th>仕入先</th>
                  <th>納入先</th>
                  <th>納品希望日</th>
                  <th class="num">合計（税込）</th>
                  <th>メモ</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((po) => (
                  <tr>
                    <td class="nowrap">
                      <a href={paths.purchaseOrder(po.id)}>{po.number}</a>
                    </td>
                    <td>
                      <OrderStatusBadge status={po.status} />
                    </td>
                    <td class="nowrap">{po.orderedOn}</td>
                    <td>{po.supplierName}</td>
                    <td>{destinationText(po)}</td>
                    <td class="nowrap">{po.deliveryRequestedOn ?? ""}</td>
                    <td class="num">{yen(po.total)}</td>
                    <td class="small">{po.memo ?? ""}</td>
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
          href={(p) => paths.purchaseOrders({ ...query, page: p })}
        />
      </section>
    </Layout>,
  );
});

purchaseOrderRoutes.post("/csv", async (c) => {
  const form = await readForm(c);
  return exportCsv(
    c,
    "purchaseOrders",
    filterFrom((name) => str(form, name)),
    formKey(form),
  );
});

// ---- 作成・編集の画面 ------------------------------------------------------------

interface OrderValues {
  readonly supplierId: string;
  readonly orderedOn: string;
  readonly supplierContactName: string;
  readonly destinationKind: DestinationKind;
  readonly destinationLocationId: string;
  readonly destinationCustomerId: string;
  readonly destinationAddress: string;
  readonly employeeId: string;
  readonly deliveryRequestedOn: string;
  readonly paymentDueOn: string;
  readonly memo: string;
  /** メーカー直の受注から作るとき、その受注の ID（作るときだけ送る） */
  readonly salesOrderId: string;
}

/** 明細の行の入力（画面に入力された文字のまま） */
interface LineValues {
  readonly itemId: string;
  readonly quantity: string;
  readonly price: string;
  readonly memo: string;
}

interface LineView extends LineValues {
  readonly item: ItemRecord;
  readonly amount: number | null;
  readonly error?: string | null | undefined;
  readonly warnings: readonly string[];
}

const DESTINATION_KINDS = ["location", "customer", "other"] as const;

function valuesFromForm(form: FormData_): OrderValues {
  return {
    supplierId: str(form, "supplierId"),
    orderedOn: str(form, "orderedOn"),
    supplierContactName: str(form, "supplierContactName"),
    destinationKind: choice(form, "destinationKind", DESTINATION_KINDS, "location" as const),
    destinationLocationId: str(form, "destinationLocationId"),
    destinationCustomerId: str(form, "destinationCustomerId"),
    destinationAddress: str(form, "destinationAddress"),
    employeeId: str(form, "employeeId"),
    deliveryRequestedOn: str(form, "deliveryRequestedOn"),
    paymentDueOn: str(form, "paymentDueOn"),
    memo: str(form, "memo"),
    salesOrderId: str(form, "salesOrderId"),
  };
}

function linesFromForm(form: FormData_, exclude?: string): LineValues[] {
  const quantities = strs(form, "lineQuantity");
  const prices = strs(form, "linePrice");
  const memos = strs(form, "lineMemo");
  return strs(form, "lineItemId").flatMap((itemId, i) =>
    itemId === exclude
      ? []
      : [
          {
            itemId,
            quantity: quantities[i] ?? "",
            price: prices[i] ?? "",
            memo: memos[i] ?? "",
          },
        ],
  );
}

/** 「12」の形の整数。それ以外は NaN（ユースケースの検証でエラーになる） */
function intText(text: string): number {
  const t = text.replaceAll(",", "").trim();
  return /^\d{1,9}$/.test(t) ? Number(t) : Number.NaN;
}

/** 単価の入力。未入力は null、不正なら NaN */
function priceText(text: string): number | null {
  const t = text.trim();
  if (t === "") return null;
  return parseYenToCenti(t) ?? Number.NaN;
}

function commandFields(v: OrderValues, lines: readonly LineValues[]) {
  return {
    ...v,
    lines: lines.map((l) => ({
      itemId: l.itemId,
      quantity: intText(l.quantity),
      unitPriceCenti: priceText(l.price),
      memo: l.memo,
    })),
  };
}

/** 明細の表示に使う商品と、金額・合計（ユースケースで計算する） */
async function lineViews(
  c: Context<AppEnv>,
  orderedOn: string,
  lines: readonly LineValues[],
  errors: ReadonlyMap<string, string> = new Map(),
): Promise<{ lines: LineView[]; summary: TaxSummary | null; error: string | null }> {
  if (lines.length === 0) return { lines: [], summary: null, error: null };
  const [items, preview] = await Promise.all([
    runQuery(c, "items.getMany", { ids: lines.map((l) => l.itemId) }),
    runQuery(c, "purchaseOrders.preview", {
      orderedOn,
      lines: lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity, price: l.price })),
    }),
  ]);
  const byId = new Map(items.map((i) => [i.id, i]));
  const views = lines.flatMap((l, i): LineView[] => {
    const item = byId.get(l.itemId);
    const p = preview.lines[i];
    if (!item) return [];
    return [
      {
        ...l,
        item,
        amount: p?.amount ?? null,
        error: errors.get(l.itemId) ?? p?.error ?? null,
        warnings: p?.warnings ?? [],
      },
    ];
  });
  return { lines: views, summary: preview.summary, error: preview.error };
}

function AmountCell(props: { line: LineView; showError?: string | null | undefined }) {
  const l = props.line;
  return (
    <div id={`po-amount-${l.item.id}`}>
      <div class="num">{l.amount === null ? "—" : yen(l.amount)}</div>
      {props.showError ? <p class="field-error">{props.showError}</p> : null}
      {l.warnings.map((w) => (
        <p class="hint">{w}</p>
      ))}
    </div>
  );
}

function OrderLineRow(props: { line: LineView }) {
  const l = props.line;
  const item = l.item;
  return (
    <tr
      data-line-item={item.id}
      hx-post={paths.purchaseOrderRecalc()}
      hx-trigger="change"
      hx-include="#po-form"
      hx-vals={JSON.stringify({ changed: item.id })}
      hx-target={`#po-amount-${item.id}`}
      hx-swap="outerHTML"
    >
      <td class="nowrap">
        <input type="hidden" name="lineItemId" value={item.id} />
        {item.code}
      </td>
      <td>
        {item.name}
        <div class="muted small">
          {item.purchaseUnitName}＝{item.unitsPerPurchaseUnit}
          {item.salesUnitName}・{TAX_CATEGORY_LABELS[item.taxCategory]}
          {item.inputPriceOnOrder ? (
            <>
              {" "}
              <Badge kind="warning">単価を入力</Badge>
            </>
          ) : null}
        </div>
      </td>
      <td class="nowrap">
        <input
          id={`qty-${item.id}`}
          name="lineQuantity"
          type="number"
          inputmode="numeric"
          min={1}
          step={1}
          value={l.quantity}
          aria-label={`${item.name}の数量（${item.purchaseUnitName}）`}
          class="input-qty"
        />
        <span class="muted small"> {item.purchaseUnitName}</span>
      </td>
      <td>
        <input
          id={`price-${item.id}`}
          name="linePrice"
          type="text"
          inputmode="decimal"
          value={l.price}
          aria-label={`${item.name}の単価`}
          class="input-price"
        />
      </td>
      <td>
        <AmountCell line={l} showError={l.error} />
      </td>
      <td>
        <input
          id={`memo-${item.id}`}
          name="lineMemo"
          type="text"
          maxlength={200}
          value={l.memo}
          aria-label={`${item.name}の明細備考`}
        />
      </td>
      <td>
        <button
          type="button"
          class="btn btn-secondary"
          hx-post={paths.purchaseOrderRecalc()}
          hx-include="#po-form"
          hx-vals={JSON.stringify({ removed: item.id })}
          hx-target="closest tr"
          hx-swap="outerHTML"
          aria-label={`${item.name}を明細から外す`}
        >
          外す
        </button>
      </td>
    </tr>
  );
}

function Totals(props: {
  summary: TaxSummary | null;
  error?: string | null | undefined;
  oob?: boolean;
}) {
  const s = props.summary;
  return (
    <div id="po-totals" class="po-totals" hx-swap-oob={props.oob ? "true" : undefined}>
      {props.error ? <p class="field-error">{props.error}</p> : null}
      <table class="table totals-table">
        <tbody>
          {(s?.groups ?? []).map((g) => (
            <tr>
              <th>
                {rate(g.rateBps)}対象（{TAX_CATEGORY_LABELS[g.category]}）
              </th>
              <td class="num">{yen(g.subtotal)}</td>
              <td class="num">消費税 {yen(g.tax)}</td>
            </tr>
          ))}
          <tr>
            <th>小計（税抜）</th>
            <td class="num" colspan={2}>
              {yen(s?.subtotal ?? 0)}
            </td>
          </tr>
          <tr>
            <th>消費税</th>
            <td class="num" colspan={2}>
              {yen(s?.tax ?? 0)}
            </td>
          </tr>
          <tr>
            <th>合計（税込）</th>
            <td class="num" colspan={2} id="po-total">
              <strong>{yen(s?.total ?? 0)}</strong>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** 部分 HTML で返す合計欄（表の行と一緒に返せるよう <template> で包む） */
function TotalsOob(props: { summary: TaxSummary | null; error?: string | null | undefined }) {
  return (
    <template>
      <Totals summary={props.summary} error={props.error} oob />
    </template>
  );
}

interface FormOptions {
  readonly supplierName: string;
  readonly supplierHasTerms: boolean;
  readonly locations: Option[];
  readonly customers: Option[];
  readonly employees: Option[];
}

async function formOptions(c: Context<AppEnv>, supplierId: string): Promise<FormOptions | null> {
  const [supplier, locations, customers, employees] = await Promise.all([
    runQuery(c, "partners.get", { id: supplierId }),
    runQuery(c, "locations.options", {}),
    runQuery(c, "partners.options", { role: "customer" }),
    runQuery(c, "employees.list", {}),
  ]);
  if (!supplier || !supplier.isSupplier) return null;
  return {
    supplierName: supplier.name,
    supplierHasTerms:
      supplier.closingDay !== null &&
      supplier.paymentMonthOffset !== null &&
      supplier.paymentDay !== null,
    locations: locations.map((l) => ({ value: l.id, label: l.name })),
    customers: customers.map((p) => ({ value: p.id, label: p.name })),
    employees: employees.filter((e) => e.active).map((e) => ({ value: e.id, label: e.name })),
  };
}

function Radio(props: { name: string; value: string; label: string; checked: boolean }) {
  return (
    <label class="checkbox">
      <input type="radio" name={props.name} value={props.value} checked={props.checked} />{" "}
      {props.label}
    </label>
  );
}

function OrderForm(props: {
  action: string;
  values: OrderValues;
  lines: readonly LineView[];
  summary: TaxSummary | null;
  summaryError?: string | null;
  options: FormOptions;
  errors: FormErrors;
  error?: DomainError | null;
  version?: number;
  submitLabel: string;
}) {
  const v = props.values;
  const e = props.errors;
  return (
    <form
      id="po-form"
      method="post"
      action={props.action}
      hx-post={props.action}
      hx-target="this"
      hx-swap="outerHTML"
      class="form"
    >
      <ErrorSummary error={props.error} />
      <FormKey />
      {props.version !== undefined ? <Version value={props.version} /> : null}
      <input type="hidden" name="supplierId" value={v.supplierId} />
      {v.salesOrderId ? <input type="hidden" name="salesOrderId" value={v.salesOrderId} /> : null}
      <fieldset>
        <legend>発注先と日付</legend>
        <div class="grid-3">
          <div class="field">
            <span class="label">仕入先</span>
            <p>
              <strong>{props.options.supplierName}</strong>
            </p>
            {e["supplierId"] ? <p class="field-error">{e["supplierId"]}</p> : null}
          </div>
          <Field label="仕入先の担当者" name="supplierContactName" error={e["supplierContactName"]}>
            <Input name="supplierContactName" value={v.supplierContactName} maxlength={100} />
          </Field>
          <Field label="社内の担当者" name="employeeId" error={e["employeeId"]}>
            <Select
              name="employeeId"
              value={v.employeeId}
              options={props.options.employees}
              empty="未設定"
            />
          </Field>
          <Field label="発注日" name="orderedOn" required error={e["orderedOn"]}>
            <Input name="orderedOn" type="date" value={v.orderedOn} />
          </Field>
          <Field label="納品希望日" name="deliveryRequestedOn" error={e["deliveryRequestedOn"]}>
            <Input name="deliveryRequestedOn" type="date" value={v.deliveryRequestedOn} />
          </Field>
          {props.options.supplierHasTerms ? (
            <div class="field">
              <span class="label">支払予定日</span>
              <p class="hint">
                取引条件から自動で計算します（納品希望日、なければ発注日の締め期間で計算）
              </p>
            </div>
          ) : (
            <Field
              label="支払予定日"
              name="paymentDueOn"
              error={e["paymentDueOn"]}
              hint="この仕入先は取引条件が未設定なので、必要なら入力します"
            >
              <Input name="paymentDueOn" type="date" value={v.paymentDueOn} />
            </Field>
          )}
        </div>
      </fieldset>
      <fieldset>
        <legend>納入先</legend>
        {e["destinationKind"] ? <p class="field-error">{e["destinationKind"]}</p> : null}
        <div class="inline">
          {DESTINATION_KINDS.map((k) => (
            <Radio
              name="destinationKind"
              value={k}
              label={DESTINATION_LABELS[k]}
              checked={v.destinationKind === k}
            />
          ))}
        </div>
        <div class="grid-3">
          <Field
            label="保管場所（在庫に入れる）"
            name="destinationLocationId"
            error={e["destinationLocationId"]}
          >
            <Select
              name="destinationLocationId"
              value={v.destinationLocationId}
              options={props.options.locations}
              empty="選んでください"
            />
          </Field>
          <Field
            label="販売先（メーカー直。在庫に入れない）"
            name="destinationCustomerId"
            error={e["destinationCustomerId"]}
          >
            <Select
              name="destinationCustomerId"
              value={v.destinationCustomerId}
              options={props.options.customers}
              empty="選んでください"
            />
          </Field>
          <Field
            label="その他の届け先（名前と住所。在庫に入れない）"
            name="destinationAddress"
            error={e["destinationAddress"]}
          >
            <TextArea name="destinationAddress" value={v.destinationAddress} rows={2} />
          </Field>
        </div>
      </fieldset>
      <fieldset>
        <legend>明細</legend>
        {e["lines"] ? <p class="field-error">{e["lines"]}</p> : null}
        <p class="hint">
          数量は仕入単位、単価は仕入単位あたりの税抜の金額です。数量・単価を変えると金額と合計を計算し直します。
        </p>
        <div class="table-wrap">
          <table class="table po-lines">
            <thead>
              <tr>
                <th>商品コード</th>
                <th>商品名</th>
                <th>数量</th>
                <th>単価（税抜）</th>
                <th class="num">金額</th>
                <th>明細備考</th>
                <th>
                  <span class="sr-only">操作</span>
                </th>
              </tr>
            </thead>
            <tbody id="po-lines">
              {props.lines.map((line) => (
                <OrderLineRow line={line} />
              ))}
            </tbody>
          </table>
        </div>
        <div class="toolbar">
          <ItemPickerButton picker="po-picker" />
        </div>
        <Totals summary={props.summary} error={props.summaryError} />
      </fieldset>
      <Field label="メモ（社内用。発注書の備考にも載ります）" name="memo" error={e["memo"]}>
        <TextArea name="memo" value={v.memo} rows={2} />
      </Field>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">
          {props.submitLabel}
        </button>
      </div>
    </form>
  );
}

function OrderPicker(props: { supplierId: string }) {
  return (
    <ItemPicker
      id="po-picker"
      addUrl={paths.purchaseOrderLines()}
      target="#po-lines"
      include="#po-form"
      supplierId={props.supplierId}
      title="この仕入先の商品を選ぶ"
    />
  );
}

/** 入力エラーを明細の行（商品 ID）ごとに分ける */
function lineErrorsFrom(errors: FormErrors, lines: readonly LineValues[]): Map<string, string> {
  const out = new Map<string, string>();
  lines.forEach((l, i) => {
    const message =
      errors[`lines.${i}.quantity`] ??
      errors[`lines.${i}.unitPriceCenti`] ??
      errors[`lines.${i}.itemId`] ??
      errors[`lines.${i}.memo`];
    if (message) out.set(l.itemId, message);
  });
  return out;
}

async function renderFormError(
  c: Context<AppEnv>,
  action: string,
  values: OrderValues,
  lines: readonly LineValues[],
  error: DomainError,
  prefix: string,
  submitLabel: string,
  version?: number,
) {
  const errors = toFormErrors(error, prefix);
  const [options, views] = await Promise.all([
    formOptions(c, values.supplierId),
    lineViews(c, values.orderedOn, lines, lineErrorsFrom(errors, lines)),
  ]);
  if (!options) return c.text("仕入先が見つかりません", 404);
  return c.html(
    <OrderForm
      action={action}
      values={values}
      lines={views.lines}
      summary={views.summary}
      summaryError={views.error}
      options={options}
      errors={errors}
      error={error}
      submitLabel={submitLabel}
      {...(version === undefined ? {} : { version })}
    />,
  );
}

/**
 * メーカー直の受注から発注を作る画面（要件定義書 3.8 Should）。受注の明細が複数の仕入先にまたがるときは
 * 仕入先を選んでもらい、選んだ仕入先の商品だけを明細にする。納入先は受注の販売先、数量は仕入単位に換算した値、
 * 納品希望日は受注の納品希望日を初期値にする。保存は通常の発注の作成（受注の ID つき）で行う。
 */
async function makerDirectNew(c: Context<AppEnv>, salesOrderId: string, supplierId: string) {
  const actor = c.get("actor");
  const page = (body: Child) =>
    c.html(
      <Layout title="発注の作成（メーカー直）" actor={actor} current={paths.purchaseOrders()}>
        <PageHeader title="発注の作成（メーカー直）" />
        {body}
      </Layout>,
    );
  const plan = await runQuery(c, "purchaseOrders.makerDirectPlan", { salesOrderId });
  if (!plan) return c.notFound();
  const back = (
    <p>
      <a href={paths.salesOrder(salesOrderId)}>受注に戻る</a>
    </p>
  );
  // 仕入先が1つだけで、まだ発注がなければ選ばずに進む
  const [single] = plan.suppliers.length === 1 ? plan.suppliers : [];
  const chosen = supplierId || (single?.activeOrder === null ? single.supplierId : "");
  if (!chosen) {
    const number = (await runQuery(c, "salesOrders.get", { id: salesOrderId }))?.order.number ?? "";
    return page(
      <>
        <MakerDirectSupplierChoice plan={plan} number={number} />
        {back}
      </>,
    );
  }
  const result = await runQuery(c, "purchaseOrders.makerDirectDraft", {
    salesOrderId,
    supplierId: chosen,
  });
  if (!result.draft)
    return page(
      <>
        <Alert kind="warning">{result.error}</Alert>
        {back}
      </>,
    );
  const draft = result.draft;
  const today = toBusinessDate(new Date());
  const lines: LineValues[] = draft.lines.map((l) => ({
    itemId: l.itemId,
    quantity: String(l.quantity),
    price: l.unitPriceCenti === null ? "" : centiPlain(l.unitPriceCenti),
    memo: "",
  }));
  const [options, views] = await Promise.all([
    formOptions(c, draft.supplierId),
    lineViews(c, today, lines),
  ]);
  if (!options) return c.notFound();
  return page(
    <>
      <MakerDirectDraftNote draft={draft} />
      <OrderForm
        action={paths.purchaseOrderNew()}
        values={{
          supplierId: draft.supplierId,
          orderedOn: today,
          supplierContactName: "",
          destinationKind: "customer",
          destinationLocationId: "",
          destinationCustomerId: draft.customerId,
          destinationAddress: "",
          employeeId: actor.employeeId,
          deliveryRequestedOn: draft.deliveryRequestedOn ?? "",
          paymentDueOn: "",
          memo: "",
          salesOrderId: draft.salesOrderId,
        }}
        lines={views.lines}
        summary={views.summary}
        summaryError={views.error}
        options={options}
        errors={{}}
        submitLabel="作成中として保存"
      />
      <OrderPicker supplierId={draft.supplierId} />
    </>,
  );
}

purchaseOrderRoutes.get("/new", async (c) => {
  const actor = c.get("actor");
  const supplierId = c.req.query("supplierId") ?? "";
  const canManage = hasPermission(actor.roles, "purchaseOrders.manage");
  if (!canManage) {
    return c.html(
      <Layout title="発注の作成" actor={actor} current={paths.purchaseOrders()}>
        <PageHeader title="発注の作成" />
        <Alert kind="warning">発注を作成する権限がありません。</Alert>
      </Layout>,
    );
  }
  const salesOrderId = c.req.query("salesOrderId") ?? "";
  if (salesOrderId) return makerDirectNew(c, salesOrderId, supplierId);
  const options = supplierId ? await formOptions(c, supplierId) : null;
  if (!options) {
    // 1. 仕入先を選ぶ（発注書は仕入先ごとに1枚。商品はその仕入先の取扱商品に限る）
    const suppliers = await supplierOptions(c);
    return c.html(
      <Layout title="発注の作成" actor={actor} current={paths.purchaseOrders()}>
        <PageHeader title="発注の作成" />
        <form class="form" method="get" action={paths.purchaseOrderNew()}>
          <Field
            label="仕入先"
            name="supplierId"
            required
            hint="発注書は仕入先ごとに1枚です。選んだ仕入先の商品だけを追加できます"
          >
            <Select
              name="supplierId"
              value={supplierId}
              options={suppliers}
              empty="選んでください"
            />
          </Field>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary">
              次へ
            </button>
          </div>
        </form>
      </Layout>,
    );
  }
  const today = toBusinessDate(new Date());
  return c.html(
    <Layout title="発注の作成" actor={actor} current={paths.purchaseOrders()}>
      <PageHeader title="発注の作成" />
      <OrderForm
        action={paths.purchaseOrderNew()}
        values={{
          supplierId,
          orderedOn: today,
          supplierContactName: "",
          destinationKind: "location",
          destinationLocationId:
            options.locations.length === 1 ? (options.locations[0]?.value ?? "") : "",
          destinationCustomerId: "",
          destinationAddress: "",
          employeeId: actor.employeeId,
          deliveryRequestedOn: "",
          paymentDueOn: "",
          memo: "",
          salesOrderId: "",
        }}
        lines={[]}
        summary={null}
        options={options}
        errors={{}}
        submitLabel="作成中として保存"
      />
      <OrderPicker supplierId={supplierId} />
    </Layout>,
  );
});

purchaseOrderRoutes.post("/new", async (c) => {
  const form = await readForm(c);
  const values = valuesFromForm(form);
  const lines = linesFromForm(form);
  const result = await runCommand(
    c,
    "purchaseOrders.create",
    commandFields(values, lines),
    formKey(form),
  );
  if (result.ok) return redirectTo(c, paths.purchaseOrder(result.value.id, { notice: "created" }));
  return renderFormError(
    c,
    paths.purchaseOrderNew(),
    values,
    lines,
    result.error,
    "",
    "作成中として保存",
  );
});

/** 商品選択ダイアログで選んだ商品を、明細の行にして返す（すでにある商品は除く）。合計欄も差し替える */
purchaseOrderRoutes.post("/lines", async (c) => {
  const form = await readForm(c);
  const existing = linesFromForm(form);
  const have = new Set(existing.map((l) => l.itemId));
  const ids = pickedItemIds(form).filter((id) => !have.has(id));
  if (ids.length === 0) return c.body(null, 200);
  const supplierId = str(form, "supplierId");
  const items = (await runQuery(c, "items.getMany", { ids })).filter(
    (i) => i.supplierId === supplierId && !i.discontinued,
  );
  const added: LineValues[] = items.map((i) => ({
    itemId: i.id,
    quantity: String(Math.max(1, i.purchaseMinLot)),
    price: i.inputPriceOnOrder ? "" : centiPlain(i.purchasePriceCenti),
    memo: "",
  }));
  const views = await lineViews(c, str(form, "orderedOn"), [...existing, ...added]);
  const newRows = views.lines.filter((l) => !have.has(l.itemId));
  return c.html(
    <>
      {newRows.map((line) => (
        <OrderLineRow line={line} />
      ))}
      <TotalsOob summary={views.summary} error={views.error} />
    </>,
  );
});

/**
 * 明細の数量・単価を変えたとき（changed）：その行の金額と合計欄を返す。
 * 行を外したとき（removed）：行は空で置き換え（消え）、合計欄だけを差し替える。
 */
purchaseOrderRoutes.post("/lines/recalc", async (c) => {
  const form = await readForm(c);
  const removed = str(form, "removed");
  const lines = linesFromForm(form, removed || undefined);
  const views = await lineViews(c, str(form, "orderedOn"), lines);
  if (removed) return c.html(<TotalsOob summary={views.summary} error={views.error} />);
  const changed = views.lines.find((l) => l.itemId === str(form, "changed"));
  return c.html(
    <>
      {changed ? <AmountCell line={changed} showError={changed.error} /> : null}
      <TotalsOob summary={views.summary} error={views.error} />
    </>,
  );
});

// ---- 詳細 ---------------------------------------------------------------------

function MemoSection(props: {
  id: string;
  memo: string | null;
  version: number;
  canEdit: boolean;
  error?: DomainError | null;
  saved?: boolean;
}) {
  return (
    <section class="card" id="po-memo">
      <h2>メモ</h2>
      {props.saved ? <Alert kind="success">メモを保存しました</Alert> : null}
      {props.canEdit ? (
        <form
          method="post"
          action={paths.purchaseOrderMemo(props.id)}
          hx-post={paths.purchaseOrderMemo(props.id)}
          hx-target="#po-memo"
          hx-swap="outerHTML"
          class="form"
        >
          <ErrorSummary error={props.error} />
          <FormKey />
          <Version value={props.version} />
          <Field label="メモ（状態に関係なく編集できます）" name="memo">
            <TextArea name="memo" value={props.memo} rows={2} />
          </Field>
          <div class="form-actions">
            <button type="submit" class="btn btn-secondary">
              メモを保存
            </button>
          </div>
        </form>
      ) : props.memo ? (
        <p class="pre">{props.memo}</p>
      ) : (
        <p class="muted">メモはありません</p>
      )}
    </section>
  );
}

function ConfirmForm(props: {
  view: PurchaseOrderView;
  error?: DomainError | null;
  values?: { sendMethod: "email" | "none"; recipient: string };
}) {
  const { order } = props.view;
  const v = props.values ?? {
    sendMethod: props.view.supplierSendMethod,
    recipient: props.view.supplierEmail ?? "",
  };
  const errors = props.error ? toFormErrors(props.error) : {};
  return (
    <form
      id="po-confirm"
      method="post"
      action={paths.purchaseOrderConfirm(order.id)}
      hx-post={paths.purchaseOrderConfirm(order.id)}
      hx-target="this"
      hx-swap="outerHTML"
      hx-confirm={`${order.number} を確定します。確定後は明細を変更できません。よろしいですか？`}
      class="form card"
    >
      <h2>確定と送付</h2>
      <p class="hint">
        確定すると発注書を発行し、明細は変更できなくなります。メールを選ぶと発注書（PDF）をメールで送ります。
        FAX で送る場合は「送付しない」を選び、発注書の画面で PDF を出力して送ってください。
      </p>
      <ErrorSummary error={props.error} />
      <FormKey />
      <Version value={order.version} />
      <div class="grid-2">
        <Field label="送付方法" name="sendMethod" error={errors["sendMethod"]}>
          <Select
            name="sendMethod"
            value={v.sendMethod}
            options={[
              { value: "email", label: ORDER_SEND_METHOD_LABELS.email },
              { value: "none", label: ORDER_SEND_METHOD_LABELS.none },
            ]}
          />
        </Field>
        <Field
          label="宛先のメールアドレス（メールのとき）"
          name="recipient"
          error={errors["recipient"]}
        >
          <Input name="recipient" type="email" value={v.recipient} />
        </Field>
      </div>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">
          確定して送付する
        </button>
      </div>
    </form>
  );
}

function CancelOrderForm(props: { id: string; version: number; error?: DomainError | null }) {
  return (
    <details class="card" id="po-cancel" open={props.error ? true : undefined}>
      <summary>発注を取り消す</summary>
      <form
        method="post"
        action={paths.purchaseOrderCancel(props.id)}
        hx-post={paths.purchaseOrderCancel(props.id)}
        hx-target="#po-cancel"
        hx-swap="outerHTML"
        class="form"
      >
        <ErrorSummary error={props.error} />
        <FormKey />
        <Version value={props.version} />
        <Field
          label="取消の理由"
          name="reason"
          required
          error={props.error ? toFormErrors(props.error)["reason"] : undefined}
        >
          <TextArea name="reason" rows={2} />
        </Field>
        <p class="hint">取消は入荷前だけできます。発行した発注書も取消済みになります。</p>
        <div class="form-actions">
          <button type="submit" class="btn btn-danger">
            取り消す
          </button>
        </div>
      </form>
    </details>
  );
}

function DocumentSection(props: { view: PurchaseOrderView }) {
  const { documents, sends, order } = props.view;
  const latest = documents[0];
  if (!latest) return null;
  return (
    <section class="card">
      <h2>発注書と送付履歴</h2>
      <DescriptionList
        items={[
          [
            "発注書",
            <>
              <a href={paths.document(latest.id)}>{latest.number}</a>{" "}
              {latest.cancelled ? <Badge>取消済み</Badge> : null}{" "}
              <Badge kind={latest.status === "failed" ? "danger" : "neutral"}>
                {RENDER_STATUS_LABELS[latest.status]}
              </Badge>{" "}
              {latest.status === "ready" ? (
                <a href={paths.documentDownload(latest.id)}>PDF をダウンロード</a>
              ) : null}
            </>,
          ],
          ["送付方法", ORDER_SEND_METHOD_LABELS[order.sendMethod]],
        ]}
      />
      {sends.length === 0 ? (
        <p class="muted">
          まだ送付していません。FAX などで送ったら、
          <a href={paths.document(latest.id)}>発注書の画面</a>
          で「手動で送付した」を記録してください。
        </p>
      ) : (
        <table class="table">
          <thead>
            <tr>
              <th>日時</th>
              <th>方法</th>
              <th>宛先</th>
              <th>結果</th>
            </tr>
          </thead>
          <tbody>
            {sends.map((s) => (
              <tr class={s.status === "failed" ? "row-danger" : undefined}>
                <td class="nowrap">{dateTime(s.sentAt ?? s.createdAt)}</td>
                <td>{s.method === "email" ? "メール" : "手動（FAX など）"}</td>
                <td>{s.recipient ?? s.note ?? ""}</td>
                <td>
                  {SEND_STATUS_LABELS[s.status]}
                  {s.error ? <div class="small text-danger">{s.error}</div> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {sends[0]?.status === "failed" ? (
        <p>
          <a class="btn btn-secondary" href={paths.document(latest.id)}>
            送り直す
          </a>
        </p>
      ) : null}
    </section>
  );
}

function OrderDetail(props: { view: PurchaseOrderView; notice?: string | undefined }) {
  const { view } = props;
  const { order, actions } = view;
  const cancellable = new Set(view.cancellableReceiptIds);
  return (
    <>
      {props.notice ? <Alert kind="success">{props.notice}</Alert> : null}
      <section class="card">
        <DescriptionList
          items={[
            ["状態", <OrderStatusBadge status={order.status} />],
            ["仕入先", <a href={paths.partner(order.supplierId)}>{order.supplierName}</a>],
            ["仕入先の担当者", order.supplierContactName],
            ["発注日", order.orderedOn],
            ["納品希望日", order.deliveryRequestedOn],
            [
              "納入先",
              <>
                {DESTINATION_LABELS[order.destinationKind]}：{order.destinationName ?? ""}
                {order.destinationAddress ? (
                  <span class="pre">{order.destinationAddress}</span>
                ) : null}
              </>,
            ],
            ["社内の担当者", order.employeeName],
            [
              "受注（メーカー直）",
              order.salesOrderId ? (
                <a href={paths.salesOrder(order.salesOrderId)}>{order.salesOrderNumber}</a>
              ) : null,
            ],
            ["支払予定日", order.paymentDueOn],
            ["確定日時", order.confirmedAt ? dateTime(order.confirmedAt) : null],
            ["取消の理由", order.cancelReason],
          ]}
        />
      </section>
      <section class="card">
        <h2>明細</h2>
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>商品</th>
                <th class="num">数量</th>
                <th class="num">単価（税抜）</th>
                <th class="num">金額</th>
                <th class="num">入荷済み</th>
                <th class="num">残り</th>
                <th class="num">仕入返品</th>
                <th>明細備考</th>
              </tr>
            </thead>
            <tbody>
              {view.lines.map((l) => (
                <tr>
                  <td>
                    {l.itemCode} {l.itemName}
                    <div class="muted small">
                      {l.purchaseUnitName}＝{l.unitsPerPurchaseUnit}
                      {l.salesUnitName}・{TAX_CATEGORY_LABELS[l.taxCategory]}
                      {l.closed ? "・残りを打ち切り" : ""}
                    </div>
                  </td>
                  <td class="num">
                    {qty(l.quantity)}
                    <span class="muted small">{l.purchaseUnitName}</span>
                  </td>
                  <td class="num">{centiYen(l.unitPriceCenti)}</td>
                  <td class="num">{yen(l.amount)}</td>
                  <td class="num">{qty(l.receivedQuantity)}</td>
                  <td class="num">{qty(l.remaining)}</td>
                  <td class="num">
                    {l.returnedUnits > 0 ? `${qty(l.returnedUnits)}${l.salesUnitName}` : ""}
                  </td>
                  <td class="small">{l.memo ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <table class="table totals-table">
          <tbody>
            {view.taxGroups.map((g) => (
              <tr>
                <th>{rate(g.rateBps)}対象</th>
                <td class="num">{yen(g.subtotal)}</td>
                <td class="num">消費税 {yen(g.tax)}</td>
              </tr>
            ))}
            <tr>
              <th>合計（税込）</th>
              <td class="num" colspan={2}>
                <strong>{yen(order.total)}</strong>（税抜 {yen(order.subtotal)}・消費税{" "}
                {yen(order.tax)}）
              </td>
            </tr>
          </tbody>
        </table>
      </section>
      {actions.confirm ? <ConfirmForm view={view} /> : null}
      <DocumentSection view={view} />
      <MemoSection id={order.id} memo={order.memo} version={order.version} canEdit={actions.memo} />
      <section class="card">
        <h2>入荷の履歴</h2>
        {view.receipts.length === 0 ? (
          <p class="muted">まだ入荷はありません</p>
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>入荷番号</th>
                  <th>入荷日</th>
                  <th>保管場所</th>
                  <th>内容</th>
                  <th class="num">金額（税抜）</th>
                  <th>仕入先請求書</th>
                  <th>
                    <span class="sr-only">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {view.receipts.map((r) => (
                  <tr class={r.cancelled ? "muted" : undefined}>
                    <td class="nowrap">
                      {r.number} {r.cancelled ? <Badge>取消</Badge> : null}
                    </td>
                    <td class="nowrap">{r.receivedOn}</td>
                    <td>{r.locationName ?? "在庫に入れない（納品済みの確認）"}</td>
                    <td class="small">
                      {r.lines.map((l) => (
                        <div>
                          {l.itemName}：受入 {qty(l.accepted)}
                          {l.returned > 0 ? `・返品 ${qty(l.returned)}` : ""}
                          {l.closedRemaining ? "・残りを打ち切り" : ""}
                        </div>
                      ))}
                      {r.cancelReason ? <div>取消の理由：{r.cancelReason}</div> : null}
                    </td>
                    <td class="num">{yen(r.subtotal)}</td>
                    <td>
                      {r.supplierInvoiceId ? (
                        <a href={paths.supplierInvoice(r.supplierInvoiceId)}>
                          {r.supplierInvoiceStatus ? (
                            <SupplierInvoiceStatusBadge status={r.supplierInvoiceStatus} />
                          ) : (
                            "請求書"
                          )}
                        </a>
                      ) : (
                        ""
                      )}
                    </td>
                    <td>
                      {cancellable.has(r.id) ? (
                        <ReceiptCancelForm receiptId={r.id} number={r.number} version={r.version} />
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section class="card">
        <h2>仕入返品</h2>
        {view.returns.length === 0 ? (
          <p class="muted">仕入返品はありません</p>
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>返品番号</th>
                  <th>返品日</th>
                  <th>保管場所</th>
                  <th>内容</th>
                  <th class="num">返品額（税抜）</th>
                </tr>
              </thead>
              <tbody>
                {view.returns.map((r) => (
                  <tr>
                    <td class="nowrap">{r.number}</td>
                    <td class="nowrap">{r.returnedOn}</td>
                    <td>{r.locationName}</td>
                    <td class="small">
                      {r.lines.map((l) => (
                        <div>
                          {l.itemName}：{qty(l.quantity)}
                          {l.salesUnitName}
                        </div>
                      ))}
                      {r.memo ? <div>{r.memo}</div> : null}
                    </td>
                    <td class="num">{yen(r.subtotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {actions.returnGoods ? (
          <a class="btn btn-secondary" href={paths.purchaseReturnNew(order.id)}>
            仕入返品を記録
          </a>
        ) : null}
      </section>
      {view.invoices.length > 0 ? (
        <section class="card">
          <h2>仕入先請求書</h2>
          <ul>
            {view.invoices.map((i) => (
              <li>
                <a href={paths.supplierInvoice(i.id)}>{i.invoiceNumber ?? "（番号なし）"}</a>{" "}
                <SupplierInvoiceStatusBadge status={i.status} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {actions.cancel ? <CancelOrderForm id={order.id} version={order.version} /> : null}
    </>
  );
}

async function loadView(c: Context<AppEnv>, id: string) {
  return runQuery(c, "purchaseOrders.get", { id });
}

purchaseOrderRoutes.get("/:id", async (c) => {
  const view = await loadView(c, c.req.param("id"));
  if (!view) return c.notFound();
  const { order, actions } = view;
  return c.html(
    <Layout title={`発注 ${order.number}`} actor={c.get("actor")} current={paths.purchaseOrders()}>
      <PageHeader
        title={`発注 ${order.number}`}
        actions={
          <>
            {actions.edit ? (
              <a class="btn btn-secondary" href={paths.purchaseOrderEdit(order.id)}>
                編集
              </a>
            ) : null}
            {actions.receive ? (
              <a class="btn btn-primary" href={paths.receivingOrder(order.id)}>
                入荷を記録
              </a>
            ) : null}
            {actions.invoice ? (
              <a
                class="btn btn-secondary"
                href={paths.supplierInvoiceNew({ supplierId: order.supplierId })}
              >
                仕入先請求書を登録
              </a>
            ) : null}
          </>
        }
      />
      <OrderDetail view={view} notice={PO_NOTICES[c.req.query("notice") ?? ""]} />
    </Layout>,
  );
});

purchaseOrderRoutes.get("/:id/edit", async (c) => {
  const id = c.req.param("id");
  const view = await loadView(c, id);
  if (!view) return c.notFound();
  const { order } = view;
  if (!view.actions.edit) return redirectTo(c, paths.purchaseOrder(id));
  const lines: LineValues[] = order.lines.map((l) => ({
    itemId: l.itemId,
    quantity: String(l.quantity),
    price: centiPlain(l.unitPriceCenti),
    memo: l.memo ?? "",
  }));
  const [options, views] = await Promise.all([
    formOptions(c, order.supplierId),
    lineViews(c, order.orderedOn, lines),
  ]);
  if (!options) return c.notFound();
  return c.html(
    <Layout
      title={`発注 ${order.number} の編集`}
      actor={c.get("actor")}
      current={paths.purchaseOrders()}
    >
      <PageHeader title={`発注 ${order.number} の編集`} />
      <OrderForm
        action={paths.purchaseOrderEdit(id)}
        values={{
          supplierId: order.supplierId,
          orderedOn: order.orderedOn,
          supplierContactName: order.supplierContactName ?? "",
          destinationKind: order.destinationKind,
          destinationLocationId: order.destinationLocationId ?? "",
          destinationCustomerId: order.destinationCustomerId ?? "",
          destinationAddress: order.destinationAddress ?? "",
          employeeId: order.employeeId ?? "",
          deliveryRequestedOn: order.deliveryRequestedOn ?? "",
          paymentDueOn: order.paymentDueOn ?? "",
          memo: order.memo ?? "",
          salesOrderId: order.salesOrderId ?? "",
        }}
        lines={views.lines}
        summary={views.summary}
        summaryError={views.error}
        options={options}
        errors={{}}
        version={order.version}
        submitLabel="保存する"
      />
      <OrderPicker supplierId={order.supplierId} />
    </Layout>,
  );
});

purchaseOrderRoutes.post("/:id/edit", async (c) => {
  const id = c.req.param("id");
  const form = await readForm(c);
  const values = valuesFromForm(form);
  const lines = linesFromForm(form);
  const version = int(form, "version");
  const result = await runCommand(
    c,
    "purchaseOrders.update",
    { id, version, fields: commandFields(values, lines) },
    formKey(form),
  );
  if (result.ok) return redirectTo(c, paths.purchaseOrder(id, { notice: "updated" }));
  return renderFormError(
    c,
    paths.purchaseOrderEdit(id),
    values,
    lines,
    result.error,
    "fields.",
    "保存する",
    version,
  );
});

purchaseOrderRoutes.post("/:id/confirm", async (c) => {
  const id = c.req.param("id");
  const form = await readForm(c);
  const sendMethod = choice(form, "sendMethod", ["email", "none"] as const, "none" as const);
  const recipient = str(form, "recipient");
  const result = await runCommand(
    c,
    "purchaseOrders.confirm",
    { id, version: int(form, "version"), sendMethod, recipient },
    formKey(form),
  );
  if (result.ok)
    return redirectTo(
      c,
      paths.purchaseOrder(id, { notice: result.value.sendId ? "sent" : "confirmed" }),
    );
  const view = await loadView(c, id);
  if (!view) return c.notFound();
  return c.html(
    <ConfirmForm view={view} error={result.error} values={{ sendMethod, recipient }} />,
  );
});

purchaseOrderRoutes.post("/:id/cancel", async (c) => {
  const id = c.req.param("id");
  const form = await readForm(c);
  const version = int(form, "version");
  const result = await runCommand(
    c,
    "purchaseOrders.cancel",
    { id, version, reason: str(form, "reason") },
    formKey(form),
  );
  if (result.ok) return redirectTo(c, paths.purchaseOrder(id, { notice: "cancelled" }));
  return c.html(<CancelOrderForm id={id} version={version} error={result.error} />);
});

/** メモの保存。メモの欄だけを返す */
purchaseOrderRoutes.post("/:id/memo", async (c) => {
  const id = c.req.param("id");
  const form = await readForm(c);
  const memo = str(form, "memo");
  const version = int(form, "version");
  const result = await runCommand(
    c,
    "purchaseOrders.updateMemo",
    { id, version, memo },
    formKey(form),
  );
  const canEdit = hasPermission(c.get("actor").roles, "purchaseOrders.manage");
  if (result.ok)
    return c.html(
      <MemoSection
        id={id}
        memo={memo.trim() === "" ? null : memo.trim()}
        version={result.value.version}
        canEdit={canEdit}
        saved
      />,
    );
  return c.html(
    <MemoSection id={id} memo={memo} version={version} canEdit={canEdit} error={result.error} />,
  );
});

// ---- 仕入返品 -------------------------------------------------------------------

function ReturnForm(props: {
  view: PurchaseOrderView;
  locations: readonly Option[];
  values: {
    returnedOn: string;
    locationId: string;
    memo: string;
    units: ReadonlyMap<string, string>;
  };
  error?: DomainError | null;
  shortages?: readonly ShortageDetail[] | undefined;
}) {
  const { order } = props.view;
  const errors = props.error ? toFormErrors(props.error) : {};
  return (
    <form
      id="return-form"
      method="post"
      action={paths.purchaseReturnNew(order.id)}
      hx-post={paths.purchaseReturnNew(order.id)}
      hx-target="this"
      hx-swap="outerHTML"
      class="form"
    >
      <StockErrorSummary error={props.error} shortages={props.shortages} />
      <FormKey />
      <div class="grid-3">
        <Field label="返品日" name="returnedOn" required error={errors["returnedOn"]}>
          <Input name="returnedOn" type="date" value={props.values.returnedOn} />
        </Field>
        <Field label="在庫を減らす保管場所" name="locationId" required error={errors["locationId"]}>
          <Select
            name="locationId"
            value={props.values.locationId}
            options={props.locations}
            empty="選んでください"
          />
        </Field>
      </div>
      <table class="table">
        <thead>
          <tr>
            <th>商品</th>
            <th class="num">受入数</th>
            <th class="num">返品できる数</th>
            <th>返品する数（販売単位）</th>
          </tr>
        </thead>
        <tbody>
          {props.view.lines
            .filter((l) => l.acceptedQuantity > 0)
            .map((l) => (
              <tr>
                <td>
                  <input type="hidden" name="lineId" value={l.id} />
                  {l.itemCode} {l.itemName}
                </td>
                <td class="num">
                  {qty(l.acceptedQuantity)}
                  {l.purchaseUnitName}（{qty(l.unitsPerPurchaseUnit)}
                  {l.salesUnitName}入）
                </td>
                <td class="num">
                  {qty(l.returnableUnits)}
                  {l.salesUnitName}
                </td>
                <td>
                  <input
                    id={`units-${l.id}`}
                    name="units"
                    type="number"
                    inputmode="numeric"
                    min={0}
                    max={l.returnableUnits}
                    step={1}
                    value={props.values.units.get(l.id) ?? "0"}
                    aria-label={`${l.itemName}の返品する数`}
                  />
                </td>
              </tr>
            ))}
        </tbody>
      </table>
      <Field label="理由・メモ" name="memo" error={errors["memo"]}>
        <TextArea name="memo" value={props.values.memo} rows={2} />
      </Field>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">
          仕入返品を記録する
        </button>
      </div>
    </form>
  );
}

async function locationOptions(c: Context<AppEnv>): Promise<Option[]> {
  const locations = await runQuery(c, "locations.options", {});
  return locations.map((l) => ({ value: l.id, label: l.name }));
}

purchaseOrderRoutes.get("/:id/returns/new", async (c) => {
  const id = c.req.param("id");
  const [view, locations] = await Promise.all([loadView(c, id), locationOptions(c)]);
  if (!view) return c.notFound();
  const actor = c.get("actor");
  return c.html(
    <Layout
      title={`仕入返品（${view.order.number}）`}
      actor={actor}
      current={paths.purchaseOrders()}
    >
      <PageHeader title={`仕入返品（${view.order.number}）`}>
        <p class="hint">
          入荷後に見つかった不良品などを仕入先に返します。在庫から減らし、仕入先請求書の計算額から差し引きます。
        </p>
      </PageHeader>
      {view.actions.returnGoods ? (
        <ReturnForm
          view={view}
          locations={locations}
          values={{
            returnedOn: toBusinessDate(new Date()),
            locationId: view.order.destinationLocationId ?? "",
            memo: "",
            units: new Map(),
          }}
        />
      ) : (
        <Alert kind="warning">
          この発注には、仕入返品を記録できる入荷がない（または権限がない）ため記録できません。
        </Alert>
      )}
      <p>
        <a href={paths.purchaseOrder(id)}>発注に戻る</a>
      </p>
    </Layout>,
  );
});

purchaseOrderRoutes.post("/:id/returns/new", async (c) => {
  const id = c.req.param("id");
  const form = await readForm(c);
  const lineIds = strs(form, "lineId");
  const unitTexts = strs(form, "units");
  const values = {
    returnedOn: str(form, "returnedOn"),
    locationId: str(form, "locationId"),
    memo: str(form, "memo"),
    units: new Map(lineIds.map((l, i) => [l, unitTexts[i] ?? ""])),
  };
  const result = await runCommand(
    c,
    "purchaseReturns.create",
    {
      purchaseOrderId: id,
      returnedOn: values.returnedOn,
      locationId: values.locationId,
      memo: values.memo,
      lines: lineIds.map((lineId, i) => ({
        lineId,
        units: (unitTexts[i] ?? "").trim() === "" ? 0 : intText(unitTexts[i] ?? ""),
      })),
    },
    formKey(form),
  );
  if (result.ok) return redirectTo(c, paths.purchaseOrder(id, { notice: "returned" }));
  const [view, locations, shortages] = await Promise.all([
    loadView(c, id),
    locationOptions(c),
    result.error.code === "insufficient_stock"
      ? runQuery(c, "stock.shortages", { details: [...(result.error.details ?? [])] })
      : Promise.resolve(undefined),
  ]);
  if (!view) return c.notFound();
  return c.html(
    <ReturnForm
      view={view}
      locations={locations}
      values={values}
      error={result.error}
      shortages={shortages}
    />,
  );
});
