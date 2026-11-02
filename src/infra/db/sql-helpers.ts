/**
 * Durable Objects の SQLite は、1つのクエリで使えるバインド変数が100個まで。
 * IN の一覧は JSON の配列1つにまとめて渡し、複数行の INSERT は上限に収まる行数ずつに分ける。
 */
import { sql, type Column, type SQL } from "drizzle-orm";

const MAX_BOUND_PARAMETERS = 100;

/** column IN (values)。values がいくつあってもバインド変数は1つ */
export function inList(column: Column | SQL, values: readonly string[]): SQL {
  return sql`${column} IN (SELECT value FROM json_each(${JSON.stringify(values)}))`;
}

/** column NOT IN (values) */
export function notInList(column: Column | SQL, values: readonly string[]): SQL {
  return sql`${column} NOT IN (SELECT value FROM json_each(${JSON.stringify(values)}))`;
}

/** 1行あたりの列数から、1回の INSERT に入れられる行数ずつに分ける */
export function insertBatches<T>(rows: readonly T[], columnsPerRow: number): T[][] {
  const size = Math.max(1, Math.floor(MAX_BOUND_PARAMETERS / columnsPerRow));
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}
