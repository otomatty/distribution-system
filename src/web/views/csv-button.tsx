/**
 * 一覧の「CSV 出力」ボタン。今の絞り込み条件を hidden で持つ POST のフォーム（csv-exports.ts の exportCsv で受ける）。
 * 一覧の #results の中に置くと、絞り込みを変えるたびに条件ごと描き直される。
 * 件数が多い場合は非同期で作るので、二重に押しても処理が1つになるよう受付番号を付ける。
 */
import type { Query } from "../paths";
import { FormKey } from "./components";

export function CsvButton(props: { action: string; filters: Query; label?: string }) {
  return (
    <form method="post" action={props.action} class="inline">
      <FormKey />
      {Object.entries(props.filters).map(([name, value]) =>
        value === undefined || value === null || value === "" || value === false ? null : (
          <input type="hidden" name={name} value={String(value)} />
        ),
      )}
      <button type="submit" class="btn btn-secondary btn-sm">
        {props.label ?? "CSV 出力"}
      </button>
    </form>
  );
}
