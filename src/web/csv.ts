/**
 * CSV の出力（要件定義書 3.13）：BOM 付きの UTF-8（Excel でそのまま開ける）、日本語の列名、RFC 4180 の引用。
 * 件数の多い CSV は非同期で作る（platform の CSV ジョブ）。ここは画面から直接返す小さな CSV 用。
 */
import type { Context } from "hono";

import type { AppEnv } from "./types";

export type CsvCell = string | number | boolean | null | undefined;

/** Excel が数式として読む文字で始まる文字列は、先頭に ' を付けて文字列として扱わせる（CSV インジェクション対策） */
function neutralize(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

function cell(value: CsvCell): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "1" : "0";
  const text = neutralize(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** 見出しと行から CSV の本文（BOM 付き、改行は CRLF）を作る */
export function toCsv(header: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  const lines = [header, ...rows].map((r) => r.map(cell).join(","));
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** CSV をダウンロードさせる。filename は日本語でよい（RFC 5987 で送る） */
export function csvResponse(
  c: Context<AppEnv>,
  filename: string,
  header: readonly string[],
  rows: readonly (readonly CsvCell[])[],
): Response {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replaceAll('"', "_");
  return c.body(toCsv(header, rows), 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  });
}
