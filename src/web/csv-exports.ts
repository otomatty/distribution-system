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

import { toBusinessDate } from "../domain/dates";
import {
  DOCUMENT_TYPE_LABELS,
  RENDER_STATUS_LABELS,
  SEND_STATUS_LABELS,
} from "../domain/documents";
import type { Result } from "../domain/result";
import { SALES_ORDER_STATUS_LABELS } from "../domain/sales";
import type { ActorRef } from "../infra/do/actor-ref";
import type { QueryInput, QueryName, QueryOutput } from "../usecases/registry";
import { csvResponse, type CsvValue } from "./csv";
import { redirectTo } from "./http";
import { paths } from "./paths";
import type { AppEnv } from "./types";
import { queryAs, runCommand } from "./usecase";
import { dateTime } from "./views/format";

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
} satisfies Readonly<Record<string, CsvExport>>;

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
