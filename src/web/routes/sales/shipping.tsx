/**
 * 発送リスト（要件定義書 3.9、5章 発送リスト。倉庫のタブレット対応）。
 * 出荷予定日 × 保管場所で、行が商品・列が販売先・右端が合計の表。選んだ日までに出荷予定日が来た未発送の受注をすべて出し、
 * 出荷予定日を過ぎたもの（遅れ）は表の上の要約・列の見出し・一括発送の表で「遅れ」と示す。
 * 印刷（A4 横、販売先が多ければ列を分けて複数ページ）、販売先ごとの仕分けリスト、一括発送（確認してから
 * 1つのトランザクションで実行。在庫が足りない受注・受注日が発送日より後の受注は外して続けられる）、納品書の一括 PDF は、
 * どれも画面と同じ受注を対象にする。
 */
import { Hono, type Context } from "hono";
import type { Child } from "hono/jsx";

import { toBusinessDate } from "../../../domain/dates";
import type { DomainError } from "../../../domain/result";
import type { BulkCheck, ShippingList, ShipResult } from "../../../usecases/sales/shipments";
import { formKey, readForm, str, strs, type FormData_ } from "../../form";
import { isHtmx, redirectTo } from "../../http";
import { hasPermission } from "../../middleware";
import { paths } from "../../paths";
import type { AppEnv } from "../../types";
import { queryAs, runCommand, runQuery } from "../../usecase";
import {
  Alert,
  Badge,
  EmptyState,
  ErrorSummary,
  Field,
  FormKey,
  Input,
  PageHeader,
  Select,
  type Option,
} from "../../views/components";
import { jaDate, qty } from "../../views/format";
import { HtmlDocument, Layout } from "../../views/layout";
import { OfflineSnapshot } from "../../views/offline-snapshot";

export const shippingRoutes = new Hono<AppEnv>();

/** 印刷で1ページに並べる販売先の列の数（A4 横） */
const PRINT_COLUMNS = 10;

function chunk<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function locationOptions(c: Context<AppEnv>): Promise<Option[]> {
  const list = await runQuery(c, "locations.options", {});
  return list.map((l) => ({ value: l.id, label: l.name }));
}

/** 条件（出荷予定日・保管場所）。保管場所が1つだけならそれを選ぶ */
function conditionFrom(get: (name: string) => string, locations: readonly Option[]) {
  const date = get("date").trim() || toBusinessDate(new Date());
  const only = locations.length === 1 ? (locations[0]?.value ?? "") : "";
  return { date, locationId: get("locationId").trim() || only };
}

async function loadList(
  c: Context<AppEnv>,
  date: string,
  locationId: string,
): Promise<{ list: ShippingList | null; error: string | null }> {
  if (!locationId) return { list: null, error: null };
  const r = await queryAs(c.env, c.get("actorRef"), "shipping.list", { date, locationId });
  if (!r.ok) return { list: null, error: r.error.message };
  return { list: r.value, error: r.value ? null : "保管場所が見つかりません" };
}

function Matrix(props: { list: ShippingList }) {
  const { list } = props;
  const m = list.matrix;
  return (
    <div class="matrix-wrap" role="region" aria-label="発送リストの表" tabindex={0}>
      <table class="table shipping-matrix">
        <thead>
          <tr>
            <th class="sticky-col" scope="col">
              商品
            </th>
            <th class="num" scope="col">
              現在庫
            </th>
            {list.customers.map((cu) => (
              <th
                class={cu.overdue ? "num customer-col overdue-col" : "num customer-col"}
                scope="col"
                data-customer={cu.id}
              >
                {cu.name}
                {cu.overdue ? (
                  <>
                    {" "}
                    <Badge kind="danger">遅れ</Badge>
                  </>
                ) : null}
                <div class="muted small">
                  {cu.orders.map((o) => (
                    <div>
                      {o.number}
                      {o.overdue ? `（遅れ：出荷予定日 ${o.shipPlannedOn}）` : ""}
                    </div>
                  ))}
                </div>
              </th>
            ))}
            <th class="num total-col" scope="col">
              合計
            </th>
          </tr>
        </thead>
        <tbody>
          {list.items.map((item, r) => {
            const total = m.rowTotals[r] ?? 0;
            return (
              <tr class={total > item.onHand ? "row-danger" : undefined}>
                <th class="sticky-col" scope="row">
                  <span class="muted small">{item.code}</span> {item.name}
                </th>
                <td class="num">{qty(item.onHand)}</td>
                {(m.quantities[r] ?? []).map((n) => (
                  <td class="num">{n === 0 ? "" : qty(n)}</td>
                ))}
                <td class="num total-col">
                  {qty(total)}
                  <span class="muted small">{item.salesUnitName}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <th class="sticky-col" scope="row">
              合計
            </th>
            <td></td>
            {m.columnTotals.map((n) => (
              <td class="num">{qty(n)}</td>
            ))}
            <td class="num total-col">{qty(m.grandTotal)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** 出荷予定日を過ぎた未発送の受注（遅れ）の要約。表の上に出す */
function OverdueSummary(props: { list: ShippingList }) {
  const overdue = props.list.overdueOrders;
  if (overdue.length === 0) return null;
  return (
    <Alert kind="warning">
      <strong>
        <Badge kind="danger">遅れ</Badge> 出荷予定日を過ぎた未発送の受注が {overdue.length}{" "}
        件あります（この表と一括発送に含みます）。
      </strong>
      <ul class="overdue-list">
        {overdue.map((o) => (
          <li>
            <a href={paths.salesOrder(o.id)}>{o.number}</a>（{o.customerName}）：出荷予定日{" "}
            {o.shipPlannedOn}
          </li>
        ))}
      </ul>
    </Alert>
  );
}

function BulkForm(props: { list: ShippingList }) {
  const { list } = props;
  const short = new Set(list.shortOrderIds);
  const tooEarly = new Set(list.tooEarlyOrderIds);
  return (
    <form
      id="bulk-form"
      method="post"
      action={paths.shippingBulkConfirm()}
      hx-post={paths.shippingBulkConfirm()}
      hx-target="#bulk-panel"
      hx-swap="innerHTML"
    >
      <input type="hidden" name="date" value={list.date} />
      <input type="hidden" name="locationId" value={list.locationId} />
      <div class="table-wrap">
        <table class="table bulk-orders">
          <thead>
            <tr>
              <th>発送する</th>
              <th>受注番号</th>
              <th>販売先</th>
              <th>出荷予定日</th>
              <th class="num">明細</th>
              <th>在庫</th>
            </tr>
          </thead>
          <tbody>
            {list.orders.map((o) => (
              <tr
                class={
                  short.has(o.id) || tooEarly.has(o.id)
                    ? "row-warning"
                    : o.overdue
                      ? "row-danger"
                      : undefined
                }
              >
                <td>
                  <input
                    class="big-check"
                    type="checkbox"
                    name="orderId"
                    value={o.id}
                    checked
                    aria-label={`${o.number}（${o.customerName}）を発送する`}
                  />
                </td>
                <td class="nowrap">
                  <a href={paths.salesOrder(o.id)}>{o.number}</a>
                </td>
                <td>{o.customerName}</td>
                <td class="nowrap">
                  {o.shipPlannedOn}
                  {o.overdue ? (
                    <>
                      {" "}
                      <Badge kind="danger">遅れ</Badge>
                    </>
                  ) : null}
                </td>
                <td class="num">{o.lineCount}</td>
                <td>
                  {short.has(o.id) ? <Badge kind="warning">在庫不足</Badge> : null}
                  {tooEarly.has(o.id) ? <Badge kind="warning">受注日が今日より後</Badge> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary btn-lg">
          選んだ受注を一括発送する…
        </button>
      </div>
    </form>
  );
}

function ShortageList(props: { check: BulkCheck }) {
  return (
    <ul class="shortage-list">
      {props.check.short.map((s) => (
        <li>
          <strong>
            {s.number}（{s.customerName}）
          </strong>
          ：
          {s.shortages
            .map((x) => `${x.itemCode} ${x.itemName} があと${qty(x.shortBy)}${x.salesUnitName}`)
            .join("、")}
          足りません
        </li>
      ))}
    </ul>
  );
}

/** 外して続けるボタンの文言（在庫が足りない受注・受注日が発送日より後の受注） */
function continueLabel(check: BulkCheck): string {
  const n = check.shippable.length;
  const reasons = [
    ...(check.short.length > 0 ? [`在庫が足りない ${check.short.length} 件`] : []),
    ...(check.tooEarly.length > 0 ? [`受注日が発送日より後の ${check.tooEarly.length} 件`] : []),
  ];
  return reasons.length > 0
    ? `${reasons.join("・")}を外して続ける（${n} 件を発送）`
    : `${n} 件を発送する`;
}

/**
 * 一括発送の確認。対象と件数を示し、在庫が足りない受注・受注日が発送日より後の受注は「外して続ける」か「中止」を選ぶ。
 * 発送日を変えると、その日で確かめ直す（受注日が発送日より後の受注が変わる）
 */
function ConfirmPanel(props: {
  check: BulkCheck;
  date: string;
  locationId: string;
  error?: DomainError | undefined;
}) {
  const { check } = props;
  const n = check.shippable.length;
  const today = toBusinessDate(new Date());
  const cancel = paths.shipping({ date: props.date, locationId: props.locationId });
  const all = [...check.shippable, ...check.short, ...check.tooEarly];
  const dateField = (
    <div
      hx-post={paths.shippingBulkConfirm()}
      hx-trigger="change"
      hx-target="closest .confirm-panel"
      hx-swap="outerHTML"
    >
      <Field
        label="発送日"
        name="shippedOn"
        required
        hint="変えると、その日で発送できるか確かめ直します（受注日より前の日には発送できません）"
      >
        <Input name="shippedOn" type="date" value={check.shippedOn} max={today} />
      </Field>
    </div>
  );
  return (
    <div class="card confirm-panel" role="region" aria-label="一括発送の確認">
      <h2>一括発送の確認</h2>
      {props.error ? (
        <ErrorSummary
          error={
            props.error.code === "insufficient_stock"
              ? {
                  code: props.error.code,
                  message: "在庫が変わったため、発送できない受注があります。もう一度選んでください",
                }
              : props.error
          }
        />
      ) : null}
      {check.short.length > 0 ? (
        <Alert kind="warning">
          <strong>在庫が足りない受注が {check.short.length} 件あります。</strong>
          <ShortageList check={check} />
        </Alert>
      ) : null}
      {check.tooEarly.length > 0 ? (
        <Alert kind="warning">
          <strong>
            受注日が発送日（{check.shippedOn}）より後の受注が {check.tooEarly.length}{" "}
            件あります。この発送日では発送できません。
          </strong>
          <ul class="shortage-list">
            {check.tooEarly.map((o) => (
              <li>
                {o.number}（{o.customerName}）：受注日 {o.orderedOn}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}
      {check.ineligibleIds.length > 0 ? (
        <Alert kind="info">
          発送済み・取消などで対象外の受注が {check.ineligibleIds.length} 件あります（除きます）。
        </Alert>
      ) : null}
      <form
        method="post"
        action={paths.shippingBulkShip()}
        hx-post={paths.shippingBulkShip()}
        hx-target="#shipping-results"
        hx-swap="outerHTML"
      >
        <FormKey />
        <input type="hidden" name="date" value={props.date} />
        <input type="hidden" name="locationId" value={props.locationId} />
        {all.map((o) => (
          <>
            <input type="hidden" name="orderId" value={o.id} />
            <input type="hidden" name="orderVersion" value={String(o.version)} />
          </>
        ))}
        {check.short.map((o) => (
          <input type="hidden" name="excludeId" value={o.id} />
        ))}
        {check.tooEarly.map((o) => (
          <input type="hidden" name="excludeEarlyId" value={o.id} />
        ))}
        {n === 0 ? (
          <>
            <p>この発送日で発送できる受注がありません。</p>
            {check.tooEarly.length > 0 ? dateField : null}
            <a class="btn btn-secondary btn-lg" href={cancel}>
              中止
            </a>
          </>
        ) : (
          <>
            <p class="confirm-count">
              <strong>{n} 件</strong>
              の受注を発送します。引当を外して在庫を減らし、納品書を発行します。
            </p>
            <p class="small">
              {check.shippable.map((o) => `${o.number}（${o.customerName}）`).join("、")}
            </p>
            {dateField}
            <div class="form-actions">
              <button type="submit" class="btn btn-primary btn-lg">
                {continueLabel(check)}
              </button>
              <a class="btn btn-secondary btn-lg" href={cancel}>
                中止
              </a>
            </div>
          </>
        )}
      </form>
    </div>
  );
}

function DeliveryNotesButton(props: {
  shipmentIds: readonly string[];
  name: string;
  label: string;
}) {
  if (props.shipmentIds.length === 0) return null;
  return (
    <form method="post" action={paths.shippingDeliveryNotes()} class="inline">
      <FormKey />
      <input type="hidden" name="name" value={props.name} />
      {props.shipmentIds.map((id) => (
        <input type="hidden" name="shipmentId" value={id} />
      ))}
      <button type="submit" class="btn btn-secondary btn-lg">
        {props.label}
      </button>
    </form>
  );
}

function ShippedPanel(props: {
  shipped: readonly ShipResult[];
  /** 外した受注の件数（在庫が足りない・受注日が発送日より後） */
  excluded: { short: number; tooEarly: number };
  name: string;
}) {
  const reasons = [
    ...(props.excluded.short > 0 ? [`在庫が足りない ${props.excluded.short} 件`] : []),
    ...(props.excluded.tooEarly > 0
      ? [`受注日が発送日より後の ${props.excluded.tooEarly} 件`]
      : []),
  ];
  return (
    <div class="card" role="status">
      <Alert kind="success">
        {props.shipped.length} 件を発送しました
        {reasons.length > 0 ? `（${reasons.join("・")}は外しました）` : ""}。納品書：
        {props.shipped.map((s) => s.deliveryNoteNumber).join("、")}
      </Alert>
      <DeliveryNotesButton
        shipmentIds={props.shipped.map((s) => s.shipmentId)}
        name={props.name}
        label={`発送した ${props.shipped.length} 件の納品書を一括で PDF にする`}
      />
    </div>
  );
}

function notesName(list: { date: string; locationName: string }): string {
  return `納品書_${list.date}_${list.locationName}`.slice(0, 100);
}

function Results(props: {
  date: string;
  locationId: string;
  list: ShippingList | null;
  error: string | null;
  canShip: boolean;
  panel?: Child;
}) {
  const { list } = props;
  return (
    <section id="shipping-results">
      <OfflineSnapshot scope={paths.shipping()} loadedAt={new Date()} />
      {props.error ? <Alert kind="error">{props.error}</Alert> : null}
      {props.panel ?? null}
      {!props.locationId ? (
        <EmptyState message="保管場所を選んでください" />
      ) : !list ? null : (
        <>
          <div class="toolbar">
            <p class="shipping-summary">
              {jaDate(list.date)}までの出荷予定・{list.locationName}：受注 {list.orders.length}{" "}
              件・販売先 {list.customers.length} 件
              {list.shippedShipmentIds.length > 0
                ? `（発送済み ${list.shippedShipmentIds.length} 件）`
                : ""}
              {list.overdueOrders.length > 0 ? (
                <>
                  {" "}
                  <Badge kind="danger">遅れ {list.overdueOrders.length} 件</Badge>
                </>
              ) : null}
            </p>
            <a
              class="btn btn-secondary btn-lg"
              href={paths.shippingPrint({ date: list.date, locationId: list.locationId })}
              target="_blank"
              rel="noopener"
            >
              印刷（A4 横）
            </a>
            <a
              class="btn btn-secondary btn-lg"
              href={paths.shippingSorting({ date: list.date, locationId: list.locationId })}
              target="_blank"
              rel="noopener"
            >
              仕分けリスト
            </a>
            <DeliveryNotesButton
              shipmentIds={list.shippedShipmentIds}
              name={notesName(list)}
              label={`発送済みの納品書を一括 PDF（${list.shippedShipmentIds.length} 件）`}
            />
          </div>
          {list.orders.length === 0 ? (
            <EmptyState message="この日までに発送する受注はありません" />
          ) : (
            <>
              <OverdueSummary list={list} />
              <Matrix list={list} />
              <h2>一括発送</h2>
              {props.canShip ? (
                <>
                  <BulkForm list={list} />
                  <div id="bulk-panel" aria-live="polite"></div>
                </>
              ) : (
                <p class="muted">発送する権限がありません。</p>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

function ShippingPage(props: {
  c: Context<AppEnv>;
  date: string;
  locationId: string;
  locations: readonly Option[];
  results: Child;
}) {
  return (
    <Layout title="発送リスト" actor={props.c.get("actor")} current={paths.shipping()} touch>
      <PageHeader title="発送リスト" />
      <form
        class="filters"
        method="get"
        action={paths.shipping()}
        hx-get={paths.shipping()}
        hx-target="#shipping-results"
        hx-select="#shipping-results"
        hx-swap="outerHTML"
        hx-push-url="true"
        hx-trigger="change"
      >
        <Field
          label="出荷予定日"
          name="date"
          hint="この日までに出荷予定日が来た未発送の受注を出します（過ぎたものは「遅れ」）"
        >
          <Input name="date" type="date" value={props.date} />
        </Field>
        <Field label="保管場所" name="locationId">
          <Select
            name="locationId"
            value={props.locationId}
            options={props.locations}
            empty="選んでください"
          />
        </Field>
        <noscript>
          <button type="submit" class="btn btn-secondary">
            表示
          </button>
        </noscript>
      </form>
      {props.results}
    </Layout>
  );
}

shippingRoutes.get("/", async (c) => {
  const locations = await locationOptions(c);
  const { date, locationId } = conditionFrom((n) => c.req.query(n) ?? "", locations);
  const { list, error } = await loadList(c, date, locationId);
  const canShip = hasPermission(c.get("actor").roles, "shipments.manage");
  return c.html(
    <ShippingPage
      c={c}
      date={date}
      locationId={locationId}
      locations={locations}
      results={
        <Results date={date} locationId={locationId} list={list} error={error} canShip={canShip} />
      }
    />,
  );
});

/**
 * 一括発送の確認（部分 HTML）。選んだ受注のうち在庫が足りないものと、受注日が発送日より後のものを示す。
 * 発送日は確認の画面で変えたもの（初めは今日）
 */
shippingRoutes.post("/bulk/confirm", async (c) => {
  const form = await readForm(c);
  const orderIds = strs(form, "orderId");
  if (orderIds.length === 0)
    return c.html(<Alert kind="warning">発送する受注を選んでください。</Alert>);
  const check = await queryAs(c.env, c.get("actorRef"), "shipping.check", {
    orderIds,
    shippedOn: str(form, "shippedOn"),
  });
  if (!check.ok) return c.html(<Alert kind="error">{check.error.message}</Alert>);
  return c.html(
    <ConfirmPanel
      check={check.value}
      date={str(form, "date")}
      locationId={str(form, "locationId")}
    />,
  );
});

function versionsFrom(form: FormData_) {
  const versions = strs(form, "orderVersion");
  return strs(form, "orderId").map((id, i) => ({ id, version: Number(versions[i] ?? "0") || 0 }));
}

/** 一括発送の実行（1つのトランザクション）。結果と、発送した受注の納品書の一括 PDF のボタンを返す */
shippingRoutes.post("/bulk/ship", async (c) => {
  const form = await readForm(c);
  const date = str(form, "date");
  const locationId = str(form, "locationId");
  const orders = versionsFrom(form);
  const short = strs(form, "excludeId");
  const early = strs(form, "excludeEarlyId");
  const shippedOn = str(form, "shippedOn");
  const result = await runCommand(
    c,
    "shipments.bulkShip",
    { orders, exclude: [...short, ...early], shippedOn },
    formKey(form),
  );
  const canShip = hasPermission(c.get("actor").roles, "shipments.manage");
  const { list, error } = await loadList(c, date, locationId);
  let panel: Child;
  if (result.ok) {
    panel = (
      <ShippedPanel
        shipped={result.value.shipped}
        excluded={{ short: short.length, tooEarly: early.length }}
        name={notesName({ date, locationName: list?.locationName ?? "" })}
      />
    );
  } else {
    const check = await queryAs(c.env, c.get("actorRef"), "shipping.check", {
      orderIds: orders.map((o) => o.id),
      shippedOn,
    });
    panel = check.ok ? (
      <ConfirmPanel check={check.value} date={date} locationId={locationId} error={result.error} />
    ) : (
      <ErrorSummary error={result.error} />
    );
  }
  const results = (
    <Results
      date={date}
      locationId={locationId}
      list={list}
      error={error}
      canShip={canShip}
      panel={panel}
    />
  );
  if (isHtmx(c)) return c.html(results, result.ok ? 200 : 422);
  const locations = await locationOptions(c);
  return c.html(
    <ShippingPage
      c={c}
      date={date}
      locationId={locationId}
      locations={locations}
      results={results}
    />,
    result.ok ? 200 : 422,
  );
});

/** 発送した受注の納品書を1つの PDF にまとめる（非同期）。処理状況の画面へ移る */
shippingRoutes.post("/delivery-notes", async (c) => {
  const form = await readForm(c);
  const result = await runCommand(
    c,
    "deliveryNotes.bulkPdf",
    { shipmentIds: strs(form, "shipmentId"), name: str(form, "name") },
    formKey(form),
  );
  if (result.ok) return redirectTo(c, paths.jobs({ notice: "bulk" }));
  return c.html(
    <Layout title="納品書の一括 PDF" actor={c.get("actor")} current={paths.shipping()} touch>
      <Alert kind="error">{result.error.message}</Alert>
      <a href={paths.shipping()}>発送リストに戻る</a>
    </Layout>,
    422,
  );
});

// ---- 印刷用の HTML ----------------------------------------------------------------

/** 印刷用のページ（public/assets/print.css。画面の CSP のままで、埋め込みのスタイルやスクリプトは使わない） */
function PrintLayout(props: { title: string; back: string; children: Child; portrait?: boolean }) {
  return (
    <HtmlDocument>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex,nofollow" />
        <title>{props.title}</title>
        <link rel="stylesheet" href="/assets/print.css" />
        <script src="/assets/print.js" defer></script>
      </head>
      <body class={props.portrait ? "print portrait" : "print landscape"}>
        <div class="print-toolbar">
          <button type="button" class="print-button" data-print>
            印刷する
          </button>
          <a href={props.back}>発送リストに戻る</a>
          <span>{props.portrait ? "A4 縦" : "A4 横"}で印刷します。</span>
        </div>
        {props.children}
      </body>
    </HtmlDocument>
  );
}

async function printData(c: Context<AppEnv>) {
  const locations = await locationOptions(c);
  const { date, locationId } = conditionFrom((n) => c.req.query(n) ?? "", locations);
  const { list, error } = await loadList(c, date, locationId);
  return { date, locationId, list, error, back: paths.shipping({ date, locationId }) };
}

shippingRoutes.get("/print", async (c) => {
  const { list, error, back } = await printData(c);
  if (!list) return c.text(error ?? "保管場所を選んでください", 400);
  const pages = chunk(
    list.customers.map((cu, i) => ({ cu, i })),
    PRINT_COLUMNS,
  );
  const m = list.matrix;
  const total = pages.length;
  return c.html(
    <PrintLayout title={`発送リスト ${list.date} ${list.locationName}`} back={back}>
      {total === 0 ? (
        <section class="print-page">
          <h1>発送リスト</h1>
          <p>
            出荷予定日 {jaDate(list.date)}まで・{list.locationName}
            ：この日までに発送する受注はありません。
          </p>
        </section>
      ) : (
        pages.map((cols, p) => (
          <section class="print-page">
            <header class="print-header">
              <h1>発送リスト</h1>
              <p>
                出荷予定日 {jaDate(list.date)}まで　保管場所 {list.locationName}　{p + 1} / {total}
                ページ
              </p>
              {list.overdueOrders.length > 0 ? (
                <p class="overdue">
                  【遅れ】出荷予定日を過ぎた受注 {list.overdueOrders.length} 件を含みます：
                  {list.overdueOrders
                    .map((o) => `${o.number}（${o.customerName}、出荷予定日 ${o.shipPlannedOn}）`)
                    .join("、")}
                </p>
              ) : null}
            </header>
            <table class="print-table">
              <thead>
                <tr>
                  <th class="item">商品</th>
                  {cols.map(({ cu }) => (
                    <th class={cu.overdue ? "qty overdue" : "qty"}>
                      {cu.overdue ? "【遅れ】" : ""}
                      {cu.name}
                    </th>
                  ))}
                  <th class="qty total">合計</th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((item, r) => (
                  <tr>
                    <th class="item">
                      {item.code} {item.name}
                    </th>
                    {cols.map(({ i }) => {
                      const n = m.quantities[r]?.[i] ?? 0;
                      return <td class="qty">{n === 0 ? "" : qty(n)}</td>;
                    })}
                    <td class="qty total">
                      {qty(m.rowTotals[r] ?? 0)}
                      {item.salesUnitName}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th class="item">合計</th>
                  {cols.map(({ i }) => (
                    <td class="qty">{qty(m.columnTotals[i] ?? 0)}</td>
                  ))}
                  <td class="qty total">{qty(m.grandTotal)}</td>
                </tr>
              </tfoot>
            </table>
          </section>
        ))
      )}
    </PrintLayout>,
  );
});

/** 販売先ごとの仕分けリスト（1販売先1枚、A4 縦） */
shippingRoutes.get("/sorting", async (c) => {
  const { list, error, back } = await printData(c);
  if (!list) return c.text(error ?? "保管場所を選んでください", 400);
  const m = list.matrix;
  return c.html(
    <PrintLayout title={`仕分けリスト ${list.date} ${list.locationName}`} back={back} portrait>
      {list.customers.length === 0 ? (
        <section class="print-page">
          <h1>仕分けリスト</h1>
          <p>
            出荷予定日 {jaDate(list.date)}まで・{list.locationName}
            ：この日までに発送する受注はありません。
          </p>
        </section>
      ) : (
        list.customers.map((cu, col) => (
          <section class="print-page">
            <header class="print-header">
              <h1>仕分けリスト</h1>
              <p class="customer">
                {cu.name} {cu.honorific}
              </p>
              <p>
                出荷予定日 {jaDate(list.date)}まで　保管場所 {list.locationName}　受注{" "}
                {cu.orders
                  .map((o) =>
                    o.overdue ? `${o.number}【遅れ：出荷予定日 ${o.shipPlannedOn}】` : o.number,
                  )
                  .join("・")}
              </p>
            </header>
            <table class="print-table sorting">
              <thead>
                <tr>
                  <th class="check">確認</th>
                  <th>商品コード</th>
                  <th class="item">商品名</th>
                  <th class="qty">数量</th>
                </tr>
              </thead>
              <tbody>
                {list.items.flatMap((item, r) => {
                  const n = m.quantities[r]?.[col] ?? 0;
                  return n === 0
                    ? []
                    : [
                        <tr>
                          <td class="check">□</td>
                          <td>{item.code}</td>
                          <td class="item">{item.name}</td>
                          <td class="qty">
                            {qty(n)}
                            {item.salesUnitName}
                          </td>
                        </tr>,
                      ];
                })}
              </tbody>
              <tfoot>
                <tr>
                  <th colspan={3}>合計</th>
                  <td class="qty">{qty(m.columnTotals[col] ?? 0)}</td>
                </tr>
              </tfoot>
            </table>
            {cu.orders.some((o) => o.memo) ? (
              <p class="memo">
                {cu.orders.flatMap((o) => (o.memo ? [`${o.number}：${o.memo}`] : [])).join(" ／ ")}
              </p>
            ) : null}
          </section>
        ))
      )}
    </PrintLayout>,
  );
});
