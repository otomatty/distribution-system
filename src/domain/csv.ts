/**
 * CSV の読み込み（RFC 4180）。商品の CSV 一括登録などで使う。
 * - 区切りはカンマ、行の区切りは CRLF・LF・CR のどれでもよい。先頭の BOM は除く
 * - 引用符（"）で囲んだ値はカンマ・改行を含められ、引用符は2つ重ねる
 * - 出力（web/csv.ts）が数式の実行を防ぐために付けた先頭の ' は、unescapeCsvValue で外す
 */
import { err, ok, type Result } from "./result";

export interface CsvRecord {
  /** その行が始まる、ファイルの中の行番号（1から） */
  readonly line: number;
  readonly fields: readonly string[];
}

/** バイト順マーク（Excel の「CSV UTF-8」が先頭に付ける） */
const BOM = String.fromCodePoint(0xfeff);

function isLineBreak(ch: string | undefined): boolean {
  return ch === "\r" || ch === "\n";
}

/**
 * CSV を行と値に分ける。何も書かれていない行は飛ばす。
 * 閉じていない引用符や、閉じた引用符の後に区切り以外の文字がある場合はエラー（行番号つき）。
 */
export function parseCsv(text: string): Result<CsvRecord[]> {
  const src = text.startsWith(BOM) ? text.slice(1) : text;
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = "";
  /** 今の値が引用符で囲まれていたか（"" だけの値と、何もない行を区別する） */
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  let i = 0;

  const endField = () => {
    fields.push(field);
    field = "";
    quoted = false;
  };
  const endRecord = () => {
    const blank = fields.length === 0 && field === "" && !quoted;
    endField();
    if (!blank) records.push({ line: recordLine, fields });
    fields = [];
  };

  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' && field === "" && !quoted) {
      quoted = true;
      const start = line;
      i += 1;
      for (;;) {
        const c = src[i];
        if (c === undefined) return err("validation", `${start}行目：引用符（"）が閉じていません`);
        if (c === '"') {
          if (src[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        if (c === "\n" || (c === "\r" && src[i + 1] !== "\n")) line += 1;
        field += c;
        i += 1;
      }
      const next = src[i];
      if (next !== undefined && next !== "," && !isLineBreak(next))
        return err(
          "validation",
          `${line}行目：引用符（"）で囲んだ値の後に、区切りのカンマがありません`,
        );
      continue;
    }
    if (ch === ",") {
      endField();
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      endRecord();
      i += ch === "\r" && src[i + 1] === "\n" ? 2 : 1;
      line += 1;
      recordLine = line;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (fields.length > 0 || field !== "" || quoted) endRecord();
  return ok(records);
}

/**
 * CSV の出力で数式の実行を防ぐために付けた先頭の '（= + - @ タブ CR の前）を外す。
 * それ以外の ' で始まる値はそのまま。元から「'=」などで始まる値は、付けた ' と区別できないので ' が外れる
 */
export function unescapeCsvValue(value: string): string {
  return /^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value;
}
