/**
 * 受注（要件定義書 3.8、5章 受注一覧・受注の作成・編集・受注詳細）。
 * 一覧（絞り込み・CSV）、作成・編集（明細の行と合計をサーバーで計算し直す）、詳細（発送・取消・分割・発送の取消）。
 */
import { Hono, type Context } from "hono";

import { toBusinessDate } from "../../../domain/dates";
import { parseYenToCenti } from "../../../domain/money";
import type { DomainError } from "../../../domain/result";
import { SALES_ORDER_STATUS_LABELS, type SalesOrderStatus } from "../../../domain/sales";
import type { OrderReturns } from "../../../usecases/billing/returns";
import type { MakerDirectPlan } from "../../../usecases/purchasing/maker-direct";
import type { OrderEvaluation } from "../../../usecases/sales/evaluate";
import type { SalesOrderView } from "../../../usecases/sales/orders";
import type { ShortageDetail } from "../../../usecases/stock/queries";
import { exportCsv } from "../../csv-exports";
import { bool, formKey, int, readForm, str, strs, type FormData_ } from "../../form";
import { isHtmx, NOTICES, redirectTo } from "../../http";
import { hasPermission } from "../../middleware";
import { paths, type Query } from "../../paths";
import type { AppEnv } from "../../types";
import { queryAs, runCommand, runQuery } from "../../usecase";
import { SalesReturnsSection } from "../../views/billing";
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
import { centiPlain, dateTime, qty, yen } from "../../views/format";
import { ItemPicker, pickedItemIds } from "../../views/item-picker";
import { Layout } from "../../views/layout";
import { MakerDirectOrders } from "../../views/maker-direct";
import { OrderLinesTable, SalesOrderStatusBadge } from "../../views/sales";
import {
  ChargeRow,
  LineRow,
  LINES_ID,
  OrderTotals,
  PICKER_ID,
  FORM_ID,
  SalesOrderForm,
  ShipDateField,
  type ChargeView,
  type LineView,
  type OrderFormOptions,
  type OrderFormValues,
} from "../../views/sales-order-form";
import { StockErrorSummary } from "../../views/stock";

export const salesOrderRoutes = new Hono<AppEnv>();

const ORDER_NOTICES: Readonly<Record<string, string>> = {
  ...NOTICES,
  created: "受注を登録しました",
  updated: "受注を保存しました",
  shipped: "発送しました。納品書を発行しました（PDF はこの後に作成します）",
  cancelled: "受注を取り消しました。引当を解除しました",
  split: "受注を分割しました",
  shipment_cancelled: "発送を取り消しました。在庫と引当を戻し、納品書を取消済みにしました",
};

const STATUSES: readonly SalesOrderStatus[] = ["received", "shipped", "cancelled"];
const STATUS_OPTIONS: Option[] = STATUSES.map((s) => ({
  value: s,
  label: SALES_ORDER_STATUS_LABELS[s],
}));

// ---- 一覧 ---------------------------------------------------------------------

function filterFrom(get: (name: string) => string) {
  const text = (name: string) => get(name).trim() || undefined;
  return {
    status: STATUSES.find((s) => s === get("status")),
    customerId: text("customerId"),
    locationId: text("locationId"),
    shipFrom: text("shipFrom"),
    shipTo: text("shipTo"),
    q: text("q"),
    shortage: get("shortage") === "1",
  };
}

type Filter = ReturnType<typeof filterFrom>;

function filterQuery(f: Filter): Query {
  return { ...f, shortage: f.shortage ? 1 : undefined };
}

async function listOptions(c: Context<AppEnv>) {
  const [customers, locations] = await Promise.all([
    runQuery(c, "partners.options", { role: "customer" }),
    runQuery(c, "locations.options", {}),
  ]);
  return {
    customers: customers.map((p) => ({ value: p.id, label: p.name })),
    locations: locations.map((l) => ({ value: l.id, label: l.name })),
  };
}

salesOrderRoutes.get("/", async (c) => {
  const filter = filterFrom((name) => c.req.query(name) ?? "");
  const page = Math.max(1, Number(c.req.query("page") ?? "1") || 1);
  const [result, options] = await Promise.all([
    queryAs(c.env, c.get("actorRef"), "salesOrders.list", { ...filter, page, pageSize: 50 }),
    listOptions(c),
  ]);
  const query = filterQuery(filter);
  const canManage = hasPermission(c.get("actor").roles, "salesOrders.manage");
  const notice = ORDER_NOTICES[c.req.query("notice") ?? ""];
  return c.html(
    <Layout title="受注一覧" actor={c.get("actor")} current={paths.salesOrders()}>
      <PageHeader
        title="受注一覧"
        actions={
          <>
            <a class="btn btn-secondary" href={paths.shipping()}>
              発送リスト
            </a>
            {canManage ? (
              <a class="btn btn-primary" href={paths.salesOrderNew()}>
                受注を登録
              </a>
            ) : null}
          </>
        }
      />
      {notice ? <Alert kind="success">{notice}</Alert> : null}
      <form
        class="filters"
        method="get"
        action={paths.salesOrders()}
        hx-get={paths.salesOrders()}
        hx-target="#results"
        hx-select="#results"
        hx-swap="outerHTML"
        hx-push-url="true"
        hx-trigger="input changed delay:300ms from:input[name=q], change"
      >
        <div class="field wide">
          <label for="f-q">受注番号・販売先・商品・メモで検索</label>
          <Input name="q" type="search" value={filter.q} />
        </div>
        <Field label="状態" name="status">
          <Select name="status" value={filter.status} options={STATUS_OPTIONS} empty="すべて" />
        </Field>
        <Field label="販売先" name="customerId">
          <Select
            name="customerId"
            value={filter.customerId}
            options={options.customers}
            empty="すべて"
          />
        </Field>
        <Field label="出荷元" name="locationId">
          <Select
            name="locationId"
            value={filter.locationId}
            options={[...options.locations, { value: "maker", label: "メーカー直" }]}
            empty="すべて"
          />
        </Field>
        <Field label="出荷予定日（から）" name="shipFrom">
          <Input name="shipFrom" type="date" value={filter.shipFrom} />
        </Field>
        <Field label="出荷予定日（まで）" name="shipTo">
          <Input name="shipTo" type="date" value={filter.shipTo} />
        </Field>
        <Checkbox
          name="shortage"
          value="1"
          label="出荷可能数が足りない受注だけ"
          checked={filter.shortage}
        />
        <noscript>
          <button type="submit" class="btn btn-secondary">
            検索
          </button>
        </noscript>
      </form>
      <section id="results">
        <div class="toolbar">
          <CsvButton action={paths.salesOrdersCsv()} filters={query} />
        </div>
        {!result.ok ? (
          <Alert kind="error">{result.error.message}</Alert>
        ) : result.value.rows.length === 0 ? (
          <EmptyState message="条件に合う受注はありません" />
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>受注番号</th>
                  <th>状態</th>
                  <th>出荷予定日</th>
                  <th>販売先</th>
                  <th>出荷元</th>
                  <th class="num">明細</th>
                  <th class="num">合計（税込）</th>
                  <th>受注日</th>
                  <th>担当</th>
                </tr>
              </thead>
              <tbody>
                {result.value.rows.map((o) => (
                  <tr class={o.shortage ? "row-warning" : undefined}>
                    <td class="nowrap">
                      <a href={paths.salesOrder(o.id)}>{o.number}</a>
                    </td>
                    <td>
                      <SalesOrderStatusBadge status={o.status} />{" "}
                      {o.shortage ? <Badge kind="warning">在庫不足</Badge> : null}
                    </td>
                    <td class="nowrap">{o.shipPlannedOn}</td>
                    <td>{o.customerName}</td>
                    <td>{o.makerDirect ? <Badge>メーカー直</Badge> : (o.locationName ?? "")}</td>
                    <td class="num">{o.lineCount}</td>
                    <td class="num">{yen(o.total)}</td>
                    <td class="nowrap">{o.orderedOn}</td>
                    <td>{o.employeeName ?? ""}</td>
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
            href={(p) => paths.salesOrders({ ...query, page: p })}
          />
        ) : null}
      </section>
    </Layout>,
  );
});

salesOrderRoutes.post("/csv", async (c) => {
  const form = await readForm(c);
  return exportCsv(
    c,
    "salesOrders",
    filterFrom((name) => str(form, name)),
    formKey(form),
  );
});

// ---- 作成・編集のフォーム ------------------------------------------------------------

interface DraftLine {
  readonly itemId: string;
  readonly quantity: string;
  readonly price: string;
  readonly reason: string;
}

function valuesFromForm(form: FormData_): OrderFormValues {
  return {
    customerId: str(form, "customerId"),
    orderedOn: str(form, "orderedOn"),
    customerContactName: str(form, "customerContactName"),
    makerDirect: bool(form, "makerDirect"),
    locationId: str(form, "locationId"),
    employeeId: str(form, "employeeId"),
    deliveryRequestedOn: str(form, "deliveryRequestedOn"),
    shipPlannedOn: str(form, "shipPlannedOn"),
    memo: str(form, "memo"),
  };
}

function linesFromForm(form: FormData_): DraftLine[] {
  const quantities = strs(form, "lineQuantity");
  const prices = strs(form, "linePrice");
  const reasons = strs(form, "linePriceReason");
  return strs(form, "lineItemId").map((itemId, i) => ({
    itemId,
    quantity: quantities[i] ?? "",
    price: prices[i] ?? "",
    reason: reasons[i] ?? "",
  }));
}

function chargesFromForm(form: FormData_): Omit<ChargeView, "amount">[] {
  const descriptions = strs(form, "chargeDescription");
  const quantities = strs(form, "chargeQuantity");
  const amounts = strs(form, "chargeUnitAmount");
  const taxes = strs(form, "chargeTaxCategory");
  return strs(form, "chargeKey").map((key, i) => ({
    key,
    description: descriptions[i] ?? "",
    quantity: quantities[i] ?? "",
    unitAmount: amounts[i] ?? "",
    taxCategory: taxes[i] === "reduced" ? "reduced" : "standard",
  }));
}

/** 「12」の形の整数。それ以外は NaN（登録のときにユースケースの検証でエラーになる） */
function intText(text: string): number {
  const t = text.replaceAll(",", "").trim();
  return /^\d{1,9}$/.test(t) ? Number(t) : Number.NaN;
}

function centiText(text: string): number {
  return parseYenToCenti(text) ?? Number.NaN;
}

function orNull(n: number): number | null {
  return Number.isNaN(n) ? null : n;
}

function commandFields(values: OrderFormValues, form: FormData_) {
  return {
    customerId: values.customerId,
    orderedOn: values.orderedOn,
    customerContactName: values.customerContactName,
    makerDirect: values.makerDirect,
    locationId: values.locationId,
    employeeId: values.employeeId,
    deliveryRequestedOn: values.deliveryRequestedOn,
    shipPlannedOn: values.shipPlannedOn,
    memo: values.memo,
    lines: linesFromForm(form).map((l) => ({
      itemId: l.itemId,
      quantity: intText(l.quantity),
      unitPriceCenti: centiText(l.price),
      priceOverrideReason: l.reason,
    })),
    charges: chargesFromForm(form).map((ch) => ({
      description: ch.description,
      quantity: intText(ch.quantity),
      unitAmount: intText(ch.unitAmount),
      taxCategory: ch.taxCategory,
    })),
  };
}

async function evaluate(
  c: Context<AppEnv>,
  orderId: string | null,
  values: OrderFormValues,
  lines: readonly DraftLine[],
  charges: readonly Omit<ChargeView, "amount">[],
): Promise<OrderEvaluation> {
  return runQuery(c, "salesOrders.preview", {
    orderId,
    orderedOn: values.orderedOn,
    makerDirect: values.makerDirect,
    locationId: values.locationId || null,
    lines: lines.map((l) => ({
      itemId: l.itemId,
      quantity: orNull(intText(l.quantity)),
      unitPriceCenti: orNull(centiText(l.price)),
      priceOverrideReason: l.reason.trim() === "" ? null : l.reason,
    })),
    charges: charges.map((ch) => ({
      description: ch.description,
      quantity: orNull(intText(ch.quantity)),
      unitAmount: orNull(intText(ch.unitAmount)),
      taxCategory: ch.taxCategory,
    })),
  });
}

/** 計算結果と入力中の文字から、明細の行の表示を作る。errors は登録のエラー（lines.<i>.<項目>） */
function lineViews(
  evaluation: OrderEvaluation,
  drafts: readonly DraftLine[],
  errors: FormErrors = {},
): LineView[] {
  const byItem = new Map(drafts.map((d, i) => [d.itemId, { d, i }]));
  return evaluation.lines.flatMap((line) => {
    const found = byItem.get(line.itemId);
    if (!found) return [];
    const { d, i } = found;
    const e = (field: string) => errors[`lines.${i}.${field}`];
    return [
      {
        line,
        quantity: d.quantity,
        price: d.price,
        reason: d.reason,
        errors: {
          quantity: e("quantity"),
          price: e("unitPriceCenti"),
          reason: e("priceOverrideReason"),
          item: e("itemId"),
        },
      },
    ];
  });
}

function chargeViews(
  evaluation: OrderEvaluation,
  charges: readonly Omit<ChargeView, "amount">[],
  errors: FormErrors = {},
): ChargeView[] {
  return charges.map((ch, i) => ({
    ...ch,
    amount: evaluation.chargeAmounts[i] ?? null,
    error:
      errors[`charges.${i}.description`] ??
      errors[`charges.${i}.quantity`] ??
      errors[`charges.${i}.unitAmount`],
  }));
}

function withCurrent(list: Option[], extra: Option | undefined): Option[] {
  return extra && !list.some((o) => o.value === extra.value) ? [extra, ...list] : list;
}

/** 選択肢。取引終了などで一覧にない、今の値も選べるように足す */
async function formOptions(
  c: Context<AppEnv>,
  current?: { customer?: Option | undefined; location?: Option | undefined },
): Promise<OrderFormOptions> {
  const [customers, locations, employees] = await Promise.all([
    runQuery(c, "partners.options", { role: "customer" }),
    runQuery(c, "locations.options", {}),
    runQuery(c, "employees.list", {}),
  ]);
  return {
    customers: withCurrent(
      customers.map((p) => ({ value: p.id, label: p.name })),
      current?.customer,
    ),
    locations: withCurrent(
      locations.map((l) => ({ value: l.id, label: l.name })),
      current?.location,
    ),
    employees: employees.filter((e) => e.active).map((e) => ({ value: e.id, label: e.name })),
  };
}

function newChargeKey(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}

async function renderForm(
  c: Context<AppEnv>,
  props: {
    orderId: string | null;
    version: number | null;
    values: OrderFormValues;
    lines: readonly DraftLine[];
    charges: readonly Omit<ChargeView, "amount">[];
    options: OrderFormOptions;
    error?: DomainError | undefined;
  },
) {
  const errors = props.error ? toFormErrors(props.error, props.orderId ? "fields." : "") : {};
  const evaluation = await evaluate(c, props.orderId, props.values, props.lines, props.charges);
  return (
    <SalesOrderForm
      action={props.orderId ? paths.salesOrderEdit(props.orderId) : paths.salesOrderNew()}
      submitLabel={props.orderId ? "保存する" : "登録する"}
      orderId={props.orderId}
      version={props.version}
      values={props.values}
      lines={lineViews(evaluation, props.lines, errors)}
      charges={chargeViews(evaluation, props.charges, errors)}
      summary={evaluation.summary}
      incomplete={evaluation.incomplete}
      options={props.options}
      errors={errors}
      error={props.error}
    />
  );
}

function FormPage(props: { title: string; c: Context<AppEnv>; form: unknown; canManage: boolean }) {
  return (
    <Layout title={props.title} actor={props.c.get("actor")} current={paths.salesOrders()}>
      <PageHeader title={props.title} />
      {props.canManage ? (
        <>
          {props.form}
          <ItemPicker
            id={PICKER_ID}
            addUrl={paths.salesOrderLines()}
            target={`#${LINES_ID}`}
            include={`#${FORM_ID}`}
          />
        </>
      ) : (
        <Alert kind="warning">受注を登録・編集する権限がありません。</Alert>
      )}
    </Layout>
  );
}

salesOrderRoutes.get("/new", async (c) => {
  const actor = c.get("actor");
  const canManage = hasPermission(actor.roles, "salesOrders.manage");
  const options = await formOptions(c);
  const today = toBusinessDate(new Date());
  const form = await renderForm(c, {
    orderId: null,
    version: null,
    values: {
      customerId: "",
      orderedOn: today,
      customerContactName: "",
      makerDirect: false,
      locationId: options.locations.length === 1 ? (options.locations[0]?.value ?? "") : "",
      employeeId: options.employees.some((e) => e.value === actor.employeeId)
        ? actor.employeeId
        : "",
      deliveryRequestedOn: "",
      shipPlannedOn: today,
      memo: "",
    },
    lines: [],
    charges: [],
    options,
  });
  return c.html(<FormPage title="受注の登録" c={c} form={form} canManage={canManage} />);
});

salesOrderRoutes.post("/new", async (c) => {
  const form = await readForm(c);
  const values = valuesFromForm(form);
  const result = await runCommand(
    c,
    "salesOrders.create",
    commandFields(values, form),
    formKey(form),
  );
  if (result.ok) return redirectTo(c, paths.salesOrder(result.value.id, { notice: "created" }));
  return c.html(
    await renderForm(c, {
      orderId: null,
      version: null,
      values,
      lines: linesFromForm(form),
      charges: chargesFromForm(form),
      options: await formOptions(c),
      error: result.error,
    }),
  );
});

/** 商品選択ダイアログで選んだ商品を、明細の行にして返す（すでにある商品は除く）。合計欄も差し替える */
salesOrderRoutes.post("/form/lines", async (c) => {
  const form = await readForm(c);
  const current = linesFromForm(form);
  const existing = new Set(current.map((l) => l.itemId));
  const ids = pickedItemIds(form).filter((id) => !existing.has(id));
  if (ids.length === 0) return c.body(null, 200);
  const items = await runQuery(c, "items.getMany", { ids });
  const added: DraftLine[] = items.map((i) => ({
    itemId: i.id,
    quantity: String(i.salesMinLot),
    price: centiPlain(i.salesPriceCenti),
    reason: "",
  }));
  const values = valuesFromForm(form);
  const evaluation = await evaluate(
    c,
    str(form, "orderId") || null,
    values,
    [...current, ...added],
    chargesFromForm(form),
  );
  const addedIds = new Set(added.map((a) => a.itemId));
  return c.html(
    <>
      {lineViews(evaluation, added)
        .filter((v) => addedIds.has(v.line.itemId))
        .map((v) => (
          <LineRow view={v} />
        ))}
      <OrderTotals summary={evaluation.summary} incomplete={evaluation.incomplete} oob />
    </>,
  );
});

/**
 * 明細・送料・見出しの変更で計算し直す。
 * - row=<商品 ID>：その明細の行、charge=<行の値>：その送料の行
 * - remove=<商品 ID>・removeCharge=<行の値>：行を消す（空の応答で行を差し替える）
 * - scope=lines：保管場所・受注日・メーカー直を変えたので、明細の行をすべて
 * どの場合も合計欄（tfoot#so-totals）を hx-swap-oob で一緒に返す
 */
salesOrderRoutes.post("/form/recalc", async (c) => {
  const form = await readForm(c);
  const remove = str(form, "remove");
  const removeCharge = str(form, "removeCharge");
  const lines = linesFromForm(form).filter((l) => l.itemId !== remove);
  const charges = chargesFromForm(form).filter((ch) => ch.key !== removeCharge);
  const values = valuesFromForm(form);
  const evaluation = await evaluate(c, str(form, "orderId") || null, values, lines, charges);
  const totals = (
    <OrderTotals summary={evaluation.summary} incomplete={evaluation.incomplete} oob />
  );
  if (remove || removeCharge) return c.html(totals);
  if (str(form, "scope") === "lines") {
    return c.html(
      <>
        {lineViews(evaluation, lines).map((v) => (
          <LineRow view={v} />
        ))}
        {totals}
      </>,
    );
  }
  const row = str(form, "row");
  if (row) {
    const view = lineViews(evaluation, lines).find((v) => v.line.itemId === row);
    return c.html(
      <>
        {view ? <LineRow view={view} /> : null}
        {totals}
      </>,
    );
  }
  const chargeKey = str(form, "charge");
  const charge = chargeViews(evaluation, charges).find((ch) => ch.key === chargeKey);
  return c.html(
    <>
      {charge ? <ChargeRow view={charge} /> : null}
      {totals}
    </>,
  );
});

salesOrderRoutes.post("/form/charge", (c) =>
  c.html(
    <ChargeRow
      view={{
        key: newChargeKey(),
        description: "送料",
        quantity: "1",
        unitAmount: "",
        taxCategory: "standard",
        amount: null,
      }}
    />,
  ),
);

salesOrderRoutes.post("/form/ship-date", async (c) => {
  const form = await readForm(c);
  const result = await queryAs(c.env, c.get("actorRef"), "salesOrders.defaultShipDate", {
    customerId: str(form, "customerId"),
    deliveryRequestedOn: str(form, "deliveryRequestedOn"),
    orderedOn: str(form, "orderedOn"),
  });
  return c.html(
    result.ok ? (
      <ShipDateField value={result.value} />
    ) : (
      <ShipDateField
        value={str(form, "shipPlannedOn")}
        error={result.error.fields?.[0]?.message ?? result.error.message}
      />
    ),
  );
});

// ---- 詳細 ---------------------------------------------------------------------

const DELIVERY_NOTE_DATE_ID = "delivery-note-date";

/**
 * 納品書の発行日の欄。空なら、発送するときに発送日から初期値を決める（当日、月締めの販売先は締め日）。
 * 初期値は案内に出し、発送日を変えると計算し直してこの欄だけを差し替える。初期値を入力欄に入れておくと、
 * 発送日を変えた直後に送ったときに古い初期値で発行してしまうため、入力欄は空にしておく
 */
function DeliveryNoteDateField(props: { defaultOn: string | null; value: string }) {
  return (
    <div id={DELIVERY_NOTE_DATE_ID}>
      <Field
        label="納品書の発行日"
        name="deliveryNoteIssuedOn"
        hint={`空なら初期値${props.defaultOn ? `（${props.defaultOn}）` : ""}にします。初期値は当日、月締めの販売先は発送日を含む締め期間の締め日です`}
      >
        <Input name="deliveryNoteIssuedOn" type="date" value={props.value} />
      </Field>
    </div>
  );
}

function DetailBody(props: {
  view: SalesOrderView;
  /** 今日発送するときの納品書の発行日の初期値（発送できる受注だけ） */
  deliveryNoteDefault?: string | null | undefined;
  /** 返品伝票の欄（請求の区分の照会） */
  returns: OrderReturns | null;
  canManage: boolean;
  canShip: boolean;
  canReturn: boolean;
  notice?: string | undefined;
  error?: DomainError | undefined;
  shortages?: readonly ShortageDetail[] | undefined;
  /** メーカー直の受注から作った発注（メーカー直の受注だけ） */
  makerDirect?: MakerDirectPlan | null | undefined;
}) {
  const { order, evaluation, shipments, actions } = props.view;
  const today = toBusinessDate(new Date());
  return (
    <div id="so-detail">
      <PageHeader
        title={`受注 ${order.number}`}
        actions={
          props.canManage ? (
            <>
              {actions.edit ? (
                <a class="btn btn-secondary" href={paths.salesOrderEdit(order.id)}>
                  編集
                </a>
              ) : null}
              {actions.split ? (
                <a class="btn btn-secondary" href={paths.salesOrderSplit(order.id)}>
                  分割
                </a>
              ) : null}
            </>
          ) : null
        }
      >
        <p>
          <SalesOrderStatusBadge status={order.status} />{" "}
          {order.makerDirect ? <Badge>メーカー直</Badge> : null}
        </p>
      </PageHeader>
      {props.notice ? <Alert kind="success">{props.notice}</Alert> : null}
      {props.error?.code === "insufficient_stock" ? (
        <StockErrorSummary error={props.error} shortages={props.shortages} />
      ) : (
        <ErrorSummary error={props.error ? withFieldMessages(props.error) : null} />
      )}
      <section class="card">
        <DescriptionList
          items={[
            ["販売先", order.customerName],
            ["受注日", order.orderedOn],
            ["先方の担当者", order.customerContactName],
            ["出荷元", order.makerDirect ? "メーカー直（在庫を動かさない）" : order.locationName],
            ["納品希望日", order.deliveryRequestedOn],
            ["出荷予定日", order.shipPlannedOn],
            ["社内の担当者", order.employeeName],
            [
              "分割元",
              order.splitFromId ? (
                <a href={paths.salesOrder(order.splitFromId)}>{order.splitFromNumber}</a>
              ) : null,
            ],
            [
              "分割した受注",
              order.splits.length > 0 ? (
                <>
                  {order.splits.map((s) => (
                    <>
                      <a href={paths.salesOrder(s.id)}>{s.number}</a>（
                      {SALES_ORDER_STATUS_LABELS[s.status]}）{" "}
                    </>
                  ))}
                </>
              ) : null,
            ],
            ["メモ", order.memo ? <span class="pre">{order.memo}</span> : null],
            ["取消の理由", order.cancelReason],
            ["登録", dateTime(order.createdAt)],
          ]}
        />
      </section>
      <section class="card">
        <h2>明細</h2>
        <OrderLinesTable
          lines={evaluation.lines}
          saved={order.lines}
          charges={order.charges}
          chargeAmounts={evaluation.chargeAmounts}
          summary={evaluation.summary}
          withStock={actions.edit}
        />
      </section>
      {props.makerDirect ? <MakerDirectOrders plan={props.makerDirect} /> : null}
      {actions.ship && props.canShip ? (
        <section class="card">
          <h2>発送</h2>
          <form
            method="post"
            action={paths.salesOrderShip(order.id)}
            hx-post={paths.salesOrderShip(order.id)}
            hx-target="#so-detail"
            hx-swap="outerHTML"
            hx-confirm={`受注 ${order.number} を発送します。${order.makerDirect ? "" : "引当を外して在庫を減らし、"}納品書を発行します。よろしいですか？`}
            class="inline-form"
          >
            <FormKey />
            <Version value={order.version} />
            <div
              hx-post={paths.salesOrderDeliveryNoteDate(order.id)}
              hx-trigger="change"
              hx-target={`#${DELIVERY_NOTE_DATE_ID}`}
              hx-swap="outerHTML"
              hx-confirm="unset"
            >
              <Field label="発送日" name="shippedOn" required>
                <Input name="shippedOn" type="date" value={today} max={today} />
              </Field>
            </div>
            <DeliveryNoteDateField defaultOn={props.deliveryNoteDefault ?? null} value="" />
            <button type="submit" class="btn btn-primary btn-lg">
              発送する
            </button>
          </form>
          {order.makerDirect ? (
            <p class="hint">メーカー直の受注は在庫を動かさずに発送済みにします。</p>
          ) : null}
        </section>
      ) : null}
      <section class="card">
        <h2>発送の履歴と納品書</h2>
        {shipments.length === 0 ? (
          <p class="muted">まだ発送していません。</p>
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>納品書番号</th>
                  <th>発送日</th>
                  <th>状態</th>
                  <th>請求</th>
                  <th>納品書</th>
                  <th>記録</th>
                  <th>
                    <span class="sr-only">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shipments.map((s) => (
                  <tr class={s.cancelled ? "row-muted" : undefined}>
                    <td class="nowrap">{s.deliveryNoteNumber}</td>
                    <td class="nowrap">{s.shippedOn}</td>
                    <td>
                      {s.cancelled ? (
                        <>
                          <Badge>取消</Badge>
                          <div class="muted small">{s.cancelReason ?? ""}</div>
                        </>
                      ) : (
                        <Badge kind="success">有効</Badge>
                      )}
                    </td>
                    <td>
                      {s.invoiceId ? (
                        <a href={paths.invoice(s.invoiceId)}>請求書に記載済み</a>
                      ) : s.cancelled ? null : (
                        <a href={paths.invoiceNew({ shipmentId: s.id })}>未請求</a>
                      )}
                    </td>
                    <td>
                      {s.deliveryNote ? (
                        <>
                          <a href={paths.document(s.deliveryNote.documentId)}>納品書を開く</a>{" "}
                          {s.deliveryNote.cancelled ? (
                            <Badge>取消済み</Badge>
                          ) : s.deliveryNote.status === "ready" ? (
                            <a
                              class="btn btn-secondary btn-sm"
                              href={paths.documentDownload(s.deliveryNote.documentId)}
                            >
                              PDF
                            </a>
                          ) : s.deliveryNote.status === "failed" ? (
                            <Badge kind="danger">PDF 作成失敗</Badge>
                          ) : (
                            <Badge>PDF 作成中</Badge>
                          )}
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td class="small">
                      {dateTime(s.createdAt)}
                      <div class="muted">{s.createdByName ?? ""}</div>
                    </td>
                    <td>
                      {s.cancellable && props.canShip ? (
                        <details class="disclosure">
                          <summary class="btn btn-secondary btn-sm">発送を取り消す</summary>
                          <form
                            method="post"
                            action={paths.shipmentCancel(s.id)}
                            hx-post={paths.shipmentCancel(s.id)}
                            hx-target="#so-detail"
                            hx-swap="outerHTML"
                            hx-confirm={`発送（${s.deliveryNoteNumber}）を取り消します。在庫と引当を戻し、納品書を取消済みにします。よろしいですか？`}
                          >
                            <FormKey />
                            <Version value={s.version} />
                            <input type="hidden" name="orderId" value={order.id} />
                            <Field label="取り消す理由" name={`reason-${s.id}`} required>
                              <textarea
                                id={`f-reason-${s.id}`}
                                name="reason"
                                rows={2}
                                maxlength={500}
                              ></textarea>
                            </Field>
                            <button type="submit" class="btn btn-danger">
                              発送を取り消す
                            </button>
                          </form>
                        </details>
                      ) : null}
                      {!s.cancelled && s.invoiceId ? (
                        <span class="muted small">先に請求書を取り消してください</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {props.returns ? (
        <SalesReturnsSection orderId={order.id} data={props.returns} canManage={props.canReturn} />
      ) : null}
      {actions.cancel && props.canManage ? (
        <section class="card">
          <h2>受注の取消</h2>
          <form
            method="post"
            action={paths.salesOrderCancel(order.id)}
            hx-post={paths.salesOrderCancel(order.id)}
            hx-target="#so-detail"
            hx-swap="outerHTML"
            hx-confirm={`受注 ${order.number} を取り消します。引当を解除します。よろしいですか？`}
          >
            <FormKey />
            <Version value={order.version} />
            <Field label="取り消す理由" name="reason" required>
              <TextArea name="reason" rows={2} />
            </Field>
            <button type="submit" class="btn btn-danger">
              受注を取り消す
            </button>
          </form>
        </section>
      ) : null}
    </div>
  );
}

const ACTION_FIELD_LABELS: Readonly<Record<string, string>> = {
  reason: "取り消す理由",
  shippedOn: "発送日",
  deliveryNoteIssuedOn: "納品書の発行日",
};

/** 詳細での操作のエラー。項目のエラーは「項目名：内容」の一覧にする */
function withFieldMessages(error: DomainError): DomainError {
  const fields = error.fields ?? [];
  if (fields.length === 0) return { code: error.code, message: error.message };
  return {
    code: error.code,
    message: error.message,
    details: fields.map((f) => `${ACTION_FIELD_LABELS[f.field] ?? f.field}：${f.message}`),
  };
}

async function detailBody(
  c: Context<AppEnv>,
  id: string,
  extra: {
    notice?: string | undefined;
    error?: DomainError | undefined;
  } = {},
) {
  const view = await runQuery(c, "salesOrders.get", { id });
  if (!view) return null;
  const returns = await runQuery(c, "salesReturns.forOrder", { salesOrderId: id });
  const roles = c.get("actor").roles;
  const shortages =
    extra.error?.code === "insufficient_stock"
      ? await runQuery(c, "stock.shortages", { details: [...(extra.error.details ?? [])] })
      : undefined;
  const makerDirect = view.order.makerDirect
    ? await runQuery(c, "purchaseOrders.makerDirectPlan", { salesOrderId: id })
    : null;
  const deliveryNoteDefault = view.actions.ship
    ? await runQuery(c, "shipments.deliveryNoteDate", {
        salesOrderId: id,
        shippedOn: toBusinessDate(new Date()),
      })
    : null;
  return (
    <DetailBody
      view={view}
      deliveryNoteDefault={deliveryNoteDefault}
      returns={returns}
      canManage={hasPermission(roles, "salesOrders.manage")}
      canShip={hasPermission(roles, "shipments.manage")}
      canReturn={hasPermission(roles, "salesReturns.manage")}
      notice={extra.notice}
      error={extra.error}
      shortages={shortages}
      makerDirect={makerDirect}
    />
  );
}

salesOrderRoutes.get("/:id", async (c) => {
  const body = await detailBody(c, c.req.param("id"), {
    notice: ORDER_NOTICES[c.req.query("notice") ?? ""],
  });
  if (!body) return c.notFound();
  return c.html(
    <Layout title="受注詳細" actor={c.get("actor")} current={paths.salesOrders()}>
      {body}
    </Layout>,
  );
});

/** 詳細での操作の結果。htmx なら詳細の部分だけを返し、通常の送信なら詳細へ移る */
async function afterAction(
  c: Context<AppEnv>,
  id: string,
  result: { ok: true } | { ok: false; error: DomainError },
  notice: string,
) {
  if (!isHtmx(c)) {
    if (result.ok) return redirectTo(c, paths.salesOrder(id, { notice }));
    const body = await detailBody(c, id, { error: result.error });
    if (!body) return c.notFound();
    return c.html(
      <Layout title="受注詳細" actor={c.get("actor")} current={paths.salesOrders()}>
        {body}
      </Layout>,
      409,
    );
  }
  const body = await detailBody(
    c,
    id,
    result.ok ? { notice: ORDER_NOTICES[notice] } : { error: result.error },
  );
  if (!body) return c.notFound();
  return c.html(body);
}

salesOrderRoutes.post("/:id/ship", async (c) => {
  const id = c.req.param("id");
  const form = await readForm(c);
  const result = await runCommand(
    c,
    "shipments.ship",
    {
      id,
      version: int(form, "version"),
      shippedOn: str(form, "shippedOn"),
      deliveryNoteIssuedOn: str(form, "deliveryNoteIssuedOn"),
    },
    formKey(form),
  );
  return afterAction(c, id, result, "shipped");
});

/** 発送日を変えたときの、納品書の発行日の初期値（欄だけを差し替える） */
salesOrderRoutes.post("/:id/ship/delivery-note-date", async (c) => {
  const form = await readForm(c);
  const result = await queryAs(c.env, c.get("actorRef"), "shipments.deliveryNoteDate", {
    salesOrderId: c.req.param("id"),
    shippedOn: str(form, "shippedOn"),
  });
  // 入力中の発行日はそのまま残す。発送日が正しくなければ初期値は出さない（発送するときに検証する）
  return c.html(
    <DeliveryNoteDateField
      defaultOn={result.ok ? result.value : null}
      value={str(form, "deliveryNoteIssuedOn")}
    />,
  );
});

salesOrderRoutes.post("/:id/cancel", async (c) => {
  const id = c.req.param("id");
  const form = await readForm(c);
  const result = await runCommand(
    c,
    "salesOrders.cancel",
    { id, version: int(form, "version"), reason: str(form, "reason") },
    formKey(form),
  );
  return afterAction(c, id, result, "cancelled");
});

// ---- 編集 ---------------------------------------------------------------------

salesOrderRoutes.get("/:id/edit", async (c) => {
  const view = await runQuery(c, "salesOrders.get", { id: c.req.param("id") });
  if (!view) return c.notFound();
  const { order } = view;
  const canManage = hasPermission(c.get("actor").roles, "salesOrders.manage");
  if (!view.actions.edit) {
    return c.html(
      <Layout title="受注の編集" actor={c.get("actor")} current={paths.salesOrders()}>
        <Alert kind="warning">発送前（受注済み）の受注だけを編集できます。</Alert>
        <a href={paths.salesOrder(order.id)}>受注詳細に戻る</a>
      </Layout>,
      409,
    );
  }
  const options = await formOptions(c, {
    customer: { value: order.customerId, label: order.customerName },
    location:
      order.locationId && order.locationName
        ? { value: order.locationId, label: order.locationName }
        : undefined,
  });
  const form = await renderForm(c, {
    orderId: order.id,
    version: order.version,
    values: {
      customerId: order.customerId,
      orderedOn: order.orderedOn,
      customerContactName: order.customerContactName ?? "",
      makerDirect: order.makerDirect,
      locationId: order.locationId ?? "",
      employeeId: order.employeeId ?? "",
      deliveryRequestedOn: order.deliveryRequestedOn ?? "",
      shipPlannedOn: order.shipPlannedOn,
      memo: order.memo ?? "",
    },
    lines: order.lines.map((l) => ({
      itemId: l.itemId,
      quantity: String(l.quantity),
      price: centiPlain(l.unitPriceCenti),
      reason: l.priceOverrideReason ?? "",
    })),
    charges: order.charges.map((ch) => ({
      key: newChargeKey(),
      description: ch.description,
      quantity: String(ch.quantity),
      unitAmount: String(ch.unitAmount),
      taxCategory: ch.taxCategory,
    })),
    options,
  });
  return c.html(
    <FormPage title={`受注 ${order.number} の編集`} c={c} form={form} canManage={canManage} />,
  );
});

salesOrderRoutes.post("/:id/edit", async (c) => {
  const id = c.req.param("id");
  const form = await readForm(c);
  const values = valuesFromForm(form);
  const version = int(form, "version");
  const result = await runCommand(
    c,
    "salesOrders.update",
    { id, version, fields: commandFields(values, form) },
    formKey(form),
  );
  if (result.ok) return redirectTo(c, paths.salesOrder(id, { notice: "updated" }));
  return c.html(
    await renderForm(c, {
      orderId: id,
      version,
      values,
      lines: linesFromForm(form),
      charges: chargesFromForm(form),
      options: await formOptions(c),
      error: result.error,
    }),
  );
});

// ---- 分割 ---------------------------------------------------------------------

function SplitForm(props: {
  view: SalesOrderView;
  moves: ReadonlyMap<string, string>;
  shipPlannedOn: string;
  error?: DomainError | undefined;
  errors: FormErrors;
}) {
  const { order } = props.view;
  return (
    <form
      method="post"
      action={paths.salesOrderSplit(order.id)}
      hx-post={paths.salesOrderSplit(order.id)}
      hx-target="this"
      hx-swap="outerHTML"
      class="form"
    >
      <ErrorSummary error={props.error} />
      <FormKey />
      <Version value={order.version} />
      <p class="hint">
        新しい受注に移す数を入力してください。送料などは元の受注に残ります。保管場所は同じなので、引当の合計は変わりません。
      </p>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>商品</th>
              <th class="num">今の数量</th>
              <th>新しい受注に移す数</th>
            </tr>
          </thead>
          <tbody>
            {order.lines.map((l) => (
              <tr>
                <td>
                  <input type="hidden" name="lineId" value={l.id} />
                  <span class="muted small">{l.itemCode}</span> {l.itemName}
                </td>
                <td class="num">
                  {qty(l.quantity)}
                  <span class="muted small">{l.salesUnitName}</span>
                </td>
                <td>
                  <input
                    name="moveQuantity"
                    type="number"
                    inputmode="numeric"
                    min={0}
                    max={l.quantity}
                    step={1}
                    value={props.moves.get(l.id) ?? "0"}
                    aria-label={`${l.itemName}の新しい受注に移す数`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Field
        label="新しい受注の出荷予定日"
        name="shipPlannedOn"
        error={props.errors["shipPlannedOn"]}
        hint="未入力なら元の受注と同じ日"
      >
        <Input name="shipPlannedOn" type="date" value={props.shipPlannedOn} />
      </Field>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">
          分割する
        </button>
        <a class="btn btn-secondary" href={paths.salesOrder(order.id)}>
          やめる
        </a>
      </div>
    </form>
  );
}

salesOrderRoutes.get("/:id/split", async (c) => {
  const view = await runQuery(c, "salesOrders.get", { id: c.req.param("id") });
  if (!view) return c.notFound();
  const canManage = hasPermission(c.get("actor").roles, "salesOrders.manage");
  return c.html(
    <Layout
      title={`受注 ${view.order.number} の分割`}
      actor={c.get("actor")}
      current={paths.salesOrders()}
    >
      <PageHeader title={`受注 ${view.order.number} の分割`} />
      {!canManage ? (
        <Alert kind="warning">受注を分割する権限がありません。</Alert>
      ) : !view.actions.split ? (
        <Alert kind="warning">発送前（受注済み）で、数量が2以上の受注だけを分割できます。</Alert>
      ) : (
        <SplitForm
          view={view}
          moves={new Map()}
          shipPlannedOn={view.order.shipPlannedOn}
          errors={{}}
        />
      )}
    </Layout>,
  );
});

salesOrderRoutes.post("/:id/split", async (c) => {
  const id = c.req.param("id");
  const form = await readForm(c);
  const lineIds = strs(form, "lineId");
  const quantities = strs(form, "moveQuantity");
  const moves = lineIds.map((lineId, i) => ({
    lineId,
    quantity: (quantities[i] ?? "").trim() === "" ? 0 : intText(quantities[i] ?? ""),
  }));
  const result = await runCommand(
    c,
    "salesOrders.split",
    { id, version: int(form, "version"), moves, shipPlannedOn: str(form, "shipPlannedOn") },
    formKey(form),
  );
  if (result.ok) return redirectTo(c, paths.salesOrder(result.value.id, { notice: "split" }));
  const view = await runQuery(c, "salesOrders.get", { id });
  if (!view) return c.notFound();
  return c.html(
    <SplitForm
      view={view}
      moves={new Map(lineIds.map((l, i) => [l, quantities[i] ?? ""]))}
      shipPlannedOn={str(form, "shipPlannedOn")}
      error={result.error}
      errors={toFormErrors(result.error)}
    />,
  );
});

// ---- 発送の取消 -------------------------------------------------------------------

export const shipmentRoutes = new Hono<AppEnv>();

shipmentRoutes.post("/:id/cancel", async (c) => {
  const form = await readForm(c);
  const result = await runCommand(
    c,
    "shipments.cancel",
    { shipmentId: c.req.param("id"), version: int(form, "version"), reason: str(form, "reason") },
    formKey(form),
  );
  if (result.ok) return afterAction(c, result.value.salesOrderId, result, "shipment_cancelled");
  const orderId = str(form, "orderId");
  if (!orderId) return c.text(result.error.message, 409);
  return afterAction(c, orderId, result, "shipment_cancelled");
});
