// 開発用のテストデータを投入する（要件定義書 9章 テストデータ、7章 規模と性能）。
// 手元の wrangler dev（--local）の /dev/seed を、手順ごとに少しずつ呼ぶ（開発環境とテストだけで使える）。
//
// 使い方：
//   bun run db:seed                     小さい量（本番と同じくらいのマスタと、約3か月分の取引。毎日の開発用）
//   bun run db:seed -- --scale=full     本番の約5倍（商品 2,500・取引先 1,000・受注 約11万件・発注 約4万件の3年分）
//   bun run db:seed -- --reset          業務データを消してから入れる（データがあると投入しない）
//   --today=YYYY-MM-DD   取引の最終日（省略すると今日）。同じ日なら毎回同じデータになる
//   --url=http://localhost:8787   投入先。動いていなければ、このスクリプトが wrangler dev を起動して、終わったら止める
//   --persist-to=.wrangler/state  wrangler dev を起動するときのデータの置き場所（bun run dev と同じ場所が既定）
//   --skip-to=operations:59      途中で止まった投入を、その手順の回から続ける
import { spawn } from "node:child_process";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.length > 0 ? v.join("=") : "true"];
  }),
);

const scale = args.scale ?? "small";
const today = args.today ?? new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
let base = (args.url ?? process.env.SEED_URL ?? "http://localhost:8787").replace(/\/$/, "");

async function reachable(url) {
  try {
    const res = await fetch(`${url}/login`, { redirect: "manual" });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function startServer() {
  const port = Number(args.port ?? 8799);
  const persist = args["persist-to"];
  const cmd = [
    "wrangler",
    "dev",
    "--local",
    "--port",
    String(port),
    "--var",
    "ENVIRONMENT:development",
    ...(persist ? ["--persist-to", persist] : []),
  ];
  console.log(`wrangler dev を起動します（ポート ${port}）…`);
  const child = spawn("npx", cmd, { stdio: ["ignore", "ignore", "inherit"], detached: true });
  const url = `http://localhost:${port}`;
  for (let i = 0; i < 120; i += 1) {
    if (await reachable(url)) return { child, url };
    await new Promise((r) => setTimeout(r, 1000));
  }
  process.kill(-child.pid);
  throw new Error("wrangler dev が起動しませんでした");
}

class SeedError extends Error {}

async function callOnce(body) {
  const res = await fetch(`${base}/dev/seed`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify(body),
  });
  if (res.status === 404)
    throw new SeedError(
      "/dev/seed が見つかりません。ENVIRONMENT が development の wrangler dev か確かめてください",
    );
  // wrangler dev が途中で再起動すると 503 などの JSON でない応答になる（やり直す）
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`応答が JSON ではありません（${res.status}）`);
  }
  if (!json.ok) throw new SeedError(json.error?.message ?? `投入に失敗しました（${res.status}）`);
  return json.value;
}

/**
 * 通信の失敗や wrangler dev の再起動は、サーバーが戻るのを待ってやり直す。
 * 手順の1回分は業務 DB の側で「済み」の印と一緒に確定するので、やり直しても二重に投入しない
 */
async function call(body) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await callOnce(body);
    } catch (e) {
      if (e instanceof SeedError || attempt >= 5) throw e;
      console.log(`  （${e instanceof Error ? e.message : String(e)}。やり直します）`);
      for (let i = 0; i < 60 && !(await reachable(base)); i += 1)
        await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)}秒`;
}

async function main() {
  let server = null;
  if (!(await reachable(base))) {
    server = await startServer();
    base = server.url;
  }
  const started = Date.now();
  let failed = false;
  try {
    if (args.reset === "true") {
      console.log("業務データを消しています…");
      await call({ action: "reset" });
    }
    const plan = await call({ action: "plan", scale, today });
    console.log(
      `テストデータ（${plan.scale}）：${plan.from}〜${plan.today} を ${base} に投入します`,
    );
    let commands = 0;
    let rejected = 0;
    // --skip-to=operations:59 で、途中の手順から続ける（それより前の手順は実行済みとみなす）
    const [skipStep, skipChunk] = (args["skip-to"] ?? "").split(":");
    let skipping = Boolean(skipStep);
    for (const step of plan.steps) {
      const stepStarted = Date.now();
      for (let chunk = 0; chunk < step.chunks; chunk += 1) {
        if (skipping && step.name === skipStep && chunk >= Number(skipChunk ?? 0)) skipping = false;
        if (skipping) continue;
        const t = Date.now();
        const r = await call({ action: "run", scale, today, step: step.name, chunk });
        commands += r.commands;
        rejected += r.rejected;
        const where = r.label ? ` ${r.label}` : "";
        console.log(
          `  ${step.label} ${chunk + 1}/${step.chunks}${where}：${r.commands}件（${seconds(Date.now() - t)}）${r.rejected > 0 ? ` 記録できなかった操作 ${r.rejected}件` : ""}`,
        );
        for (const reason of r.rejections) console.log(`    - ${reason}`);
      }
      console.log(`${step.label}：${seconds(Date.now() - stepStarted)}`);
    }
    const verify = await call({ action: "verify" });
    console.log("\n件数：");
    for (const [name, n] of Object.entries(verify.counts))
      console.log(`  ${name}：${n.toLocaleString("ja-JP")}`);
    console.log("\n整合の確認：");
    for (const c of verify.checks) {
      console.log(`  ${c.ok ? "OK" : "NG"} ${c.name}${c.ok ? "" : `（${c.mismatches}件）`}`);
      for (const s of c.sample) console.log(`    - ${s}`);
    }
    console.log(
      `\n実行したユースケース ${commands.toLocaleString("ja-JP")}件、記録できなかった操作 ${rejected}件、${seconds(Date.now() - started)}`,
    );
    failed = !verify.ok;
  } finally {
    if (server) process.kill(-server.child.pid);
  }
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
