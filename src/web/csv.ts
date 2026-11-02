/**
 * CSV の出力（要件定義書 3.13）。Excel でそのまま開けるよう、BOM 付きの UTF-8・改行は CRLF にする。
 * 値の区切りと引用符は RFC 4180 に従う。列名は日本語にし、一覧の絞り込み条件と同じ内容を出す。
 *
 * 件数の多い一覧は csv-exports.ts の exportCsv を使う（件数で同期と非同期を切り替える）。
 */
import type { Context } from "hono";

import { contentDisposition } from "../infra/storage/files";
import type { AppEnv } from "./types";

export type CsvValue = string | number | boolean | null | undefined;

export const CSV_BOM = "\uFEFF";
export const CSV_CONTENT_TYPE = "text/csv; charset=utf-8";

/**
 * 1つの値を CSV の形にする。
 * - 区切り（,）・引用符（"）・改行を含む値は引用符で囲み、引用符は2つ重ねる
 * - 「= + - @」やタブで始まる文字列は、Excel が数式として実行しないよう先頭に ' を付ける（CSV インジェクション対策）。
 *   数値（number）はそのまま出す
 */
export function csvField(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "1" : "0";
  let text = value;
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function csvLine(values: readonly CsvValue[]): string {
  return `${values.map(csvField).join(",")}\r\n`;
}

/** 見出しと行を CSV にする（先頭に BOM を付ける） */
export function encodeCsv(
  header: readonly string[],
  rows: readonly (readonly CsvValue[])[],
): string {
  return CSV_BOM + csvLine(header) + rows.map(csvLine).join("");
}

/** CSV をダウンロードさせる。filename は拡張子つき（例：帳票一覧_2026-11-02.csv） */
export function csvResponse(
  c: Context<AppEnv>,
  filename: string,
  header: readonly string[],
  rows: readonly (readonly CsvValue[])[],
): Response {
  return c.body(encodeCsv(header, rows), 200, {
    "Content-Type": CSV_CONTENT_TYPE,
    "Content-Disposition": contentDisposition(filename),
    "Cache-Control": "private, no-store",
  });
}
