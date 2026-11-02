// drizzle-kit が出力した業務 DB のマイグレーションを、Worker から読み込める TS モジュールに変換する。
// 使い方：bun run db:generate の後に自動で実行される。
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = "drizzle/business";
const journal = JSON.parse(readFileSync(join(dir, "meta/_journal.json"), "utf8"));
const migrations = {};
for (const entry of journal.entries) {
  const key = `m${String(entry.idx).padStart(4, "0")}`;
  migrations[key] = readFileSync(join(dir, `${entry.tag}.sql`), "utf8");
}
const out = `// このファイルは scripts/build-migrations.mjs が生成する。手で編集しない。
export const businessMigrations: {
  journal: { entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[] };
  migrations: Record<string, string>;
} = ${JSON.stringify({ journal: { entries: journal.entries }, migrations }, null, 2)};
`;
writeFileSync("src/infra/db/migrations/business.generated.ts", out);
rmSync(join(dir, "migrations.js"), { force: true });
console.log(`業務 DB のマイグレーション ${journal.entries.length} 件を変換しました`);
