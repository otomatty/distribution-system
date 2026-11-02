/**
 * 商品の CSV 一括登録の形式とルール（要件定義書 3.2 Should、10章「取り込む項目と形式を決める」）。
 *
 * 形式（ひな形は商品の登録画面の項目と同じ見出し）：
 * - 1行目は見出し。列の順は自由だが、下の列がすべて必要（ない列・知らない列・同じ列が2つあるとエラー）
 * - 商品コードが登録済みの商品と同じなら、その商品をすべての列の値で更新する（空の列は空・初期値になる）。
 *   登録済みでなければ新しく登録する。空なら自動で採番する（IT000001 の形式）
 * - 仕入先・ジャンルは名前で書く（取引終了のものは、すでにその仕入先・ジャンルの商品の更新でだけ使える）
 * - 温度帯は「常温」「冷蔵」「冷凍」（空なら常温）、税区分は「標準」「軽減」（「標準税率」「10%」なども可）
 * - はい・いいえの列は「する」「しない」（「1」「0」「はい」「いいえ」「○」「×」も可。空なら「しない」）
 * - 金額は円で小数第2位まで（「1,234.56」「¥1234」も可）。全角の数字も読む
 * - 1回に3,000行まで。すべての行を確かめてから、問題がなければ1つのトランザクションで登録する
 */
import { unescapeCsvValue, type CsvRecord } from "./csv";
import { TEMPERATURE_ZONES, type TemperatureZone } from "./items";
import { parseYenToCenti, type TaxCategory } from "./money";
import { err, ok, type Result } from "./result";

/** 1回に取り込める行の数（見出しを除く） */
export const MAX_ITEM_CSV_ROWS = 3000;

/** CSV の列（key は商品マスタの項目名。仕入先・ジャンルは名前で書く） */
export const ITEM_CSV_COLUMNS = [
  { key: "code", header: "商品コード" },
  { key: "jan", header: "JAN" },
  { key: "name", header: "商品名" },
  { key: "supplierId", header: "仕入先" },
  { key: "genreId", header: "ジャンル" },
  { key: "temperatureZone", header: "温度帯" },
  { key: "taxCategory", header: "税区分" },
  { key: "purchaseUnitName", header: "仕入単位" },
  { key: "salesUnitName", header: "販売単位" },
  { key: "unitsPerPurchaseUnit", header: "入数" },
  { key: "purchasePriceCenti", header: "仕入価格（仕入単位あたり・税抜・円）" },
  { key: "salesPriceCenti", header: "卸単価（販売単位あたり・税抜・円）" },
  { key: "inputPriceOnOrder", header: "発注時に仕入価格を入力する" },
  { key: "purchaseMinLot", header: "最低ロット（仕入・仕入単位）" },
  { key: "salesMinLot", header: "最低ロット（販売・販売単位）" },
  { key: "leadTimeDays", header: "リードタイム（日）" },
  { key: "reorderEnabled", header: "発注点を管理する" },
  { key: "reorderPoint", header: "発注点在庫数（販売単位）" },
  { key: "purchaseShippingNote", header: "送料条件（仕入）" },
  { key: "salesShippingNote", header: "送料条件（販売）" },
  { key: "memo", header: "備考" },
] as const;

export type ItemCsvKey = (typeof ITEM_CSV_COLUMNS)[number]["key"];

/** ひな形の見出し */
export const ITEM_CSV_HEADERS: readonly string[] = ITEM_CSV_COLUMNS.map((c) => c.header);

const HEADER_OF = new Map<string, string>(ITEM_CSV_COLUMNS.map((c) => [c.key, c.header]));

/** 項目名（ユースケースの検証のエラーの項目）を、CSV の見出しにする。知らない項目はそのまま */
export function itemCsvHeader(key: string): string {
  return HEADER_OF.get(key) ?? key;
}

/** 見出しの比べ方：全角・半角の違いと前後の空白を無視する */
function normalizeHeader(text: string): string {
  return text.normalize("NFKC").replaceAll(/\s/g, "");
}

const KEY_OF_HEADER = new Map<string, ItemCsvKey>(
  ITEM_CSV_COLUMNS.map((c) => [normalizeHeader(c.header), c.key]),
);

export interface ItemCsvRow {
  /** ファイルの中の行番号 */
  readonly line: number;
  /** 列ごとの値（前後の空白を除いたもの。列が足りない行は空） */
  readonly values: ReadonlyMap<ItemCsvKey, string>;
  /** 列の数など、行の形の問題 */
  readonly problems: readonly string[];
}

/** CSV の行を、見出しで項目に分ける。見出しの問題・行がない・多すぎる場合はファイル全体のエラー */
export function readItemCsv(
  records: readonly CsvRecord[],
  maxRows = MAX_ITEM_CSV_ROWS,
): Result<ItemCsvRow[]> {
  const [head, ...data] = records;
  if (!head) return err("validation", "CSV に見出しの行がありません。ひな形を使ってください");
  const keys: (ItemCsvKey | null)[] = [];
  const details: string[] = [];
  const seen = new Set<ItemCsvKey>();
  for (const h of head.fields) {
    const key = KEY_OF_HEADER.get(normalizeHeader(h)) ?? null;
    if (key === null) {
      if (h.trim() !== "") details.push(`「${h.trim()}」は商品の項目にない列です`);
    } else if (seen.has(key)) {
      details.push(`「${itemCsvHeader(key)}」の列が2つあります`);
    } else {
      seen.add(key);
    }
    keys.push(key);
  }
  for (const c of ITEM_CSV_COLUMNS)
    if (!seen.has(c.key)) details.push(`「${c.header}」の列がありません`);
  if (details.length > 0)
    return err("validation", "見出しの行を確かめてください（ひな形と同じ見出しにします）", {
      details,
    });
  if (data.length === 0) return err("validation", "取り込む行がありません");
  if (data.length > maxRows)
    return err(
      "validation",
      `1回に取り込めるのは${maxRows.toLocaleString("ja-JP")}行までです（${data.length.toLocaleString("ja-JP")}行あります）。ファイルを分けてください`,
    );
  return ok(
    data.map((record): ItemCsvRow => {
      const values = new Map<ItemCsvKey, string>();
      const problems: string[] = [];
      record.fields.forEach((field, i) => {
        const key = keys[i];
        if (key) values.set(key, unescapeCsvValue(field.trim()));
        else if (field.trim() !== "" && i >= keys.length)
          problems.push("見出しより多くの列に値があります");
      });
      return { line: record.line, values, problems: [...new Set(problems)] };
    }),
  );
}

/** 文字の数値を読むための正規化（全角を半角に、桁区切りのカンマと前後の空白を除く） */
function numeric(text: string): string {
  return text.normalize("NFKC").replaceAll(",", "").trim();
}

/** 整数。空は undefined（初期値・必須のエラーはユースケースの検証に任せる）、数でなければ NaN */
function integer(text: string): number | undefined {
  const t = numeric(text);
  if (t === "") return undefined;
  return /^\d{1,12}$/.test(t) ? Number(t) : Number.NaN;
}

/** 円（小数第2位まで）を centi-yen に。空は undefined、読めなければ NaN */
function price(text: string): number | undefined {
  const t = numeric(text).replace(/^¥/, "").replace(/円$/, "").trim();
  if (t === "") return undefined;
  return parseYenToCenti(t) ?? Number.NaN;
}

const TRUE_WORDS = new Set(["する", "1", "はい", "○", "◯", "true", "yes", "y"]);
const FALSE_WORDS = new Set(["しない", "0", "いいえ", "×", "false", "no", "n", ""]);

function yesNo(text: string): boolean | undefined {
  const t = text.normalize("NFKC").trim().toLowerCase();
  if (TRUE_WORDS.has(t)) return true;
  if (FALSE_WORDS.has(t)) return false;
  return undefined;
}

const ZONE_WORDS: Readonly<Record<string, TemperatureZone>> = {
  "": "ambient",
  常温: "ambient",
  冷蔵: "chilled",
  冷凍: "frozen",
};

const TAX_WORDS: Readonly<Record<string, TaxCategory>> = {
  標準: "standard",
  標準税率: "standard",
  "10%": "standard",
  standard: "standard",
  軽減: "reduced",
  軽減税率: "reduced",
  "8%": "reduced",
  reduced: "reduced",
};

/** CSV の1行を、商品マスタの登録の入力の形にしたもの（仕入先・ジャンルはまだ名前） */
export interface ItemCsvDraft {
  readonly code: string;
  readonly jan: string;
  readonly name: string;
  readonly supplierName: string;
  readonly genreName: string;
  readonly temperatureZone: TemperatureZone;
  /** 空なら ""（ユースケースの検証で「税区分を選んでください」になる） */
  readonly taxCategory: TaxCategory | "";
  readonly purchaseUnitName: string;
  readonly salesUnitName: string;
  readonly unitsPerPurchaseUnit: number | undefined;
  readonly purchasePriceCenti: number | undefined;
  readonly salesPriceCenti: number | undefined;
  readonly inputPriceOnOrder: boolean;
  readonly purchaseMinLot: number | undefined;
  readonly salesMinLot: number | undefined;
  readonly leadTimeDays: number | null;
  readonly reorderEnabled: boolean;
  readonly reorderPoint: number | undefined;
  readonly purchaseShippingNote: string;
  readonly salesShippingNote: string;
  readonly memo: string;
}

export interface CsvFieldProblem {
  readonly key: ItemCsvKey;
  readonly message: string;
}

/**
 * CSV の値（文字）を、商品マスタの入力の形にする。言葉の列（温度帯・税区分・する／しない）の読み違いは problems に返す。
 * 数や金額の形式の誤りは NaN にして、商品の登録画面と同じ検証（ユースケースの zod）でエラーにする。
 */
export function toItemDraft(values: ReadonlyMap<ItemCsvKey, string>): {
  draft: ItemCsvDraft;
  problems: CsvFieldProblem[];
} {
  const v = (key: ItemCsvKey): string => values.get(key) ?? "";
  const problems: CsvFieldProblem[] = [];
  const zoneText = v("temperatureZone").normalize("NFKC").trim();
  const zone = ZONE_WORDS[zoneText] ?? TEMPERATURE_ZONES.find((z) => z === zoneText);
  if (zone === undefined)
    problems.push({
      key: "temperatureZone",
      message: "「常温」「冷蔵」「冷凍」のどれかにしてください",
    });
  const taxText = v("taxCategory").normalize("NFKC").trim();
  const tax = TAX_WORDS[taxText];
  if (taxText !== "" && tax === undefined)
    problems.push({ key: "taxCategory", message: "「標準」か「軽減」にしてください" });
  const flag = (key: "inputPriceOnOrder" | "reorderEnabled"): boolean => {
    const yes = yesNo(v(key));
    if (yes === undefined)
      problems.push({ key, message: "「する」か「しない」（または 1 か 0）にしてください" });
    return yes ?? false;
  };
  const lead = integer(v("leadTimeDays"));
  return {
    problems,
    draft: {
      code: v("code").normalize("NFKC"),
      jan: v("jan").normalize("NFKC"),
      name: v("name"),
      supplierName: v("supplierId"),
      genreName: v("genreId"),
      temperatureZone: zone ?? "ambient",
      taxCategory: tax ?? "",
      purchaseUnitName: v("purchaseUnitName"),
      salesUnitName: v("salesUnitName"),
      unitsPerPurchaseUnit: integer(v("unitsPerPurchaseUnit")),
      purchasePriceCenti: price(v("purchasePriceCenti")),
      salesPriceCenti: price(v("salesPriceCenti")),
      inputPriceOnOrder: flag("inputPriceOnOrder"),
      purchaseMinLot: integer(v("purchaseMinLot")),
      salesMinLot: integer(v("salesMinLot")),
      leadTimeDays: lead === undefined ? null : lead,
      reorderEnabled: flag("reorderEnabled"),
      reorderPoint: integer(v("reorderPoint")),
      purchaseShippingNote: v("purchaseShippingNote"),
      salesShippingNote: v("salesShippingNote"),
      memo: v("memo"),
    },
  };
}

/** 同じ商品コードが前の行にもあれば、その行番号（商品コードが空の行は比べない） */
export function duplicateCodeLines(
  rows: readonly { readonly line: number; readonly code: string }[],
): Map<number, number> {
  const first = new Map<string, number>();
  const out = new Map<number, number>();
  for (const r of rows) {
    if (r.code === "") continue;
    const earlier = first.get(r.code);
    if (earlier === undefined) first.set(r.code, r.line);
    else out.set(r.line, earlier);
  }
  return out;
}

/** 取込の計画の1行：更新する商品と確かめたときの版番号（新しく登録する行は null） */
export interface ImportPlanEntry {
  readonly itemId: string | null;
  readonly version: number | null;
}

/**
 * 確かめたときの計画を表す文字列。登録する時にもう一度計画を作って比べ、確かめた後にほかの人が
 * 登録・更新した商品があれば止める（版番号の確認。AGENTS.md 4章）
 */
export function importPlanToken(entries: readonly ImportPlanEntry[]): string {
  return entries.map((e) => (e.itemId === null ? "+" : `${e.itemId}@${e.version ?? 0}`)).join(",");
}

/** 確かめたときの計画と違う行の位置（行の数が違えばすべて） */
export function changedPlanEntries(
  expectedToken: string,
  entries: readonly ImportPlanEntry[],
): number[] {
  const expected = expectedToken === "" ? [] : expectedToken.split(",");
  const actual = importPlanToken(entries);
  const now = actual === "" ? [] : actual.split(",");
  if (expected.length !== now.length) return now.map((_, i) => i);
  return now.flatMap((t, i) => (t === expected[i] ? [] : [i]));
}
