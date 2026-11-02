# AGENTS.md

このファイルは、このリポジトリで作業する AI エージェントと開発者のためのルールです。作業を始める前に必ず全体を読んでください。

## 1. このリポジトリについて

大船渡の流通管理システム（菓子・食品の仕入・在庫・販売）を作り直したものです。社内の約10人が使う業務システムで、発注・入荷・支払、受注・発送・請求・入金、在庫、販売先廃棄を扱います。

- 要件の正本は要件定義書です：https://claude.ai/artifact/474X7tYjok4fdwbi4TgcLV
- リポジトリには写しを `docs/requirements.md` に置いています。作業ではこちらを読んでください（正本を変えたら写しも更新する）
- 実装の中で決めた規則は、要件定義書の「11. 実装で決めた仕様」にまとめています。上の章と食い違うときは11章が新しい決定です
- 仕様が要件定義書と食い違う、または書かれていない場合は、推測で実装せずに質問してください

### 技術スタック

| 区分           | 採用                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------- |
| 言語           | TypeScript 7（厳格なオプションをすべて有効）                                              |
| 画面と API     | Hono + htmx（同一ドメイン、JSX でサーバー側描画）                                         |
| 実行環境       | Cloudflare Workers                                                                        |
| 業務 DB        | Durable Objects の SQLite（Drizzle）                                                      |
| ログイン       | Better Auth + Google（会社の Workspace ドメインに限定）、保存先は D1                      |
| ファイル       | R2（帳票 PDF、CSV、バックアップ）                                                         |
| 非同期処理     | Queues、Cron Triggers                                                                     |
| 帳票           | JSX で作った HTML を Browser Rendering で PDF 化                                          |
| メール         | Cloudflare Email Service（差し替え可能。予備は Resend）                                   |
| パッケージ管理 | Bun（ツールの実行は Node.js。バージョンは mise で固定）                                   |
| Lint / 整形    | oxlint（型情報を使うルール）/ oxfmt                                                       |
| テスト         | Vitest、fast-check、`@cloudflare/vitest-plugin`（Workers の実行環境で動かす）、Playwright |

## 2. ディレクトリ構成と層のルール

```text
src/
  domain/            状態遷移、税・金額計算、在庫の不変条件（入出力なし）
  usecases/          「発注する」「発送する」など。権限判定とトランザクションの境界
    core.ts          ユースケースの共通の型（操作者、時刻、採番、操作履歴、ジョブ、帳票）
    registry.ts      ユースケースの一覧（区分ごとの index.ts をまとめる）
    ports.ts         ポートの一覧（区分ごとの stores.ts をまとめる）
    <区分>/          masters・stock・purchasing・sales・billing・platform・reports
      index.ts       この区分のユースケースの一覧（commands / queries）
      stores.ts      この区分のポート（インターフェース）
  infra/
    db/schema/       Drizzle のスキーマ（全テーブル）
    db/stores/<区分>/ ポートの実装
    db/migrations/   マイグレーションを Durable Object に組み込むための生成物
    do/              業務 DB の Durable Object（ユースケースを RPC で公開）
    auth/            Better Auth の設定（D1）
    mail/            メール送信の実装
    pdf/             Browser Rendering による PDF 化
    storage/         R2
    queue/           ジョブ（Queues）と Cron の処理
  web/
    routes/<区分>/   Hono のルート（画面と部分 HTML）。index.ts で区分のルートをまとめる
    views/           JSX テンプレート（画面の部品、レイアウト、帳票）
    paths/<区分>.ts  URL を生成するヘルパー
  worker.ts          エントリーポイント（fetch・queue・scheduled）
public/assets/       画面の CSS と補助スクリプト（ビルドなしの素の JavaScript）、htmx
public/sw.js         倉庫のタブレットのオフライン閲覧（service worker。範囲は発送リストと入荷予定一覧だけ）
drizzle/             生成したマイグレーション（business：業務 DB、auth：ログイン情報）
tests/
  integration/       Workers 環境の結合テスト（画面のルートとユースケース）
  e2e/               Playwright
docs/requirements.md 要件定義書の写し
```

機能の区分と担当範囲：

| 区分       | 内容                                                                               |
| ---------- | ---------------------------------------------------------------------------------- |
| masters    | 社員、自社設定・税率表、取引先、商品、保管場所、払い出し先店舗、ジャンル           |
| stock      | 在庫台帳、集計表、在庫操作（調整・移動・店舗払い出し）、棚卸、在庫一覧・明細       |
| purchasing | 発注、入荷（分納）、仕入返品、仕入先請求書、支払、入荷予定一覧、支払予定・買掛残高 |
| sales      | 受注、引当、分割、発送リスト、発送と取消、納品書                                   |
| billing    | 請求書、締め処理、返品伝票、返還請求書、入金と消込、売掛残高、販売先廃棄、集計     |
| platform   | 帳票の PDF 化と送付、帳票の検索、処理状況、CSV、バックアップ、ダッシュボード       |
| reports    | 売上・仕入の集計（月別に、販売先別・仕入先別・商品別）                             |

依存の向きは次のとおりで、oxlint のルールで強制しています。違反する import を書かないでください。

- `domain` は何にも依存しない。DB、通信、現在時刻の取得、乱数、環境変数を使わない（必要な値は引数で受け取る）
- `usecases` は `domain` だけに依存する。必要な入出力はポート（インターフェース）として `usecases` に定義する
- `infra` はポートを実装する。`domain` の型は使ってよい
- `web` は `usecases` を呼ぶだけ。金額の計算や状態の判定をしない

業務ルールを追加・変更するときは、まず `domain` に置けないかを考えてください。

### 機能を追加する手順

取引先（`usecases/masters/partners.ts`、`infra/db/stores/masters/partners.ts`、`web/routes/masters/partners.tsx`、`tests/integration/partners.test.ts`）が見本です。

1. ルールを `domain` に純粋関数として書き、単体テストを書く
2. ポート（インターフェース）を `usecases/<区分>/` に書き、`usecases/<区分>/stores.ts` に追加する
3. ユースケースを `defineCommand` / `defineQuery` で書き、`usecases/<区分>/index.ts` の一覧に登録する。名前は `<対象>.<操作>`（例：`purchaseOrders.confirm`）
4. ポートを `infra/db/stores/<区分>/` に実装し、同じフォルダの `index.ts` に追加する
5. 画面のルートを `web/routes/<区分>/` に書き、`index.ts` に取り付ける。URL は `web/paths/<区分>.ts` に追加する
6. 結合テストを `tests/integration/` に書く（`tests/integration/helpers.ts` を使う）

ユースケースの書き方：

- ユースケースは業務 DB（Durable Object）の中で、1つのトランザクションとして同期的に実行されます。`await` は使えません
- 失敗は `err(...)` で返します。返した時点でトランザクション全体が取り消されます（途中の書き込みも残りません）
- 権限は `permission` に書けば業務 DB が判定します。入力は `input` の zod スキーマで検証されます
- 現在時刻と業務日は `ctx.clock`、ID は `ctx.ids`、番号は `ctx.sequences`、操作履歴は `ctx.audit` を使います
- 帳票（発注書・納品書・請求書・返還請求書）は `ctx.documents.issue(...)` で発行します。発行時点の内容を `snapshot` として保存し、PDF 化はコミット後に非同期で行います。メールでの送付は `ctx.documents.sendEmail(...)`
- 時間のかかる処理（一括 PDF、大きな CSV など）は `ctx.jobs.enqueue(...)` で登録し、`infra/queue` で処理します。登録はコミットと同時に確定し、Queues への送信はコミット後に行われます（outbox）

### 帳票・一括 PDF・CSV・ダッシュボードを追加する手順

- 帳票：発行するユースケースの側にスナップショットの zod スキーマを書き、`web/views/documents/<帳票>.tsx` に `defineTemplate({ schema, render })`（`template.ts` から読み込む。`registry.ts` から読み込むと循環する）でテンプレートを書いて、`web/views/documents/registry.ts` の `documentTemplates` に1行で登録する。テンプレートは値を表示するだけで、金額を計算しない。テンプレートがない帳票やスキーマに合わない帳票は、PDF 化が失敗し理由が画面に残る
- 帳票の送付・検索・再送は共通の仕組み（`documents.*`）が受け持つ。各区分は `ctx.documents.issue(...)`（発行）と `ctx.documents.cancel(...)`（取消）だけを呼ぶ。画面からは `paths.document(id)`（詳細と送付）と `paths.documentDownload(id)` に移る
- 一括 PDF：`jobs.bulkDocuments`（帳票の ID、または `documentType` と元の伝票の ID）を呼ぶか、ユースケースの中で `ctx.jobs.enqueue("bulk_documents", { documentIds, name }, documentIds.length)` で登録し、処理状況（`paths.jobs()`）へ移る
- CSV：`web/csv-exports.ts` の `csvExports` に定義（名前 → `{ fileName, fetch, columns }`）を足し、一覧の `#results` の中に `<CsvButton>` を置き、POST のルートで `exportCsv(c, 名前, 絞り込み条件, formKey(form))` を返す。2,000件を超えると自動で非同期になる。小さな表をその場で返すだけなら `web/csv.ts` の `csvResponse`
- ダッシュボード：`web/dashboard/<区分>.ts` に欄（`DashboardSection`）を書き、`web/dashboard/sections.ts` の一覧に1行で登録する。件数は照会（ユースケース）で数え、項目は絞り込み済みの一覧の URL を持つ
- CSV の取込（商品の一括登録が見本）：`domain/csv.ts` の `parseCsv`（RFC 4180）で読み、列の読み取りは domain に、行の検証は登録画面と同じ zod のスキーマで行う。文字コード（BOM 付き UTF-8・UTF-8・Shift_JIS）の判定とファイルの大きさの上限は web 層。「確かめる（照会。書き込まない）→ 登録する（コマンド。1つのトランザクション）」の2段階にし、確かめたときの計画（更新する行の版番号）を登録のときに比べる（`web/routes/masters/item-import.tsx`）
- 受け取ったファイル（仕入先請求書の PDF が見本）：形式は拡張子ではなく中身で確かめ、版ごとに新しいキーで R2 に置いてから、業務 DB に版（SHA-256 つき）を記録する。上書き・削除はせず、記録できなかったファイルだけを消す（`web/routes/purchasing/supplier-invoice-attachments.tsx`、`docs/operations.md`）
- 運用（バックアップと復元、バケットロック、失敗に気づく方法）は `docs/operations.md`

### テストデータ（bun run db:seed）

- 投入の処理は `src/infra/seed/`。業務 DB の Durable Object の `seed`（`/dev/seed`）から呼び、開発用ログインと同じく ENVIRONMENT が development / test のときだけ動く
- 書き込みは必ず本物のユースケースを通す（`session.run(コマンド, 入力, 社員, 時刻)`。過去の業務日の時刻で実行する）。テーブルに直接書かない。受付番号（`seed:<規模>:<手順>:<回>:<何番目>`）は `session.run` が付ける
- 乱数は `session.random(対象のキー…)` を使う。キーには番号・名前・日付を使い、ID（ULID は毎回変わる）を使わない
- 手順を足すときは `src/infra/seed/index.ts` の `STEPS`、毎日の操作を足すときは `operations.ts` の `DAILY`（発注・入荷・受注・発送・在庫・仕入先請求書・支払と一部支払）か `billing.ts`（返品伝票・請求書・締め処理・返還請求書・入金と消込・返還額の消込と返金・販売先廃棄。1日の取引の最後に行う）に追加する。後から期間をまとめて処理すると、途中の未請求・未処理が実際の運用より大きく膨らむため、毎日の流れの中で行う
- 整合の確認（`verify.ts`）と結合テスト（`tests/integration/seed.test.ts`）も更新する
- 一覧・集計を追加・変更したら、full のデータで速さを確かめる（`bun run perf`、`docs/performance.md`）

## 3. コマンド

`package.json` に次の名前で定義しています。

| コマンド                            | 内容                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------- |
| `bun install`                       | 依存のインストール                                                                          |
| `bun run dev`                       | ローカル開発サーバー（wrangler dev）。`/dev/login` から社員のメールアドレスでログインできる |
| `bun run check`                     | 下の検査をすべて実行する。作業の完了前に必ず通す                                            |
| `bun run fmt` / `bun run fmt:check` | oxfmt で整形 / 整形の確認                                                                   |
| `bun run lint`                      | oxlint（型情報を使うルールと型チェック）                                                    |
| `bun run test`                      | 単体テストと結合テスト（Vitest）                                                            |
| `bun run test:e2e`                  | E2E テスト（Playwright）                                                                    |
| `bun run knip`                      | 使われていないコードと依存の検出                                                            |
| `bun run secrets`                   | 秘密情報の混入チェック（secretlint）。`bun run check`、コミット時のフック、CI でも動く      |
| `bun run db:generate`               | Drizzle のマイグレーションを生成                                                            |
| `bun run db:seed`                   | 開発用のテストデータを投入（乱数の種は固定。`-- --scale=full` で本番の約5倍）               |
| `bun run perf`                      | テストデータを入れた wrangler dev で、主な画面の速さを測る（docs/performance.md）           |
| `bun run db:migrate:local`          | ログイン情報（D1）のマイグレーションを手元に適用                                            |
| `bun run cf-typegen`                | `wrangler.jsonc` からバインディングの型を生成                                               |

開発用ログインは `ENVIRONMENT` が `development` か `test` のときだけ有効です。`wrangler.jsonc` の既定の値（`unconfigured`）では有効にならないので、`--env` を付けずに配備しても開きません。手元の開発は `bun run dev`（`--var ENVIRONMENT:development`）と `.dev.vars`、テストは `vitest.config.ts`、E2E は `tests/e2e/playwright.config.ts` で値を明示的に渡します。

E2E テストの Chromium は `bunx playwright install chromium` で入れます。別の場所にある Chromium を使う場合は、環境変数 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` にパスを指定してください。

デプロイは CI からだけ行います。手元から本番にデプロイしないでください。

## 4. コーディング規約

### 全般

- `any`、型アサーション（`as`）、`@ts-ignore`、`@ts-expect-error`、lint の無効化コメントは使わない。どうしても必要な場合は理由をコメントに書き、PR で説明する（例外：`web/usecase.ts` で RPC の戻り値を registry の型に戻す箇所、`as const`）
- Promise は必ず `await` するか、意図的に扱わないことを明示する（`no-floating-promises` が有効）
- 外部から来る値（フォーム、クエリ、Queue のメッセージ、環境変数）は境界でスキーマ検証してから使う
- 命名：ファイルは kebab-case、型は PascalCase、関数と変数は camelCase、DB のテーブルと列は snake_case
- 業務用語は要件定義書の言葉に合わせる（例：入荷は `receipt`、仕入先請求書は `supplierInvoice`、消込は `allocation`）

### エラー

- 業務エラー（在庫不足、状態が違う、権限がないなど）は例外にせず、型つきの結果（成功か失敗か）として返す
- 例外は想定外の失敗だけに使い、ログに残す。利用者には生の例外メッセージを見せない

### 金額と数量

- 単価は税抜で、100分の1円単位の整数で持つ。金額は円単位の整数で持つ。浮動小数点数で金額を計算しない
- 明細の金額（単価 × 数量）の1円未満は明細ごとに、消費税は請求書1枚ごとに税率ごとに1回、どちらも設定の端数処理の方法で処理する
- 金額と税額の計算は `domain` の1か所だけに置く。画面や帳票は計算結果を表示するだけにする
- 在庫数は販売単位の整数。入荷では「受入数 × 入数」を加える

### 日付と時刻

- 日時は UTC で保存し、日本時間で表示する
- 発注日・入荷日・出荷予定日などの業務日は、日本時間の日付（`YYYY-MM-DD` の文字列）で保存する
- `domain` の中で現在時刻を取得しない。ユースケースから引数で渡す

### ID と番号

- 内部の ID は ULID
- 画面や帳票に出す番号は、種別×年ごとの連番（例：`PO-2026-000123`）。採番は伝票の作成と同じトランザクションで行う

### データの変更

- 状態の変更は、必ず `domain` の遷移関数を通す。状態の列を直接書き換えない
- 在庫台帳は追記のみ。誤りは打ち消しの行で直し、行の更新や削除はしない。台帳への追記と在庫の集計表の更新は、同じトランザクションで行う
- 削除は原則として行わない。取扱終了・取引終了・取消で表す
- 全テーブルに作成・更新の日時と操作者、版番号を持たせる。版番号が一致しない保存はエラーにする
- 登録や状態を変える操作は、受付番号（冪等キー）を受け取り、処理済みの番号なら前回の結果を返す
- 状態を変える操作は、操作履歴（誰が・いつ・何を・変更前後の値）を同じトランザクションで記録する

### 権限

- 権限は画面での出し分けに加えて、ユースケースの中で必ず判定する。役割ごとにできる操作は要件定義書の権限表に従う

### 画面（Hono + htmx + JSX）

- HTML は JSX で作り、自動エスケープに任せる。生の HTML を埋め込まない
- `hx-get` や `hx-post` の URL は `web/paths/` のヘルパーで生成し、文字列を直書きしない
- 一覧の絞り込みは表の部分だけを差し替え、条件を URL に残す（`hx-push-url`）
- 状態を変える操作の後は、変わった部分の HTML だけを返す
- 画面からの POST には CSRF 対策（Origin の検証）を通す
- 倉庫の4画面（入荷予定一覧・入荷確認・発送リスト・在庫操作）はタブレットの横向きでも操作できる大きさにし、ホバーで現れる操作を使わない

### 画面の補助スクリプト

- `public/assets/app.js` はビルドしない素の JavaScript です（通信断の表示と再送信、下書きの保存、数量の増減ボタン、オフライン閲覧の登録と消去）。htmx で書けることはこのファイルに書かない
- 発送リストと入荷予定一覧のオフライン閲覧（要件定義書 7章の Should）は service worker（`public/sw.js`）で行う。
  localStorage に残す方法では、通信が途切れた後に画面を開き直す（タブレットのブラウザを閉じた後や、URL を開いた）ときに画面そのものを読み込めないため。
  service worker はルートから配信し（`/sw.js`）、範囲（scope）は `/shipping` と `/receiving` だけにして、ほかの画面には関わらない。
  ファイルは同じ生成元なので、CSP（`script-src 'self'`、埋め込みのスクリプトなし）のままで動く
  - 画面は通信を優先し、取れなかったときだけ最後に読み込んだ画面を返す（絞り込みの htmx の応答も画面全体なので残す）。残すのは、結果の欄に目印（`web/views/offline-snapshot.tsx` の `data-offline-snapshot`）のある正常な HTML の応答だけ（ログイン画面への移動やエラーは残さない）
  - 残した画面を返すときは目印を `cached` に変える。画面は読み込んだ時刻と「通信が途切れているため…」を出し、`app.js` が操作のボタンと入力欄を使えなくする
  - 共有のタブレットのため、端末に残すもの（下書き・残した画面・service worker の登録）は、ログアウトの後の画面（`data-clear-drafts`）でまとめて消す。端末に何かを残す機能を足すときは、同じ目印で消す
  - `public/sw.js` は素の JavaScript なので、型の情報を使う lint の規則は `public/assets/*.js` と同じく外している（`.oxlintrc.json`）
- 外部のライブラリは CDN から読み込まず、`public/assets/vendor` に置く（`bun run build:assets`）

### 実行環境

- Worker のコードでは Web 標準の API と Workers の API だけを使う。Bun 独自の API（`Bun.file()`、`bun:sqlite` など）と Node.js 独自の API に頼らない
- 秘密情報は Workers の Secrets から読む。コードや設定ファイルに書かない

## 5. テスト

### どの変更にどのテストが必要か

| 変更の種類                                   | 必須のテスト                                                         |
| -------------------------------------------- | -------------------------------------------------------------------- |
| 状態遷移・金額計算・在庫のルール（`domain`） | 単体テスト。在庫に関わるものはプロパティベーステスト（fast-check）も |
| ユースケースの追加・変更（`usecases`）       | Workers 環境の結合テスト。権限、二重送信、業務エラーの場合を含める   |
| 画面の追加・変更（`web`）                    | ルートの結合テスト。主要な業務の流れに関わるものは E2E テストも      |
| 帳票のレイアウト                             | テンプレートのスナップショットテストと、インボイスの記載事項の検査   |
| DB のスキーマ                                | マイグレーションの適用テストと、既存の結合テスト                     |

### ルール

- `domain` と `usecases` は、行と分岐の90%以上のカバレッジを保つ（CI の合格条件）
- 在庫の不変条件「台帳の合計と集計表の現在庫が常に一致する」「出荷可能数 = 現在庫 − 引当数」は、プロパティベーステストで守る
- テストを通すためにテストを弱めたり、消したり、スキップしたりしない。仕様の変更でテストを直す場合は、PR で理由を書く
- テストデータは固定の乱数の種で作り、毎回同じ結果になるようにする

## 6. 変更の手順

1. 要件定義書で、変更する仕様を確認する。書かれていなければ質問する
2. 先にテストを書き、失敗することを確かめる
3. 実装する（ルールは `domain` へ、入出力は `infra` へ）
4. `bun run check` を通す。画面の変更なら `bun run test:e2e` も通す
5. 仕様が変わった場合は、要件定義書と、このファイルの該当箇所を更新する

「完了した」と報告するのは、上の検査をすべて実際に実行して通ったことを確かめた後だけにしてください。実行していない検査を通ったとは書かないでください。

## 7. やってはいけないこと

- `domain` 層に入出力（DB、通信、現在時刻、乱数、環境変数）を書く
- 画面やテンプレートで金額や税額を計算する
- 状態の列や在庫の数を、遷移関数や台帳を通さずに直接書き換える
- 適用済みのマイグレーションを書き換える（変更は新しいマイグレーションで行う）
- 秘密情報や個人情報（取引先の連絡先など）をコード、テスト、ログ、コミットに含める
- lint のルールや TypeScript の厳格なオプションを緩める
- 手元から本番環境にデプロイする

## 8. DB とマイグレーション

- スキーマは `src/infra/db/` の Drizzle 定義が正本。変更したら `bun run db:generate` でマイグレーションを生成してコミットする
- 1つのマイグレーションには1つの目的だけを入れる
- 列の削除や名前の変更は、データを移す段階と古い列を消す段階に分ける

## 9. PR の書き方

- タイトル：何を変えたかを1行で（例：「入荷確認で分納を記録できるようにする」）
- 本文に書くこと：
  - 変更の目的と、関係する要件定義書の章
  - 変更内容の要約
  - 追加・変更したテストと、実行した検査（`bun run check` など）の結果
  - 画面の変更があれば、変更前後のスクリーンショット
  - 仕様について判断した点や、確認してほしい点
- コミットは Conventional Commits の形式（`feat:`、`fix:`、`refactor:`、`test:`、`docs:`、`chore:`）
