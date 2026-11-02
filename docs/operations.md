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
- デプロイ（`.github/workflows/deploy.yml`）は、GitHub のリポジトリの変数 `DEPLOY_ENABLED` が `true` のときだけ動きます。Cloudflare 側の準備（D1・R2・Queues の作成と `wrangler.jsonc` の ID、Secrets）と、GitHub の Secrets（`CLOUDFLARE_API_TOKEN`・`CLOUDFLARE_ACCOUNT_ID`）、Environments（`production` に必須レビュー）を設定してから有効にします
- 開発環境で定期処理を試すには、`wrangler dev` の実行中に `curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=0+18+*+*+*"` を実行します

### Cloudflare のリソースの作成（環境ごとに1回。配置は「アジア太平洋」）

要件定義書 7章のとおり、Durable Objects・D1・R2 は「アジア太平洋」（`apac`）の配置を指定します。
配置の指定は**作るときだけ**効き、後から変えられません（日本国内は保証されません）。作り直すと中身が消えるので、最初に正しく作ります。

| 対象                      | 配置の指定のしかた                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| Durable Object（業務 DB） | コードで指定済み（`src/infra/do/client.ts` の `locationHint: "apac"`）。最初の呼び出しで作られる |
| D1（ログイン情報）        | `wrangler d1 create … --location apac`                                                           |
| R2（ファイル）            | `wrangler r2 bucket create … --location apac`                                                    |

```sh
# <環境> は staging か production。Cloudflare の API トークン（D1・R2・Queues の編集権限）で実行する
npx wrangler d1 create distribution-auth-<環境> --location apac
npx wrangler r2 bucket create distribution-files-<環境> --location apac
npx wrangler queues create distribution-jobs-<環境>

# 確認（D1 は一覧の location、R2 は bucket info の location）
npx wrangler d1 list
npx wrangler r2 bucket info distribution-files-<環境>
```

- `wrangler d1 create` が表示する `database_id` を、`wrangler.jsonc` の `env.<環境>.d1_databases[0].database_id` に書きます。
  **`wrangler.jsonc` の `database_id` はすべて `00000000-0000-0000-0000-000000000000`（仮の値）なので、最初に CI からデプロイする前に、検証と本番の両方を本物の ID に書き換えてコミットしてください**
  （仮の値のままだと、CI の D1 のマイグレーションとデプロイが失敗します。トップレベルの `distribution-auth-dev` は手元の開発用で、`--local` でしか使わないので仮の値のままでよい）
- Durable Object は、デプロイ後に最初に画面を開いた（または Cron が動いた）ときに `apac` に作られます。後から配置は変わりません
- 作った後に、R2 のバケットロック（2章）と Secrets（README の「初回の準備」）を設定し、`DEPLOY_ENABLED` を `true` にします

### メールの送信元（Email Service）

1. Cloudflare のダッシュボードで、会社のドメインを Email Service（Email Sending）に登録する
2. 表示される SPF・DKIM のレコードを DNS に追加し、DMARC のレコード（例：`v=DMARC1; p=quarantine; rua=mailto:...`）も追加する
3. `wrangler.jsonc` の `MAIL_FROM`（送信元のアドレス）を登録したドメインのアドレスにする
4. 新しいアカウントは1日の送信数が少なめに設定されるので、稼働前の検証期間から検証環境で送信しておく
5. 送れないときのエラーコード（`E_SENDER_NOT_VERIFIED` など）は送付履歴に日本語の説明つきで残ります

### メールの送信の切り替え（Email Service ⇔ Resend）

送信の部分は `wrangler.jsonc` の変数 `MAIL_PROVIDER` で選びます（`src/infra/mail/mailer.ts`）。値は送信のたびに検証し、誤りがあれば送付は
「メールの送信の設定が正しくありません」で失敗します（送付履歴に残り、設定を直した後に画面から再送できる）。

| `MAIL_PROVIDER`         | 送信の部分                                            | 必要なもの                                                              |
| ----------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| `email_service`（既定） | Cloudflare Email Service（バインディング `EMAIL`）    | `send_email` のバインディング（開発・テストでは付けず、ログに出すだけ） |
| `resend`（予備）        | Resend の REST API（`https://api.resend.com/emails`） | Secrets の `RESEND_API_KEY`、Resend で確認済みの送信元のドメイン        |

Email Service（ベータ）で問題が出たら、次の手順で Resend に切り替えます。先に検証環境で切り替え、帳票を1件送って届くことを確かめてから本番で行います。

1. Resend に会社のドメインを登録し、表示される SPF・DKIM のレコードを DNS に追加する（`MAIL_FROM` のドメイン。DMARC は Email Service と共通）
2. Resend で送信だけの権限の API キーを作り、Secrets に入れる
   ```sh
   npx wrangler secret put RESEND_API_KEY --env <環境>
   ```
3. `wrangler.jsonc` の `env.<環境>.vars.MAIL_PROVIDER` を `"resend"` にして PR を出し、CI から配備する
4. 帳票を1件メールで送り、送付履歴が「送付済み」になって届くことを確かめる。失敗した送付は帳票の詳細から再送する
5. Email Service に戻すときは `MAIL_PROVIDER` を `"email_service"` に戻して配備し、`npx wrangler secret delete RESEND_API_KEY --env <環境>` で API キーを消す（Resend の側でもキーを無効にする）

- Resend へは、送付履歴の ID を `Idempotency-Key` に付けて送ります。Queues の再試行で同じ送付が重ねて届いても、24時間は1通だけ送られます
- Resend のエラー（`validation_error`、`daily_quota_exceeded` など）は、送付履歴に日本語の説明と名前つきで残ります。混み合い（429）と 5xx は自動で再試行します
- 添付を含めて1通 40MB（Base64 にした後）までです（Email Service は 25MiB）
- 重大なエラーの管理者への通知も、同じ送信の部分を使います

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
| 業務 DB の復元の記録        | `restores/<復元の ID>.json`（3章の A）            |

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
ロックの対象は `documents/` と `supplier-invoices/` です。`jobs/`（処理の結果）・`backups/`・`restores/`（復元の記録。戻ったときに書き直す）は対象外です。
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

Durable Object の SQLite は、過去30日の任意の時点に戻せます。業務 DB は1つのオブジェクト（名前 `main`）にまとまっているので、
戻すと全業務データ（社員と役割、受付番号、処理状況、操作履歴を含む）がその時点の状態になり、その後の操作はすべて失われます。
画面の「管理 › 業務 DB の復元」（`/admin/restore`、`platform.admin` の管理者だけ）から行います。

仕組み（`src/infra/do/restore.ts`、`src/infra/do/business-db.ts`）：

1. `ctx.storage.getBookmarkForTime(時刻)` で戻す時刻のブックマークを取り、`ctx.storage.onNextSessionRestoreBookmark(ブックマーク)` で、
   次に開いたときにその状態に戻すよう予約する（戻り値は取り消し用のブックマーク）
2. 依頼の記録を R2 の `restores/<復元の ID>.json`（戻しても消えない）、Workers のログ（`point-in-time restore scheduled`）、操作履歴に残す
3. 同じ呼び出しの中で、すぐに `ctx.abort()` で Durable Object を作り直す。次の要求で開き直したときに、予約した時点の状態に戻る
   （予約したまま動き続けると、いつか作り直されたときにその間の操作が消えるので、予約と作り直しの間はあけない）
4. 戻った業務 DB に、戻したこと（依頼した人・理由・戻した時刻・取り消し用のブックマーク）を操作履歴として残す
   （2 で書いた操作履歴が消えていれば戻ったと判断する。戻した時刻はそれより前なので）

安全のための決まり：

- 戻す時刻を選ぶと、戻すと失われる操作（操作履歴）の件数と新しいもの20件を出す
- 確認のため、戻す日時を日本時間の秒まで（`2026-11-02 09:15:00` の形）そのまま入力し、理由を書かないと戻せない
- 戻せるのは今より前で、過去30日以内だけ
- **本番の追加の鍵**：本番（`ENVIRONMENT` が `development`・`test`・`staging` のどれでもない環境。`--env` なしで配備したものも含む）では、
  管理者の操作に加えて、運用担当（Cloudflare の権限を持つ人）が Secrets の `RESTORE_UNLOCK_UNTIL` に
  「今から24時間以内の時刻」（ISO 8601）を入れている間だけ戻せる。画面の権限だけでは本番を戻せず、鍵は時間がたつと自動で閉じる
- 同じ画面の送信（同じ受付番号）を二重に送っても、予約は1回だけ

手順：

1. 利用者に操作を止めてもらう（戻した時点より後の操作は失われる）
2. 戻す時刻を決める（例：誤操作の直前。「管理 › 操作履歴」で対象の番号や操作した人で探し、その日時の少し前にする）
3. 本番では、運用担当が鍵を開ける（検証環境では不要）
   ```sh
   # 今から1時間だけ開ける例（24時間より先の時刻は受け付けない）
   date -u -d '+1 hour' +%Y-%m-%dT%H:%M:%SZ | npx wrangler secret put RESTORE_UNLOCK_UNTIL --env production
   ```
4. 管理者が「業務 DB の復元」で戻す日時を選び、「戻すと失われる操作を確かめる」を押す。件数と内容を確かめる
5. 確認の欄に戻す日時をそのまま入力し、理由を書いて「業務 DB をこの日時に戻す」を押す。記録の画面に移る
   - 「業務 DB を … の状態に戻しました」と出れば終わり
   - 「まだ戻ったことを確かめられていません」と出たら、少し待ってから「戻ったか確かめる」を押す
6. 画面で取引先・帳票・在庫などが戻ったことを確かめ、利用者に再開してもらう
7. 本番では、運用担当が鍵を消す：`npx wrangler secret delete RESTORE_UNLOCK_UNTIL --env production`
8. 戻した時刻より後に発行した帳票の PDF は R2 に残っています（バケットロックで消せない）。索引にない PDF は「戻した後に発行されたもの」として扱う。
   社員と役割も業務 DB にあるので戻る。戻した時刻より後に登録・変更した社員は、管理者が登録し直す（ログイン情報（D1）は戻らないが、次のログインで社員と結びつき直す）

戻したのを取り消すとき（戻す前の状態に戻す）は、記録の画面にある「取り消し用のブックマーク」を使います。
画面からは行えないので、検証環境で手順を確かめたうえで、`onNextSessionRestoreBookmark(取り消し用のブックマーク)` → `ctx.abort()` を
一時的に呼ぶ処理を CI から配備して行います（必要になったら管理者の操作として追加する）。

これまでの復元は、画面の「これまでの復元」（R2 の `restores/`）と、Workers のログの `point-in-time restore` で確かめられます。

**手元と自動テストでは戻せません**：Durable Object の Point-in-Time Recovery は手元（`wrangler dev`・Vitest の Miniflare）では使えず、
「この環境では特定の時点への復元を使えません」と出ます。結合テスト（`tests/integration/restore.test.ts`）は、
storage の API を `PointInTimeRecovery` に差し替えて、予約・記録・確認・本番の鍵を確かめています。実際に戻ることは検証環境で試します。

##### 検証環境での試し方（四半期ごとの訓練）

1. 検証環境（`https://distribution-staging.example.co.jp`）に管理者でログインする
2. 目印のデータを作る：取引先を1件登録し（名前に日時を入れる）、その日時を控える。1分ほど待ってから、その取引先の名前を変える
3. 「業務 DB の復元」で、名前を変える前（登録の後）の日時を選び、失われる操作に「取引先 › 更新」が出ることを確かめる
4. 確認の日時と理由（「復元の訓練」）を入れて戻す。記録の画面で「戻しました」と出るまでの時間を控える
5. 取引先の名前が登録したときのものに戻っていること、「操作履歴」に「特定の時点への復元」が1件あることを確かめる
6. かかった時間と問題点を、下の「定期的な復元の訓練」に追記する

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

四半期に1回、検証環境で A（特定時点への復元。上の「検証環境での試し方」）と B（バックアップからの復元）を試し、かかった時間と問題点をこの手順書に追記します。

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
