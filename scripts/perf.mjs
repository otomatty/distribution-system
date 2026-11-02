// 主な画面の速さを測る（要件定義書 7章 規模と性能、docs/performance.md）。
// テストデータ（bun run db:seed -- --scale=full）を入れた手元の wrangler dev に、開発用ログインで
// 一覧・詳細・集計・CSV を数回ずつ要求し、応答までの時間（中央値・最大）と大きさを表にする。
//
// 使い方：node scripts/perf.mjs [--url=http://localhost:8787] [--runs=5] [--email=admin@example.co.jp]
//         [--only=集計]（名前に含む項目だけ） [--today=YYYY-MM-DD]（発送リストの日付。既定は今日）
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.length > 0 ? v.join("=") : "true"];
  }),
);
const base = (args.url ?? "http://localhost:8787").replace(/\/$/, "");
const runs = Number(args.runs ?? 5);
const email = args.email ?? "admin@example.co.jp";
const today = args.today ?? new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const headers = { Cookie: `dev_actor=${encodeURIComponent(email)}`, Origin: base };

async function request(path, form) {
  const started = performance.now();
  const res = await fetch(base + path, {
    method: form ? "POST" : "GET",
    redirect: "manual",
    headers: form ? { ...headers, "Content-Type": "application/x-www-form-urlencoded" } : headers,
    body: form ? new URLSearchParams(form) : undefined,
  });
  const body = new Uint8Array(await res.arrayBuffer());
  return { ms: performance.now() - started, status: res.status, bytes: body.length, body, res };
}

async function firstId(path, pattern) {
  const { body } = await request(path);
  const m = new TextDecoder().decode(body).match(pattern);
  if (!m) throw new Error(`${path} から ID を見つけられませんでした`);
  return m[1];
}

const ID = "([0-9A-HJKMNP-TV-Z]{26})";

/** YYYY-MM に n か月を足す */
function addMonths(ym, n) {
  const d = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

/** YYYY-MM の初日と末日 */
function monthDays(ym) {
  const last = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0));
  return { from: `${ym}-01`, to: last.toISOString().slice(0, 10) };
}

async function main() {
  const login = await request("/");
  if (login.status !== 200)
    throw new Error(`ログインできません（${login.status}）。${email} は登録済みですか`);
  const mainId = await firstId(
    "/masters/locations",
    new RegExp(`/masters/locations/${ID}"[^>]*>本社倉庫`),
  );
  const supplierId = await firstId("/partners?role=supplier", new RegExp(`/partners/${ID}"`));
  const customerId = await firstId("/partners?role=customer", new RegExp(`/partners/${ID}"`));
  const poId = await firstId("/purchase-orders?status=paid", new RegExp(`/purchase-orders/${ID}"`));
  const orderedPoId = await firstId(
    "/purchase-orders?status=ordered",
    new RegExp(`/purchase-orders/${ID}"`),
  );
  const soId = await firstId("/sales-orders?status=shipped", new RegExp(`/sales-orders/${ID}"`));
  const itemId = await firstId("/stock", new RegExp(`/stock/${ID}[?"]`));
  const invoiceId = await firstId("/invoices?status=paid", new RegExp(`/invoices/${ID}"`));
  const month = today.slice(0, 7);
  // 1年前の月（データがそろっている月）
  const ago = monthDays(addMonths(month, -12));
  const scenarios = [
    { name: "ダッシュボード（管理者）", path: "/" },
    { name: "発注一覧", path: "/purchase-orders" },
    { name: "発注一覧（状態：発注済み）", path: "/purchase-orders?status=ordered" },
    { name: "発注一覧（仕入先）", path: `/purchase-orders?supplierId=${supplierId}` },
    { name: "発注一覧（1か月）", path: `/purchase-orders?from=${ago.from}&to=${ago.to}` },
    {
      name: "発注一覧（キーワード）",
      path: `/purchase-orders?q=${encodeURIComponent("せんべい")}`,
    },
    { name: "発注一覧（納品希望日を過ぎた）", path: "/purchase-orders?overdue=1" },
    { name: "発注一覧（800ページ目）", path: "/purchase-orders?page=800" },
    { name: "発注詳細", path: `/purchase-orders/${poId}` },
    { name: "入荷予定一覧", path: "/receiving" },
    { name: "入荷確認", path: `/receiving/${orderedPoId}` },
    { name: "仕入先請求書一覧", path: "/supplier-invoices" },
    { name: "支払予定一覧", path: "/payables" },
    { name: "買掛残高", path: "/payables/balances" },
    { name: "受注一覧", path: "/sales-orders" },
    { name: "受注一覧（状態：受注済み）", path: "/sales-orders?status=received" },
    { name: "受注一覧（販売先）", path: `/sales-orders?customerId=${customerId}` },
    { name: "受注一覧（キーワード）", path: `/sales-orders?q=${encodeURIComponent("羊羹")}` },
    { name: "受注一覧（出荷可能数が足りない）", path: "/sales-orders?shortage=1" },
    { name: "受注一覧（2000ページ目）", path: "/sales-orders?page=2000" },
    { name: "受注詳細", path: `/sales-orders/${soId}` },
    { name: "発送リスト（今日・本社倉庫）", path: `/shipping?date=${today}&locationId=${mainId}` },
    { name: "在庫一覧", path: "/stock" },
    { name: "在庫一覧（キーワード）", path: `/stock?q=${encodeURIComponent("せんべい")}` },
    { name: "在庫明細（商品の台帳）", path: `/stock/${itemId}` },
    { name: "棚卸の入力表（本社倉庫）", path: `/stock/stocktaking?locationId=${mainId}` },
    { name: "在庫操作の履歴", path: "/stock/operations" },
    { name: "商品一覧", path: "/items" },
    { name: "商品一覧（キーワード）", path: `/items?q=${encodeURIComponent("せんべい")}` },
    {
      name: "商品選択ダイアログ（検索）",
      path: `/items/picker?pickerId=so&q=${encodeURIComponent("せんべい")}`,
    },
    { name: "取引先一覧", path: "/partners" },
    { name: "取引先一覧（キーワード）", path: `/partners?q=${encodeURIComponent("みなと")}` },
    { name: "帳票の検索", path: "/documents" },
    {
      name: "帳票の検索（取引先名）",
      path: `/documents?partnerQuery=${encodeURIComponent("みなと")}`,
    },
    {
      name: "帳票の検索（期間・金額）",
      path: `/documents?dateFrom=${ago.from}&dateTo=${ago.to}&amountMin=10000`,
    },
    { name: "処理状況", path: "/jobs" },
    { name: "請求書一覧", path: "/invoices" },
    { name: "請求書一覧（状態：未入金）", path: "/invoices?status=unpaid" },
    { name: "請求書一覧（販売先）", path: `/invoices?customerId=${customerId}` },
    {
      name: "請求書一覧（発行日の1か月）",
      path: `/invoices?issuedFrom=${ago.from}&issuedTo=${ago.to}`,
    },
    { name: "請求書一覧（支払期限を過ぎた）", path: "/invoices?overdue=1" },
    { name: "請求書一覧（500ページ目）", path: "/invoices?page=500" },
    { name: "請求書詳細", path: `/invoices/${invoiceId}` },
    { name: "未請求の発送", path: "/invoices/new" },
    { name: "締め処理", path: "/invoices/closing" },
    { name: "入金一覧", path: "/receipts" },
    { name: "売掛残高", path: "/receivables" },
    { name: "入金予定", path: "/receivables/schedule" },
    { name: "廃棄伝票一覧", path: "/disposals" },
    { name: "廃棄率（今月・販売先×商品）", path: "/disposals/rates" },
    {
      name: "廃棄率（12か月・商品別）",
      path: `/disposals/rates?from=${monthDays(addMonths(month, -11)).from}&to=${today}&groupBy=item`,
    },
    {
      name: "廃棄率（12か月・販売先別・出荷のみも含む）",
      path: `/disposals/rates?from=${monthDays(addMonths(month, -11)).from}&to=${today}&groupBy=customer&all=1`,
    },
    { name: "集計（販売先別・12か月）", path: "/reports" },
    { name: "集計（商品別・12か月）", path: "/reports?view=sales_item" },
    { name: "集計（仕入先別の仕入・12か月）", path: "/reports?view=purchases_supplier" },
    {
      name: "集計（商品別・36か月）",
      path: `/reports?view=sales_item&from=${addMonths(month, -35)}&to=${month}`,
    },
    {
      name: "CSV：発注一覧（1か月）",
      path: "/purchase-orders/csv",
      form: { from: ago.from, to: ago.to },
    },
    {
      name: "CSV：受注一覧（出荷予定日の1週間）",
      path: "/sales-orders/csv",
      form: { shipFrom: ago.from, shipTo: ago.from.replace(/-01$/, "-07") },
    },
    { name: "CSV：在庫一覧", path: "/stock/csv", form: {} },
    {
      name: "CSV：請求書一覧（発行日の1か月）",
      path: "/invoices/csv",
      form: { issuedFrom: ago.from, issuedTo: ago.to },
    },
    { name: "CSV：売掛残高", path: "/receivables/csv", form: {} },
    {
      name: "CSV：集計（販売先別・12か月）→ 非同期",
      path: "/reports/csv",
      form: { view: "sales_customer" },
    },
  ].filter((x) => !args.only || x.name.includes(args.only));

  console.log(`| 画面 | 中央値 | 最大 | 応答 | 大きさ |`);
  console.log(`| --- | ---: | ---: | --- | ---: |`);
  for (const { name, path, form } of scenarios) {
    const times = [];
    let last;
    // 1回目は捨てる（Worker の読み込みと SQLite のキャッシュ）
    for (let i = 0; i <= runs; i += 1) {
      const r = await request(path, form ? { ...form, _key: crypto.randomUUID() } : undefined);
      if (i > 0) times.push(r.ms);
      last = r;
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    const max = times[times.length - 1];
    const status =
      last.status >= 300 && last.status < 400
        ? `${last.status} → ${last.res.headers.get("Location")}`
        : String(last.status);
    const size =
      last.bytes > 1024 * 1024
        ? `${(last.bytes / 1024 / 1024).toFixed(1)}MB`
        : `${Math.round(last.bytes / 1024)}KB`;
    console.log(
      `| ${name} | ${Math.round(median)}ms | ${Math.round(max)}ms | ${status} | ${size} |`,
    );
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
