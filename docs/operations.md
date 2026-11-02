# 運用手順書

本番・検証環境の運用（バックアップと復元、帳票の保存、メールと PDF の設定、失敗に気づく方法）の手順です。
要件定義書の「7. 非機能要件」に対応します。コマンドの `<環境>` は `staging` か `production` です。

## 1. 環境ごとの設定

| 項目             | 開発・テスト                      | 検証・本番                                                      |
| ---------------- | --------------------------------- | --------------------------------------------------------------- |
| 帳票の PDF 化    | `BROWSER` なし：HTML のまま保存   | Browser Rendering（`"browser": { "binding": "BROWSER" }`）      |
| 帳票のメール送付 | `EMAIL` なし：送らずにログに出す  | Email Service（`"send_email": [{ "name": "EMAIL" }]`）          |
| ファイル         | R2 `distribution-files-dev`       | R2 `distribution-files-<環境>`                                  |
| 非同期処理       | Queues `distribution-jobs-dev`    | Queues `distribution-jobs-<環境>`（最大3回まで再試行）          |
| 定期処理         | `wrangler dev` では自動で動かない | Cron `0 18 * * *`（毎日 03:00 日本時間）と `30 * * * *`（毎時） |

- バインディングは `wrangler.jsonc` の `env.staging` / `env.production` にあります。変えたら `bun run cf-typegen` で型を作り直します
- 開発環境で定期処理を試すには、`wrangler dev` の実行中に `curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=0+18+*+*+*"` を実行します

### メールの送信元（Email Service）

1. Cloudflare のダッシュボードで、会社のドメインを Email Service（Email Sending）に登録する
2. 表示される SPF・DKIM のレコードを DNS に追加し、DMARC のレコード（例：`v=DMARC1; p=quarantine; rua=mailto:...`）も追加する
3. `wrangler.jsonc` の `MAIL_FROM`（送信元のアドレス）を登録したドメインのアドレスにする
4. 新しいアカウントは1日の送信数が少なめに設定されるので、稼働前の検証期間から検証環境で送信しておく
5. 送れないときのエラーコード（`E_SENDER_NOT_VERIFIED` など）は送付履歴に日本語の説明つきで残ります

Email Service に問題が出た場合は、`src/infra/mail/mailer.ts` の `Mailer` を実装した Resend の送信に差し替えます（API キーは Secrets に置く）。

### 帳票の PDF 化（Browser Rendering）

- PDF 化は Browser Rendering の Quick Action（`env.BROWSER.quickAction("pdf", …)`）で行います。A4 縦が基本で、横はテンプレートの `orientation` で指定します
- 帳票の HTML は外部のファイルを読みません（スクリプトは無効、`http(s)://` への通信は拒否）。フォントは Browser Rendering に入っている Noto CJK・IPA フォントを使います
- 混み合っている（429・5xx）ときは自動で再試行し、HTML の誤りなど（4xx）は再試行せずに失敗にします

## 2. 帳票の保存（電子帳簿保存法）

### 保存先

| 種類                        | R2 のキー                                         |
| --------------------------- | ------------------------------------------------- |
| 帳票の PDF                  | `documents/<種類>/<取引年>/<番号>-<帳票 ID>.pdf`  |
| 仕入先請求書の添付 PDF      | `supplier-invoices/<請求書 ID>/<ファイル ID>.pdf` |
| 一括 PDF・CSV（処理の結果） | `jobs/<処理 ID>/<ファイル名>`                     |
| 日次バックアップ            | `backups/<YYYY-MM-DD>.json.gz`                    |

仕入先から受け取った請求書の PDF（要件定義書 3.7 Should）は、仕入先請求書の詳細から添付します（PDF だけ、10 MB まで）。
版ごとに `supplier_invoice_attachments` に1行（ファイル名・大きさ・SHA-256・保存した人と日時）を記録し、R2 には版ごとに別のキーで置きます。
保存した版は消さず、上書きもしません。差し替えは新しい版として追加し、画面は最新の版を示します（前の版もダウンロードできる）。
仕入先請求書（請求日・請求額・仕入先）が検索の手がかりになり、取り消した請求書にも添付は残ります（取消の後は追加できない）。
R2 の customMetadata にも SHA-256 を残すので、R2 のファイルだけでも改変がないことを確かめられます。
画面から保存したが記録できなかったファイル（権限や状態の誤り、同じ受付番号の再送信）はすぐに消します。

帳票の索引（種類・番号・取引年月日・金額・取引先・R2 のキー・取消）は業務 DB の `documents` にあり、
「帳票の検索」（`/documents`）で範囲指定と組み合わせで検索できます。取消済みの帳票も消さずに残します。
作成済みの PDF は作り直しません（作り直せるのは、作成に失敗したものだけ）。

### バケットロック（7年保持）

`documents/` に保持ルールを設定し、保存期間中の上書きと削除を防ぎます。
保存期間は法定申告期限から7年なので、余裕をみて8年（2922日）にします（期間は税理士に確認する）。

```sh
# 設定（環境ごとに1回）
npx wrangler r2 bucket lock add distribution-files-<環境> documents-retention documents/ --retention-days 2922
npx wrangler r2 bucket lock add distribution-files-<環境> supplier-invoices-retention supplier-invoices/ --retention-days 2922

# 確認
npx wrangler r2 bucket lock list distribution-files-<環境>
```

設定後、検証環境で次を確かめます（要件定義書 10章の検証項目）。

1. 帳票を1件発行し、PDF ができたら `npx wrangler r2 object delete distribution-files-staging/<キー> --remote` が拒否されること
2. 同じキーへの上書き（`npx wrangler r2 object put ... --remote`）が拒否されること

バケットロックは、設定を変えられる権限があれば外せます。真実性の要件は事務処理規程と組み合わせて満たします（方法は税理士に確認する）。
ロックの対象は `documents/` と `supplier-invoices/` です。`jobs/`（処理の結果）と `backups/` は対象外です。
`supplier-invoices/` をロックすると、記録できなかったファイルを消す処理も拒否されます（その場合は業務 DB に記録のないファイルとして残り、
画面には出ません。ログに `unrecorded attachment left in R2` が出ます）。

## 3. バックアップ

### 毎日のバックアップ（自動）

毎日 03:00（日本時間）に Cron が次を行います（`src/infra/queue/backup.ts`）。

1. 業務 DB（Durable Object の SQLite）の全テーブルを JSON にし、gzip で圧縮して `backups/<YYYY-MM-DD>.json.gz` に保存する
2. 保存期間を過ぎたバックアップを消す（直近30日は毎日の分、それより前は月初の分を7年）
3. 30日より古い受付番号（`idempotency_keys`）を消す

バックアップの形式：

```json
{
  "format": "distribution-system-backup",
  "version": 1,
  "createdAt": "2026-11-01T18:00:00.000Z",
  "tables": { "partners": [{ "id": "...", "name": "...", "is_supplier": 1 }], "...": [] }
}
```

- `tables` のキーは DB のテーブル名、行の列名は DB の列名（snake_case）のまま。真偽値は 0/1、JSON の列は文字列
- ログイン情報（D1）は含みません（D1 の Time Travel で戻す）
- バックアップの成否は「処理状況」（管理者には「日次バックアップ」の行が出る。結果のファイルもここからダウンロードできる）と、管理者のダッシュボード「日次バックアップの異常」に出ます

### 復元

状況に合わせて、次のどれかで戻します。どれも先に**検証環境で**手順を試してから本番で行います。

#### A. 業務 DB を30日以内のある時点に戻す（Durable Objects の特定時点への復元）

Durable Object の SQLite は、過去30日の任意の時点に戻せます（`ctx.storage.getBookmarkForTime()` と
`ctx.storage.onNextSessionRestoreBookmark()`）。業務 DB は1つのオブジェクト（名前 `main`）にまとまっているので、
戻すと全業務データがその時点の状態になります（その後の操作は失われる）。

1. 利用者に操作を止めてもらう（戻した時点より後の操作は失われる）
2. 戻す時刻を決める（例：誤操作の直前。操作履歴 `audit_logs` の日時が手がかりになる）
3. 業務 DB に、指定した時刻のブックマークで復元する処理を一時的に加えたバージョンを、CI から検証環境 → 本番へ配備する
   （`getBookmarkForTime(時刻)` → `onNextSessionRestoreBookmark(ブックマーク)` → `ctx.abort()`。復元用の管理コマンドは未実装）
4. 画面で取引先・帳票などが戻ったことを確かめ、復元用の処理を外したバージョンを配備する
5. 戻した時刻より後に発行した帳票の PDF は R2 に残っています（バケットロックで消せない）。索引にない PDF は「戻した後に発行されたもの」として扱う

#### B. 30日より前の状態や、Durable Object ごと失った場合（日次バックアップから）

1. バックアップを取り出す
   ```sh
   npx wrangler r2 object get distribution-files-<環境>/backups/<YYYY-MM-DD>.json.gz --remote --file backup.json.gz
   gunzip backup.json.gz
   ```
2. 中身を確かめる（`jq '.tables | map_values(length)' backup.json` で各テーブルの件数）
3. 空の業務 DB（新しい環境、または検証環境）に、マイグレーションを適用した状態から行を戻す。
   列名は DB の列名のままなので、`INSERT INTO <テーブル> (<列>) VALUES (...)` で戻せます（今のスキーマには外部キーの制約がない。
   制約を追加した場合は、参照される側のテーブルから戻す）
   （JSON から業務 DB に書き込む管理コマンドは未実装。必要になったら、空の DB にだけ書き込める管理者専用の処理として追加する）
4. 戻した後、帳票の検索で件数と金額の合計がバックアップの時点と一致するか確かめる

#### C. ログイン情報（D1）を戻す

```sh
npx wrangler d1 time-travel info distribution-auth-<環境>
npx wrangler d1 time-travel restore distribution-auth-<環境> --timestamp=<RFC 3339 の日時>
```

D1 にはセッションと Google アカウントの紐づけだけがあり、社員と役割は業務 DB にあります。
戻した後は、利用者にログインし直してもらいます。

### 定期的な復元の訓練

四半期に1回、検証環境で A（特定時点への復元）と B（バックアップからの復元）を試し、かかった時間と問題点をこの手順書に追記します。

## 4. 失敗に気づく方法

| 何が                         | どこに出るか                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| 帳票のメール送付の失敗       | 帳票の詳細の送付履歴（理由つき、再送ボタン）、ダッシュボード「送付に失敗した帳票」                 |
| 帳票の PDF 化の失敗          | 帳票の詳細（理由と、管理者には作り直しボタン）、管理者のダッシュボード「PDF の作成に失敗した帳票」 |
| 一括 PDF・CSV の失敗         | 処理状況（理由つき）、ダッシュボード「失敗した処理（7日間）」                                      |
| 日次バックアップの失敗・遅れ | 処理状況、管理者のダッシュボード「日次バックアップの異常」（失敗、または最後の成功から48時間以上） |
| 想定外のエラー               | Workers のログ（`critical: true`）と、管理者へのメール（同じエラーは1時間に1回まで）               |

- ログは JSON の構造化した形式です（`level`、`message`、`jobId`、`type`、`error`、`stack` など）。
  Workers のダッシュボードの Logs で `level = "error"` や `critical = true`、`message = "job failed"` で検索します
- 管理者へのメールは、有効な管理者全員に送ります（開発環境ではログに出すだけ）
- 再試行で直る失敗（混み合いなど）は、30秒後・2分後に自動でやり直し、3回目で失敗にします
- Worker が途中で止まって結果を記録できなかった処理は、毎時30分の Cron が「1時間以上進まない処理」として失敗にします
  （その処理で送っていた帳票の送付も失敗になり、画面から再送できる）
- ログには取引先のメールアドレスを出しません（宛先は伏せる）

## 5. 処理の上限

- 一括 PDF は一度に500件まで。CSV は2,000件を超えると非同期で作り、最大200,000件まで出力します
- 非同期処理（Queues）の CPU 時間は Workers の上限（初期値30秒）に従います。一括 PDF が上限を超える場合は、
  `wrangler.jsonc` の `limits.cpu_ms` を上げるか、一度にまとめる件数を減らします
