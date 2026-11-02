/**
 * 商品の CSV 一括登録（要件定義書 3.2 Should）。形式は domain/item-import.ts。
 * 1. ひな形（商品の登録画面と同じ見出しの CSV）をダウンロードする
 * 2. ファイルを選んで確かめる：すべての行を検証し、行ごとの問題を示す（何も書き込まない）
 * 3. 問題がなければ「登録する」：同じ内容で1つのトランザクションで登録・更新する（受付番号・操作履歴つき）
 *
 * 文字コード：BOM 付き UTF-8（Excel の「CSV UTF-8」）と、BOM なしの UTF-8、Shift_JIS（Excel の「CSV」）を読む。
 * UTF-8 として正しくないバイト列なら Shift_JIS として読む（Workers の TextDecoder は shift_jis を読める）。
 * 大きさはファイルで 1 MB まで、行は 3,000 行まで。
 */
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Child } from "hono/jsx";

import { ITEM_CSV_COLUMNS, ITEM_CSV_HEADERS, MAX_ITEM_CSV_ROWS } from "../../../domain/item-import";
import type { DomainError } from "../../../domain/result";
import type { ItemImportCheck } from "../../../usecases/masters/item-import";
import { csvResponse } from "../../csv";
import { isHtmx } from "../../http";
import { requirePermission } from "../../middleware";
import { paths } from "../../paths";
import type { AppEnv } from "../../types";
import { runCommand, runQuery } from "../../usecase";
import { Alert, Badge, ErrorSummary, Field, FormKey, PageHeader } from "../../views/components";
import { qty } from "../../views/format";
import { Layout } from "../../views/layout";

export const itemImportRoutes = new Hono<AppEnv>();

itemImportRoutes.use("*", requirePermission("items.manage"));

/** 選べるファイルの大きさ */
const MAX_FILE_BYTES = 1024 * 1024;
/** 確かめた結果の画面に並べる行の数（問題のある行はすべて出す） */
const PREVIEW_ROWS = 100;

type Encoding = "UTF-8" | "Shift_JIS";

/** CSV のバイト列を文字列にする（BOM 付き UTF-8 → UTF-8 → Shift_JIS の順に試す） */
function decodeCsv(bytes: Uint8Array): { text: string; encoding: Encoding } {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "UTF-8" };
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
      encoding: "UTF-8",
    };
  } catch {
    return { text: new TextDecoder("shift_jis").decode(bytes), encoding: "Shift_JIS" };
  }
}

function page(c: Context<AppEnv>, body: Child, status: 200 | 409 | 422 = 200) {
  if (isHtmx(c)) return c.html(<>{body}</>, status);
  return c.html(
    <Layout title="商品の CSV 一括登録" actor={c.get("actor")} current={paths.items()}>
      <PageHeader title="商品の CSV 一括登録" />
      {body}
      <p>
        <a href={paths.itemImport()}>CSV の一括登録に戻る</a>
      </p>
    </Layout>,
    status,
  );
}

const COLUMN_NOTES: Readonly<Record<string, string>> = {
  code: "空なら自動で採番。登録済みのコードなら、その商品を更新します",
  jan: "8桁または13桁（任意）",
  name: "必須",
  supplierId: "取引先の名前（必須）",
  genreId: "ジャンルの名前（任意）",
  temperatureZone: "常温・冷蔵・冷凍（空なら常温）",
  taxCategory: "標準・軽減（必須）",
  purchaseUnitName: "例：ケース（必須）",
  salesUnitName: "例：個（必須）",
  unitsPerPurchaseUnit: "1仕入単位あたりの販売単位の数（必須）",
  purchasePriceCenti: "小数第2位まで（必須）",
  salesPriceCenti: "小数第2位まで（必須）",
  inputPriceOnOrder: "する・しない（空ならしない）",
  purchaseMinLot: "空なら1",
  salesMinLot: "空なら1",
  leadTimeDays: "0〜365（任意）",
  reorderEnabled: "する・しない（空ならしない）",
  reorderPoint: "空なら0",
  purchaseShippingNote: "任意",
  salesShippingNote: "任意",
  memo: "任意",
};

function UploadForm() {
  return (
    <form
      method="post"
      action={paths.itemImportCheck()}
      enctype="multipart/form-data"
      hx-post={paths.itemImportCheck()}
      hx-encoding="multipart/form-data"
      hx-target="#import-result"
      hx-swap="innerHTML"
      class="form"
    >
      <Field
        label="CSV ファイル"
        name="file"
        hint="BOM 付き UTF-8（Excel の「CSV UTF-8」）か Shift_JIS（Excel の「CSV」）。1 MB まで"
      >
        <input id="f-file" type="file" name="file" accept=".csv,text/csv" required />
      </Field>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">
          ファイルを確かめる（まだ登録しません）
        </button>
      </div>
    </form>
  );
}

itemImportRoutes.get("/", (c) =>
  c.html(
    <Layout title="商品の CSV 一括登録" actor={c.get("actor")} current={paths.items()}>
      <PageHeader
        title="商品の CSV 一括登録"
        actions={
          <a class="btn btn-secondary" href={paths.items()}>
            商品の一覧
          </a>
        }
      >
        <p class="hint">
          すべての行を先に確かめ、問題のある行があればどの商品も登録しません。問題がなければ、確かめた内容をまとめて登録・更新します。
        </p>
      </PageHeader>
      <section class="card">
        <h2>1. ひな形をダウンロードする</h2>
        <p>
          商品の登録画面と同じ項目の見出しが入った CSV です。1行に1つの商品を書きます（
          {qty(MAX_ITEM_CSV_ROWS)}
          行まで）。
        </p>
        <p>
          <a class="btn btn-secondary" href={paths.itemImportTemplate()}>
            ひな形（CSV）をダウンロード
          </a>
        </p>
        <details>
          <summary>列の書き方</summary>
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>見出し</th>
                  <th>書き方</th>
                </tr>
              </thead>
              <tbody>
                {ITEM_CSV_COLUMNS.map((col) => (
                  <tr>
                    <td>{col.header}</td>
                    <td>{COLUMN_NOTES[col.key] ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p class="hint">
            既存の商品を更新するときも、すべての列の値で置き換えます（空の列は空または初期値になります）。
            取扱終了と在庫は CSV では変えません。
          </p>
        </details>
      </section>
      <section class="card">
        <h2>2. ファイルを確かめて登録する</h2>
        <UploadForm />
        <div id="import-result" aria-live="polite"></div>
      </section>
    </Layout>,
  ),
);

itemImportRoutes.get("/template.csv", (c) =>
  csvResponse(c, "商品の一括登録_ひな形.csv", ITEM_CSV_HEADERS, []),
);

function FileErrorPanel(props: { check: ItemImportCheck }) {
  const e = props.check.fileError;
  if (!e) return null;
  return (
    <Alert kind="error">
      <strong>{e.message}</strong>
      {e.details.length > 0 ? (
        <ul>
          {e.details.map((d) => (
            <li>{d}</li>
          ))}
        </ul>
      ) : null}
    </Alert>
  );
}

function CheckResult(props: { check: ItemImportCheck; csv: string; encoding: Encoding }) {
  const { check } = props;
  if (check.fileError) return <FileErrorPanel check={check} />;
  const { counts } = check;
  const bad = check.rows.filter((r) => r.errors.length > 0);
  const shown = bad.length > 0 ? bad : check.rows.slice(0, PREVIEW_ROWS);
  return (
    <div class="import-result">
      <p class="import-summary">
        全 {qty(check.rows.length)} 行：新規 <strong>{qty(counts.create)}</strong> 件・更新{" "}
        <strong>{qty(counts.update)}</strong> 件
        {counts.error > 0 ? (
          <>
            ・<strong class="text-danger">問題のある行 {qty(counts.error)} 件</strong>
          </>
        ) : null}
        <span class="muted small">（文字コード：{props.encoding}）</span>
      </p>
      {bad.length > 0 ? (
        <Alert kind="error">
          問題のある行があるため、まだどの商品も登録していません。ファイルを直して、もう一度選んで確かめてください。
        </Alert>
      ) : null}
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th class="num">行</th>
              <th>処理</th>
              <th>商品コード</th>
              <th>商品名</th>
              {bad.length > 0 ? <th>問題</th> : null}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr class={r.errors.length > 0 ? "row-danger" : undefined}>
                <td class="num">{r.line}</td>
                <td>
                  {r.action === "update" ? (
                    <Badge kind="info">更新</Badge>
                  ) : (
                    <Badge kind="success">新規</Badge>
                  )}
                </td>
                <td class="nowrap">{r.code ?? <span class="muted">自動で採番</span>}</td>
                <td>{r.name}</td>
                {bad.length > 0 ? (
                  <td>
                    <ul class="import-errors">
                      {r.errors.map((e) => (
                        <li>{e}</li>
                      ))}
                    </ul>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {bad.length === 0 && check.rows.length > shown.length ? (
        <p class="muted">ほか {qty(check.rows.length - shown.length)} 行</p>
      ) : null}
      {bad.length === 0 ? (
        <form
          method="post"
          action={paths.itemImport()}
          enctype="multipart/form-data"
          hx-post={paths.itemImport()}
          hx-encoding="multipart/form-data"
          hx-target="#import-result"
          hx-swap="innerHTML"
          hx-confirm={`商品を ${counts.create} 件登録し、${counts.update} 件更新します。よろしいですか？`}
          class="form"
        >
          <FormKey />
          <input type="hidden" name="planToken" value={check.planToken} />
          <textarea name="csv" hidden>
            {props.csv}
          </textarea>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary">
              {counts.create} 件を登録し、{counts.update} 件を更新する
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function fieldText(body: Readonly<Record<string, unknown>>, name: string): string {
  const v = body[name];
  return typeof v === "string" ? v : "";
}

itemImportRoutes.post(
  "/check",
  bodyLimit({
    maxSize: MAX_FILE_BYTES + 64 * 1024,
    onError: (c) => c.text("CSV は1 MB 以下にしてください。ファイルを分けてください", 413),
  }),
  async (c) => {
    const body = await c.req.parseBody();
    const file = body["file"];
    if (!(file instanceof File) || file.size === 0)
      return page(c, <Alert kind="error">CSV のファイルを選んでください</Alert>, 422);
    const { text, encoding } = decodeCsv(new Uint8Array(await file.arrayBuffer()));
    const check = await runQuery(c, "items.importCheck", { csv: text });
    return page(c, <CheckResult check={check} csv={text} encoding={encoding} />);
  },
);

function ImportError(props: { error: DomainError }) {
  return (
    <>
      <ErrorSummary error={props.error} />
      <p>ファイルを直してから、もう一度選んで確かめてください。</p>
    </>
  );
}

itemImportRoutes.post(
  "/",
  // 確かめた CSV（文字列）をそのまま送り直すので、ファイルの上限より大きめにする
  bodyLimit({
    maxSize: 4 * MAX_FILE_BYTES,
    onError: (c) => c.text("CSV が大きすぎます。ファイルを分けてください", 413),
  }),
  async (c) => {
    const body = await c.req.parseBody();
    const key = fieldText(body, "_key");
    const result = await runCommand(
      c,
      "items.import",
      { csv: fieldText(body, "csv"), planToken: fieldText(body, "planToken") },
      key === "" ? null : key,
    );
    if (!result.ok)
      return page(
        c,
        <ImportError error={result.error} />,
        result.error.code === "conflict" ? 409 : 422,
      );
    return page(
      c,
      <Alert kind="success">
        商品を {qty(result.value.created)} 件登録し、{qty(result.value.updated)} 件更新しました。{" "}
        <a href={paths.items()}>商品の一覧を見る</a>
      </Alert>,
    );
  },
);
