/**
 * 販売先廃棄（要件定義書 3.12、5章 販売先廃棄）。廃棄伝票の一覧・登録・詳細と、廃棄率の集計（CSV つき）。
 * 登録画面では、販売先を選ぶとその販売先に出荷したことのある商品を先に並べ、ほかの商品は商品選択ダイアログで足す。
 * 記録と分析のためだけに使い、請求・入金・自社の在庫には影響しない。
 */
import { Hono, type Context } from "hono";
import type { Child } from "hono/jsx";

import { DISPOSAL_REASON_LABELS, type DisposalReason } from "../../../domain/billing";
import { monthOf, monthRange, toBusinessDate } from "../../../domain/dates";
import type { DomainError } from "../../../domain/result";
import { exportCsv } from "../../csv-exports";
import { formKey, readForm, str, strs, type FormData_ } from "../../form";
import { isHtmx, redirectTo } from "../../http";
import { hasPermission } from "../../middleware";
import { paths, type Query } from "../../paths";
import type { AppEnv } from "../../types";
import { queryAs, runCommand, runQuery } from "../../usecase";
import { disposalReasonLabel } from "../../views/billing";
import {
  Alert,
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
  type FormErrors,
  type Option,
} from "../../views/components";
import { CsvButton } from "../../views/csv-button";
import { dateTime, qty, rate } from "../../views/format";
import { ItemPicker, ItemPickerButton, pickedItemIds } from "../../views/item-picker";
import { Layout } from "../../views/layout";

export const disposalRoutes = new Hono<AppEnv>();

const PICKER_ID = "ds-picker";
const LINES_ID = "disposal-lines";
const FORM_ID = "disposal-form";

const REASONS: readonly DisposalReason[] = ["expired", "damaged", "other"];

async function customerOptions(c: Context<AppEnv>): Promise<Option[]> {
  const customers = await runQuery(c, "partners.options", { role: "customer" });
  return customers.map((p) => ({ value: p.id, label: p.name }));
}

// ---- 一覧 ---------------------------------------------------------------------

function filterFrom(get: (name: string) => string) {
  const text = (name: string) => get(name).trim() || undefined;
  return { customerId: text("customerId"), from: text("from"), to: text("to") };
}

function Tabs(props: { current: "list" | "rates" }) {
  return (
    <nav class="tabs" aria-label="販売先廃棄">
      <a href={paths.disposals()} aria-current={props.current === "list" ? "page" : undefined}>
        廃棄伝票
      </a>
      <a href={paths.disposalRates()} aria-current={props.current === "rates" ? "page" : undefined}>
        廃棄率の集計
      </a>
    </nav>
  );
}

function Header(props: { c: Context<AppEnv> }) {
  return (
    <PageHeader
      title="販売先廃棄"
      actions={
        hasPermission(props.c.get("actor").roles, "disposals.manage") ? (
          <a class="btn btn-primary" href={paths.disposalNew()}>
            廃棄伝票を登録
          </a>
        ) : null
      }
    >
      <p class="muted">販売先で廃棄した商品の記録です。請求・入金・自社の在庫には影響しません。</p>
    </PageHeader>
  );
}

disposalRoutes.get("/", async (c) => {
  const filter = filterFrom((name) => c.req.query(name) ?? "");
  const page = Math.max(1, Number(c.req.query("page") ?? "1") || 1);
  const [result, customers] = await Promise.all([
    queryAs(c.env, c.get("actorRef"), "disposals.list", { ...filter, page, pageSize: 50 }),
    customerOptions(c),
  ]);
  const query: Query = filter;
  const notice = c.req.query("notice") === "created" ? "廃棄伝票を登録しました" : undefined;
  return c.html(
    <Layout title="販売先廃棄" actor={c.get("actor")} current={paths.disposals()}>
      <Header c={c} />
      {notice ? <Alert kind="success">{notice}</Alert> : null}
      <Tabs current="list" />
      <form
        class="filters"
        method="get"
        action={paths.disposals()}
        hx-get={paths.disposals()}
        hx-target="#results"
        hx-select="#results"
        hx-swap="outerHTML"
        hx-push-url="true"
        hx-trigger="change"
      >
        <Field label="販売先" name="customerId">
          <Select name="customerId" value={filter.customerId} options={customers} empty="すべて" />
        </Field>
        <Field label="廃棄日（から）" name="from">
          <Input name="from" type="date" value={filter.from} />
        </Field>
        <Field label="廃棄日（まで）" name="to">
          <Input name="to" type="date" value={filter.to} />
        </Field>
        <noscript>
          <button type="submit" class="btn btn-secondary">
            検索
          </button>
        </noscript>
      </form>
      <section id="results">
        <div class="toolbar">
          <CsvButton action={paths.disposalsCsv()} filters={query} />
        </div>
        {!result.ok ? (
          <Alert kind="error">{result.error.message}</Alert>
        ) : result.value.rows.length === 0 ? (
          <EmptyState message="条件に合う廃棄伝票はありません" />
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>廃棄伝票</th>
                  <th>廃棄日</th>
                  <th>販売先</th>
                  <th>先方の担当者</th>
                  <th class="num">商品数</th>
                  <th class="num">数量の合計</th>
                </tr>
              </thead>
              <tbody>
                {result.value.rows.map((d) => (
                  <tr>
                    <td class="nowrap">
                      <a href={paths.disposal(d.id)}>{d.number}</a>
                    </td>
                    <td class="nowrap">{d.disposedOn}</td>
                    <td>{d.customerName}</td>
                    <td>{d.contactName ?? ""}</td>
                    <td class="num">{d.lineCount}</td>
                    <td class="num">{qty(d.totalQuantity)}</td>
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
            href={(p) => paths.disposals({ ...query, page: p })}
          />
        ) : null}
      </section>
    </Layout>,
  );
});

disposalRoutes.post("/csv", async (c) => {
  const form = await readForm(c);
  return exportCsv(
    c,
    "disposals",
    filterFrom((name) => str(form, name)),
    formKey(form),
  );
});

// ---- 登録 ---------------------------------------------------------------------

interface LineItem {
  readonly itemId: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly unitName: string;
  /** 販売先に最後に出荷した日（出荷したことがなければ null） */
  readonly lastShippedOn: string | null;
}

interface LineDraft {
  readonly quantity: string;
  readonly reason: string;
  readonly error?: string | undefined;
}

function LineRow(props: { item: LineItem; draft?: LineDraft | undefined }) {
  const { item, draft } = props;
  return (
    <tr data-line-item={item.itemId}>
      <td>
        <input type="hidden" name="lineItemId" value={item.itemId} />
        <input type="hidden" name="lineCode" value={item.itemCode} />
        <input type="hidden" name="lineName" value={item.itemName} />
        <input type="hidden" name="lineUnit" value={item.unitName} />
        <input type="hidden" name="lineShipped" value={item.lastShippedOn ?? ""} />
        <span class="muted small">{item.itemCode}</span> {item.itemName}
        {item.lastShippedOn ? <div class="muted small">最後の出荷 {item.lastShippedOn}</div> : null}
        {draft?.error ? <p class="field-error">{draft.error}</p> : null}
      </td>
      <td>
        <input
          name="lineQuantity"
          type="number"
          inputmode="numeric"
          min={0}
          step={1}
          value={draft?.quantity ?? ""}
          aria-label={`${item.itemName}の廃棄数`}
          aria-invalid={draft?.error ? "true" : undefined}
        />
        <span class="muted small">{item.unitName}</span>
      </td>
      <td>
        <select name="lineReason" aria-label={`${item.itemName}の廃棄理由`}>
          <option value="">（任意）</option>
          {REASONS.map((r) => (
            <option value={r} selected={r === draft?.reason}>
              {DISPOSAL_REASON_LABELS[r]}
            </option>
          ))}
        </select>
      </td>
    </tr>
  );
}

function LinesBody(props: { lines: readonly { item: LineItem; draft?: LineDraft | undefined }[] }) {
  return (
    <tbody id={LINES_ID}>
      {props.lines.map((l) => (
        <LineRow item={l.item} draft={l.draft} />
      ))}
    </tbody>
  );
}

interface FormValues {
  readonly customerId: string;
  readonly disposedOn: string;
  readonly contactName: string;
  readonly memo: string;
}

function DisposalForm(props: {
  values: FormValues;
  customers: readonly Option[];
  lines: readonly { item: LineItem; draft?: LineDraft | undefined }[];
  error?: DomainError | undefined;
  errors?: FormErrors;
}) {
  const errors = props.errors ?? {};
  const today = toBusinessDate(new Date());
  return (
    <form
      id={FORM_ID}
      class="form"
      method="post"
      action={paths.disposalNew()}
      hx-post={paths.disposalNew()}
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
            hx-post={paths.disposalShippedItems()}
            hx-trigger="change"
            hx-include={`#${FORM_ID}`}
            hx-target={`#${LINES_ID}`}
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
        <Field label="廃棄日" name="disposedOn" required error={errors["disposedOn"]}>
          <Input
            name="disposedOn"
            type="date"
            value={props.values.disposedOn}
            max={today}
            error={errors["disposedOn"]}
          />
        </Field>
        <Field label="先方の担当者" name="contactName">
          <Input name="contactName" value={props.values.contactName} maxlength={100} />
        </Field>
        <Field label="メモ" name="memo">
          <TextArea name="memo" rows={2} value={props.values.memo} />
        </Field>
      </div>
      <h2>廃棄した商品</h2>
      <p class="hint">
        販売先を選ぶと、その販売先に出荷したことのある商品を先に並べます。廃棄した数を入力した行だけ登録します。
      </p>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>商品</th>
              <th>廃棄数</th>
              <th>理由</th>
            </tr>
          </thead>
          <LinesBody lines={props.lines} />
        </table>
      </div>
      <ItemPickerButton picker={PICKER_ID} label="ほかの商品を追加" />
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">
          廃棄伝票を登録する
        </button>
        <a class="btn btn-secondary" href={paths.disposals()}>
          やめる
        </a>
      </div>
    </form>
  );
}

function linesFromForm(form: FormData_): { item: LineItem; draft: LineDraft }[] {
  const codes = strs(form, "lineCode");
  const names = strs(form, "lineName");
  const units = strs(form, "lineUnit");
  const shipped = strs(form, "lineShipped");
  const quantities = strs(form, "lineQuantity");
  const reasons = strs(form, "lineReason");
  return strs(form, "lineItemId").map((itemId, i) => ({
    item: {
      itemId,
      itemCode: codes[i] ?? "",
      itemName: names[i] ?? "",
      unitName: units[i] ?? "",
      lastShippedOn: (shipped[i] ?? "") || null,
    },
    draft: { quantity: quantities[i] ?? "", reason: reasons[i] ?? "" },
  }));
}

async function shippedLines(c: Context<AppEnv>, customerId: string): Promise<{ item: LineItem }[]> {
  if (!customerId) return [];
  const r = await queryAs(c.env, c.get("actorRef"), "disposals.shippedItems", { customerId });
  return r.ok ? r.value.map((i) => ({ item: i })) : [];
}

function FormPage(props: { c: Context<AppEnv>; body: Child; status?: 200 | 409 }) {
  return props.c.html(
    <Layout title="廃棄伝票の登録" actor={props.c.get("actor")} current={paths.disposals()}>
      <PageHeader title="廃棄伝票の登録" />
      {props.body}
      <ItemPicker
        id={PICKER_ID}
        addUrl={paths.disposalLines()}
        target={`#${LINES_ID}`}
        include={`#${FORM_ID}`}
      />
    </Layout>,
    props.status ?? 200,
  );
}

disposalRoutes.get("/new", async (c) => {
  if (!hasPermission(c.get("actor").roles, "disposals.manage")) {
    return c.html(
      <Layout title="廃棄伝票の登録" actor={c.get("actor")} current={paths.disposals()}>
        <Alert kind="warning">廃棄伝票を登録する権限がありません。</Alert>
      </Layout>,
    );
  }
  const customerId = c.req.query("customerId") ?? "";
  const [customers, lines] = await Promise.all([customerOptions(c), shippedLines(c, customerId)]);
  return FormPage({
    c,
    body: (
      <DisposalForm
        values={{ customerId, disposedOn: toBusinessDate(new Date()), contactName: "", memo: "" }}
        customers={customers}
        lines={lines}
      />
    ),
  });
});

/** 販売先を変えたとき：その販売先に出荷した商品の行（ダイアログで足した、出荷のない商品の行は残す） */
disposalRoutes.post("/new/shipped", async (c) => {
  const form = await readForm(c);
  const shipped = await shippedLines(c, str(form, "customerId"));
  const shippedIds = new Set(shipped.map((s) => s.item.itemId));
  const current = linesFromForm(form);
  const drafts = new Map(current.map((l) => [l.item.itemId, l.draft]));
  const extra = current.filter(
    (l) => l.item.lastShippedOn === null && !shippedIds.has(l.item.itemId),
  );
  return c.html(
    <LinesBody
      lines={[
        ...shipped.map((s) => ({ item: s.item, draft: drafts.get(s.item.itemId) })),
        ...extra,
      ]}
    />,
  );
});

/** 商品選択ダイアログで選んだ商品を行にして返す（すでにある商品は除く） */
disposalRoutes.post("/new/lines", async (c) => {
  const form = await readForm(c);
  const existing = new Set(strs(form, "lineItemId"));
  const ids = pickedItemIds(form).filter((id) => !existing.has(id));
  if (ids.length === 0) return c.body(null, 200);
  const items = await runQuery(c, "items.getMany", { ids });
  return c.html(
    <>
      {items.map((i) => (
        <LineRow
          item={{
            itemId: i.id,
            itemCode: i.code,
            itemName: i.name,
            unitName: i.salesUnitName,
            lastShippedOn: null,
          }}
        />
      ))}
    </>,
  );
});

disposalRoutes.post("/new", async (c) => {
  const form = await readForm(c);
  const values: FormValues = {
    customerId: str(form, "customerId"),
    disposedOn: str(form, "disposedOn"),
    contactName: str(form, "contactName"),
    memo: str(form, "memo"),
  };
  const all = linesFromForm(form);
  // 廃棄数を入力した行だけを登録する（入力しなかった行は登録しない）
  const entered = all.filter((l) => l.draft.quantity.trim() !== "");
  const result = await runCommand(
    c,
    "disposals.create",
    {
      ...values,
      lines: entered.map((l) => ({
        itemId: l.item.itemId,
        quantity: /^\d{1,7}$/.test(l.draft.quantity.trim()) ? Number(l.draft.quantity) : Number.NaN,
        reason: REASONS.find((r) => r === l.draft.reason) ?? null,
      })),
    },
    formKey(form),
  );
  if (result.ok) return redirectTo(c, paths.disposal(result.value.id, { notice: "created" }));
  const errors = toFormErrors(result.error);
  const rowErrors = new Map(
    entered.flatMap((l, i) => {
      const message = errors[`lines.${i}.quantity`] ?? errors[`lines.${i}.itemId`];
      return message ? [[l, message] as const] : [];
    }),
  );
  const body = (
    <DisposalForm
      values={values}
      customers={await customerOptions(c)}
      lines={all.map((l) => ({ item: l.item, draft: { ...l.draft, error: rowErrors.get(l) } }))}
      error={result.error}
      errors={errors}
    />
  );
  if (isHtmx(c)) return c.html(body);
  return FormPage({ c, body, status: 409 });
});

// ---- 廃棄率の集計 ---------------------------------------------------------------

const GROUPS = ["customer_item", "customer", "item"] as const;
const GROUP_OPTIONS: Option[] = [
  { value: "customer_item", label: "販売先 × 商品" },
  { value: "customer", label: "販売先ごと" },
  { value: "item", label: "商品ごと" },
];

function rateFilter(get: (name: string) => string) {
  const month = monthRange(monthOf(toBusinessDate(new Date())));
  return {
    from: get("from").trim() || month.from,
    to: get("to").trim() || month.to,
    customerId: get("customerId").trim() || undefined,
    itemId: get("itemId").trim() || undefined,
    groupBy: GROUPS.find((g) => g === get("groupBy")) ?? "customer_item",
    onlyDisposed: get("all") !== "1",
  };
}

type RateFilter = ReturnType<typeof rateFilter>;

function rateQuery(f: RateFilter): Query {
  return {
    from: f.from,
    to: f.to,
    customerId: f.customerId,
    itemId: f.itemId,
    groupBy: f.groupBy === "customer_item" ? undefined : f.groupBy,
    all: f.onlyDisposed ? undefined : 1,
  };
}

disposalRoutes.get("/rates", async (c) => {
  const filter = rateFilter((name) => c.req.query(name) ?? "");
  const page = Math.max(1, Number(c.req.query("page") ?? "1") || 1);
  const [result, customers] = await Promise.all([
    queryAs(c.env, c.get("actorRef"), "disposals.rates", { ...filter, page, pageSize: 100 }),
    customerOptions(c),
  ]);
  const query = rateQuery(filter);
  return c.html(
    <Layout title="廃棄率の集計" actor={c.get("actor")} current={paths.disposals()}>
      <Header c={c} />
      <Tabs current="rates" />
      <form
        class="filters"
        method="get"
        action={paths.disposalRates()}
        hx-get={paths.disposalRates()}
        hx-target="#results"
        hx-select="#results"
        hx-swap="outerHTML"
        hx-push-url="true"
        hx-trigger="change"
      >
        <Field label="期間（から）" name="from">
          <Input name="from" type="date" value={filter.from} />
        </Field>
        <Field label="期間（まで）" name="to">
          <Input name="to" type="date" value={filter.to} />
        </Field>
        <Field label="販売先" name="customerId">
          <Select name="customerId" value={filter.customerId} options={customers} empty="すべて" />
        </Field>
        <Field label="集計の単位" name="groupBy">
          <Select name="groupBy" value={filter.groupBy} options={GROUP_OPTIONS} />
        </Field>
        {filter.itemId ? <input type="hidden" name="itemId" value={filter.itemId} /> : null}
        <Checkbox
          name="all"
          value="1"
          label="廃棄のない組み合わせも表示する"
          checked={!filter.onlyDisposed}
        />
        <noscript>
          <button type="submit" class="btn btn-secondary">
            集計
          </button>
        </noscript>
      </form>
      <section id="results">
        <div class="toolbar">
          <CsvButton action={paths.disposalRatesCsv()} filters={query} />
          <p class="muted small">
            廃棄率 = 廃棄数 ÷ 出荷数（期間内に発送した数。発送を取り消したものは除く）
          </p>
        </div>
        {!result.ok ? (
          <Alert kind="error">{result.error.message}</Alert>
        ) : result.value.rows.length === 0 ? (
          <EmptyState message="この期間の廃棄はありません" />
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  {filter.groupBy === "item" ? null : <th>販売先</th>}
                  {filter.groupBy === "customer" ? null : <th>商品</th>}
                  <th class="num">廃棄数</th>
                  <th class="num">出荷数</th>
                  <th class="num">廃棄率</th>
                </tr>
              </thead>
              <tbody>
                {result.value.rows.map((r) => (
                  <tr>
                    {filter.groupBy === "item" ? null : <td>{r.customerName}</td>}
                    {filter.groupBy === "customer" ? null : (
                      <td>
                        <span class="muted small">{r.itemCode}</span> {r.itemName}
                      </td>
                    )}
                    <td class="num">{qty(r.disposed)}</td>
                    <td class="num">{qty(r.shipped)}</td>
                    <td class="num">{r.rateBps === null ? "—" : rate(r.rateBps)}</td>
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
            href={(p) => paths.disposalRates({ ...query, page: p })}
          />
        ) : null}
      </section>
    </Layout>,
  );
});

disposalRoutes.post("/rates/csv", async (c) => {
  const form = await readForm(c);
  return exportCsv(
    c,
    "disposalRates",
    rateFilter((name) => str(form, name)),
    formKey(form),
  );
});

// ---- 詳細 ---------------------------------------------------------------------

disposalRoutes.get("/:id", async (c) => {
  const d = await runQuery(c, "disposals.get", { id: c.req.param("id") });
  if (!d) return c.notFound();
  const notice = c.req.query("notice") === "created" ? "廃棄伝票を登録しました" : undefined;
  return c.html(
    <Layout title="廃棄伝票" actor={c.get("actor")} current={paths.disposals()}>
      <PageHeader title={`廃棄伝票 ${d.number}`} />
      {notice ? <Alert kind="success">{notice}</Alert> : null}
      <section class="card">
        <DescriptionList
          items={[
            ["販売先", d.customerName],
            ["廃棄日", d.disposedOn],
            ["先方の担当者", d.contactName],
            ["メモ", d.memo ? <span class="pre">{d.memo}</span> : null],
            ["登録", `${dateTime(d.createdAt)} ${d.createdByName ?? ""}`],
          ]}
        />
      </section>
      <section class="card">
        <h2>廃棄した商品</h2>
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>商品</th>
                <th class="num">数量</th>
                <th>理由</th>
              </tr>
            </thead>
            <tbody>
              {d.lines.map((l) => (
                <tr>
                  <td>
                    <span class="muted small">{l.itemCode}</span> {l.itemName}
                  </td>
                  <td class="num">
                    {qty(l.quantity)}
                    <span class="muted small">{l.unitName}</span>
                  </td>
                  <td>{disposalReasonLabel(l.reason)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <p>
        <a href={paths.disposals()}>廃棄伝票の一覧に戻る</a>
      </p>
    </Layout>,
  );
});
