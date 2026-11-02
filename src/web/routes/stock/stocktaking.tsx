/**
 * 棚卸（要件定義書 3.4 の Should）：保管場所を選び、その場所の商品の実際の数を一括で入力する。
 * 帳簿在庫との差を「棚卸差異」として記録する。数えていない商品（空欄）は記録しない。
 */
import { Hono, type Context } from "hono";

import { toBusinessDate } from "../../../domain/dates";
import type { DomainError } from "../../../domain/result";
import type { ItemRecord } from "../../../usecases/masters/items.port";
import { formKey, readForm, str, strs } from "../../form";
import { redirectTo } from "../../http";
import { hasPermission } from "../../middleware";
import { paths } from "../../paths";
import type { AppEnv } from "../../types";
import { runCommand, runQuery } from "../../usecase";
import {
  Alert,
  EmptyState,
  Field,
  FormKey,
  Input,
  PageHeader,
  Select,
  TextArea,
  toFormErrors,
  type FormErrors,
  type Option,
} from "../../views/components";
import { qty } from "../../views/format";
import { ItemPicker, ItemPickerButton, pickedItemIds } from "../../views/item-picker";
import { Layout } from "../../views/layout";
import { LineQuantity, RemoveRowButton, StockErrorSummary } from "../../views/stock";

export const stocktakingRoutes = new Hono<AppEnv>();

interface SheetRow {
  readonly item: ItemRecord;
  /** 帳簿在庫 */
  readonly expected: number;
  /** 実際の数（入力した文字のまま） */
  readonly counted: string;
  readonly changed?: boolean;
  readonly error?: string | undefined;
}

function SheetRowView(props: { row: SheetRow }) {
  const { item, expected } = props.row;
  return (
    <tr class={props.row.changed ? "row-warning" : undefined} data-line-item={item.id}>
      <td class="nowrap">
        <input type="hidden" name="lineItemId" value={item.id} />
        <input type="hidden" name="lineExpected" value={String(expected)} />
        {item.code}
      </td>
      <td>
        {item.name}
        {props.row.changed ? <div class="small">入力中に在庫が動きました</div> : null}
      </td>
      <td class="num">
        {qty(expected)}
        <span class="muted small">{item.salesUnitName}</span>
      </td>
      <td>
        <LineQuantity
          name="lineCounted"
          id={`count-${item.id}`}
          label={`${item.name}の実際の数`}
          value={props.row.counted}
          min={0}
          error={props.row.error}
        />
      </td>
      <td>
        <RemoveRowButton label={item.name} />
      </td>
    </tr>
  );
}

function SheetForm(props: {
  locationId: string;
  operationDate: string;
  memo: string;
  rows: readonly SheetRow[];
  errors: FormErrors;
  error?: DomainError | null;
}) {
  return (
    <form
      id="stocktake-form"
      method="post"
      action={paths.stocktaking()}
      hx-post={paths.stocktaking()}
      hx-target="this"
      hx-swap="outerHTML"
      class="form"
    >
      <StockErrorSummary error={props.error} />
      <FormKey />
      <input type="hidden" name="locationId" value={props.locationId} />
      <div class="grid-3">
        <Field label="棚卸日" name="operationDate" required error={props.errors["operationDate"]}>
          <Input name="operationDate" type="date" value={props.operationDate} />
        </Field>
      </div>
      {props.errors["lines"] ? <p class="field-error">{props.errors["lines"]}</p> : null}
      <p class="hint">
        数えた商品だけ実際の数を入力してください（空欄の商品は記録しません）。帳簿在庫との差を「棚卸差異」として記録します。
      </p>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>商品コード</th>
              <th>商品名</th>
              <th class="num">帳簿在庫</th>
              <th>実際の数</th>
              <th>
                <span class="sr-only">操作</span>
              </th>
            </tr>
          </thead>
          <tbody id="stocktake-lines">
            {props.rows.map((row) => (
              <SheetRowView row={row} />
            ))}
          </tbody>
        </table>
      </div>
      {props.rows.length === 0 ? (
        <p class="muted">この保管場所には在庫の記録がありません。数えた商品を追加してください。</p>
      ) : null}
      <div class="toolbar">
        <ItemPickerButton picker="stocktake-picker" label="表にない商品を追加" />
      </div>
      <Field label="メモ" name="memo" error={props.errors["memo"]}>
        <TextArea name="memo" value={props.memo} rows={2} />
      </Field>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary btn-lg">
          棚卸の結果を記録する
        </button>
      </div>
    </form>
  );
}

async function locationOptions(c: Context<AppEnv>): Promise<Option[]> {
  return (await runQuery(c, "locations.options", {})).map((l) => ({ value: l.id, label: l.name }));
}

stocktakingRoutes.get("/", async (c) => {
  const actor = c.get("actor");
  const locationId = c.req.query("locationId") ?? "";
  const locations = await locationOptions(c);
  const canManage = hasPermission(actor.roles, "stock.manage");
  const valid = locations.some((l) => l.value === locationId);
  const sheet = valid && canManage ? await runQuery(c, "stocktakes.sheet", { locationId }) : [];
  return c.html(
    <Layout title="棚卸" actor={actor} current={paths.stocktaking()}>
      <PageHeader
        title="棚卸"
        actions={
          <a class="btn btn-secondary" href={paths.stockOperations({ kind: "stocktake" })}>
            これまでの棚卸
          </a>
        }
      />
      {canManage ? (
        <>
          <form
            class="filters"
            method="get"
            action={paths.stocktaking()}
            hx-get={paths.stocktaking()}
            hx-target="#sheet"
            hx-select="#sheet"
            hx-swap="outerHTML"
            hx-push-url="true"
            hx-trigger="change"
          >
            <Field label="保管場所" name="locationId">
              <Select
                name="locationId"
                value={locationId}
                options={locations}
                empty="選んでください"
              />
            </Field>
            <noscript>
              <button type="submit" class="btn btn-secondary">
                表示
              </button>
            </noscript>
          </form>
          <section id="sheet">
            {valid ? (
              <SheetForm
                locationId={locationId}
                operationDate={toBusinessDate(new Date())}
                memo=""
                rows={sheet.map((r) => ({ item: r.item, expected: r.onHand, counted: "" }))}
                errors={{}}
              />
            ) : (
              <EmptyState message="棚卸をする保管場所を選んでください" />
            )}
          </section>
          <ItemPicker
            id="stocktake-picker"
            addUrl={paths.stocktakingLines()}
            target="#stocktake-lines"
            include="#stocktake-form"
          />
        </>
      ) : (
        <Alert kind="warning">棚卸を記録する権限がありません。</Alert>
      )}
    </Layout>,
  );
});

/** 商品選択ダイアログで選んだ商品を、棚卸の表の行にして返す（帳簿在庫つき、すでにある商品は除く） */
stocktakingRoutes.post("/lines", async (c) => {
  const form = await readForm(c);
  const locationId = str(form, "locationId");
  const existing = new Set(strs(form, "lineItemId"));
  const ids = pickedItemIds(form).filter((id) => !existing.has(id));
  if (ids.length === 0 || locationId === "") return c.html("");
  const [items, levels] = await Promise.all([
    runQuery(c, "items.getMany", { ids }),
    runQuery(c, "stock.levels", { itemIds: ids, locationId }),
  ]);
  const onHand = new Map(levels.map((l) => [l.itemId, l.onHand]));
  return c.html(
    <>
      {items.map((item) => (
        <SheetRowView row={{ item, expected: onHand.get(item.id) ?? 0, counted: "" }} />
      ))}
    </>,
  );
});

/** 「12」の形の0以上の整数。それ以外は NaN（ユースケースの検証でエラーになる） */
function count(text: string): number {
  const t = text.trim();
  return /^\d{1,7}$/.test(t) ? Number(t) : Number.NaN;
}

stocktakingRoutes.post("/", async (c) => {
  const form = await readForm(c);
  const locationId = str(form, "locationId");
  const operationDate = str(form, "operationDate");
  const memo = str(form, "memo");
  const ids = strs(form, "lineItemId");
  const expected = strs(form, "lineExpected").map(Number);
  const counted = strs(form, "lineCounted");
  // 空欄（数えていない商品）は送らない
  const submitted = ids.flatMap((itemId, i) =>
    (counted[i] ?? "").trim() === ""
      ? []
      : [{ itemId, counted: count(counted[i] ?? ""), expected: expected[i] ?? 0 }],
  );
  const result = await runCommand(
    c,
    "stocktakes.create",
    { locationId, operationDate, memo, lines: submitted },
    formKey(form),
  );
  if (result.ok) return redirectTo(c, paths.stockOperation(result.value.id, { notice: "created" }));

  const errors = toFormErrors(result.error);
  const rowErrors = new Map(
    submitted.flatMap((l, i) => {
      const message = errors[`lines.${i}.counted`];
      return message ? [[l.itemId, message] as const] : [];
    }),
  );
  // 入力中に在庫が動いた商品は、帳簿在庫を最新にして入力し直してもらう
  const changed = new Set(result.error.code === "conflict" ? (result.error.details ?? []) : []);
  const unique = [...new Set(ids)];
  const [items, levels] = await Promise.all([
    runQuery(c, "items.getMany", { ids: unique }),
    locationId && unique.length > 0
      ? runQuery(c, "stock.levels", { itemIds: unique, locationId })
      : Promise.resolve([]),
  ]);
  const current = new Map(levels.map((l) => [l.itemId, l.onHand]));
  const countedById = new Map(ids.map((id, i) => [id, counted[i] ?? ""]));
  const expectedById = new Map(ids.map((id, i) => [id, expected[i] ?? 0]));
  return c.html(
    <SheetForm
      locationId={locationId}
      operationDate={operationDate}
      memo={memo}
      rows={items.map((item) => ({
        item,
        expected: changed.has(item.id)
          ? (current.get(item.id) ?? 0)
          : (expectedById.get(item.id) ?? 0),
        counted: countedById.get(item.id) ?? "",
        changed: changed.has(item.id),
        error: rowErrors.get(item.id),
      }))}
      errors={errors}
      error={result.error}
    />,
  );
});
