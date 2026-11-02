/**
 * 一覧の CSV 出力の定義と、件数による同期・非同期の切り替え（要件定義書 3.13）。
 *
 * 一覧に CSV 出力を付ける手順：
 * 1. 下の csvExports に定義を1つ足す（名前 → { fileName, fetch, columns }）。
 *    fetch は一覧と同じ照会（rows と total を返すもの）を、渡された絞り込み条件とページで呼ぶ。
 *    columns の header は日本語の列名、value は1行分の値（表示用の整形だけ。金額の計算はしない）
 * 2. 一覧の #results の中に <CsvButton action={paths.xxxCsv()} filters={今の絞り込み条件} /> を置く
 *    （views/csv-button.tsx。絞り込みを変えると #results と一緒に描き直されるので、条件がずれない）
 * 3. POST のルートで exportCsv(c, "名前", 絞り込み条件, formKey(form)) を返す
 *
 * exportCsv は件数を数え、CSV_ASYNC_THRESHOLD 件以下ならその場で CSV を返す。
 * それより多ければ export_csv の処理（infra/queue/jobs/export-csv.ts）を登録して処理状況（/jobs）へ移る。
 * 処理は依頼した社員の権限で同じ照会をページごとに呼び、R2 の jobs/<処理 ID>/ に CSV を保存する。
 */
import type { Context } from "hono";

import { PAYMENT_METHOD_LABELS } from "../domain/billing";
import { toBusinessDate } from "../domain/dates";
import {
  DOCUMENT_TYPE_LABELS,
  RENDER_STATUS_LABELS,
  SEND_STATUS_LABELS,
} from "../domain/documents";
import { formatRate } from "../domain/money";
import {
  DESTINATION_LABELS,
  PURCHASE_ORDER_STATUS_LABELS,
  SUPPLIER_INVOICE_STATUS_LABELS,
} from "../domain/purchasing";
import { REPORT_AXIS_LABELS, REPORT_MEASURE_LABELS } from "../domain/reports";
import type { Result } from "../domain/result";
import { INVOICE_STATUS_LABELS, SALES_ORDER_STATUS_LABELS } from "../domain/sales";
import type { ActorRef } from "../infra/do/actor-ref";
import type { QueryInput, QueryName, QueryOutput } from "../usecases/registry";
import { csvResponse, type CsvValue } from "./csv";
import { redirectTo } from "./http";
import { paths } from "./paths";
import type { AppEnv } from "./types";
import { queryAs, runCommand } from "./usecase";
import { dateTime } from "./views/format";
import { destinationText } from "./views/purchasing";

/** これより多い件数の CSV は非同期で作る */
export const CSV_ASYNC_THRESHOLD = 2000;
/** 1回の照会で読む件数（pageInput の上限） */
export const CSV_PAGE_SIZE = 200;
/** 非同期でも、これより多い件数は出さない（ファイルが大きくなりすぎないように） */
export const CSV_MAX_ROWS = 200_000;

export type CsvFilter = Readonly<Record<string, unknown>>;

type QueryFn = <N extends QueryName>(
  name: N,
  input: QueryInput<N> | CsvFilter,
) => Promise<Result<QueryOutput<N>>>;

export interface CsvColumn<R> {
  readonly header: string;
  value(row: R): CsvValue;
}

export interface CsvPage {
  readonly rows: CsvValue[][];
  readonly total: number;
}

export interface CsvExport {
  /** ダウンロードするときのファイル名（拡張子と日付は付けない） */
  readonly fileName: string;
  readonly header: readonly string[];
  /** 絞り込み条件の1ページ分を CSV の行にする */
  page(
    env: Env,
    actorRef: ActorRef,
    filter: CsvFilter,
    page: number,
    pageSize: number,
  ): Promise<Result<CsvPage>>;
}

export function defineCsvExport<R>(def: {
  readonly fileName: string;
  /** 一覧と同じ照会を呼ぶ（例：(q, filter, page, pageSize) => q("documents.search", { ...filter, page, pageSize })） */
  readonly fetch: (
    query: QueryFn,
    filter: CsvFilter,
    page: number,
    pageSize: number,
  ) => Promise<Result<{ readonly rows: readonly R[]; readonly total: number }>>;
  readonly columns: readonly CsvColumn<R>[];
}): CsvExport {
  return {
    fileName: def.fileName,
    header: def.columns.map((col) => col.header),
    async page(env, actorRef, filter, page, pageSize) {
      const query: QueryFn = (name, input) => queryAs(env, actorRef, name, input);
      const result = await def.fetch(query, filter, page, pageSize);
      if (!result.ok) return result;
      return {
        ok: true,
        value: {
          rows: result.value.rows.map((row) => def.columns.map((col) => col.value(row))),
          total: result.value.total,
        },
      };
    },
  };
}

/** CSV 出力の一覧。名前は処理の内容（payload）に入るので、変えないようにする */
export const csvExports = {
  documents: defineCsvExport({
    fileName: "帳票一覧",
    fetch: (q, filter, page, pageSize) => q("documents.search", { ...filter, page, pageSize }),
    columns: [
      { header: "種類", value: (d) => DOCUMENT_TYPE_LABELS[d.documentType] },
      { header: "番号", value: (d) => d.number },
      { header: "取引年月日", value: (d) => d.transactionDate },
      { header: "取引先", value: (d) => d.partnerName },
      { header: "金額（税込）", value: (d) => d.amount },
      { header: "取消", value: (d) => (d.cancelled ? "取消済み" : "") },
      { header: "PDF", value: (d) => RENDER_STATUS_LABELS[d.status] },
      {
        header: "最新の送付",
        value: (d) => (d.lastSendStatus ? SEND_STATUS_LABELS[d.lastSendStatus] : "未送付"),
      },
      { header: "発行日時", value: (d) => dateTime(d.createdAt) },
    ],
  }),
  salesOrders: defineCsvExport({
    fileName: "受注一覧",
    fetch: (q, filter, page, pageSize) => q("salesOrders.list", { ...filter, page, pageSize }),
    columns: [
      { header: "受注番号", value: (o) => o.number },
      { header: "状態", value: (o) => SALES_ORDER_STATUS_LABELS[o.status] },
      { header: "出荷可能数", value: (o) => (o.shortage ? "不足" : "") },
      { header: "受注日", value: (o) => o.orderedOn },
      { header: "納品希望日", value: (o) => o.deliveryRequestedOn },
      { header: "出荷予定日", value: (o) => o.shipPlannedOn },
      { header: "販売先", value: (o) => o.customerName },
      { header: "先方の担当者", value: (o) => o.customerContactName },
      { header: "出荷元", value: (o) => (o.makerDirect ? "メーカー直" : o.locationName) },
      { header: "社内の担当者", value: (o) => o.employeeName },
      { header: "明細数", value: (o) => o.lineCount },
      { header: "小計（税抜）", value: (o) => o.subtotal },
      { header: "合計（税込）", value: (o) => o.total },
      { header: "分割元", value: (o) => (o.splitFromId ? "分割" : "") },
      { header: "メモ", value: (o) => o.memo },
      { header: "取消の理由", value: (o) => o.cancelReason },
      { header: "登録日時", value: (o) => dateTime(o.createdAt) },
    ],
  }),
  purchaseOrders: defineCsvExport({
    fileName: "発注一覧",
    fetch: (q, filter, page, pageSize) => q("purchaseOrders.list", { ...filter, page, pageSize }),
    columns: [
      { header: "発注番号", value: (p) => p.number },
      { header: "状態", value: (p) => PURCHASE_ORDER_STATUS_LABELS[p.status] },
      { header: "発注日", value: (p) => p.orderedOn },
      { header: "仕入先", value: (p) => p.supplierName },
      { header: "納入先の区分", value: (p) => DESTINATION_LABELS[p.destinationKind] },
      { header: "納入先", value: (p) => destinationText(p) },
      { header: "納品希望日", value: (p) => p.deliveryRequestedOn },
      { header: "支払予定日", value: (p) => p.paymentDueOn },
      { header: "明細数", value: (p) => p.lineCount },
      { header: "小計（税抜）", value: (p) => p.subtotal },
      { header: "消費税", value: (p) => p.tax },
      { header: "合計（税込）", value: (p) => p.total },
      { header: "社内の担当者", value: (p) => p.employeeName },
      { header: "メモ", value: (p) => p.memo },
      { header: "取消の理由", value: (p) => p.cancelReason },
    ],
  }),
  supplierInvoices: defineCsvExport({
    fileName: "仕入先請求書一覧",
    fetch: (q, filter, page, pageSize) => q("supplierInvoices.list", { ...filter, page, pageSize }),
    columns: supplierInvoiceColumns(),
  }),
  payables: defineCsvExport({
    fileName: "支払予定一覧",
    fetch: (q, filter, page, pageSize) => q("payables.list", { ...filter, page, pageSize }),
    columns: supplierInvoiceColumns(),
  }),
  // ---- 請求・入金・販売先廃棄 ----
  invoices: defineCsvExport({
    fileName: "請求書一覧",
    fetch: (q, filter, page, pageSize) => q("invoices.list", { ...filter, page, pageSize }),
    columns: [
      { header: "請求書番号", value: (i) => i.number },
      { header: "状態", value: (i) => INVOICE_STATUS_LABELS[i.status] },
      { header: "期限超過", value: (i) => (i.overdue ? "超過" : "") },
      { header: "販売先", value: (i) => i.customerName },
      { header: "発行日", value: (i) => i.issuedOn },
      { header: "締め期間（から）", value: (i) => i.periodFrom },
      { header: "締め期間（まで）", value: (i) => i.periodTo },
      { header: "支払期限", value: (i) => i.dueOn },
      { header: "小計（税抜）", value: (i) => i.subtotal },
      { header: "消費税", value: (i) => i.tax },
      { header: "合計（税込）", value: (i) => i.total },
      { header: "消込済み", value: (i) => i.allocated },
      { header: "残高", value: (i) => (i.status === "cancelled" ? null : i.outstanding) },
      {
        header: "最新の送付",
        value: (i) =>
          i.document?.lastSendStatus ? SEND_STATUS_LABELS[i.document.lastSendStatus] : "未送付",
      },
      { header: "取消の理由", value: (i) => i.cancelReason },
      { header: "発行日時", value: (i) => dateTime(i.createdAt) },
    ],
  }),
  customerPayments: defineCsvExport({
    fileName: "入金一覧",
    fetch: (q, filter, page, pageSize) => q("customerPayments.list", { ...filter, page, pageSize }),
    columns: [
      { header: "入金日", value: (p) => p.receivedOn },
      { header: "販売先", value: (p) => p.customerName },
      { header: "方法", value: (p) => PAYMENT_METHOD_LABELS[p.method] },
      { header: "入金額", value: (p) => p.amount },
      { header: "消込済み", value: (p) => p.allocatedAmount },
      { header: "未消込", value: (p) => p.unallocated },
      { header: "取消", value: (p) => (p.cancelled ? "取消" : "") },
      { header: "メモ", value: (p) => p.memo },
      { header: "記録日時", value: (p) => dateTime(p.createdAt) },
    ],
  }),
  receivables: defineCsvExport({
    fileName: "売掛残高",
    fetch: (q, filter, page, pageSize) => q("receivables.balances", { ...filter, page, pageSize }),
    columns: [
      { header: "販売先", value: (r) => r.customerName },
      { header: "請求残高", value: (r) => r.billed },
      { header: "うち期限超過", value: (r) => r.overdue },
      { header: "未消込の入金", value: (r) => r.unallocated },
      { header: "売掛残高", value: (r) => r.balance },
      { header: "未入金の請求書", value: (r) => r.openCount },
      { header: "期限超過の請求書", value: (r) => r.overdueCount },
      { header: "次の支払期限", value: (r) => r.nextDueOn },
    ],
  }),
  receiptSchedule: defineCsvExport({
    fileName: "入金予定",
    fetch: (q, filter, page, pageSize) => q("receivables.schedule", { ...filter, page, pageSize }),
    columns: [
      { header: "支払期限", value: (r) => r.dueOn },
      { header: "期限超過", value: (r) => (r.overdue ? "超過" : "") },
      { header: "請求書番号", value: (r) => r.number },
      { header: "状態", value: (r) => INVOICE_STATUS_LABELS[r.status] },
      { header: "販売先", value: (r) => r.customerName },
      { header: "発行日", value: (r) => r.issuedOn },
      { header: "合計（税込）", value: (r) => r.total },
      { header: "残高", value: (r) => r.outstanding },
    ],
  }),
  disposals: defineCsvExport({
    fileName: "販売先廃棄",
    fetch: (q, filter, page, pageSize) => q("disposals.list", { ...filter, page, pageSize }),
    columns: [
      { header: "廃棄伝票", value: (d) => d.number },
      { header: "廃棄日", value: (d) => d.disposedOn },
      { header: "販売先", value: (d) => d.customerName },
      { header: "先方の担当者", value: (d) => d.contactName },
      { header: "商品数", value: (d) => d.lineCount },
      { header: "数量の合計", value: (d) => d.totalQuantity },
      { header: "登録日時", value: (d) => dateTime(d.createdAt) },
    ],
  }),
  disposalRates: defineCsvExport({
    fileName: "廃棄率",
    fetch: (q, filter, page, pageSize) => q("disposals.rates", { ...filter, page, pageSize }),
    columns: [
      { header: "販売先", value: (r) => r.customerName },
      { header: "商品コード", value: (r) => r.itemCode },
      { header: "商品", value: (r) => r.itemName },
      { header: "廃棄数", value: (r) => r.disposed },
      { header: "出荷数", value: (r) => r.shipped },
      { header: "廃棄率（%）", value: (r) => (r.rateBps === null ? null : formatRate(r.rateBps)) },
    ],
  }),
  /**
   * 売上・仕入の集計：行 × 月を縦に並べる（Excel のピボットテーブルで集計し直せる）。
   * 1ページは「行（販売先・仕入先・商品）pageSize 件分 × 月」なので、CSV の行は pageSize より多く返る
   */
  reports: defineCsvExport({
    fileName: "売上・仕入の集計",
    fetch: (q, filter, page, pageSize) => q("reports.cells", { ...filter, page, pageSize }),
    columns: [
      { header: "集計", value: (r) => REPORT_MEASURE_LABELS[r.measure] },
      { header: "区分", value: (r) => REPORT_AXIS_LABELS[r.axis] },
      { header: "コード", value: (r) => r.code },
      { header: "名前", value: (r) => r.name },
      { header: "月", value: (r) => r.month },
      { header: "金額（税抜）", value: (r) => r.amount },
    ],
  }),
} satisfies Readonly<Record<string, CsvExport>>;

/** 仕入先請求書の一覧と支払予定一覧の列 */
function supplierInvoiceColumns(): CsvColumn<{
  readonly supplierName: string;
  readonly invoiceNumber: string | null;
  readonly invoiceDate: string;
  readonly status: keyof typeof SUPPLIER_INVOICE_STATUS_LABELS;
  readonly invoicedAmount: number;
  readonly shippingFee: number;
  readonly computedAmount: number;
  readonly difference: number;
  readonly differenceReason: string | null;
  readonly paymentDueOn: string | null;
  readonly payment: { readonly paidOn: string; readonly amount: number } | null;
}>[] {
  return [
    { header: "仕入先", value: (i) => i.supplierName },
    { header: "請求書番号", value: (i) => i.invoiceNumber },
    { header: "請求日", value: (i) => i.invoiceDate },
    { header: "状態", value: (i) => SUPPLIER_INVOICE_STATUS_LABELS[i.status] },
    { header: "請求額", value: (i) => i.invoicedAmount },
    { header: "送料", value: (i) => i.shippingFee },
    { header: "計算額", value: (i) => i.computedAmount },
    { header: "差額", value: (i) => i.difference },
    { header: "差額の理由", value: (i) => i.differenceReason },
    { header: "支払予定日", value: (i) => i.paymentDueOn },
    { header: "支払日", value: (i) => i.payment?.paidOn ?? null },
    { header: "支払額", value: (i) => i.payment?.amount ?? null },
  ];
}

export type CsvExportName = keyof typeof csvExports;

const exportMap = new Map<string, CsvExport>(Object.entries(csvExports));

/** 処理（export_csv）から名前で定義を探す */
export function findCsvExport(name: string): CsvExport | undefined {
  return exportMap.get(name);
}

export function csvFileName(def: CsvExport, date: string): string {
  return `${def.fileName}_${date}.csv`;
}

/**
 * 一覧の CSV ボタン（POST）の処理。件数が少なければその場で CSV を返し、多ければ非同期の処理を登録して
 * 処理状況の画面へ移る。idempotencyKey はボタンのフォームの受付番号（二重に押しても処理は1つ）。
 */
export async function exportCsv(
  c: Context<AppEnv>,
  name: CsvExportName,
  filter: CsvFilter,
  idempotencyKey: string | null,
): Promise<Response> {
  const def = csvExports[name];
  const actorRef = c.get("actorRef");
  const first = await def.page(c.env, actorRef, filter, 1, CSV_PAGE_SIZE);
  if (!first.ok) return c.text(first.error.message, first.error.code === "forbidden" ? 403 : 400);
  if (first.value.total > CSV_ASYNC_THRESHOLD) {
    const queued = await runCommand(
      c,
      "jobs.exportCsv",
      { definition: name, input: { ...filter } },
      idempotencyKey,
    );
    if (!queued.ok) return c.text(queued.error.message, 400);
    return redirectTo(c, paths.jobs({ notice: "csv" }));
  }
  const rows = [...first.value.rows];
  for (let page = 2; rows.length < first.value.total; page += 1) {
    const next = await def.page(c.env, actorRef, filter, page, CSV_PAGE_SIZE);
    if (!next.ok) return c.text(next.error.message, 400);
    if (next.value.rows.length === 0) break;
    rows.push(...next.value.rows);
  }
  return csvResponse(c, csvFileName(def, toBusinessDate(new Date())), [...def.header], rows);
}
