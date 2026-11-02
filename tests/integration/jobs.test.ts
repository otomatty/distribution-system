/**
 * 処理状況（一括 PDF・大きな CSV）の画面と、その処理（要件定義書 3.9・3.13、5章 処理状況）。
 */
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { PDFDocument } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "../../src/infra/db/schema";
import { businessDb } from "../../src/infra/do/client";
import { CSV_ASYNC_THRESHOLD } from "../../src/web/csv-exports";
import { ADMIN_EMAIL, as, createEmployee, newKey, systemCommand } from "./helpers";
import {
  createTestPartner,
  documentRow,
  issueDocument,
  jobRow,
  pendingJobIds,
  runJobs,
  useTestTemplates,
} from "./platform-helpers";

let restoreTemplates: () => void;
beforeAll(() => {
  restoreTemplates = useTestTemplates([
    "purchase_order",
    "delivery_note",
    "invoice",
    "credit_note",
  ]);
});
afterAll(() => restoreTemplates());

async function pdfBrowser() {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  const bytes = await doc.save();
  const binding = {
    quickAction: () =>
      Promise.resolve(new Response(bytes, { headers: { "Content-Type": "application/pdf" } })),
  };
  return binding as unknown as BrowserRun;
}

/** 依頼した処理の ID（処理状況の一覧の行から） */
function jobIdsIn(html: string): string[] {
  return [...html.matchAll(/id="job-([0-9A-Z]{26})"/g)].map((m) => m[1] ?? "");
}

describe("一括 PDF", () => {
  it("まとめた PDF を作り、進み具合を記録して、処理状況からダウンロードできる", async () => {
    const browser = await pdfBrowser();
    const user = await createEmployee(["sales"]);
    const partnerId = await createTestPartner();
    const a = await issueDocument({ partnerId, documentType: "delivery_note" });
    const b = await issueDocument({ partnerId, documentType: "delivery_note" });
    await runJobs([...a.jobIds, ...b.jobIds], { env: { ...env, BROWSER: browser } });

    await as(user).post("/documents/bulk", {
      documentIds: [a.documentId, b.documentId],
      _key: newKey(),
    });
    const list = await (await as(user).get("/jobs?notice=bulk")).text();
    expect(list).toContain("一括 PDF の作成を受け付けました");
    const [jobId] = jobIdsIn(list);
    expect(jobId).toBeDefined();
    // 終わっていない行は2秒ごとに読み直す
    expect(list).toContain(`hx-get="/jobs/${jobId ?? ""}"`);
    expect(list).toContain('hx-trigger="every 2s"');
    const early = await as(user).get(`/jobs/${jobId ?? ""}/download`);
    expect(early.status).toBe(409);

    await runJobs([jobId ?? ""], { env: { ...env, BROWSER: browser } });
    const job = await jobRow(jobId ?? "");
    expect(job).toMatchObject({ status: "succeeded", progress: 2, total: 2 });
    expect(job?.resultKey).toMatch(
      new RegExp(`^jobs/${jobId ?? ""}/帳票_\\d{4}-\\d{2}-\\d{2}\\.pdf$`),
    );

    // 終わった行は読み直さない（htmx からの要求には行だけを返す）
    const row = await (await as(user).get(`/jobs/${jobId ?? ""}`, { "HX-Request": "true" })).text();
    expect(row.startsWith(`<tr id="job-${jobId ?? ""}"`)).toBe(true);
    expect(row).not.toContain("hx-trigger");
    expect(row).toContain("ダウンロード");
    expect(row).toContain('value="100"');

    const res = await as(user).get(`/jobs/${jobId ?? ""}/download`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toContain("filename*=UTF-8''");
    const merged = await PDFDocument.load(new Uint8Array(await res.arrayBuffer()));
    expect(merged.getPageCount()).toBe(2);
  });

  it("PDF がまだない帳票はその場で作る。HTML のままの環境では1つの HTML にまとめる", async () => {
    const partnerId = await createTestPartner();
    const a = await issueDocument({ partnerId, number: "PO-2026-700001" });
    const b = await issueDocument({ partnerId, number: "PO-2026-700002" });
    const { jobId } = await systemCommand("jobs.bulkDocuments", {
      documentIds: [b.documentId, a.documentId, "missing-id"],
      name: "発注書まとめ",
    });
    await runJobs([jobId]);
    expect((await documentRow(a.documentId))?.status).toBe("ready");
    const job = await jobRow(jobId);
    expect(job?.status).toBe("succeeded");
    expect(job?.resultName).toBe("発注書まとめ.html");
    const html = (await (await env.FILES.get(job?.resultKey ?? ""))?.text()) ?? "";
    expect(html.match(/<section class="sheet">/g)).toHaveLength(2);
    expect(html.indexOf("PO-2026-700002")).toBeLessThan(html.indexOf("PO-2026-700001"));
  });

  it("伝票の ID で指定すると、取消されていない最新の帳票を使う", async () => {
    const partnerId = await createTestPartner();
    const a = await issueDocument({
      partnerId,
      documentType: "delivery_note",
      entityId: "shipment-x",
    });
    const { jobId, count } = await systemCommand("jobs.bulkDocuments", {
      documentType: "delivery_note",
      entityIds: ["shipment-x", "shipment-none"],
    });
    expect(count).toBe(1);
    const job = await jobRow(jobId);
    expect(JSON.parse(job?.payloadJson ?? "{}")).toMatchObject({ documentIds: [a.documentId] });
  });

  it("対象の帳票がなければ登録しない", async () => {
    const user = await createEmployee(["sales"]);
    const empty = await as(user).post("/documents/bulk", {
      documentIds: ["missing-id"],
      _key: newKey(),
    });
    expect(empty.status).toBe(400);
    expect(await empty.text()).toContain("PDF にする帳票を選んでください");
  });

  it("テンプレートがない帳票を含むと、理由を示して失敗にする", async () => {
    const user = await createEmployee(["sales"]);
    const partnerId = await createTestPartner();
    restoreTemplates();
    try {
      const a = await issueDocument({ partnerId, documentType: "invoice" });
      await as(user).post("/documents/bulk", { documentIds: [a.documentId], _key: newKey() });
      const [jobId] = jobIdsIn(await (await as(user).get("/jobs")).text());
      await runJobs([jobId ?? ""]);
      const job = await jobRow(jobId ?? "");
      expect(job?.status).toBe("failed");
      expect(job?.error).toContain("請求書のテンプレートが登録されていない");
      const failed = await (await as(user).get("/jobs?status=failed")).text();
      expect(failed).toContain("請求書のテンプレートが登録されていない");
    } finally {
      restoreTemplates = useTestTemplates([
        "purchase_order",
        "delivery_note",
        "invoice",
        "credit_note",
      ]);
    }
  });
});

describe("処理状況の画面", () => {
  it("本人が依頼した処理だけを表示し、管理者はすべてを見る。他人の結果はダウンロードできない", async () => {
    const owner = await createEmployee(["purchasing"]);
    const other = await createEmployee(["purchasing"]);
    const partnerId = await createTestPartner();
    const doc = await issueDocument({ partnerId });
    await runJobs(doc.jobIds);
    await as(owner).post("/documents/bulk", { documentIds: [doc.documentId], _key: newKey() });
    const [jobId] = jobIdsIn(await (await as(owner).get("/jobs")).text());
    await runJobs([jobId ?? ""]);

    expect(jobIdsIn(await (await as(other).get("/jobs")).text())).not.toContain(jobId);
    expect(jobIdsIn(await (await as(ADMIN_EMAIL).get("/jobs")).text())).toContain(jobId);
    expect((await as(other).get(`/jobs/${jobId ?? ""}/download`)).status).toBe(404);
    expect((await as(other).get(`/jobs/${jobId ?? ""}`)).status).toBe(404);
    expect((await as(owner).get(`/jobs/${jobId ?? ""}/download`)).status).toBe(200);
    const page = await (await as(owner).get(`/jobs/${jobId ?? ""}`)).text();
    expect(page).toContain("処理状況の一覧に戻る");

    // 帳票ごとの PDF 化・送付の処理は、処理状況には出さない
    expect((await as(ADMIN_EMAIL).get(`/jobs/${doc.jobIds[0] ?? ""}`)).status).toBe(404);
  });

  it("状態で絞り込める", async () => {
    const user = await createEmployee(["accounting"]);
    const html = await (await as(user).get("/jobs?status=active")).text();
    expect(html).toContain("処理はありません");
    expect(html).toContain('hx-push-url="true"');
  });
});

describe("CSV の非同期出力", () => {
  it(`${CSV_ASYNC_THRESHOLD}件を超えると処理を登録し、依頼した社員の権限で R2 に CSV を作る`, async () => {
    const user = await createEmployee(["accounting"]);
    const partnerId = await createTestPartner({ name: "大量帳票商店" });
    const count = CSV_ASYNC_THRESHOLD + 1;
    await runInDurableObject(businessDb(env), (_instance, state) => {
      const db = drizzle(state.storage, { schema });
      const at = new Date().toISOString();
      db.transaction((tx) => {
        for (let i = 0; i < count; i += 1) {
          tx.insert(schema.documents)
            .values({
              id: `bulkcsv-${String(i).padStart(5, "0")}`,
              documentType: "invoice",
              number: `INV-2025-${String(i + 1).padStart(6, "0")}`,
              entityId: `e-${i}`,
              partnerId,
              transactionDate: "2025-12-01",
              amount: i,
              snapshotJson: "{}",
              status: "ready",
              r2Key: null,
              createdAt: at,
              createdBy: "system",
              updatedAt: at,
              updatedBy: "system",
            })
            .run();
        }
      });
    });

    const key = newKey();
    const res = await as(user).post("/documents/csv", { partnerId, _key: key });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/jobs?notice=csv");
    // 二重に押しても処理は1つ
    await as(user).post("/documents/csv", { partnerId, _key: key });
    const jobs = await pendingJobIds("export_csv");
    expect(jobs).toHaveLength(1);
    const list = await (await as(user).get("/jobs?notice=csv")).text();
    expect(list).toContain("件数が多いため、CSV をあとで作成します");
    expect(list).toContain("CSV 出力");

    await runJobs(jobs);
    const job = await jobRow(jobs[0] ?? "");
    expect(job).toMatchObject({ status: "succeeded", progress: count, total: count });
    expect(job?.resultName).toMatch(/^帳票一覧_\d{4}-\d{2}-\d{2}\.csv$/);
    const object = await env.FILES.get(job?.resultKey ?? "");
    expect(object?.httpMetadata?.contentType).toBe("text/csv; charset=utf-8");
    const bytes = new Uint8Array((await object?.arrayBuffer()) ?? new ArrayBuffer(0));
    expect(Array.from(bytes.subarray(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    // TextDecoder は先頭の BOM を取り除く
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith("種類,番号,")).toBe(true);
    const lines = text.split("\r\n");
    expect(lines).toHaveLength(count + 2);
    expect(lines[1]).toMatch(/^請求書,INV-2025-002001,2025-12-01,大量帳票商店,2000,/);

    const download = await as(user).get(`/jobs/${jobs[0] ?? ""}/download`);
    expect(download.status).toBe(200);
    expect(download.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
  });

  it("無効にされた社員の依頼は出力しない", async () => {
    const email = await createEmployee(["sales"]);
    const { jobId } = await systemCommand("jobs.exportCsv", {
      definition: "documents",
      input: {},
    });
    const employees = await runInDurableObject(businessDb(env), (_instance, state) =>
      drizzle(state.storage, { schema }).select().from(schema.employees).all(),
    );
    const employee = employees.find((e) => e.email === email);
    await runInDurableObject(businessDb(env), (_instance, state) => {
      drizzle(state.storage, { schema })
        .update(schema.jobs)
        .set({ createdBy: employee?.id ?? "" })
        .where(eq(schema.jobs.id, jobId))
        .run();
    });
    await systemCommand("employees.update", {
      id: employee?.id ?? "",
      version: employee?.version ?? 1,
      name: employee?.name ?? "",
      roles: ["sales"],
      active: false,
    });
    await runJobs([jobId]);
    const job = await jobRow(jobId);
    expect(job?.status).toBe("failed");
    expect(job?.error).toContain("CSV を作れませんでした");
  });

  it("不明な定義の CSV は失敗にする", async () => {
    const { jobId } = await systemCommand("jobs.exportCsv", { definition: "unknown", input: {} });
    await runJobs([jobId]);
    expect((await jobRow(jobId))?.error).toContain("CSV の出力の定義が見つかりません");
  });
});
