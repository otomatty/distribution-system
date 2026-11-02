/**
 * 在庫操作（要件定義書 3.4）：調整・移動・店舗払い出しの登録（タブレット対応）、履歴の一覧、伝票の詳細。
 * 商品は商品選択ダイアログで複数まとめて追加する。初期在庫は「調整」の理由「初期在庫」で入れる。
 */
import { Hono, type Context } from "hono";

import { toBusinessDate } from "../../../domain/dates";
import type { DomainError } from "../../../domain/result";
import {
  ADJUSTMENT_REASONS,
  STOCK_OPERATION_KINDS,
  STOCK_OPERATION_LABELS,
  STOCK_REASONS,
  type StockOperationKind,
} from "../../../domain/stock";
import type { ItemRecord } from "../../../usecases/masters/items.port";
import type { ShortageDetail } from "../../../usecases/stock/queries";
import { choice, formKey, readForm, str, strs, type FormData_ } from "../../form";
import { NOTICES, redirectTo } from "../../http";
import { hasPermission } from "../../middleware";
import { paths } from "../../paths";
import type { AppEnv } from "../../types";
import { runCommand, runQuery } from "../../usecase";
import {
  Alert,
  Badge,
  DescriptionList,
  EmptyState,
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
import { dateTime, qty } from "../../views/format";
import { ItemPicker, ItemPickerButton, pickedItemIds } from "../../views/item-picker";
import { Layout } from "../../views/layout";
import { LineQuantity, RemoveRowButton, signedQty, StockErrorSummary } from "../../views/stock";

export const stockOperationRoutes = new Hono<AppEnv>();

const OP_KINDS = ["adjustment", "transfer", "store_transfer"] as const;
type OpKind = (typeof OP_KINDS)[number];

const REASON_OPTIONS: Option[] = ADJUSTMENT_REASONS.map((r) => ({
  value: r,
  label: STOCK_REASONS[r],
}));
const KIND_OPTIONS: Option[] = STOCK_OPERATION_KINDS.map((k) => ({
  value: k,
  label: STOCK_OPERATION_LABELS[k],
}));

const KIND_HINTS: Readonly<Record<OpKind, string>> = {
  adjustment:
    "増やす数はプラス、減らす数はマイナスで入力します（サンプル・処分はマイナス、初期在庫はプラス）。",
  transfer: "移動元から減らし、移動先に同じ数を加えます。",
  store_transfer: "自社店舗に出した数を入力します。店舗の在庫は管理しないので、在庫から外れます。",
};

interface LineView {
  readonly item: ItemRecord;
  /** 選んだ保管場所での現在庫（保管場所が未選択なら null） */
  readonly onHand: number | null;
  readonly quantity: string;
  readonly error?: string | undefined;
}

interface OpValues {
  readonly kind: OpKind;
  readonly operationDate: string;
  readonly locationId: string;
  readonly toLocationId: string;
  readonly storeId: string;
  readonly reason: string;
  readonly memo: string;
}

function OperationLineRow(props: { kind: OpKind; line: LineView }) {
  const { item, onHand } = props.line;
  return (
    <tr data-line-item={item.id}>
      <td class="nowrap">
        <input type="hidden" name="lineItemId" value={item.id} />
        {item.code}
      </td>
      <td>{item.name}</td>
      <td class="num">
        {onHand === null ? "—" : qty(onHand)}
        <span class="muted small">{item.salesUnitName}</span>
      </td>
      <td>
        <LineQuantity
          name="lineQuantity"
          id={`qty-${item.id}`}
          label={`${item.name}の数量`}
          value={props.line.quantity}
          {...(props.kind === "adjustment" ? {} : { min: 1 })}
          error={props.line.error}
        />
      </td>
      <td>
        <RemoveRowButton label={item.name} />
      </td>
    </tr>
  );
}

function OperationForm(props: {
  values: OpValues;
  lines: readonly LineView[];
  locations: readonly Option[];
  stores: readonly Option[];
  errors: FormErrors;
  error?: DomainError | null;
  shortages?: readonly ShortageDetail[] | undefined;
}) {
  const v = props.values;
  const e = props.errors;
  return (
    <form
      id="op-form"
      method="post"
      action={paths.stockOperationNew()}
      hx-post={paths.stockOperationNew()}
      hx-target="this"
      hx-swap="outerHTML"
      class="form op-form"
      data-draft={`stock-operation:${v.kind}`}
      data-draft-lines={paths.stockOperationLines()}
      data-draft-lines-target="#op-lines"
    >
      <StockErrorSummary error={props.error} shortages={props.shortages} />
      <FormKey />
      <input type="hidden" name="kind" value={v.kind} />
      <p class="hint">{KIND_HINTS[v.kind]}</p>
      <div class="grid-3">
        <Field label="操作日" name="operationDate" required error={e["operationDate"]}>
          <Input name="operationDate" type="date" value={v.operationDate} />
        </Field>
        <Field
          label={v.kind === "transfer" ? "移動元" : "保管場所"}
          name="locationId"
          required
          error={e["locationId"]}
        >
          <Select
            name="locationId"
            value={v.locationId}
            options={props.locations}
            empty="選んでください"
          />
        </Field>
        {v.kind === "transfer" ? (
          <Field label="移動先" name="toLocationId" required error={e["toLocationId"]}>
            <Select
              name="toLocationId"
              value={v.toLocationId}
              options={props.locations}
              empty="選んでください"
            />
          </Field>
        ) : null}
        {v.kind === "store_transfer" ? (
          <Field label="払い出し先店舗" name="storeId" required error={e["storeId"]}>
            <Select
              name="storeId"
              value={v.storeId}
              options={props.stores}
              empty="選んでください"
            />
          </Field>
        ) : null}
        {v.kind === "adjustment" ? (
          <Field label="理由" name="reason" required error={e["reason"]}>
            <Select
              name="reason"
              value={v.reason}
              options={REASON_OPTIONS}
              empty="選んでください"
            />
          </Field>
        ) : null}
      </div>
      <fieldset>
        <legend>商品と数量</legend>
        {e["lines"] ? <p class="field-error">{e["lines"]}</p> : null}
        <div class="table-wrap">
          <table class="table op-lines">
            <thead>
              <tr>
                <th>商品コード</th>
                <th>商品名</th>
                <th class="num">現在庫</th>
                <th>{v.kind === "adjustment" ? "増減数" : "数量"}</th>
                <th>
                  <span class="sr-only">操作</span>
                </th>
              </tr>
            </thead>
            <tbody id="op-lines">
              {props.lines.map((line) => (
                <OperationLineRow kind={v.kind} line={line} />
              ))}
            </tbody>
          </table>
        </div>
        <div class="toolbar">
          <ItemPickerButton picker="op-picker" large />
        </div>
      </fieldset>
      <Field label="メモ" name="memo" error={e["memo"]}>
        <TextArea name="memo" value={v.memo} rows={2} />
      </Field>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary btn-lg">
          {STOCK_OPERATION_LABELS[v.kind]}を記録する
        </button>
      </div>
    </form>
  );
}

function KindTabs(props: { kind: OpKind }) {
  return (
    <nav class="tabs tabs-lg" aria-label="操作の種類">
      {OP_KINDS.map((k) => (
        <a
          href={paths.stockOperationNew({ kind: k })}
          aria-current={k === props.kind ? "page" : undefined}
        >
          {STOCK_OPERATION_LABELS[k]}
        </a>
      ))}
    </nav>
  );
}

async function selectOptions(c: Context<AppEnv>) {
  const [locations, stores] = await Promise.all([
    runQuery(c, "locations.options", {}),
    runQuery(c, "retailStores.options", {}),
  ]);
  return {
    locations: locations.map((l) => ({ value: l.id, label: l.name })),
    stores: stores.map((s) => ({ value: s.id, label: s.name })),
  };
}

/** 明細の行の表示に使う商品と現在庫を読む */
async function lineViews(
  c: Context<AppEnv>,
  ids: readonly string[],
  locationId: string,
  quantities: ReadonlyMap<string, string>,
  errors: ReadonlyMap<string, string>,
): Promise<LineView[]> {
  if (ids.length === 0) return [];
  const [items, levels] = await Promise.all([
    runQuery(c, "items.getMany", { ids: [...ids] }),
    locationId
      ? runQuery(c, "stock.levels", { itemIds: [...ids], locationId })
      : Promise.resolve([]),
  ]);
  const onHand = new Map(levels.map((l) => [l.itemId, l.onHand]));
  return items.map((item) => ({
    item,
    onHand: locationId ? (onHand.get(item.id) ?? 0) : null,
    quantity: quantities.get(item.id) ?? "",
    error: errors.get(item.id),
  }));
}

function kindFrom(value: string | undefined): OpKind {
  return OP_KINDS.find((k) => k === value) ?? "adjustment";
}

/** 「-3」「12」の形の整数。それ以外は NaN（ユースケースの検証でエラーになる） */
function signedInt(text: string): number {
  const t = text.trim();
  return /^-?\d{1,7}$/.test(t) ? Number(t) : Number.NaN;
}

function valuesFromForm(form: FormData_): OpValues {
  return {
    kind: kindFrom(str(form, "kind")),
    operationDate: str(form, "operationDate"),
    locationId: str(form, "locationId"),
    toLocationId: str(form, "toLocationId"),
    storeId: str(form, "storeId"),
    reason: str(form, "reason"),
    memo: str(form, "memo"),
  };
}

function inputFromForm(v: OpValues, form: FormData_) {
  const quantities = strs(form, "lineQuantity");
  const common = {
    operationDate: v.operationDate,
    locationId: v.locationId,
    memo: v.memo,
    lines: strs(form, "lineItemId").map((itemId, i) => ({
      itemId,
      quantity: signedInt(quantities[i] ?? ""),
    })),
  };
  if (v.kind === "transfer") return { kind: v.kind, toLocationId: v.toLocationId, ...common };
  if (v.kind === "store_transfer") return { kind: v.kind, storeId: v.storeId, ...common };
  return {
    kind: v.kind,
    reason: choice(form, "reason", ADJUSTMENT_REASONS, "" as const),
    ...common,
  };
}

const OP_NOTICES: Readonly<Record<string, string>> = { ...NOTICES, created: "記録しました" };

// ---- 登録（タブレット対応） ----------------------------------------------------------

stockOperationRoutes.get("/new", async (c) => {
  const kind = kindFrom(c.req.query("kind"));
  const actor = c.get("actor");
  const canManage = hasPermission(actor.roles, "stock.manage");
  const options = await selectOptions(c);
  return c.html(
    <Layout title="在庫操作" actor={actor} current={paths.stockOperationNew()} touch>
      <PageHeader
        title="在庫操作"
        actions={
          <a class="btn btn-secondary" href={paths.stockOperations()}>
            記録した操作の一覧
          </a>
        }
      />
      <KindTabs kind={kind} />
      {canManage ? (
        <>
          <OperationForm
            values={{
              kind,
              operationDate: toBusinessDate(new Date()),
              locationId: options.locations.length === 1 ? (options.locations[0]?.value ?? "") : "",
              toLocationId: "",
              storeId: "",
              reason: "",
              memo: "",
            }}
            lines={[]}
            locations={options.locations}
            stores={options.stores}
            errors={{}}
          />
          <ItemPicker
            id="op-picker"
            addUrl={paths.stockOperationLines()}
            target="#op-lines"
            include="#op-form"
          />
        </>
      ) : (
        <Alert kind="warning">在庫の調整・移動・店舗払い出しを記録する権限がありません。</Alert>
      )}
    </Layout>,
  );
});

/** 商品選択ダイアログで選んだ商品を、明細の行にして返す（すでにある商品は除く） */
stockOperationRoutes.post("/lines", async (c) => {
  const form = await readForm(c);
  const existing = new Set(strs(form, "lineItemId"));
  const ids = pickedItemIds(form).filter((id) => !existing.has(id));
  const kind = kindFrom(str(form, "kind"));
  const lines = await lineViews(c, ids, str(form, "locationId"), new Map(), new Map());
  return c.html(
    <>
      {lines.map((line) => (
        <OperationLineRow kind={kind} line={line} />
      ))}
    </>,
  );
});

stockOperationRoutes.post("/new", async (c) => {
  const form = await readForm(c);
  const values = valuesFromForm(form);
  const input = inputFromForm(values, form);
  const result = await runCommand(c, "stockOperations.create", input, formKey(form));
  if (result.ok) return redirectTo(c, `${paths.stockOperation(result.value.id)}?notice=created`);

  const errors = toFormErrors(result.error);
  const ids = input.lines.map((l) => l.itemId);
  const quantities = new Map(ids.map((id, i) => [id, strs(form, "lineQuantity")[i] ?? ""]));
  const lineErrors = new Map(
    ids.flatMap((id, i) => {
      const message = errors[`lines.${i}.quantity`] ?? errors[`lines.${i}.itemId`];
      return message ? [[id, message] as const] : [];
    }),
  );
  const [options, lines, shortages] = await Promise.all([
    selectOptions(c),
    lineViews(c, [...new Set(ids)], values.locationId, quantities, lineErrors),
    result.error.code === "insufficient_stock"
      ? runQuery(c, "stock.shortages", { details: [...(result.error.details ?? [])] })
      : Promise.resolve(undefined),
  ]);
  return c.html(
    <OperationForm
      values={values}
      lines={lines}
      locations={options.locations}
      stores={options.stores}
      errors={errors}
      error={result.error}
      shortages={shortages}
    />,
  );
});

// ---- 一覧 ---------------------------------------------------------------------

function placeLabel(op: {
  kind: StockOperationKind;
  locationName: string;
  toLocationName: string | null;
  storeName: string | null;
}): string {
  if (op.kind === "transfer") return `${op.locationName} → ${op.toLocationName ?? ""}`;
  if (op.kind === "store_transfer") return `${op.locationName} → ${op.storeName ?? ""}（店舗）`;
  return op.locationName;
}

stockOperationRoutes.get("/", async (c) => {
  const kindParam = c.req.query("kind") ?? "";
  const kind = STOCK_OPERATION_KINDS.find((k) => k === kindParam);
  const locationId = c.req.query("locationId") ?? "";
  const from = c.req.query("from") ?? "";
  const to = c.req.query("to") ?? "";
  const page = Math.max(1, Number(c.req.query("page") ?? "1") || 1);
  const [result, options] = await Promise.all([
    runQuery(c, "stockOperations.list", {
      kind,
      locationId: locationId || undefined,
      from: from || undefined,
      to: to || undefined,
      page,
      pageSize: 50,
    }),
    selectOptions(c),
  ]);
  const href = (p: number) => paths.stockOperations({ kind, locationId, from, to, page: p });
  const canManage = hasPermission(c.get("actor").roles, "stock.manage");
  return c.html(
    <Layout title="在庫操作の一覧" actor={c.get("actor")} current={paths.stockOperations()}>
      <PageHeader
        title="在庫操作の一覧"
        actions={
          canManage ? (
            <>
              <a class="btn btn-secondary" href={paths.stocktaking()}>
                棚卸
              </a>
              <a class="btn btn-primary" href={paths.stockOperationNew()}>
                在庫操作を記録
              </a>
            </>
          ) : null
        }
      />
      <form
        class="filters"
        method="get"
        action={paths.stockOperations()}
        hx-get={paths.stockOperations()}
        hx-target="#results"
        hx-select="#results"
        hx-swap="outerHTML"
        hx-push-url="true"
        hx-trigger="change"
      >
        <Field label="種類" name="kind">
          <Select name="kind" value={kind ?? ""} options={KIND_OPTIONS} empty="すべて" />
        </Field>
        <Field label="保管場所" name="locationId">
          <Select name="locationId" value={locationId} options={options.locations} empty="すべて" />
        </Field>
        <Field label="操作日（から）" name="from">
          <Input name="from" type="date" value={from} />
        </Field>
        <Field label="操作日（まで）" name="to">
          <Input name="to" type="date" value={to} />
        </Field>
        <noscript>
          <button type="submit" class="btn btn-secondary">
            表示
          </button>
        </noscript>
      </form>
      <section id="results">
        {result.rows.length === 0 ? (
          <EmptyState message="記録した在庫操作はありません" />
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>番号</th>
                  <th>操作日</th>
                  <th>種類</th>
                  <th>保管場所</th>
                  <th class="num">商品数</th>
                  <th>記録</th>
                  <th>メモ</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((op) => (
                  <tr>
                    <td class="nowrap">
                      <a href={paths.stockOperation(op.id)}>{op.number}</a>
                    </td>
                    <td class="nowrap">{op.operationDate}</td>
                    <td>
                      {STOCK_OPERATION_LABELS[op.kind]}
                      {op.adjustmentReason ? (
                        <span class="muted small">（{STOCK_REASONS[op.adjustmentReason]}）</span>
                      ) : null}
                    </td>
                    <td>{placeLabel(op)}</td>
                    <td class="num">{op.lineCount}</td>
                    <td class="small">
                      {dateTime(op.createdAt)}
                      <div class="muted">{op.createdByName ?? ""}</div>
                    </td>
                    <td class="small">{op.memo ?? ""}</td>
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
          href={href}
        />
      </section>
    </Layout>,
  );
});

// ---- 詳細 ---------------------------------------------------------------------

stockOperationRoutes.get("/:id", async (c) => {
  const op = await runQuery(c, "stockOperations.get", { id: c.req.param("id") });
  if (!op) return c.notFound();
  const notice = OP_NOTICES[c.req.query("notice") ?? ""];
  const canManage = hasPermission(c.get("actor").roles, "stock.manage");
  // 棚卸の差異（商品ごと）
  const diff = new Map<string, number>();
  for (const m of op.movements) diff.set(m.itemId, (diff.get(m.itemId) ?? 0) + m.quantity);
  const isStocktake = op.kind === "stocktake";
  return c.html(
    <Layout
      title={`${STOCK_OPERATION_LABELS[op.kind]} ${op.number}`}
      actor={c.get("actor")}
      current={paths.stockOperations()}
      touch={!isStocktake}
    >
      <PageHeader
        title={`${STOCK_OPERATION_LABELS[op.kind]} ${op.number}`}
        actions={
          canManage ? (
            <a
              class="btn btn-primary btn-lg"
              href={
                isStocktake
                  ? paths.stocktaking({ locationId: op.locationId })
                  : paths.stockOperationNew({ kind: op.kind })
              }
            >
              {isStocktake ? "続けて棚卸する" : "続けて記録する"}
            </a>
          ) : null
        }
      />
      {notice ? <Alert kind="success">{notice}</Alert> : null}
      <section class="card">
        <DescriptionList
          items={[
            ["種類", <Badge kind="info">{STOCK_OPERATION_LABELS[op.kind]}</Badge>],
            ["操作日", op.operationDate],
            [op.kind === "transfer" ? "移動" : "保管場所", placeLabel(op)],
            ["理由", op.adjustmentReason ? STOCK_REASONS[op.adjustmentReason] : null],
            ["メモ", op.memo ? <span class="pre">{op.memo}</span> : null],
            ["記録", `${dateTime(op.createdAt)} ${op.createdByName ?? ""}`],
          ]}
        />
      </section>
      <section class="card">
        <h2>{isStocktake ? "棚卸の結果" : "商品と数量"}</h2>
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>商品コード</th>
                <th>商品名</th>
                {isStocktake ? (
                  <>
                    <th class="num">帳簿在庫</th>
                    <th class="num">実際の数</th>
                    <th class="num">差異</th>
                  </>
                ) : (
                  <th class="num">{op.kind === "adjustment" ? "増減数" : "数量"}</th>
                )}
              </tr>
            </thead>
            <tbody>
              {op.lines.map((l) => {
                const d = diff.get(l.itemId) ?? 0;
                return (
                  <tr class={isStocktake && d !== 0 ? "row-warning" : undefined}>
                    <td class="nowrap">{l.itemCode}</td>
                    <td>
                      <a href={paths.stockItem(l.itemId, { locationId: op.locationId })}>
                        {l.itemName}
                      </a>
                    </td>
                    {isStocktake ? (
                      <>
                        <td class="num">{qty(l.quantity - d)}</td>
                        <td class="num">{qty(l.quantity)}</td>
                        <td class="num">{signedQty(d)}</td>
                      </>
                    ) : (
                      <td class="num">
                        {op.kind === "adjustment" ? signedQty(l.quantity) : qty(l.quantity)}
                        <span class="muted small">{l.salesUnitName}</span>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p class="hint">
          記録した在庫操作は変更できません。誤りは逆の操作（調整など）で直してください。
        </p>
      </section>
    </Layout>,
  );
});
