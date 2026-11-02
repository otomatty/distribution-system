/**
 * 帳票の検索（電子帳簿保存法：取引年月日・金額・取引先の範囲指定と組み合わせ）と、その CSV 出力。
 */
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "../../src/infra/db/schema";
import { businessDb } from "../../src/infra/do/client";
import { documentPort, jobPort } from "../../src/infra/do/document-port";
import type { QueryInput } from "../../src/usecases/registry";
import { as, createEmployee, newKey, systemCommand, systemQuery } from "./helpers";
import {
  createTestPartner,
  issueDocument,
  runJobs,
  sendRows,
  useTestTemplates,
} from "./platform-helpers";

let restoreTemplates: () => void;
let partnerA: string;
let partnerB: string;
const ids: Record<string, string> = {};

beforeAll(async () => {
  restoreTemplates = useTestTemplates([
    "purchase_order",
    "delivery_note",
    "invoice",
    "credit_note",
  ]);
  partnerA = await createTestPartner({ name: "検索テスト商店A" });
  partnerB = await createTestPartner({ name: "検索テスト商店B" });
  const docs = [
    {
      key: "po1",
      documentType: "purchase_order",
      number: "PO-2026-100001",
      partnerId: partnerA,
      transactionDate: "2026-10-01",
      amount: 5000,
    },
    {
      key: "po2",
      documentType: "purchase_order",
      number: "PO-2026-100002",
      partnerId: partnerB,
      transactionDate: "2026-10-15",
      amount: 12000,
    },
    {
      key: "dn1",
      documentType: "delivery_note",
      number: "DN-2026-100001",
      partnerId: partnerA,
      transactionDate: "2026-10-20",
      amount: 30000,
    },
    {
      key: "inv1",
      documentType: "invoice",
      number: "INV-2026-100001",
      partnerId: partnerA,
      transactionDate: "2026-10-31",
      amount: 45000,
    },
    {
      key: "inv2",
      documentType: "invoice",
      number: "INV-2026-100002",
      partnerId: partnerB,
      transactionDate: "2026-11-01",
      amount: 8000,
    },
  ] as const;
  for (const d of docs) {
    const { key, ...input } = d;
    const issued = await issueDocument(input);
    ids[key] = issued.documentId;
    await runJobs(issued.jobIds);
  }
  // inv1 は取消済み、dn1 は送付済み
  await runInDurableObject(businessDb(env), (_instance, state) => {
    const db = drizzle(state.storage, { schema });
    const meta = { at: new Date().toISOString(), by: "system" };
    documentPort(
      db,
      meta,
      () => crypto.randomUUID(),
      jobPort(db, meta, () => "", []),
    ).cancel(ids["inv1"] ?? "");
  });
  await systemCommand("documents.recordManualSend", { documentId: ids["dn1"] ?? "", note: null });
});
afterAll(() => restoreTemplates());

/** このファイルで発行した帳票だけ */
function mine(numbers: string[]): string[] {
  return numbers.filter((n) => n.includes("-2026-1000"));
}

async function search(filter: QueryInput<"documents.search">) {
  const page = await systemQuery("documents.search", filter);
  return page.rows.map((r) => r.number);
}

describe("帳票の検索", () => {
  it("取引年月日・金額の範囲、取引先、種類、番号を組み合わせて検索できる", async () => {
    expect(mine(await search({ dateFrom: "2026-10-10", dateTo: "2026-10-31" }))).toEqual([
      "INV-2026-100001",
      "DN-2026-100001",
      "PO-2026-100002",
    ]);
    expect(mine(await search({ amountMin: 10000, amountMax: 40000 }))).toEqual([
      "DN-2026-100001",
      "PO-2026-100002",
    ]);
    expect(await search({ partnerId: partnerB })).toEqual(["INV-2026-100002", "PO-2026-100002"]);
    expect(await search({ partnerId: partnerA, documentType: "invoice" })).toEqual([
      "INV-2026-100001",
    ]);
    expect(await search({ number: "DN-2026-1000" })).toEqual(["DN-2026-100001"]);
    expect(await search({ partnerId: partnerA, cancelled: "only" })).toEqual(["INV-2026-100001"]);
    expect(await search({ partnerId: partnerA, cancelled: "exclude" })).toEqual([
      "DN-2026-100001",
      "PO-2026-100001",
    ]);
    expect(await search({ partnerId: partnerA, sendStatus: "sent" })).toEqual(["DN-2026-100001"]);
    expect(await search({ partnerId: partnerA, sendStatus: "unsent" })).toEqual([
      "INV-2026-100001",
      "PO-2026-100001",
    ]);
    expect(await search({ partnerId: partnerA, renderStatus: "failed" })).toEqual([]);
  });

  it("取消済みの帳票も検索結果に残し、取消済みと表示する", async () => {
    const user = await createEmployee(["purchasing"]);
    const res = await as(user).get(`/documents?partnerId=${partnerA}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("INV-2026-100001");
    expect(html).toContain("取消済み");
    expect(html).toContain("検索テスト商店A");
    expect(html).toContain("¥45,000");
    // 絞り込みは表の部分だけを差し替え、条件を URL に残す
    expect(html).toContain('hx-push-url="true"');
    expect(html).toContain('hx-select="#results"');
  });

  it("範囲の指定が逆なら、エラーを表示する", async () => {
    const user = await createEmployee(["sales"]);
    const res = await as(user).get("/documents?dateFrom=2026-11-01&dateTo=2026-10-01");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("終わりの日付は始まりの日付以降にしてください");
    const amount = await (await as(user).get("/documents?amountMin=5000&amountMax=100")).text();
    expect(amount).toContain("上限の金額は下限の金額以上にしてください");
    const notNumber = await (await as(user).get("/documents?amountMin=abc")).text();
    expect(notNumber).toContain("条件を確認してください");
  });

  it("CSV は BOM 付きの UTF-8・CRLF で、絞り込みと同じ内容を日本語の列名で出す", async () => {
    const user = await createEmployee(["accounting"]);
    const res = await as(user).post("/documents/csv", { partnerId: partnerB, _key: newKey() });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toContain(
      `filename*=UTF-8''${encodeURIComponent("帳票一覧_")}`,
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes.subarray(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    // TextDecoder は先頭の BOM を取り除く
    const lines = new TextDecoder().decode(bytes).split("\r\n");
    expect(lines[0]).toBe("種類,番号,取引年月日,取引先,金額（税込）,取消,PDF,最新の送付,発行日時");
    expect(lines[1]).toMatch(
      /^請求書,INV-2026-100002,2026-11-01,検索テスト商店B,8000,,PDF 作成済み,未送付,/,
    );
    expect(lines[2]).toMatch(/^発注書,PO-2026-100002,2026-10-15,検索テスト商店B,12000,/);
    expect(lines[3]).toBe("");
    expect(lines).toHaveLength(4);
  });

  it("選んだ帳票をまとめて PDF にする処理を登録し、処理状況へ移る", async () => {
    const user = await createEmployee(["sales"]);
    const res = await as(user).post("/documents/bulk", {
      documentIds: [ids["dn1"] ?? "", ids["po1"] ?? ""],
      _key: newKey(),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/jobs?notice=bulk");
    const empty = await as(user).post("/documents/bulk", { _key: newKey() });
    expect(empty.headers.get("Location")).toBe("/documents?notice=bulk_empty");
  });

  it("検索の画面では送付の状況を表示する", async () => {
    expect((await sendRows(ids["dn1"] ?? ""))[0]?.method).toBe("manual");
    const user = await createEmployee(["sales"]);
    const html = await (
      await as(user).get(`/documents?partnerId=${partnerA}&sendStatus=sent`)
    ).text();
    expect(html).toContain("DN-2026-100001");
    expect(html).toContain("送付済み");
    expect(html).not.toContain("PO-2026-100001");
  });
});
