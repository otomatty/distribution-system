/**
 * 開発用のテストデータの投入（要件定義書 9章 テストデータ、7章 規模と性能）。
 *
 * - 入口は業務 DB の Durable Object の seed（開発環境とテストでだけ動く）で、scripts/seed.mjs から
 *   /dev/seed を通して手順を1回ずつ呼ぶ（bun run db:seed、--scale=full で本番の約5倍）
 * - 書き込みはすべて本物のユースケースを、過去の業務日の時刻で実行する（session.ts）。
 *   在庫・引当・状態・採番・操作履歴は画面から操作したときと同じ規則で記録される
 * - 乱数の種は固定（scale.ts の SEED）。同じ基準日（今日）なら毎回同じデータになる
 * - 帳票は索引をすべて登録し、PDF は最近の数日分だけ作る（scale.renderDays）
 *
 * 手順を足すときは STEPS に追加する。請求の区分（請求書・締め処理・入金と消込・返品伝票・販売先廃棄）は、
 * 取引（operations）の後の billing の手順で、同じ期間を1日ずつ進めて作る（billing.ts）。
 */
import { err, ok, type Result } from "../../domain/result";
import { runBilling } from "./billing";
import {
  allItemSpecs,
  allPartnerSpecs,
  hasBusinessData,
  seedItems,
  seedPartners,
  seedSettings,
} from "./masters";
import { runOperations } from "./operations";
import type { SeedRequest, SeedResult, SeedStepPlan } from "./request";
import { SEED_SCALE_DEFS } from "./scale";
import { seedPeriod, SeedSession, type SeedHost, type SeedPeriod } from "./session";
import { seedInitialStock } from "./stock";
import { verifySeed } from "./verify";
import { loadWorld, specDemand } from "./world";

interface SeedStep {
  readonly name: string;
  readonly label: string;
  chunks(period: SeedPeriod): number;
  /** chunk 番目を実行する。戻り値は結果に出す補足（期間など） */
  run(session: SeedSession, chunk: number): Result<string>;
}

const STEPS: readonly SeedStep[] = [
  {
    name: "settings",
    label: "自社設定・税率表・社員・保管場所・払い出し先店舗・ジャンル",
    chunks: () => 1,
    run(session) {
      if (hasBusinessData(session))
        return err(
          "conflict",
          "業務データがすでにあります。--reset を付けて、消してから投入してください",
        );
      seedSettings(session);
      return ok("");
    },
  },
  {
    name: "partners",
    label: "取引先",
    chunks: ({ scale }) =>
      Math.ceil((scale.suppliers + scale.customers + scale.both) / scale.partnersPerChunk),
    run(session, chunk) {
      seedPartners(session, chunk);
      return ok("");
    },
  },
  {
    name: "items",
    label: "商品",
    chunks: ({ scale }) => Math.ceil(scale.items / scale.itemsPerChunk),
    run(session, chunk) {
      const specs = allItemSpecs(session, allPartnerSpecs(session));
      seedItems(session, chunk, specDemand(session.period.scale, specs));
      return ok("");
    },
  },
  {
    name: "initialStock",
    label: "初期在庫",
    chunks: () => 1,
    run(session) {
      seedInitialStock(session, loadWorld(session));
      return ok("");
    },
  },
  {
    name: "operations",
    label: "発注・入荷・受注・発送・在庫操作・仕入先請求書・支払",
    chunks: ({ scale }) => Math.ceil(scale.days / scale.daysPerChunk),
    run(session, chunk) {
      return ok(runOperations(session, chunk));
    },
  },
  {
    name: "billing",
    label: "返品伝票・請求書・締め処理・返還請求書・入金と消込・販売先廃棄",
    chunks: ({ scale }) => Math.ceil(scale.days / scale.daysPerChunk),
    run(session, chunk) {
      return ok(runBilling(session, loadWorld(session), chunk));
    },
  },
];

/** 投入の依頼を処理する（reset は業務 DB の側で行う） */
export function runSeed(
  host: SeedHost,
  request: Exclude<SeedRequest, { action: "reset" }>,
  defaultToday: string,
): Result<SeedResult> {
  if (request.action === "verify") return ok(verifySeed(host.db));
  const scale = SEED_SCALE_DEFS[request.scale];
  const period = seedPeriod(scale, request.today ?? defaultToday);
  if (request.action === "plan") {
    const steps: SeedStepPlan[] = STEPS.map((s) => ({
      name: s.name,
      label: s.label,
      chunks: s.chunks(period),
    }));
    return ok({ action: "plan", scale: scale.name, from: period.from, today: period.today, steps });
  }
  const step = STEPS.find((s) => s.name === request.step);
  if (!step) return err("not_found", `手順「${request.step}」はありません`);
  if (request.chunk >= step.chunks(period))
    return err("validation", `手順「${step.name}」は ${step.chunks(period)} 回までです`);
  const session = new SeedSession(host, period);
  const done = step.run(session, request.chunk);
  if (!done.ok) return done;
  return ok({
    action: "run",
    step: step.name,
    chunk: request.chunk,
    commands: session.commands,
    rejected: session.rejected,
    rejections: session.rejections,
    label: done.value,
  });
}
