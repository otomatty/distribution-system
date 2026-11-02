/**
 * 返品伝票と返還請求書（要件定義書 3.11、5章 受注詳細の返品伝票）。
 * 受注詳細から開く返品伝票の登録（明細ごとの返品数、在庫に戻すか廃棄か）、返品伝票の詳細（取消、返還請求書の発行）。
 */
import { Hono, type Context } from "hono";
import type { Child } from "hono/jsx";

import { toBusinessDate } from "../../../domain/dates";
import type { DomainError } from "../../../domain/result";
import type { OrderReturns, SalesReturnView } from "../../../usecases/billing/returns";
import type { ShortageDetail } from "../../../usecases/stock/queries";
import { formKey, readForm, str, strs, type FormData_ } from "../../form";
import { isHtmx, redirectTo } from "../../http";
import { hasPermission } from "../../middleware";
import { paths } from "../../paths";
import type { AppEnv } from "../../types";
import { runCommand, runQuery } from "../../usecase";
import {
  Alert,
  Badge,
  DescriptionList,
  ErrorSummary,
  Field,
  FormKey,
  Input,
  PageHeader,
  TextArea,
  toFormErrors,
  Version,
  type FormErrors,
  type Option,
} from "../../views/components";
import { centiYen, dateTime, qty, rate, yen } from "../../views/format";
import { Layout } from "../../views/layout";
import { TaxCategoryLabel } from "../../views/sales";
import { StockErrorSummary } from "../../views/stock";

export const salesReturnRoutes = new Hono<AppEnv>();

const RETURN_NOTICES: Readonly<Record<string, string>> = {
  created: "返品伝票を登録しました",
  cancelled: "返品伝票を取り消しました。在庫に戻した分は打ち消しの行で戻しました",
  credit_note: "返還請求書を発行しました（PDF はこの後に作成します）",
};

// ---- 登録 ---------------------------------------------------------------------

interface DraftLine {
  readonly lineId: string;
  readonly quantity: string;
  readonly restock: boolean;
  readonly locationId: string;
}

function draftLines(form: FormData_): DraftLine[] {
  const quantities = strs(form, "lineQuantity");
  const handling = strs(form, "lineHandling");
  const locations = strs(form, "lineLocationId");
  return strs(form, "lineId").map((lineId, i) => ({
    lineId,
    quantity: quantities[i] ?? "",
    restock: handling[i] === "restock",
    locationId: locations[i] ?? "",
  }));
}

function quantityOf(text: string): number {
  const t = text.trim();
  if (t === "") return 0;
  return /^\d{1,7}$/.test(t) ? Number(t) : Number.NaN;
}

function ReturnForm(props: {
  orderId: string;
  data: OrderReturns;
  locations: readonly Option[];
  values: { returnedOn: string; memo: string; lines: ReadonlyMap<string, DraftLine> };
  error?: DomainError | undefined;
  errors?: FormErrors;
}) {
  const { data } = props;
  const errors = props.errors ?? {};
  const today = toBusinessDate(new Date());
  const defaultRestock = data.defaultLocationId !== null;
  return (
    <form
      id="return-form"
      class="form"
      method="post"
      action={paths.salesReturnNew(props.orderId)}
      hx-post={paths.salesReturnNew(props.orderId)}
      hx-target="this"
      hx-swap="outerHTML"
    >
      {props.error?.code === "insufficient_stock" ? (
        <StockErrorSummary error={props.error} />
      ) : (
        <ErrorSummary error={props.error} />
      )}
      <FormKey />
      <p class="hint">
        返品した数を入力してください（入力しない行は返品しません）。在庫に戻す商品は保管場所の在庫が増えます。
        廃棄する商品は在庫を動かしません。返品額は受注の単価で計算し、未請求なら次の請求書にマイナスの明細として載せます。
      </p>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>商品</th>
              <th class="num">単価（税抜）</th>
              <th class="num">発送</th>
              <th class="num">返品済み</th>
              <th>返品数</th>
              <th>扱い</th>
              <th>在庫に戻す保管場所</th>
            </tr>
          </thead>
          <tbody>
            {data.lines.map((l, i) => {
              const v = props.values.lines.get(l.salesOrderLineId);
              const restock = v ? v.restock : defaultRestock;
              const e = (field: string) => errors[`lines.${i}.${field}`];
              return (
                <tr class={l.remaining === 0 ? "row-muted" : undefined}>
                  <td>
                    <input type="hidden" name="lineId" value={l.salesOrderLineId} />
                    <span class="muted small">{l.itemCode}</span> {l.itemName}
                    {e("salesOrderLineId") ? (
                      <p class="field-error">{e("salesOrderLineId")}</p>
                    ) : null}
                  </td>
                  <td class="num">{centiYen(l.unitPriceCenti)}</td>
                  <td class="num">
                    {qty(l.shipped)}
                    <span class="muted small">{l.unitName}</span>
                  </td>
                  <td class="num">{qty(l.returned)}</td>
                  <td>
                    <input
                      name="lineQuantity"
                      type="number"
                      inputmode="numeric"
                      min={0}
                      max={l.remaining}
                      step={1}
                      value={v?.quantity ?? ""}
                      disabled={l.remaining === 0}
                      aria-label={`${l.itemName}の返品数（残り${l.remaining}）`}
                      aria-invalid={e("quantity") ? "true" : undefined}
                    />
                    {l.remaining === 0 ? (
                      <input type="hidden" name="lineQuantity" value="0" />
                    ) : null}
                    {e("quantity") ? <p class="field-error">{e("quantity")}</p> : null}
                  </td>
                  <td>
                    <select name="lineHandling" aria-label={`${l.itemName}の扱い`}>
                      <option value="restock" selected={restock}>
                        在庫に戻す
                      </option>
                      <option value="dispose" selected={!restock}>
                        廃棄
                      </option>
                    </select>
                  </td>
                  <td>
                    <select
                      name="lineLocationId"
                      aria-label={`${l.itemName}を戻す保管場所`}
                      aria-invalid={e("locationId") ? "true" : undefined}
                    >
                      <option value="">（選ぶ）</option>
                      {props.locations.map((o) => (
                        <option
                          value={o.value}
                          selected={o.value === (v?.locationId ?? data.defaultLocationId ?? "")}
                        >
                          {o.label}
                        </option>
                      ))}
                    </select>
                    {e("locationId") ? <p class="field-error">{e("locationId")}</p> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div class="grid-2">
        <Field label="返品日" name="returnedOn" required error={errors["returnedOn"]}>
          <Input
            name="returnedOn"
            type="date"
            value={props.values.returnedOn}
            {...(data.shippedOn ? { min: data.shippedOn } : {})}
            max={today}
            error={errors["returnedOn"]}
          />
        </Field>
        <Field label="メモ" name="memo">
          <TextArea name="memo" rows={2} value={props.values.memo} />
        </Field>
      </div>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">
          返品伝票を登録する
        </button>
        <a class="btn btn-secondary" href={paths.salesOrder(props.orderId)}>
          やめる
        </a>
      </div>
    </form>
  );
}

async function locationOptions(c: Context<AppEnv>): Promise<Option[]> {
  const list = await runQuery(c, "locations.options", {});
  return list.map((l) => ({ value: l.id, label: l.name }));
}

function FormPage(props: { c: Context<AppEnv>; data: OrderReturns; body: Child }) {
  return (
    <Layout title="返品伝票の登録" actor={props.c.get("actor")} current={paths.salesOrders()}>
      <PageHeader title={`返品伝票の登録（受注 ${props.data.salesOrderNumber}）`}>
        <p class="muted">
          {props.data.customerName}・発送日 {props.data.shippedOn ?? "—"}
        </p>
      </PageHeader>
      {props.body}
    </Layout>
  );
}

salesReturnRoutes.get("/new", async (c) => {
  const orderId = c.req.query("orderId") ?? "";
  if (!orderId) return c.notFound();
  const data = await runQuery(c, "salesReturns.forOrder", { salesOrderId: orderId });
  if (!data) return c.notFound();
  const canManage = hasPermission(c.get("actor").roles, "salesReturns.manage");
  const body = !canManage ? (
    <Alert kind="warning">返品伝票を登録する権限がありません。</Alert>
  ) : !data.canRecord ? (
    <Alert kind="warning">
      発送済みで、返品できる数が残っている受注だけ返品伝票を記録できます。
      <a href={paths.salesOrder(orderId)}>受注詳細に戻る</a>
    </Alert>
  ) : (
    <ReturnForm
      orderId={orderId}
      data={data}
      locations={await locationOptions(c)}
      values={{ returnedOn: toBusinessDate(new Date()), memo: "", lines: new Map() }}
    />
  );
  return c.html(<FormPage c={c} data={data} body={body} />);
});

salesReturnRoutes.post("/new", async (c) => {
  const orderId = c.req.query("orderId") ?? "";
  const form = await readForm(c);
  const lines = draftLines(form);
  const result = await runCommand(
    c,
    "salesReturns.create",
    {
      salesOrderId: orderId,
      returnedOn: str(form, "returnedOn"),
      memo: str(form, "memo"),
      lines: lines.map((l) => ({
        salesOrderLineId: l.lineId,
        quantity: quantityOf(l.quantity),
        restock: l.restock,
        locationId: l.restock ? l.locationId : null,
      })),
    },
    formKey(form),
  );
  if (result.ok) return redirectTo(c, paths.salesReturn(result.value.id, { notice: "created" }));
  const data = await runQuery(c, "salesReturns.forOrder", { salesOrderId: orderId });
  if (!data) return c.notFound();
  const body = (
    <ReturnForm
      orderId={orderId}
      data={data}
      locations={await locationOptions(c)}
      values={{
        returnedOn: str(form, "returnedOn"),
        memo: str(form, "memo"),
        lines: new Map(lines.map((l) => [l.lineId, l])),
      }}
      error={result.error}
      errors={toFormErrors(result.error)}
    />
  );
  if (isHtmx(c)) return c.html(body);
  return c.html(<FormPage c={c} data={data} body={body} />, 409);
});

// ---- 詳細 ---------------------------------------------------------------------

function DetailBody(props: {
  view: SalesReturnView;
  shortages?: readonly ShortageDetail[] | undefined;
  canManage: boolean;
  canIssueCreditNote: boolean;
  notice?: string | undefined;
  error?: DomainError | undefined;
}) {
  const { ret, creditNote } = props.view;
  const today = toBusinessDate(new Date());
  return (
    <div id="return-detail">
      <PageHeader title={`返品伝票 ${ret.number}`}>
        <p>
          {ret.cancelled ? <Badge>取消</Badge> : null}{" "}
          {ret.invoiceId ? (
            <Badge kind="info">請求済み</Badge>
          ) : ret.cancelled ? null : (
            <Badge>未請求</Badge>
          )}{" "}
          {ret.creditNoteNumber ? <Badge kind="success">返還請求書 発行済み</Badge> : null}
        </p>
      </PageHeader>
      {props.notice ? <Alert kind="success">{props.notice}</Alert> : null}
      {props.error?.code === "insufficient_stock" ? (
        <StockErrorSummary error={props.error} shortages={props.shortages} />
      ) : (
        <ErrorSummary error={props.error} />
      )}
      <section class="card">
        <DescriptionList
          items={[
            ["受注", <a href={paths.salesOrder(ret.salesOrderId)}>{ret.salesOrderNumber}</a>],
            ["販売先", ret.customerName],
            ["返品日", ret.returnedOn],
            [
              "請求書",
              ret.invoiceId ? (
                <a href={paths.invoice(ret.invoiceId)}>{ret.invoiceNumber}</a>
              ) : ret.cancelled ? null : (
                "未請求（次の請求書にマイナスの明細として載せます）"
              ),
            ],
            ["返還請求書", ret.creditNoteNumber],
            ["メモ", ret.memo ? <span class="pre">{ret.memo}</span> : null],
            ["登録", `${dateTime(ret.createdAt)} ${ret.createdByName ?? ""}`],
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
                <th class="num">返品数</th>
                <th>扱い</th>
                <th class="num">単価（税抜）</th>
                <th>税区分</th>
                <th class="num">返品額（税抜）</th>
              </tr>
            </thead>
            <tbody>
              {ret.lines.map((l) => (
                <tr>
                  <td>
                    <span class="muted small">{l.itemCode}</span> {l.itemName}
                  </td>
                  <td class="num">
                    {qty(l.quantity)}
                    <span class="muted small">{l.unitName}</span>
                  </td>
                  <td>{l.restock ? `在庫に戻した（${l.locationName ?? ""}）` : "廃棄"}</td>
                  <td class="num">{centiYen(l.unitPriceCenti)}</td>
                  <td>
                    <TaxCategoryLabel category={l.taxCategory} />
                  </td>
                  <td class="num">{yen(l.amount)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot class="totals">
              <tr class="grand-total">
                <th colspan={5} class="num">
                  合計（税抜）
                </th>
                <td class="num">{yen(ret.subtotal)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>
      <section class="card">
        <h2>返還請求書</h2>
        {creditNote.documentId ? (
          <p>
            <a href={paths.document(creditNote.documentId)}>返還請求書を開く（送付・送付履歴）</a>{" "}
            <a
              class="btn btn-secondary btn-sm"
              href={paths.documentDownload(creditNote.documentId)}
            >
              PDF
            </a>
          </p>
        ) : null}
        {creditNote.preview && !creditNote.documentId ? (
          <p class="small">
            返還額：
            {creditNote.preview.groups
              .map((g) => `${rate(g.rateBps)}対象 ${yen(g.subtotal)}（消費税 ${yen(g.tax)}）`)
              .join("、")}
            、合計（税込） {yen(creditNote.preview.total)}
          </p>
        ) : null}
        {creditNote.issuable ? (
          <>
            {creditNote.obligation === "required" ? (
              <Alert kind="warning">税込1万円以上の返品なので、返還請求書の交付が必要です。</Alert>
            ) : (
              <Alert kind="info">税込1万円未満の返品なので、返還請求書の交付は任意です。</Alert>
            )}
            {props.canIssueCreditNote ? (
              <form
                method="post"
                action={paths.creditNoteIssue(ret.id)}
                hx-post={paths.creditNoteIssue(ret.id)}
                hx-target="#return-detail"
                hx-swap="outerHTML"
                class="inline-form"
              >
                <FormKey />
                <Version value={ret.version} />
                <Field label="発行日" name="issuedOn" required>
                  <Input name="issuedOn" type="date" value={today} min={ret.returnedOn} />
                </Field>
                <button type="submit" class="btn btn-primary">
                  返還請求書を発行する
                </button>
              </form>
            ) : (
              <p class="muted">返還請求書を発行する権限がありません。</p>
            )}
          </>
        ) : creditNote.documentId ? null : (
          <p class="muted">{creditNote.blocker}</p>
        )}
      </section>
      {!ret.cancelled ? (
        <section class="card">
          <h2>返品伝票の取消</h2>
          {props.view.cancelBlocker ? (
            <p class="muted">{props.view.cancelBlocker}</p>
          ) : props.canManage ? (
            <form
              method="post"
              action={paths.salesReturnCancel(ret.id)}
              hx-post={paths.salesReturnCancel(ret.id)}
              hx-target="#return-detail"
              hx-swap="outerHTML"
              hx-confirm={`返品伝票 ${ret.number} を取り消します。在庫に戻した分は打ち消しの行で戻します。よろしいですか？`}
            >
              <FormKey />
              <Version value={ret.version} />
              <Field label="取り消す理由" name="reason" required>
                <TextArea name="reason" rows={2} />
              </Field>
              <button type="submit" class="btn btn-danger">
                返品伝票を取り消す
              </button>
            </form>
          ) : null}
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
  const view = await runQuery(c, "salesReturns.get", { id });
  if (!view) return null;
  const roles = c.get("actor").roles;
  const shortages =
    extra.error?.code === "insufficient_stock"
      ? await runQuery(c, "stock.shortages", { details: [...(extra.error.details ?? [])] })
      : undefined;
  return (
    <DetailBody
      shortages={shortages}
      view={view}
      canManage={hasPermission(roles, "salesReturns.manage")}
      canIssueCreditNote={hasPermission(roles, "invoices.manage")}
      notice={extra.notice}
      error={extra.error}
    />
  );
}

salesReturnRoutes.get("/:id", async (c) => {
  const body = await detailBody(c, c.req.param("id"), {
    notice: RETURN_NOTICES[c.req.query("notice") ?? ""],
  });
  if (!body) return c.notFound();
  return c.html(
    <Layout title="返品伝票" actor={c.get("actor")} current={paths.salesOrders()}>
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
  if (result.ok && !isHtmx(c)) return redirectTo(c, paths.salesReturn(id, { notice }));
  const body = await detailBody(
    c,
    id,
    result.ok ? { notice: RETURN_NOTICES[notice] } : { error: result.error },
  );
  if (!body) return c.notFound();
  if (isHtmx(c)) return c.html(body);
  return c.html(
    <Layout title="返品伝票" actor={c.get("actor")} current={paths.salesOrders()}>
      {body}
    </Layout>,
    409,
  );
}

salesReturnRoutes.post("/:id/cancel", async (c) => {
  const id = c.req.param("id");
  const form = await readForm(c);
  const result = await runCommand(
    c,
    "salesReturns.cancel",
    { id, version: Number(str(form, "version")) || 0, reason: str(form, "reason") },
    formKey(form),
  );
  return afterAction(c, id, result, "cancelled");
});

salesReturnRoutes.post("/:id/credit-note", async (c) => {
  const id = c.req.param("id");
  const form = await readForm(c);
  const result = await runCommand(
    c,
    "creditNotes.issue",
    {
      salesReturnId: id,
      version: Number(str(form, "version")) || 0,
      issuedOn: str(form, "issuedOn"),
    },
    formKey(form),
  );
  return afterAction(c, id, result, "credit_note");
});
