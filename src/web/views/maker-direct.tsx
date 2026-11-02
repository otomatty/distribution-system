/**
 * メーカー直の受注からの発注（要件定義書 3.8 Should）の画面の部品。
 * 受注詳細の「メーカー直の発注」の欄と、発注の作成画面の説明・仕入先の選択。値はユースケースの結果を表示するだけ。
 */
import type { MakerDirectDraft, MakerDirectPlan } from "../../usecases/purchasing/maker-direct";
import { paths } from "../paths";
import { Alert, Badge, EmptyState } from "./components";
import { qty, yen } from "./format";
import { OrderStatusBadge } from "./purchasing";

/** 受注詳細の欄：受注から作った発注（両方向のリンク）と、仕入先ごとの「発注を作る」 */
export function MakerDirectOrders(props: { plan: MakerDirectPlan }) {
  const { plan } = props;
  return (
    <section class="card" id="so-maker-direct">
      <h2>メーカー直の発注</h2>
      <p class="hint">
        仕入先から販売先へ直接届けてもらう受注です。発注書は仕入先ごとに1枚で、納入先はこの販売先、
        数量は販売単位から仕入単位に換算します（端数は切り上げ）。
      </p>
      {plan.orders.length === 0 ? (
        <p class="muted">この受注から作った発注はまだありません。</p>
      ) : (
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>発注番号</th>
                <th>仕入先</th>
                <th>状態</th>
                <th>発注日</th>
                <th class="num">合計（税込）</th>
              </tr>
            </thead>
            <tbody>
              {plan.orders.map((o) => (
                <tr class={o.status === "cancelled" ? "row-muted" : undefined}>
                  <td class="nowrap">
                    <a href={paths.purchaseOrder(o.id)}>{o.number}</a>
                  </td>
                  <td>{o.supplierName}</td>
                  <td>
                    <OrderStatusBadge status={o.status} />
                  </td>
                  <td class="nowrap">{o.orderedOn}</td>
                  <td class="num">{yen(o.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {plan.blockedReason ? <p class="muted">{plan.blockedReason}</p> : null}
      {plan.canCreate ? <SupplierActions plan={plan} /> : null}
    </section>
  );
}

function SupplierActions(props: { plan: MakerDirectPlan }) {
  const { plan } = props;
  if (plan.suppliers.length === 0) return <p class="muted">明細に商品がありません。</p>;
  return (
    <ul class="maker-direct-suppliers">
      {plan.suppliers.map((s) => (
        <li>
          <span>
            <strong>{s.supplierName}</strong>（{qty(s.lineCount)}品目）
          </span>{" "}
          {s.activeOrder ? (
            <span class="muted small">
              発注済み：<a href={paths.purchaseOrder(s.activeOrder.id)}>{s.activeOrder.number}</a>
            </span>
          ) : (
            <a
              class="btn btn-secondary"
              href={paths.purchaseOrderNew({
                salesOrderId: plan.salesOrderId,
                supplierId: s.supplierId,
              })}
            >
              {s.supplierName}への発注を作る
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

/** 発注の作成画面で、受注の明細が複数の仕入先にまたがるときに仕入先を選ぶ */
export function MakerDirectSupplierChoice(props: { plan: MakerDirectPlan; number: string }) {
  const { plan } = props;
  const open = plan.suppliers.filter((s) => s.activeOrder === null);
  return (
    <section class="card">
      <h2>仕入先を選ぶ</h2>
      <p>
        受注 <a href={paths.salesOrder(plan.salesOrderId)}>{props.number}</a> の商品は
        {plan.suppliers.length > 1 ? "複数の仕入先にまたがっています" : "次の仕入先の商品です"}
        。発注書は仕入先ごとに1枚なので、仕入先を選んでください。選んだ仕入先の商品だけを明細に入れます。
      </p>
      {plan.blockedReason ? <Alert kind="warning">{plan.blockedReason}</Alert> : null}
      {open.length === 0 && !plan.blockedReason ? (
        <EmptyState message="どの仕入先にも、すでに発注を作っています" />
      ) : null}
      {plan.canCreate ? <SupplierActions plan={plan} /> : null}
    </section>
  );
}

/** 発注の作成画面の説明：どの受注から作るかと、数量の換算 */
export function MakerDirectDraftNote(props: { draft: MakerDirectDraft }) {
  const { draft } = props;
  return (
    <Alert kind="info">
      <p>
        受注 <a href={paths.salesOrder(draft.salesOrderId)}>{draft.salesOrderNumber}</a>（
        {draft.customerName}）のメーカー直の発注を作ります。納入先は{draft.customerName}
        です。数量は販売単位から仕入単位に換算しました（端数は切り上げ）。
      </p>
      <ul>
        {draft.lines.map((l) => (
          <li>
            {l.itemName}：受注 {qty(l.salesQuantity)}
            {l.salesUnitName} → 発注 {qty(l.quantity)}
            {l.purchaseUnitName}（{qty(l.orderedUnits)}
            {l.salesUnitName}）
            {l.surplusUnits > 0 ? (
              <>
                {" "}
                <Badge kind="warning">
                  {qty(l.surplusUnits)}
                  {l.salesUnitName}多い
                </Badge>
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </Alert>
  );
}
