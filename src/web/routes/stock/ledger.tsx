/** 在庫明細（要件定義書 3.4）：商品ごとの台帳。期間・保管場所・理由で絞り込み、各行の後の残高を出す */
import { Hono } from "hono";

import { addDays, toBusinessDate } from "../../../domain/dates";
import { isStockReason, STOCK_REASONS, STOCK_SOURCE_LABELS } from "../../../domain/stock";
import type { LedgerListRow } from "../../../usecases/stock/ledger.port";
import { hasPermission } from "../../middleware";
import { paths } from "../../paths";
import type { AppEnv } from "../../types";
import { runQuery } from "../../usecase";
import {
  Badge,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Pagination,
  Select,
} from "../../views/components";
import { dateTime, qty } from "../../views/format";
import { Layout } from "../../views/layout";
import { signedQty } from "../../views/stock";

export const stockLedgerRoutes = new Hono<AppEnv>();

const REASON_OPTIONS = Object.entries(STOCK_REASONS).map(([value, label]) => ({ value, label }));

function SourceCell(props: { row: LedgerListRow }) {
  const r = props.row;
  const label = STOCK_SOURCE_LABELS[r.sourceType];
  if (r.sourceType === "stock_operation")
    return (
      <a href={paths.stockOperation(r.sourceId)}>
        {label} {r.sourceNumber ?? ""}
      </a>
    );
  return <span>{label}</span>;
}

// 商品の ID は ULID（"operations" などのほかの画面の URL と重ならない）
stockLedgerRoutes.get("/:itemId{[0-9A-Z]{26}}", async (c) => {
  const itemId = c.req.param("itemId");
  const today = toBusinessDate(new Date());
  // 期間の初期値は直近の3か月
  const from = c.req.query("from") ?? addDays(today, -90);
  const to = c.req.query("to") ?? "";
  const locationId = c.req.query("locationId") ?? "";
  const reasonParam = c.req.query("reason") ?? "";
  const reason = isStockReason(reasonParam) ? reasonParam : undefined;
  const page = Math.max(1, Number(c.req.query("page") ?? "1") || 1);
  const summary = await runQuery(c, "stock.item", { itemId });
  if (!summary) return c.notFound();
  const [ledger, locations] = await Promise.all([
    runQuery(c, "stock.ledger", {
      itemId,
      locationId: locationId || undefined,
      reason,
      from,
      to,
      page,
      pageSize: 100,
    }),
    runQuery(c, "locations.options", {}),
  ]);
  const { item } = summary;
  const query = { from, to, locationId, reason };
  const href = (p: number) => paths.stockItem(itemId, { ...query, page: p });
  const canManage = hasPermission(c.get("actor").roles, "stock.manage");
  const unit = item.salesUnitName;
  return c.html(
    <Layout title={`在庫明細：${item.name}`} actor={c.get("actor")} current={paths.stock()}>
      <PageHeader
        title={`在庫明細：${item.name}`}
        actions={
          <>
            <a class="btn btn-secondary" href={paths.item(item.id)}>
              商品の情報
            </a>
            {canManage ? (
              <a class="btn btn-primary" href={paths.stockOperationNew()}>
                在庫操作
              </a>
            ) : null}
          </>
        }
      >
        <p>
          <span class="muted">商品コード</span> {item.code}　<span class="muted">単位</span> {unit}{" "}
          {summary.belowReorderPoint ? <Badge kind="warning">発注点割れ</Badge> : null}
          {item.discontinued ? <Badge>取扱終了</Badge> : null}
        </p>
      </PageHeader>
      <section class="card">
        <h2>保管場所ごとの在庫</h2>
        {summary.locations.length === 0 ? (
          <p class="muted">在庫の記録はまだありません。</p>
        ) : (
          <table class="table">
            <thead>
              <tr>
                <th>保管場所</th>
                <th class="num">現在庫</th>
                <th class="num">引当数</th>
                <th class="num">出荷可能数</th>
                <th class="num">入荷予定数</th>
              </tr>
            </thead>
            <tbody>
              {summary.locations.map((l) => (
                <tr>
                  <td>{l.locationName}</td>
                  <td class="num">{qty(l.onHand)}</td>
                  <td class="num">{qty(l.allocated)}</td>
                  <td class={l.available < 0 ? "num text-danger" : "num"}>{qty(l.available)}</td>
                  <td class="num">{l.incoming > 0 ? qty(l.incoming) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {item.reorderEnabled ? (
          <p class="hint">
            発注点在庫数：{qty(item.reorderPoint)}
            {unit}
          </p>
        ) : null}
      </section>
      <h2>台帳</h2>
      <form
        class="filters"
        method="get"
        action={paths.stockItem(itemId)}
        hx-get={paths.stockItem(itemId)}
        hx-target="#results"
        hx-select="#results"
        hx-swap="outerHTML"
        hx-push-url="true"
        hx-trigger="change"
      >
        <Field label="期間（から）" name="from">
          <Input name="from" type="date" value={from} />
        </Field>
        <Field label="期間（まで）" name="to">
          <Input name="to" type="date" value={to} />
        </Field>
        <Field label="保管場所" name="locationId">
          <Select
            name="locationId"
            value={locationId}
            options={locations.map((l) => ({ value: l.id, label: l.name }))}
            empty="すべて"
          />
        </Field>
        <Field label="理由" name="reason">
          <Select name="reason" value={reason ?? ""} options={REASON_OPTIONS} empty="すべて" />
        </Field>
        <noscript>
          <button type="submit" class="btn btn-secondary">
            表示
          </button>
        </noscript>
      </form>
      <section id="results">
        <p class="muted">
          {locationId ? "残高はこの保管場所の在庫数" : "残高はすべての保管場所の合計"}
          です。打ち消しの行は、誤りを直すために元の行と逆の数を記録したものです。
        </p>
        {ledger.rows.rows.length === 0 ? (
          <EmptyState message="この期間の記録はありません" />
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>業務日</th>
                  <th>保管場所</th>
                  <th>理由</th>
                  <th class="num">増減</th>
                  <th class="num">残高</th>
                  <th>発生元</th>
                  <th>記録</th>
                  <th>メモ</th>
                </tr>
              </thead>
              <tbody>
                {from ? (
                  <tr>
                    <td>{from} より前</td>
                    <td colspan={3} class="muted">
                      期間の前の残高
                    </td>
                    <td class="num">{qty(ledger.opening)}</td>
                    <td colspan={3} />
                  </tr>
                ) : null}
                {ledger.rows.rows.map((r) => (
                  <tr class={r.reversed ? "muted" : undefined}>
                    <td class="nowrap">{r.businessDate}</td>
                    <td>{r.locationName}</td>
                    <td>
                      {STOCK_REASONS[r.reason]}{" "}
                      {r.reversesId ? <Badge kind="warning">打ち消し</Badge> : null}
                      {r.reversed ? <Badge>打ち消し済み</Badge> : null}
                    </td>
                    <td class="num">{signedQty(r.quantity)}</td>
                    <td class="num">{qty(r.balance)}</td>
                    <td>
                      <SourceCell row={r} />
                    </td>
                    <td class="small">
                      {dateTime(r.occurredAt)}
                      <div class="muted">{r.createdByName ?? ""}</div>
                    </td>
                    <td class="small">{r.memo ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination
          page={ledger.rows.page}
          pageSize={ledger.rows.pageSize}
          total={ledger.rows.total}
          href={href}
        />
      </section>
    </Layout>,
  );
});
