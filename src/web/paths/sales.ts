import { enc, withQuery, type Query } from "./query";

/** 受注・発送の画面 */
export const salesPaths = {
  salesOrders: (query?: Query) => withQuery("/sales-orders", query),
  /** 受注一覧の CSV（POST。一覧と同じ絞り込みの条件） */
  salesOrdersCsv: () => "/sales-orders/csv",
  salesOrderNew: () => "/sales-orders/new",
  salesOrder: (id: string, query?: Query) => withQuery(`/sales-orders/${enc(id)}`, query),
  salesOrderEdit: (id: string) => `/sales-orders/${enc(id)}/edit`,
  salesOrderShip: (id: string) => `/sales-orders/${enc(id)}/ship`,
  salesOrderCancel: (id: string) => `/sales-orders/${enc(id)}/cancel`,
  salesOrderSplit: (id: string) => `/sales-orders/${enc(id)}/split`,
  /** 受注の作成・編集の画面の部分 HTML：商品選択ダイアログから明細の行を追加する */
  salesOrderLines: () => "/sales-orders/form/lines",
  /** 受注の作成・編集の画面の部分 HTML：変わった行と合計欄を計算し直す */
  salesOrderRecalc: () => "/sales-orders/form/recalc",
  /** 受注の作成・編集の画面の部分 HTML：送料などの行を足す */
  salesOrderChargeRow: () => "/sales-orders/form/charge",
  /** 受注の作成・編集の画面の部分 HTML：出荷予定日の初期値（販売先・納品希望日から） */
  salesOrderShipDate: () => "/sales-orders/form/ship-date",
  shipmentCancel: (id: string) => `/shipments/${enc(id)}/cancel`,

  shipping: (query?: Query) => withQuery("/shipping", query),
  /** 発送リストの印刷用の HTML（A4 横） */
  shippingPrint: (query?: Query) => withQuery("/shipping/print", query),
  /** 販売先ごとの仕分けリストの印刷用の HTML（1販売先1枚） */
  shippingSorting: (query?: Query) => withQuery("/shipping/sorting", query),
  /** 一括発送の確認（部分 HTML） */
  shippingBulkConfirm: () => "/shipping/bulk/confirm",
  /** 一括発送の実行 */
  shippingBulkShip: () => "/shipping/bulk/ship",
  /** 発送した受注の納品書の一括 PDF */
  shippingDeliveryNotes: () => "/shipping/delivery-notes",
};
