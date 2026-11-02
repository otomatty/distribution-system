/**
 * 在庫一覧の CSV は、ほかの一覧と同じ仕組み（web/csv-exports.ts）で出す。
 * 2,000件までならその場で返し、それより多ければ非同期で作る（以前は2万行で黙って打ち切っていた）。
 */
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { describe, expect, it } from "vitest";

import * as schema from "../../src/infra/db/schema";
import { businessDb } from "../../src/infra/do/client";
import { CSV_ASYNC_THRESHOLD } from "../../src/web/csv-exports";
import {
  addInitialStock,
  createItem,
  createLocation,
  createSupplier,
  uniqueName,
} from "./fixtures";
import { as, createEmployee, newKey } from "./helpers";
import { jobRow, pendingJobIds, runJobs } from "./platform-helpers";

describe("在庫一覧の CSV", () => {
  it("一覧の結果の欄に、今の絞り込み条件を持つ CSV のボタンを置き、少なければその場で返す", async () => {
    const user = await createEmployee(["sales"]);
    const supplierId = await createSupplier();
    const tag = uniqueName("在庫CSV");
    const item = await createItem(supplierId, { name: `${tag}商品` });
    const locationId = await createLocation();
    await addInitialStock(locationId, [{ itemId: item.id, quantity: 7 }]);
    const page = await (
      await as(user).get(`/stock?q=${encodeURIComponent(tag)}&locationId=${locationId}`)
    ).text();
    const results = page.slice(page.indexOf('<section id="results">'));
    expect(results).toContain('action="/stock/csv"');
    expect(results).toContain(`<input type="hidden" name="q" value="${tag}"/>`);
    expect(results).toContain(`<input type="hidden" name="locationId" value="${locationId}"/>`);
    const res = await as(user).post("/stock/csv", { _key: newKey(), q: tag, locationId });
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    const lines = (await res.text()).split("\r\n").filter((l) => l !== "");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(`${item.code},,${tag}商品`);
    expect(lines[1]).toContain(",7,0,7,0,");
  });

  it(`${CSV_ASYNC_THRESHOLD}件を超えると非同期で作り、すべての行を出す`, async () => {
    const user = await createEmployee(["sales"]);
    const supplierId = await createSupplier();
    const locationId = await createLocation();
    const tag = uniqueName("ZCSV");
    const count = CSV_ASYNC_THRESHOLD + 1;
    // 在庫の行（現在庫 0）を直接足す（台帳の合計 0 と集計表の現在庫 0 は一致したまま）
    await runInDurableObject(businessDb(env), (_instance, state) => {
      const db = drizzle(state.storage, { schema });
      const at = new Date().toISOString();
      const audit = { createdAt: at, createdBy: "system", updatedAt: at, updatedBy: "system" };
      db.transaction((tx) => {
        for (let i = 0; i < count; i += 1) {
          const id = `${tag}-${String(i).padStart(5, "0")}`;
          tx.insert(schema.items)
            .values({
              id,
              code: id,
              name: `${tag}の商品${i}`,
              supplierId,
              taxCategory: "reduced",
              purchaseUnitName: "ケース",
              salesUnitName: "個",
              purchasePriceCenti: 100,
              salesPriceCenti: 100,
              ...audit,
            })
            .run();
          tx.insert(schema.stockBalances)
            .values({ itemId: id, locationId, onHand: 0, allocated: 0, updatedAt: at })
            .run();
        }
      });
    });
    const key = newKey();
    const res = await as(user).post("/stock/csv", { _key: key, q: tag });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/jobs?notice=csv");
    const jobs = await pendingJobIds("export_csv");
    expect(jobs).toHaveLength(1);
    await runJobs(jobs);
    const job = await jobRow(jobs[0] ?? "");
    expect(job).toMatchObject({ status: "succeeded", progress: count, total: count });
    expect(job?.resultName).toMatch(/^在庫一覧_\d{4}-\d{2}-\d{2}\.csv$/);
    const object = await env.FILES.get(job?.resultKey ?? "");
    const text = new TextDecoder().decode(
      new Uint8Array((await object?.arrayBuffer()) ?? new ArrayBuffer(0)),
    );
    const lines = text.split("\r\n").filter((l) => l !== "");
    expect(lines).toHaveLength(count + 1);
    expect(lines[0]?.startsWith("商品コード,JAN,商品名,")).toBe(true);
    // 商品コードの順で、ページの境目でも行が重ならない
    const codes = lines.slice(1).map((l) => l.split(",")[0]);
    expect(new Set(codes).size).toBe(count);
    expect(codes[0]).toBe(`${tag}-00000`);
    expect(codes.at(-1)).toBe(`${tag}-${String(count - 1).padStart(5, "0")}`);
  });
});
