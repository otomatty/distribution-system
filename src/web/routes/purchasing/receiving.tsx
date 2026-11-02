/**
 * 入荷予定一覧と入荷確認（要件定義書 3.6。倉庫のタブレットで使う）。
 * - 入荷予定一覧：発注済みで未入荷の明細を、保管場所ごとに納品希望日の順で表示する
 * - 入荷確認：明細ごとに受入数と返品数を入力する（「−」「＋」でも増減できる）。入力途中の内容は端末に下書きとして残り、
 *   通信が途切れても同じ受付番号で送り直せる（二重に入荷しない）
 */
import { Hono, type Context } from "hono";

import { toBusinessDate } from "../../../domain/dates";
import { DESTINATION_LABELS, PURCHASE_ORDER_STATUS_LABELS } from "../../../domain/purchasing";
import type { DomainError } from "../../../domain/result";
import type { PurchaseOrderView } from "../../../usecases/purchasing/purchase-orders";
import { bool, formKey, int, readForm, str, strs, type FormData_ } from "../../form";
import { redirectTo } from "../../http";
import { hasPermission } from "../../middleware";
import { paths } from "../../paths";
import type { AppEnv } from "../../types";
import { runCommand, runQuery } from "../../usecase";
import {
  Alert,
  Badge,
  Checkbox,
  EmptyState,
  ErrorSummary,
  Field,
  FormKey,
  Input,
  PageHeader,
  Select,
  toFormErrors,
  Version,
} from "../../views/components";
import { qty } from "../../views/format";
import { Layout } from "../../views/layout";
import { OfflineSnapshot } from "../../views/offline-snapshot";
import { OrderStatusBadge, ReceiptCancelForm } from "../../views/purchasing";
import { LineQuantity } from "../../views/stock";

export const receivingRoutes = new Hono<AppEnv>();

// ---- 入荷予定一覧 ----------------------------------------------------------------

receivingRoutes.get("/", async (c) => {
  const locationId = c.req.query("locationId") ?? "";
  const overdue = c.req.query("overdue") === "1";
  // 納品希望日（ダッシュボードの「今日の入荷予定」から開くと今日）。空ならすべて
  const on = c.req.query("on") ?? "";
  const [groups, locations] = await Promise.all([
    runQuery(c, "receipts.schedule", { locationId: locationId || undefined, overdue, on }),
    runQuery(c, "locations.options", {}),
  ]);
  return c.html(
    <Layout title="入荷予定" actor={c.get("actor")} current={paths.receiving()} touch>
      <PageHeader title="入荷予定">
        <p class="hint">
          発注済みで、まだ入荷していない商品です。保管場所ごとに納品希望日の順に並べています。
        </p>
      </PageHeader>
      <form
        class="filters"
        method="get"
        action={paths.receiving()}
        hx-get={paths.receiving()}
        hx-target="#results"
        hx-select="#results"
        hx-swap="outerHTML"
        hx-push-url="true"
        hx-trigger="change"
      >
        <Field label="保管場所" name="locationId">
          <Select
            name="locationId"
            value={locationId}
            options={locations.map((l) => ({ value: l.id, label: l.name }))}
            empty="すべて"
          />
        </Field>
        <Field label="納品希望日" name="on" hint="空ならすべての日">
          <Input name="on" type="date" value={on} />
        </Field>
        <Checkbox name="overdue" value="1" label="納品希望日を過ぎたものだけ" checked={overdue} />
        <noscript>
          <button type="submit" class="btn btn-secondary">
            表示
          </button>
        </noscript>
      </form>
      <section id="results">
        <OfflineSnapshot scope={paths.receiving()} loadedAt={new Date()} />
        {groups.length === 0 ? (
          <EmptyState message="入荷予定はありません" />
        ) : (
          groups.map((g) => (
            <section class="card">
              <h2>
                {g.title}
                {g.locationId === null ? (
                  <span class="muted small">（在庫には入りません。納品済みの確認だけです）</span>
                ) : null}
              </h2>
              <ul class="receiving-list">
                {g.orders.map((o) => (
                  <li>
                    <a class="receiving-order" href={paths.receivingOrder(o.purchaseOrderId)}>
                      <span class="receiving-head">
                        <strong>{o.purchaseOrderNumber}</strong> {o.supplierName}
                        {g.locationId === null && o.destinationName
                          ? `（${o.destinationName}）`
                          : ""}
                      </span>
                      <span>
                        納品希望日：{o.deliveryRequestedOn ?? "指定なし"}{" "}
                        {o.overdue ? <Badge kind="danger">予定日を過ぎています</Badge> : null}
                      </span>
                      <span class="small">
                        {o.lines
                          .map((l) => `${l.itemName} 残り${qty(l.remaining)}${l.purchaseUnitName}`)
                          .join("、")}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </section>
    </Layout>,
  );
});

// ---- 入荷確認 -------------------------------------------------------------------

interface LineInput {
  readonly accepted: string;
  readonly returned: string;
  readonly close: boolean;
}

/** 0 以上の整数。空は 0、それ以外の文字は NaN（ユースケースの検証でエラーになる） */
function count(text: string): number {
  const t = text.trim();
  if (t === "") return 0;
  return /^\d{1,7}$/.test(t) ? Number(t) : Number.NaN;
}

function ReceiveForm(props: {
  view: PurchaseOrderView;
  receivedOn: string;
  memo: string;
  inputs: ReadonlyMap<string, LineInput>;
  error?: DomainError | null;
}) {
  const { order } = props.view;
  const errors = props.error ? toFormErrors(props.error) : {};
  const stocked = order.destinationKind === "location";
  const open = props.view.lines.filter((l) => l.remaining > 0);
  return (
    <form
      id="receive-form"
      method="post"
      action={paths.receivingOrder(order.id)}
      hx-post={paths.receivingOrder(order.id)}
      hx-target="this"
      hx-swap="outerHTML"
      class="form receive-form"
      data-draft={`receiving:${order.id}`}
    >
      <ErrorSummary error={props.error} />
      <FormKey />
      <Version value={order.version} />
      <p class="hint">
        {stocked
          ? `在庫に入る数は「受入数 × 入数」です（${order.destinationName ?? ""}）。その場で返した数は「返品数」に入れます。`
          : "この発注は在庫に入れません（メーカー直・その他の届け先）。届いた数を「納品済み」として記録します。"}
      </p>
      <div class="grid-2">
        <Field
          label="入荷日"
          name="receivedOn"
          required
          error={errors["receivedOn"]}
          hint={`発注日（${order.orderedOn}）から今日まで`}
        >
          <Input
            name="receivedOn"
            type="date"
            value={props.receivedOn}
            min={order.orderedOn}
            error={errors["receivedOn"]}
          />
        </Field>
        <Field label="メモ" name="memo" error={errors["memo"]}>
          <Input name="memo" value={props.memo} maxlength={500} />
        </Field>
      </div>
      <div class="table-wrap">
        <table class="table receive-lines">
          <thead>
            <tr>
              <th>商品</th>
              <th class="num">残り</th>
              <th>受入数</th>
              <th>返品数（その場で返した数）</th>
              <th>打ち切り</th>
            </tr>
          </thead>
          <tbody>
            {open.map((l) => {
              const input = props.inputs.get(l.id);
              return (
                <tr>
                  <td>
                    <input type="hidden" name="lineId" value={l.id} />
                    <strong>{l.itemName}</strong>
                    <div class="muted small">
                      {l.itemCode}・発注 {qty(l.quantity)}
                      {l.purchaseUnitName}・入荷済み {qty(l.receivedQuantity)}・{l.purchaseUnitName}
                      ＝{l.unitsPerPurchaseUnit}
                      {l.salesUnitName}
                    </div>
                  </td>
                  <td class="num">
                    <strong>{qty(l.remaining)}</strong>
                    {l.purchaseUnitName}
                  </td>
                  <td>
                    <LineQuantity
                      name={`accepted_${l.id}`}
                      id={`accepted-${l.id}`}
                      label={`${l.itemName}の受入数`}
                      value={input?.accepted ?? String(l.remaining)}
                      min={0}
                    />
                  </td>
                  <td>
                    <LineQuantity
                      name={`returned_${l.id}`}
                      id={`returned-${l.id}`}
                      label={`${l.itemName}の返品数`}
                      value={input?.returned ?? "0"}
                      min={0}
                    />
                  </td>
                  <td>
                    <label class="checkbox checkbox-lg">
                      <input
                        type="checkbox"
                        name={`close_${l.id}`}
                        value="on"
                        checked={input?.close ?? false}
                      />{" "}
                      残りは打ち切り
                    </label>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {errors["lines"] ? <p class="field-error">{errors["lines"]}</p> : null}
      <div class="form-actions">
        <button type="submit" class="btn btn-primary btn-lg">
          {stocked ? "入荷を記録する" : "納品済みを記録する"}
        </button>
      </div>
    </form>
  );
}

const RECEIVE_NOTICES: Readonly<Record<string, string>> = {
  partial: "入荷を記録しました。残りの商品は次の入荷で記録します（分納）",
  done: "入荷を記録しました。全数がそろったので、この発注は入荷済みになりました",
};

function ReceivePage(props: {
  c: Context<AppEnv>;
  view: PurchaseOrderView;
  notice?: string | undefined;
}) {
  const { view } = props;
  const { order } = view;
  const actor = props.c.get("actor");
  const canReceive = hasPermission(actor.roles, "receipts.manage");
  const cancellable = new Set(view.cancellableReceiptIds);
  return (
    <Layout title={`入荷確認 ${order.number}`} actor={actor} current={paths.receiving()} touch>
      <PageHeader
        title={`入荷確認 ${order.number}`}
        actions={
          <a class="btn btn-secondary btn-lg" href={paths.receiving()}>
            入荷予定に戻る
          </a>
        }
      >
        <p>
          {order.supplierName}・{DESTINATION_LABELS[order.destinationKind]}：
          {order.destinationName ?? order.destinationAddress ?? ""}・納品希望日：
          {order.deliveryRequestedOn ?? "指定なし"} <OrderStatusBadge status={order.status} />
        </p>
      </PageHeader>
      {props.notice ? <Alert kind="success">{props.notice}</Alert> : null}
      {view.actions.receive ? (
        <ReceiveForm
          view={view}
          receivedOn={toBusinessDate(new Date())}
          memo=""
          inputs={new Map()}
        />
      ) : canReceive ? (
        <Alert kind="info">
          この発注は「{PURCHASE_ORDER_STATUS_LABELS[order.status]}
          」のため、入荷を記録できません（入荷を記録できるのは発注済みの発注だけです）。
        </Alert>
      ) : (
        <Alert kind="warning">入荷を記録する権限がありません。</Alert>
      )}
      {view.receipts.length > 0 ? (
        <section class="card">
          <h2>この発注の入荷</h2>
          <table class="table">
            <thead>
              <tr>
                <th>入荷番号</th>
                <th>入荷日</th>
                <th>内容</th>
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
                  <td class="small">
                    {r.lines.map((l) => (
                      <div>
                        {l.itemName}：受入 {qty(l.accepted)}
                        {l.returned > 0 ? `・返品 ${qty(l.returned)}` : ""}
                        {l.closedRemaining ? "・残りを打ち切り" : ""}
                      </div>
                    ))}
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
        </section>
      ) : null}
      <p>
        <a href={paths.purchaseOrder(order.id)}>発注の詳細を見る</a>
      </p>
    </Layout>
  );
}

receivingRoutes.get("/:orderId", async (c) => {
  const view = await runQuery(c, "purchaseOrders.get", { id: c.req.param("orderId") });
  if (!view) return c.notFound();
  return c.html(
    <ReceivePage c={c} view={view} notice={RECEIVE_NOTICES[c.req.query("notice") ?? ""]} />,
  );
});

function inputsFromForm(form: FormData_): Map<string, LineInput> {
  return new Map(
    strs(form, "lineId").map((id) => [
      id,
      {
        accepted: str(form, `accepted_${id}`),
        returned: str(form, `returned_${id}`),
        close: bool(form, `close_${id}`),
      },
    ]),
  );
}

receivingRoutes.post("/:orderId", async (c) => {
  const orderId = c.req.param("orderId");
  const form = await readForm(c);
  const inputs = inputsFromForm(form);
  const receivedOn = str(form, "receivedOn");
  const memo = str(form, "memo");
  const result = await runCommand(
    c,
    "receipts.record",
    {
      purchaseOrderId: orderId,
      version: int(form, "version"),
      receivedOn,
      memo,
      lines: [...inputs].map(([lineId, i]) => ({
        lineId,
        accepted: count(i.accepted),
        returned: count(i.returned),
        closeRemaining: i.close,
      })),
    },
    formKey(form),
  );
  if (result.ok)
    return redirectTo(
      c,
      paths.receivingOrder(orderId, {
        notice: result.value.status === "received" ? "done" : "partial",
      }),
    );
  const view = await runQuery(c, "purchaseOrders.get", { id: orderId });
  if (!view) return c.notFound();
  return c.html(
    <ReceiveForm
      view={view}
      receivedOn={receivedOn}
      memo={memo}
      inputs={inputs}
      error={result.error}
    />,
  );
});

/** 入荷の取消（発注詳細・入荷確認の画面から）。失敗したら取消の欄だけを返す */
receivingRoutes.post("/receipts/:id/cancel", async (c) => {
  const id = c.req.param("id");
  const form = await readForm(c);
  const version = int(form, "version");
  const result = await runCommand(
    c,
    "receipts.cancel",
    { id, version, reason: str(form, "reason") },
    formKey(form),
  );
  if (result.ok)
    return redirectTo(
      c,
      paths.purchaseOrder(result.value.purchaseOrderId, { notice: "receiptCancelled" }),
    );
  const shortages =
    result.error.code === "insufficient_stock"
      ? await runQuery(c, "stock.shortages", { details: [...(result.error.details ?? [])] })
      : undefined;
  return c.html(
    <ReceiptCancelForm
      receiptId={id}
      number={str(form, "number")}
      version={version}
      error={result.error}
      shortages={shortages}
    />,
  );
});
