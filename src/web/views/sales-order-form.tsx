import type { TaxCategory, TaxSummary } from "../../domain/money";
/**
 * 受注の作成・編集のフォーム（要件定義書 3.8）。
 * 明細の数量や単価を変えると、その行（hx-trigger="change"）だけをサーバーで計算し直して差し替え、
 * 合計欄（tfoot#so-totals）は hx-swap-oob で一緒に差し替える。金額と警告は usecases の計算結果を表示するだけ。
 */
import type { DomainError } from "../../domain/result";
import type { EvaluatedLine } from "../../usecases/sales/evaluate";
import { paths } from "../paths";
import {
  Checkbox,
  ErrorSummary,
  Field,
  FormKey,
  Input,
  Select,
  TextArea,
  Version,
  type FormErrors,
  type Option,
} from "./components";
import { centiYen, yen } from "./format";
import { ItemPickerButton } from "./item-picker";
import { LineStock, TaxCategoryLabel, TotalsFoot } from "./sales";
import { LineQuantity } from "./stock";

export const FORM_ID = "so-form";
export const LINES_ID = "so-lines";
export const CHARGES_ID = "so-charges";
export const TOTALS_ID = "so-totals";
export const SHIP_DATE_ID = "ship-date-field";
export const PICKER_ID = "so-picker";
const COLUMNS = 7;

export interface OrderFormValues {
  readonly customerId: string;
  readonly orderedOn: string;
  readonly customerContactName: string;
  readonly makerDirect: boolean;
  readonly locationId: string;
  readonly employeeId: string;
  readonly deliveryRequestedOn: string;
  readonly shipPlannedOn: string;
  readonly memo: string;
}

/** 明細の行。入力中の文字（数量・単価・理由）はそのまま戻し、金額と警告は計算結果を出す */
export interface LineView {
  readonly line: EvaluatedLine;
  readonly quantity: string;
  readonly price: string;
  readonly reason: string;
  readonly errors: Readonly<
    Partial<Record<"quantity" | "price" | "reason" | "item", string | undefined>>
  >;
}

export interface ChargeView {
  /** 行を見分ける値（画面の中だけで使う） */
  readonly key: string;
  readonly description: string;
  readonly quantity: string;
  readonly unitAmount: string;
  readonly taxCategory: TaxCategory;
  readonly amount: number | null;
  readonly error?: string | undefined;
}

export interface OrderFormOptions {
  readonly customers: readonly Option[];
  readonly locations: readonly Option[];
  readonly employees: readonly Option[];
}

const TAX_OPTIONS: Option[] = [
  { value: "standard", label: "標準税率" },
  { value: "reduced", label: "※軽減税率" },
];

function rowVals(value: Record<string, string>): string {
  return JSON.stringify(value);
}

export function LineRow(props: { view: LineView }) {
  const { line, errors } = props.view;
  const id = line.itemId;
  const invalid = Object.values(errors).some((e) => e !== undefined);
  return (
    <tr
      id={`so-line-${id}`}
      data-line-item={id}
      class={invalid ? "row-danger" : line.warnings.length > 0 ? "row-warning" : undefined}
      hx-post={paths.salesOrderRecalc()}
      hx-trigger="change"
      hx-target="this"
      hx-swap="outerHTML"
      hx-vals={rowVals({ row: id })}
    >
      <td>
        <input type="hidden" name="lineItemId" value={id} />
        <span class="muted small">{line.itemCode}</span> {line.itemName}
        {line.discontinued ? <span class="badge">取扱終了</span> : null}
        {errors.item ? <p class="field-error">{errors.item}</p> : null}
      </td>
      <td>
        <LineStock line={line} />
      </td>
      <td>
        <LineQuantity
          name="lineQuantity"
          id={`qty-${id}`}
          label={`${line.itemName}の数量`}
          value={props.view.quantity}
          min={1}
          error={errors.quantity}
        />
      </td>
      <td>
        <input
          id={`price-${id}`}
          name="linePrice"
          type="text"
          inputmode="decimal"
          class="price-input"
          value={props.view.price}
          aria-label={`${line.itemName}の単価`}
          aria-invalid={errors.price ? "true" : undefined}
        />
        {errors.price ? <p class="field-error">{errors.price}</p> : null}
        {line.priceOverridden ? (
          <div class="price-reason">
            <span class="muted small">卸単価 {centiYen(line.listPriceCenti)} から変更</span>
            <input
              id={`reason-${id}`}
              name="linePriceReason"
              type="text"
              maxlength={200}
              value={props.view.reason}
              placeholder="単価を変えた理由"
              aria-label={`${line.itemName}の単価を変えた理由`}
              aria-invalid={errors.reason || line.reasonMissing ? "true" : undefined}
            />
            {errors.reason ? (
              <p class="field-error">{errors.reason}</p>
            ) : line.reasonMissing ? (
              <p class="hint">登録には理由が必要です</p>
            ) : null}
          </div>
        ) : (
          <input type="hidden" name="linePriceReason" value="" />
        )}
      </td>
      <td>
        <TaxCategoryLabel category={line.taxCategory} />
      </td>
      <td class="num" data-amount>
        {yen(line.amount)}
      </td>
      <td>
        <button
          type="button"
          class="btn btn-secondary"
          hx-post={paths.salesOrderRecalc()}
          hx-vals={rowVals({ remove: id })}
          hx-target="closest tr"
          hx-swap="outerHTML"
          aria-label={`${line.itemName}を明細から外す`}
        >
          外す
        </button>
      </td>
    </tr>
  );
}

export function ChargeRow(props: { view: ChargeView }) {
  const v = props.view;
  return (
    <tr
      id={`so-charge-${v.key}`}
      data-charge
      class={v.error ? "row-danger" : undefined}
      hx-post={paths.salesOrderRecalc()}
      hx-trigger="change"
      hx-target="this"
      hx-swap="outerHTML"
      hx-vals={rowVals({ charge: v.key })}
    >
      <td>
        <input type="hidden" name="chargeKey" value={v.key} />
        <input
          name="chargeDescription"
          type="text"
          maxlength={50}
          value={v.description}
          aria-label="送料などの内容"
        />
        {v.error ? <p class="field-error">{v.error}</p> : null}
      </td>
      <td></td>
      <td>
        <input
          name="chargeQuantity"
          type="number"
          inputmode="numeric"
          min={1}
          step={1}
          value={v.quantity}
          aria-label="送料などの数量"
        />
      </td>
      <td>
        <input
          name="chargeUnitAmount"
          type="text"
          inputmode="numeric"
          class="price-input"
          value={v.unitAmount}
          aria-label="送料などの金額（税抜・円）"
        />
      </td>
      <td>
        <select name="chargeTaxCategory" aria-label="送料などの税区分">
          {TAX_OPTIONS.map((o) => (
            <option value={o.value} selected={o.value === v.taxCategory}>
              {o.label}
            </option>
          ))}
        </select>
      </td>
      <td class="num">{yen(v.amount)}</td>
      <td>
        <button
          type="button"
          class="btn btn-secondary"
          hx-post={paths.salesOrderRecalc()}
          hx-vals={rowVals({ removeCharge: v.key })}
          hx-target="closest tr"
          hx-swap="outerHTML"
          aria-label="送料などの行を外す"
        >
          外す
        </button>
      </td>
    </tr>
  );
}

export function OrderTotals(props: {
  summary: TaxSummary | null;
  incomplete: boolean;
  oob?: boolean;
}) {
  return (
    <TotalsFoot
      id={TOTALS_ID}
      oob={props.oob ?? false}
      summary={props.summary}
      incomplete={props.incomplete}
      columns={COLUMNS}
    />
  );
}

export function ShipDateField(props: { value: string; error?: string | undefined }) {
  return (
    <div id={SHIP_DATE_ID}>
      <Field
        label="出荷予定日"
        name="shipPlannedOn"
        required
        error={props.error}
        hint="初期値は「納品希望日 − 販売先の配送日数」。受注ごとに変えられます"
      >
        <Input name="shipPlannedOn" type="date" value={props.value} />
      </Field>
    </div>
  );
}

export function SalesOrderForm(props: {
  action: string;
  submitLabel: string;
  orderId: string | null;
  version: number | null;
  values: OrderFormValues;
  lines: readonly LineView[];
  charges: readonly ChargeView[];
  summary: TaxSummary | null;
  incomplete: boolean;
  options: OrderFormOptions;
  errors: FormErrors;
  error?: DomainError | null | undefined;
}) {
  const v = props.values;
  const e = props.errors;
  const lineError = e["lines"];
  return (
    <form
      id={FORM_ID}
      method="post"
      action={props.action}
      hx-post={props.action}
      hx-target="this"
      hx-swap="outerHTML"
      class="form so-form"
    >
      <ErrorSummary error={props.error} />
      <FormKey />
      {props.orderId ? <input type="hidden" name="orderId" value={props.orderId} /> : null}
      {props.version !== null ? <Version value={props.version} /> : null}
      <fieldset>
        <legend>受注</legend>
        <div class="grid-3">
          <div
            hx-post={paths.salesOrderShipDate()}
            hx-trigger="change"
            hx-target={`#${SHIP_DATE_ID}`}
            hx-swap="outerHTML"
          >
            <Field label="販売先" name="customerId" required error={e["customerId"]}>
              <Select
                name="customerId"
                value={v.customerId}
                options={props.options.customers}
                empty="選んでください"
              />
            </Field>
          </div>
          <div
            hx-post={paths.salesOrderRecalc()}
            hx-trigger="change"
            hx-target={`#${LINES_ID}`}
            hx-swap="innerHTML"
            hx-vals={rowVals({ scope: "lines" })}
          >
            <Field label="受注日" name="orderedOn" required error={e["orderedOn"]}>
              <Input name="orderedOn" type="date" value={v.orderedOn} />
            </Field>
          </div>
          <Field label="先方の担当者" name="customerContactName" error={e["customerContactName"]}>
            <Input name="customerContactName" value={v.customerContactName} maxlength={100} />
          </Field>
          <div
            hx-post={paths.salesOrderRecalc()}
            hx-trigger="change"
            hx-target={`#${LINES_ID}`}
            hx-swap="innerHTML"
            hx-vals={rowVals({ scope: "lines" })}
          >
            <Field
              label="出荷元の保管場所"
              name="locationId"
              error={e["locationId"]}
              hint="メーカー直のときは不要です（選んでも保存しません）"
            >
              <Select
                name="locationId"
                value={v.locationId}
                options={props.options.locations}
                empty="選んでください"
              />
            </Field>
            <Checkbox
              name="makerDirect"
              label="メーカー直（仕入先から直送。引き当てず、在庫も動かさない）"
              checked={v.makerDirect}
            />
          </div>
          <Field label="社内の担当者" name="employeeId" error={e["employeeId"]}>
            <Select
              name="employeeId"
              value={v.employeeId}
              options={props.options.employees}
              empty="未選択"
            />
          </Field>
          <div
            hx-post={paths.salesOrderShipDate()}
            hx-trigger="change"
            hx-target={`#${SHIP_DATE_ID}`}
            hx-swap="outerHTML"
          >
            <Field label="納品希望日" name="deliveryRequestedOn" error={e["deliveryRequestedOn"]}>
              <Input name="deliveryRequestedOn" type="date" value={v.deliveryRequestedOn} />
            </Field>
          </div>
          <ShipDateField value={v.shipPlannedOn} error={e["shipPlannedOn"]} />
        </div>
        <Field label="メモ" name="memo" error={e["memo"]}>
          <TextArea name="memo" value={v.memo} rows={2} />
        </Field>
      </fieldset>
      <fieldset>
        <legend>明細</legend>
        {lineError ? <p class="field-error">{lineError}</p> : null}
        <div class="table-wrap">
          <table class="table so-lines">
            <thead>
              <tr>
                <th>商品</th>
                <th>出荷可能数・警告</th>
                <th>数量</th>
                <th>単価（税抜・円）</th>
                <th>税区分</th>
                <th class="num">金額</th>
                <th>
                  <span class="sr-only">操作</span>
                </th>
              </tr>
            </thead>
            <tbody id={LINES_ID}>
              {props.lines.map((l) => (
                <LineRow view={l} />
              ))}
            </tbody>
            <tbody id={CHARGES_ID}>
              <tr class="section-row">
                <th colspan={COLUMNS}>送料など（税区分の初期値は標準税率）</th>
              </tr>
              {props.charges.map((ch) => (
                <ChargeRow view={ch} />
              ))}
            </tbody>
            <OrderTotals summary={props.summary} incomplete={props.incomplete} />
          </table>
        </div>
        <p class="hint">
          出荷可能数を超える数量・最低ロット未満・ロットの倍数でない数量は警告だけで、登録はできます。※は軽減税率の対象です。
        </p>
        <div class="toolbar">
          <ItemPickerButton picker={PICKER_ID} />
          <button
            type="button"
            class="btn btn-secondary"
            hx-post={paths.salesOrderChargeRow()}
            hx-target={`#${CHARGES_ID}`}
            hx-swap="beforeend"
          >
            送料などを追加
          </button>
        </div>
      </fieldset>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">
          {props.submitLabel}
        </button>
      </div>
    </form>
  );
}
