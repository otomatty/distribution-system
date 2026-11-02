/** 商品マスタ（要件定義書 3.2）。一覧・登録・詳細・編集・取扱終了・削除と、商品選択ダイアログの検索 */
import { Hono, type Context } from "hono";

import { TEMPERATURE_ZONE_LABELS, TEMPERATURE_ZONES } from "../../../domain/items";
import { TAX_CATEGORY_LABELS } from "../../../domain/money";
import type { DomainError } from "../../../domain/result";
import type { ItemRecord } from "../../../usecases/masters/items.port";
import {
  bool,
  centi,
  choice,
  formKey,
  int,
  intOrNull,
  readForm,
  str,
  type FormData_,
} from "../../form";
import { isHtmx, NOTICES, redirectTo } from "../../http";
import { hasPermission } from "../../middleware";
import { paths } from "../../paths";
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
import { centiPlain, centiYen, qty } from "../../views/format";
import { isPickerId, ItemPickerResults } from "../../views/item-picker";
import { Layout } from "../../views/layout";

export const itemRoutes = new Hono<AppEnv>();

const ITEM_NOTICES: Readonly<Record<string, string>> = {
  ...NOTICES,
  discontinued: "取扱終了にしました",
  resumed: "取扱終了を取り消しました",
};

const ZONE_OPTIONS: Option[] = TEMPERATURE_ZONES.map((z) => ({
  value: z,
  label: TEMPERATURE_ZONE_LABELS[z],
}));
const TAX_OPTIONS: Option[] = [
  { value: "reduced", label: TAX_CATEGORY_LABELS.reduced },
  { value: "standard", label: TAX_CATEGORY_LABELS.standard },
];

type Values = Readonly<Record<string, string | boolean | number | null | undefined>>;

function itemInputFromForm(form: FormData_) {
  return {
    code: str(form, "code"),
    jan: str(form, "jan"),
    name: str(form, "name"),
    supplierId: str(form, "supplierId"),
    genreId: str(form, "genreId"),
    temperatureZone: choice(form, "temperatureZone", TEMPERATURE_ZONES, "ambient" as const),
    taxCategory: choice(form, "taxCategory", ["standard", "reduced"] as const, "" as const),
    purchaseUnitName: str(form, "purchaseUnitName"),
    salesUnitName: str(form, "salesUnitName"),
    unitsPerPurchaseUnit: int(form, "unitsPerPurchaseUnit"),
    purchasePriceCenti: centi(form, "purchasePriceCenti"),
    salesPriceCenti: centi(form, "salesPriceCenti"),
    purchaseMinLot: int(form, "purchaseMinLot", 1),
    salesMinLot: int(form, "salesMinLot", 1),
    leadTimeDays: intOrNull(form, "leadTimeDays"),
    reorderEnabled: bool(form, "reorderEnabled"),
    reorderPoint: int(form, "reorderPoint"),
    purchaseShippingNote: str(form, "purchaseShippingNote"),
    salesShippingNote: str(form, "salesShippingNote"),
    inputPriceOnOrder: bool(form, "inputPriceOnOrder"),
    memo: str(form, "memo"),
  };
}

/** 入力し直しの画面には、入力された文字をそのまま返す（金額は入力した形のまま） */
function valuesFromForm(form: FormData_): Values {
  const out: Record<string, string | boolean> = {};
  for (const k of Object.keys(form)) out[k] = str(form, k);
  out["reorderEnabled"] = bool(form, "reorderEnabled");
  out["inputPriceOnOrder"] = bool(form, "inputPriceOnOrder");
  return out;
}

function valuesFromRecord(item: ItemRecord): Values {
  return {
    ...item,
    purchasePriceCenti: centiPlain(item.purchasePriceCenti),
    salesPriceCenti: centiPlain(item.salesPriceCenti),
  };
}

async function formOptions(c: Context<AppEnv>) {
  const [suppliers, genres] = await Promise.all([
    runQuery(c, "partners.options", { role: "supplier" }),
    runQuery(c, "genres.options", {}),
  ]);
  return {
    suppliers: suppliers.map((s) => ({ value: s.id, label: s.name })),
    genres: genres.map((g) => ({ value: g.id, label: g.name })),
  };
}

type FormOptions = Awaited<ReturnType<typeof formOptions>>;

/** 取引終了の仕入先・ジャンルを使っている商品の編集でも、今の値が選択肢に残るようにする */
function withCurrent(
  options: Option[],
  id: string | null | undefined,
  name: string | null | undefined,
) {
  if (!id || options.some((o) => o.value === id)) return options;
  return [...options, { value: id, label: `${name ?? id}（取引終了）` }];
}

function ItemForm(props: {
  action: string;
  values: Values;
  errors: FormErrors;
  error?: DomainError | null;
  version?: number;
  options: FormOptions;
  isNew: boolean;
  submitLabel: string;
}) {
  const v = props.values;
  const e = props.errors;
  const s = (k: string) => {
    const x = v[k];
    return x === null || x === undefined ? "" : String(x);
  };
  return (
    <form
      method="post"
      action={props.action}
      hx-post={props.action}
      hx-target="this"
      hx-swap="outerHTML"
      class="form"
      data-draft={props.action}
    >
      <ErrorSummary error={props.error} />
      <FormKey />
      {props.version !== undefined ? <Version value={props.version} /> : null}
      <fieldset>
        <legend>基本情報</legend>
        <div class="grid-2">
          <Field
            label="商品コード"
            name="code"
            required={!props.isNew}
            error={e["code"]}
            hint={
              props.isNew
                ? "未定なら空のまま登録すると、自動で採番します（IT000001 の形式）"
                : "ライブレジのコードとそろえます"
            }
          >
            <Input name="code" value={s("code")} maxlength={30} />
          </Field>
          <Field label="JAN" name="jan" error={e["jan"]} hint="8桁または13桁（任意）">
            <Input name="jan" value={s("jan")} inputmode="numeric" maxlength={13} />
          </Field>
          <Field label="商品名" name="name" required error={e["name"]}>
            <Input name="name" value={s("name")} maxlength={100} />
          </Field>
          <Field label="仕入先" name="supplierId" required error={e["supplierId"]}>
            <Select
              name="supplierId"
              value={s("supplierId")}
              options={withCurrent(props.options.suppliers, s("supplierId"), s("supplierName"))}
              empty="選んでください"
            />
          </Field>
          <Field label="ジャンル" name="genreId" error={e["genreId"]}>
            <Select
              name="genreId"
              value={s("genreId")}
              options={withCurrent(props.options.genres, s("genreId"), s("genreName"))}
              empty="なし"
            />
          </Field>
          <Field label="温度帯" name="temperatureZone" error={e["temperatureZone"]}>
            <Select
              name="temperatureZone"
              value={s("temperatureZone") || "ambient"}
              options={ZONE_OPTIONS}
            />
          </Field>
          <Field
            label="税区分"
            name="taxCategory"
            required
            error={e["taxCategory"]}
            hint="仕入と販売で共通。税率は取引日の税率表で決まります"
          >
            <Select
              name="taxCategory"
              value={s("taxCategory")}
              options={TAX_OPTIONS}
              empty="選んでください"
            />
          </Field>
        </div>
      </fieldset>
      <fieldset>
        <legend>単位と価格</legend>
        <div class="grid-3">
          <Field label="仕入単位" name="purchaseUnitName" required error={e["purchaseUnitName"]}>
            <Input name="purchaseUnitName" value={s("purchaseUnitName")} placeholder="ケース" />
          </Field>
          <Field
            label="販売単位"
            name="salesUnitName"
            required
            error={e["salesUnitName"]}
            hint="在庫はこの単位で数えます"
          >
            <Input name="salesUnitName" value={s("salesUnitName")} placeholder="個" />
          </Field>
          <Field
            label="入数"
            name="unitsPerPurchaseUnit"
            required
            error={e["unitsPerPurchaseUnit"]}
            hint="1仕入単位あたりの販売単位の数"
          >
            <Input
              name="unitsPerPurchaseUnit"
              type="number"
              min={1}
              inputmode="numeric"
              value={s("unitsPerPurchaseUnit") || "1"}
            />
          </Field>
          <Field
            label="仕入価格（仕入単位あたり・税抜・円）"
            name="purchasePriceCenti"
            required
            error={e["purchasePriceCenti"]}
            hint="小数第2位まで（例：1234.56）"
          >
            <Input name="purchasePriceCenti" value={s("purchasePriceCenti")} inputmode="decimal" />
          </Field>
          <Field
            label="卸単価（販売単位あたり・税抜・円）"
            name="salesPriceCenti"
            required
            error={e["salesPriceCenti"]}
            hint="小数第2位まで（例：98.5）"
          >
            <Input name="salesPriceCenti" value={s("salesPriceCenti")} inputmode="decimal" />
          </Field>
          <Field label="発注時の価格" name="inputPriceOnOrder">
            <Checkbox
              name="inputPriceOnOrder"
              label="発注時に仕入価格を入力する"
              checked={v["inputPriceOnOrder"] === true}
            />
          </Field>
        </div>
      </fieldset>
      <fieldset>
        <legend>発注・販売の条件</legend>
        <div class="grid-3">
          <Field
            label="最低ロット（仕入・仕入単位）"
            name="purchaseMinLot"
            error={e["purchaseMinLot"]}
          >
            <Input
              name="purchaseMinLot"
              type="number"
              min={1}
              inputmode="numeric"
              value={s("purchaseMinLot") || "1"}
            />
          </Field>
          <Field label="最低ロット（販売・販売単位）" name="salesMinLot" error={e["salesMinLot"]}>
            <Input
              name="salesMinLot"
              type="number"
              min={1}
              inputmode="numeric"
              value={s("salesMinLot") || "1"}
            />
          </Field>
          <Field label="リードタイム（日）" name="leadTimeDays" error={e["leadTimeDays"]}>
            <Input
              name="leadTimeDays"
              type="number"
              min={0}
              max={365}
              inputmode="numeric"
              value={s("leadTimeDays")}
            />
          </Field>
          <Field label="発注点管理" name="reorderEnabled">
            <Checkbox
              name="reorderEnabled"
              label="発注点を管理する"
              checked={v["reorderEnabled"] === true}
            />
          </Field>
          <Field
            label="発注点在庫数（販売単位）"
            name="reorderPoint"
            error={e["reorderPoint"]}
            hint="出荷可能数 + 入荷予定数がこれを下回ると発注点割れ"
          >
            <Input
              name="reorderPoint"
              type="number"
              min={0}
              inputmode="numeric"
              value={s("reorderPoint") || "0"}
            />
          </Field>
        </div>
        <div class="grid-2">
          <Field
            label="送料条件（仕入）"
            name="purchaseShippingNote"
            error={e["purchaseShippingNote"]}
          >
            <Input name="purchaseShippingNote" value={s("purchaseShippingNote")} />
          </Field>
          <Field label="送料条件（販売）" name="salesShippingNote" error={e["salesShippingNote"]}>
            <Input name="salesShippingNote" value={s("salesShippingNote")} />
          </Field>
        </div>
        <Field label="備考" name="memo" error={e["memo"]}>
          <TextArea name="memo" value={s("memo")} />
        </Field>
      </fieldset>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">
          {props.submitLabel}
        </button>
      </div>
    </form>
  );
}

function statusBadge(item: ItemRecord) {
  return item.discontinued ? <Badge>取扱終了</Badge> : null;
}

// ---- 一覧 ---------------------------------------------------------------------

itemRoutes.get("/", async (c) => {
  const q = c.req.query("q") ?? "";
  const supplierId = c.req.query("supplierId") ?? "";
  const genreId = c.req.query("genreId") ?? "";
  const includeDiscontinued = c.req.query("discontinued") === "1";
  const page = Math.max(1, Number(c.req.query("page") ?? "1") || 1);
  const [result, options] = await Promise.all([
    runQuery(c, "items.list", {
      q,
      supplierId: supplierId || undefined,
      genreId: genreId || undefined,
      includeDiscontinued,
      page,
      pageSize: 50,
    }),
    formOptions(c),
  ]);
  const notice = ITEM_NOTICES[c.req.query("notice") ?? ""];
  const href = (p: number) =>
    paths.items({
      q,
      supplierId,
      genreId,
      discontinued: includeDiscontinued ? 1 : undefined,
      page: p,
    });
  const canManage = hasPermission(c.get("actor").roles, "items.manage");
  return c.html(
    <Layout title="商品" actor={c.get("actor")} current={paths.items()}>
      <PageHeader
        title="商品"
        actions={
          canManage ? (
            <>
              <a class="btn btn-secondary" href={paths.itemImport()}>
                CSV で一括登録
              </a>
              <a class="btn btn-primary" href={paths.itemNew()}>
                商品を登録
              </a>
            </>
          ) : null
        }
      />
      {notice ? <Alert kind="success">{notice}</Alert> : null}
      <form
        class="filters"
        method="get"
        action={paths.items()}
        hx-get={paths.items()}
        hx-target="#results"
        hx-select="#results"
        hx-swap="outerHTML"
        hx-push-url="true"
        hx-trigger="input changed delay:300ms from:input[name=q], change"
      >
        <div class="field wide">
          <label for="f-q">商品名・コード・JAN で検索</label>
          <Input name="q" type="search" value={q} />
        </div>
        <Field label="仕入先" name="supplierId">
          <Select name="supplierId" value={supplierId} options={options.suppliers} empty="すべて" />
        </Field>
        <Field label="ジャンル" name="genreId">
          <Select name="genreId" value={genreId} options={options.genres} empty="すべて" />
        </Field>
        <Checkbox
          name="discontinued"
          value="1"
          label="取扱終了も表示"
          checked={includeDiscontinued}
        />
        <noscript>
          <button type="submit" class="btn btn-secondary">
            検索
          </button>
        </noscript>
      </form>
      <section id="results">
        {result.rows.length === 0 ? (
          <EmptyState message="条件に合う商品はありません" />
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>商品コード</th>
                  <th>商品名</th>
                  <th>仕入先</th>
                  <th>ジャンル</th>
                  <th>温度帯</th>
                  <th>単位・入数</th>
                  <th class="num">卸単価</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((item) => (
                  <tr>
                    <td class="nowrap">
                      <a href={paths.item(item.id)}>{item.code}</a>
                    </td>
                    <td>
                      <a href={paths.item(item.id)}>{item.name}</a> {statusBadge(item)}
                      {item.jan ? <div class="muted small">JAN {item.jan}</div> : null}
                    </td>
                    <td>{item.supplierName}</td>
                    <td>{item.genreName ?? ""}</td>
                    <td>{TEMPERATURE_ZONE_LABELS[item.temperatureZone]}</td>
                    <td class="nowrap">
                      {item.purchaseUnitName}＝{qty(item.unitsPerPurchaseUnit)}
                      {item.salesUnitName}
                    </td>
                    <td class="num">{centiYen(item.salesPriceCenti)}</td>
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

// ---- 商品選択ダイアログの検索（views/item-picker.tsx） -------------------------------

itemRoutes.get("/picker", async (c) => {
  const pickerId = c.req.query("pickerId") ?? "";
  if (!isPickerId(pickerId)) return c.text("pickerId が正しくありません", 400);
  const supplierId = c.req.query("supplierId") ?? "";
  const result = await runQuery(c, "items.pick", {
    q: c.req.query("q") ?? "",
    supplierId: supplierId || undefined,
    selectedIds: c.req.queries("itemIds") ?? [],
  });
  return c.html(
    <ItemPickerResults
      pickerId={pickerId}
      selected={result.selected}
      results={result.results.rows}
      total={result.results.total}
    />,
  );
});

// ---- 登録 ---------------------------------------------------------------------

itemRoutes.get("/new", async (c) => {
  const options = await formOptions(c);
  return c.html(
    <Layout title="商品の登録" actor={c.get("actor")} current={paths.items()}>
      <PageHeader title="商品の登録" />
      <p class="hint">初期在庫は商品の登録とは別に、在庫操作の「調整（初期在庫）」で入れます。</p>
      <ItemForm
        action={paths.itemNew()}
        values={{ temperatureZone: "ambient", unitsPerPurchaseUnit: 1 }}
        errors={{}}
        options={options}
        isNew
        submitLabel="登録する"
      />
    </Layout>,
  );
});

itemRoutes.post("/new", async (c) => {
  const form = await readForm(c);
  const result = await runCommand(c, "items.create", itemInputFromForm(form), formKey(form));
  if (result.ok) return redirectTo(c, paths.item(result.value.id, { notice: "created" }));
  return c.html(
    <ItemForm
      action={paths.itemNew()}
      values={valuesFromForm(form)}
      errors={toFormErrors(result.error)}
      error={result.error}
      options={await formOptions(c)}
      isNew
      submitLabel="登録する"
    />,
  );
});

// ---- 詳細 ---------------------------------------------------------------------

itemRoutes.get("/:id", async (c) => {
  const item = await runQuery(c, "items.get", { id: c.req.param("id") });
  if (!item) return c.notFound();
  const actor = c.get("actor");
  const canManage = hasPermission(actor.roles, "items.manage");
  const notice = ITEM_NOTICES[c.req.query("notice") ?? ""];
  return c.html(
    <Layout title={item.name} actor={actor} current={paths.items()}>
      <PageHeader
        title={item.name}
        actions={
          <>
            <a class="btn btn-secondary" href={paths.stockItem(item.id)}>
              在庫明細
            </a>
            {canManage ? (
              <a class="btn btn-secondary" href={paths.itemEdit(item.id)}>
                編集
              </a>
            ) : null}
          </>
        }
      >
        <p>
          <span class="muted">商品コード</span> {item.code} {statusBadge(item)}
        </p>
      </PageHeader>
      {notice ? <Alert kind="success">{notice}</Alert> : null}
      <section class="card">
        <h2>商品の情報</h2>
        <DescriptionList
          items={[
            ["JAN", item.jan],
            ["仕入先", <a href={paths.partner(item.supplierId)}>{item.supplierName}</a>],
            ["ジャンル", item.genreName],
            ["温度帯", TEMPERATURE_ZONE_LABELS[item.temperatureZone]],
            ["税区分", TAX_CATEGORY_LABELS[item.taxCategory]],
            ["仕入単位", item.purchaseUnitName],
            ["販売単位", item.salesUnitName],
            [
              "入数",
              `${qty(item.unitsPerPurchaseUnit)}${item.salesUnitName}／${item.purchaseUnitName}`,
            ],
            ["仕入価格（税抜）", `${centiYen(item.purchasePriceCenti)}／${item.purchaseUnitName}`],
            ["卸単価（税抜）", `${centiYen(item.salesPriceCenti)}／${item.salesUnitName}`],
            ["発注時の価格", item.inputPriceOnOrder ? "発注時に入力する" : "マスタの価格を使う"],
            ["最低ロット（仕入）", `${qty(item.purchaseMinLot)}${item.purchaseUnitName}`],
            ["最低ロット（販売）", `${qty(item.salesMinLot)}${item.salesUnitName}`],
            ["リードタイム", item.leadTimeDays === null ? null : `${item.leadTimeDays}日`],
            [
              "発注点",
              item.reorderEnabled ? `${qty(item.reorderPoint)}${item.salesUnitName}` : "管理しない",
            ],
            ["送料条件（仕入）", item.purchaseShippingNote],
            ["送料条件（販売）", item.salesShippingNote],
            ["備考", item.memo ? <span class="pre">{item.memo}</span> : null],
          ]}
        />
      </section>
      {canManage ? (
        <section class="card">
          <h2>取扱終了・削除</h2>
          <p class="hint">
            取扱終了にすると、発注・受注の商品選択に出なくなります。取引や在庫で使われた商品は削除できません。
          </p>
          <div class="toolbar">
            <form method="post" action={paths.itemDiscontinue(item.id)}>
              <FormKey />
              <Version value={item.version} />
              <input
                type="hidden"
                name="discontinued"
                value={item.discontinued ? "false" : "true"}
              />
              <button type="submit" class="btn btn-secondary">
                {item.discontinued ? "取扱終了を取り消す" : "取扱終了にする"}
              </button>
            </form>
            <form
              method="post"
              action={paths.itemDelete(item.id)}
              hx-post={paths.itemDelete(item.id)}
              hx-target="#delete-result"
              hx-confirm={`「${item.name}」を削除します。よろしいですか？`}
            >
              <FormKey />
              <Version value={item.version} />
              <button type="submit" class="btn btn-danger">
                削除
              </button>
            </form>
          </div>
          <div id="delete-result" />
        </section>
      ) : null}
    </Layout>,
  );
});

// ---- 編集 ---------------------------------------------------------------------

itemRoutes.get("/:id/edit", async (c) => {
  const item = await runQuery(c, "items.get", { id: c.req.param("id") });
  if (!item) return c.notFound();
  return c.html(
    <Layout title={`${item.name}の編集`} actor={c.get("actor")} current={paths.items()}>
      <PageHeader title={`${item.name}の編集`} />
      <ItemForm
        action={paths.itemEdit(item.id)}
        values={valuesFromRecord(item)}
        errors={{}}
        version={item.version}
        options={await formOptions(c)}
        isNew={false}
        submitLabel="保存する"
      />
    </Layout>,
  );
});

itemRoutes.post("/:id/edit", async (c) => {
  const id = c.req.param("id");
  const form = await readForm(c);
  const version = int(form, "version");
  const result = await runCommand(
    c,
    "items.update",
    { id, version, fields: itemInputFromForm(form) },
    formKey(form),
  );
  if (result.ok) return redirectTo(c, paths.item(id, { notice: "updated" }));
  return c.html(
    <ItemForm
      action={paths.itemEdit(id)}
      values={valuesFromForm(form)}
      errors={toFormErrors(result.error, "fields.")}
      error={result.error}
      version={version}
      options={await formOptions(c)}
      isNew={false}
      submitLabel="保存する"
    />,
  );
});

// ---- 取扱終了・削除 -------------------------------------------------------------

itemRoutes.post("/:id/discontinue", async (c) => {
  const id = c.req.param("id");
  const form = await readForm(c);
  const discontinued = str(form, "discontinued") === "true";
  const result = await runCommand(
    c,
    "items.discontinue",
    { id, version: int(form, "version"), discontinued },
    formKey(form),
  );
  if (result.ok)
    return redirectTo(c, paths.item(id, { notice: discontinued ? "discontinued" : "resumed" }));
  return c.html(
    <Layout title="変更できません" actor={c.get("actor")} current={paths.items()}>
      <Alert kind="error">{result.error.message}</Alert>
      <a href={paths.item(id)}>商品に戻る</a>
    </Layout>,
    409,
  );
});

itemRoutes.post("/:id/delete", async (c) => {
  const id = c.req.param("id");
  const form = await readForm(c);
  const result = await runCommand(
    c,
    "items.delete",
    { id, version: int(form, "version") },
    formKey(form),
  );
  if (result.ok) return redirectTo(c, paths.items({ notice: "deleted" }));
  if (isHtmx(c)) return c.html(<Alert kind="error">{result.error.message}</Alert>, 409);
  return c.html(
    <Layout title="削除できません" actor={c.get("actor")} current={paths.items()}>
      <Alert kind="error">{result.error.message}</Alert>
      <a href={paths.item(id)}>商品に戻る</a>
    </Layout>,
    409,
  );
});
