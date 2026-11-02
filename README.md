# 流通管理システム

菓子・食品の仕入・在庫・販売を扱う社内向けの業務システムです。発注・入荷・支払、受注・発送・請求・入金、在庫、販売先廃棄を1つの画面で扱います。

- 要件：[docs/requirements.md](docs/requirements.md)（正本は [要件定義書](https://claude.ai/artifact/474X7tYjok4fdwbi4TgcLV)）
- 開発のルール：[AGENTS.md](AGENTS.md)

## 構成

| 区分       | 採用                                                   |
| ---------- | ------------------------------------------------------ |
| 画面と API | Hono + htmx（JSX でサーバー側描画）                    |
| 実行環境   | Cloudflare Workers                                     |
| 業務 DB    | Durable Objects の SQLite（Drizzle）                   |
| ログイン   | Better Auth + Google（Workspace のドメインに限定）、D1 |
| ファイル   | R2（帳票 PDF、CSV、バックアップ）                      |
| 非同期処理 | Queues、Cron Triggers                                  |
| 帳票       | Browser Rendering で PDF 化                            |
| メール     | Cloudflare Email Service                               |

## 手元での開発

必要なもの：Node.js 22 と Bun（`mise install` で入ります）

```sh
bun install
cp .dev.vars.example .dev.vars   # 値を入れる（開発用ログインだけなら空でもよい）
bun run dev                      # http://localhost:8787
```

`/dev/login` から、登録済みの社員のメールアドレスでログインできます（開発環境とテストだけで有効）。最初の管理者は `wrangler.jsonc` の `INITIAL_ADMIN_EMAIL` です。

### テストデータ

```sh
bun run db:seed                    # 本番と同じくらいのマスタと、約3か月分の取引（毎日の開発用、30秒ほど）
bun run db:seed -- --scale=full    # 本番の約5倍（商品 2,500・取引先 1,000・受注 約11万件・発注 約4万件の3年分。速度の確認用）
bun run db:seed -- --reset         # 業務データを消してから入れ直す（データがあると投入しない）
```

- 取引は、発注・分納・仕入返品・仕入先請求書と支払、受注・メーカー直・分割・発送、在庫操作・棚卸、請求書（発送ごと・締め処理）・返品伝票・返還請求書・入金と消込（一部入金・振込手数料・期限超過を含む）・販売先廃棄です
- 取引先・商品・住所・電話番号はすべて架空です（社名に「サンプル」「見本」など、メールは example.co.jp）。乱数の種は固定で、取引の最終日（`--today=YYYY-MM-DD`、省略すると今日）が同じなら毎回同じデータになります
- `bun run dev` が動いていればそこへ、動いていなければ自分で wrangler dev を起動して投入し、終わったら止めます。投入の最後に、在庫・引当・状態・採番の整合を確かめて表示します
- ログインは `/dev/login` から：`admin@example.co.jp`（管理者）、`purchasing1@example.co.jp`（仕入担当）、`sales1@example.co.jp`（受注・出荷担当）、`warehouse1@example.co.jp`（倉庫）、`accounting1@example.co.jp`（経理担当）、`multi1@example.co.jp`（仕入と受注・出荷の兼任）など（`src/infra/seed/names.ts`）
- 帳票の PDF は最近の2日分だけ作ります。それより前の帳票は、帳票の画面の「PDF の作成をやり直す」で作れます
- 画面の速さは `bun run perf` で測れます（[docs/performance.md](docs/performance.md)）

## 検査

```sh
bun run check      # 整形・lint・型・テスト・未使用コードの検出
bun run test:e2e   # E2E テスト（Playwright）
```

## 配備

`main` への push で検証環境に自動で配備し、本番は承認の後に配備します（`.github/workflows/deploy.yml`）。手元から本番に配備しないでください。

初回の準備：

1. Cloudflare で D1（`AUTH_DB`）、R2（`FILES`、7年のバケットロック）、Queues（`JOBS`）を作り、`wrangler.jsonc` の ID を書き換える
2. 秘密情報を登録する：`wrangler secret put BETTER_AUTH_SECRET` / `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`（`--env staging` と `--env production` のそれぞれ）
3. Google Cloud で OAuth クライアント（社内向けの同意画面）を作り、リダイレクト URI に `https://<ドメイン>/api/auth/callback/google` を登録する
4. GitHub の Environments に `staging` と `production`（必須レビューつき）を作り、`CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` を登録する
