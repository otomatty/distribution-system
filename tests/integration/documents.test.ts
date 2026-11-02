/**
 * 帳票の PDF 化と送付（要件定義書 3.10・3.14）。
 * 発行 → PDF 化の処理 → R2 への保存、メールでの送付（開発環境はログに出す）、失敗と再送、権限、二重送信。
 */
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { PDFDocument } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "../../src/infra/db/schema";
import { businessDb } from "../../src/infra/do/client";
import { documentPort, jobPort } from "../../src/infra/do/document-port";
import { documentTemplates } from "../../src/web/views/documents/registry";
import { unwrapErr } from "../support/result";
import { ADMIN_EMAIL, as, createEmployee, newKey, systemCommand, systemQuery } from "./helpers";
import {
  createTestPartner,
  documentRow,
  fakeEmail,
  issueDocument,
  jobRow,
  pendingJobIds,
  runJobs,
  sendRows,
  systemCommandResult,
  testTemplate,
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

async function cancelDocument(documentId: string): Promise<void> {
  await runInDurableObject(businessDb(env), (_instance, state) => {
    const db = drizzle(state.storage, { schema });
    const meta = { at: new Date().toISOString(), by: "system" };
    documentPort(
      db,
      meta,
      () => crypto.randomUUID(),
      jobPort(db, meta, () => "", []),
    ).cancel(documentId);
  });
}

/** 発行して PDF 化まで済ませる */
async function readyDocument(input: Parameters<typeof issueDocument>[0]) {
  const issued = await issueDocument(input);
  await runJobs(issued.jobIds);
  return issued;
}

async function onePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([595, 842]);
  return pdf.save();
}

/** Browser Rendering の代わり（Quick Action の pdf に1ページの PDF を返す） */
async function fakeBrowser() {
  const calls: { action: string; options: Record<string, unknown> }[] = [];
  const bytes = await onePdf();
  const binding = {
    quickAction(action: string, options: Record<string, unknown>) {
      calls.push({ action, options });
      return Promise.resolve(
        new Response(bytes, { headers: { "Content-Type": "application/pdf" } }),
      );
    },
  };
  return { binding: binding as unknown as BrowserRun, calls };
}

describe("帳票の PDF 化", () => {
  it("発行すると PDF 化の処理が登録され、処理すると R2 に保存して作成済みになる", async () => {
    const partnerId = await createTestPartner();
    const issued = await issueDocument({ partnerId });
    expect(issued.jobIds).toHaveLength(1);
    expect((await documentRow(issued.documentId))?.status).toBe("pending");

    const result = await runJobs(issued.jobIds);
    expect(result.explicitAcks).toHaveLength(1);
    const doc = await documentRow(issued.documentId);
    expect(doc?.status).toBe("ready");
    // 開発・テストの環境（BROWSER がない）では HTML のまま保存する
    expect(doc?.r2Key).toBe(
      `documents/purchase_order/2026/${issued.number}-${issued.documentId}.html`,
    );
    const object = await env.FILES.get(doc?.r2Key ?? "");
    expect(object?.httpMetadata?.contentType).toBe("text/html; charset=utf-8");
    const html = (await object?.text()) ?? "";
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("りんごゼリー");
    expect(html).toContain(issued.number);
    expect((await jobRow(issued.jobIds[0] ?? ""))?.status).toBe("succeeded");

    // 同じ処理がもう一度届いても、同じファイルのまま
    const again = await runJobs(issued.jobIds);
    expect(again.explicitAcks).toHaveLength(1);
    expect((await documentRow(issued.documentId))?.r2Key).toBe(doc?.r2Key);
  });

  it("Browser Rendering があれば A4 の PDF にして保存する", async () => {
    const browser = await fakeBrowser();
    const partnerId = await createTestPartner();
    const issued = await issueDocument({
      partnerId,
      documentType: "invoice",
      number: "INV-2026-900001",
    });
    await runJobs(issued.jobIds, { env: { ...env, BROWSER: browser.binding } });
    const doc = await documentRow(issued.documentId);
    expect(doc?.status).toBe("ready");
    expect(doc?.r2Key).toMatch(/^documents\/invoice\/2026\/INV-2026-900001-.+\.pdf$/);
    expect(browser.calls).toHaveLength(1);
    expect(browser.calls[0]?.action).toBe("pdf");
    expect(browser.calls[0]?.options).toMatchObject({
      setJavaScriptEnabled: false,
      pdfOptions: { format: "a4", landscape: false, printBackground: true },
    });
    const object = await env.FILES.get(doc?.r2Key ?? "");
    expect(object?.httpMetadata?.contentType).toBe("application/pdf");
  });

  it("テンプレートがなければ失敗にし、理由を表示する。管理者は作り直せる", async () => {
    delete documentTemplates.credit_note;
    const partnerId = await createTestPartner();
    const issued = await issueDocument({
      partnerId,
      documentType: "credit_note",
      number: "CN-2026-000001",
    });
    const result = await runJobs(issued.jobIds);
    // 再試行しても直らない失敗なので、すぐ失敗にする
    expect(result.explicitAcks).toHaveLength(1);
    expect(result.retryMessages).toHaveLength(0);
    expect((await documentRow(issued.documentId))?.status).toBe("failed");
    const job = await jobRow(issued.jobIds[0] ?? "");
    expect(job?.status).toBe("failed");
    expect(job?.error).toContain("返還請求書のテンプレートが登録されていない");

    const accounting = await createEmployee(["accounting"]);
    const page = await (await as(accounting).get(`/documents/${issued.documentId}`)).text();
    expect(page).toContain("PDF を作成できませんでした");
    expect(page).toContain("返還請求書のテンプレートが登録されていない");
    expect(page).toContain("管理者に PDF の作り直しを依頼してください");
    expect(page).toContain("PDF の作成に失敗しているため送付できません");
    const denied = await as(accounting).post(`/documents/${issued.documentId}/rerender`, {
      _key: newKey(),
    });
    expect(denied.status).toBe(403);

    documentTemplates.credit_note = testTemplate;
    const adminPage = await (await as(ADMIN_EMAIL).get(`/documents/${issued.documentId}`)).text();
    expect(adminPage).toContain("PDF を作り直す");
    const res = await as(ADMIN_EMAIL).post(`/documents/${issued.documentId}/rerender`, {
      _key: newKey(),
    });
    expect(res.status).toBe(303);
    expect((await documentRow(issued.documentId))?.status).toBe("pending");
    await runJobs(await pendingJobIds("render_document"));
    expect((await documentRow(issued.documentId))?.status).toBe("ready");

    // 作成済みの PDF は作り直せない（電子帳簿保存法）
    const again = await as(ADMIN_EMAIL).post(`/documents/${issued.documentId}/rerender`, {
      _key: newKey(),
    });
    expect(again.status).toBe(409);
  });

  it("スナップショットがテンプレートの形式と合わなければ失敗にする", async () => {
    const partnerId = await createTestPartner();
    const issued = await issueDocument({ partnerId, snapshot: { title: 1 } });
    await runJobs(issued.jobIds);
    expect((await documentRow(issued.documentId))?.status).toBe("failed");
    expect((await jobRow(issued.jobIds[0] ?? ""))?.error).toContain(
      "帳票の内容がテンプレートの形式と合いません",
    );
  });

  it("PDF をダウンロードできる（日本語のファイル名）。作成中はダウンロードできない", async () => {
    const user = await createEmployee(["sales"]);
    const partnerId = await createTestPartner();
    const issued = await issueDocument({ partnerId });
    const early = await as(user).get(`/documents/${issued.documentId}/download`);
    expect(early.status).toBe(409);
    await runJobs(issued.jobIds);
    const res = await as(user).get(`/documents/${issued.documentId}/download`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe(
      `attachment; filename="____${issued.number}.html"; filename*=UTF-8''${encodeURIComponent(`発注書_${issued.number}.html`)}`,
    );
    // 帳票の HTML は埋め込みの <style> を使うので、その応答だけ CSP が違う
    expect(res.headers.get("Content-Security-Policy")).toContain("style-src 'unsafe-inline'");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.text()).toContain("りんごゼリー");
    expect((await as(user).get("/documents/unknown-id/download")).status).toBe(404);
  });
});

describe("帳票の送付", () => {
  it("取引先の既定の送付方法と宛先を初期値にして、メールで送付できる（開発環境はログに出す）", async () => {
    const user = await createEmployee(["purchasing"]);
    const partnerId = await createTestPartner({ email: "order@example.com" });
    const issued = await readyDocument({ partnerId });

    const page = await (await as(user).get(`/documents/${issued.documentId}`)).text();
    expect(page).toContain('value="order@example.com"');
    expect(page).toMatch(/value="email" checked/);

    const res = await as(user).hx(`/documents/${issued.documentId}/sends`, {
      method: "email",
      recipient: "buyer@example.com",
      _key: newKey(),
    });
    expect(res.status).toBe(200);
    const panel = await res.text();
    expect(panel).toContain("送付を受け付けました");
    expect(panel).toContain("送信中");
    // 送信中は送付履歴だけを読み直す
    expect(panel).toContain('hx-trigger="every 3s"');

    const [send] = await sendRows(issued.documentId);
    expect(send?.status).toBe("pending");
    expect(send?.recipient).toBe("buyer@example.com");
    await runJobs([send?.jobId ?? ""]);
    const [sent] = await sendRows(issued.documentId);
    expect(sent?.status).toBe("sent");
    expect(sent?.sentAt).not.toBeNull();

    const history = await (await as(user).get(`/documents/${issued.documentId}/sends`)).text();
    expect(history).toContain("送付済み");
    expect(history).not.toContain("hx-trigger");
  });

  it("PDF がまだなければ、送付の処理の中で作ってから送る", async () => {
    const mail = fakeEmail();
    const partnerId = await createTestPartner();
    const issued = await issueDocument({ partnerId });
    const { sendId } = await systemCommand("documents.send", { documentId: issued.documentId });
    const send = (await sendRows(issued.documentId)).find((s) => s.id === sendId);
    await runJobs([send?.jobId ?? ""], { env: { ...env, EMAIL: mail.binding } });
    expect((await documentRow(issued.documentId))?.status).toBe("ready");
    expect((await sendRows(issued.documentId))[0]?.status).toBe("sent");
    expect(mail.sent).toHaveLength(1);
    // 宛先は取引先のメールアドレス、添付は帳票のファイル
    expect(mail.sent[0]?.to).toEqual(["order@example.com"]);
    expect(String(mail.sent[0]?.subject)).toContain(`発注書（${issued.number}）のご送付`);
    expect(mail.sent[0]?.attachments).toMatchObject([
      { filename: `発注書_${issued.number}.html`, disposition: "attachment" },
    ]);
  });

  it("送信に失敗したら履歴とダッシュボードに出し、再送できる", async () => {
    const user = await createEmployee(["purchasing"]);
    const partnerId = await createTestPartner({ name: "送付失敗テスト商店" });
    const issued = await readyDocument({ partnerId });
    const before = await systemQuery("documents.attention", {});

    await as(user).hx(`/documents/${issued.documentId}/sends`, {
      method: "email",
      recipient: "blocked@example.com",
      _key: newKey(),
    });
    const [send] = await sendRows(issued.documentId);
    const rejected = fakeEmail({ code: "E_RECIPIENT_NOT_ALLOWED" });
    const result = await runJobs([send?.jobId ?? ""], { env: { ...env, EMAIL: rejected.binding } });
    // 宛先の誤りは再試行しても直らないので、すぐ失敗にする
    expect(result.retryMessages).toHaveLength(0);
    const [failed] = await sendRows(issued.documentId);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe("この宛先には送信できません（E_RECIPIENT_NOT_ALLOWED）");
    expect((await jobRow(send?.jobId ?? ""))?.status).toBe("failed");

    const after = await systemQuery("documents.attention", {});
    expect(after.failedSends).toBe(before.failedSends + 1);
    const search = await systemQuery("documents.search", { partnerId, sendStatus: "failed" });
    expect(search.rows.map((r) => r.id)).toEqual([issued.documentId]);
    const dashboard = await (await as(user).get("/")).text();
    expect(dashboard).toContain("送付に失敗した帳票");
    expect(dashboard).toContain('class="stat attention"');

    const page = await (await as(user).get(`/documents/${issued.documentId}`)).text();
    expect(page).toContain("この宛先には送信できません");
    expect(page).toContain("再送する");

    const retry = await as(user).hx(
      `/documents/${issued.documentId}/sends/${failed?.id ?? ""}/retry`,
      { _key: newKey() },
    );
    expect(await retry.text()).toContain("再送を受け付けました");
    const sends = await sendRows(issued.documentId);
    expect(sends).toHaveLength(2);
    expect(sends[1]?.status).toBe("pending");
    expect(sends[1]?.recipient).toBe("blocked@example.com");
    const ok = fakeEmail();
    await runJobs([sends[1]?.jobId ?? ""], { env: { ...env, EMAIL: ok.binding } });
    expect((await sendRows(issued.documentId))[1]?.status).toBe("sent");
    expect((await systemQuery("documents.attention", {})).failedSends).toBe(before.failedSends);

    // 最新の送付が成功したので、古い失敗はやり直せない
    const stale = await as(user).hx(
      `/documents/${issued.documentId}/sends/${failed?.id ?? ""}/retry`,
      { _key: newKey() },
    );
    expect(await stale.text()).toContain("この送付はやり直せません");
  });

  it("一時的な失敗は時間をおいて再試行し、使い切ったら失敗にする", async () => {
    const partnerId = await createTestPartner();
    const issued = await readyDocument({ partnerId });
    const { sendId } = await systemCommand("documents.send", { documentId: issued.documentId });
    const jobId = (await sendRows(issued.documentId)).find((s) => s.id === sendId)?.jobId ?? "";
    const busy = fakeEmail({ code: "E_RATE_LIMIT_EXCEEDED" });

    const first = await runJobs([jobId], { env: { ...env, EMAIL: busy.binding } });
    expect(first.retryMessages).toHaveLength(1);
    expect((await sendRows(issued.documentId))[0]?.status).toBe("pending");

    const last = await runJobs([jobId], { env: { ...env, EMAIL: busy.binding }, attempts: 3 });
    expect(last.retryMessages).toHaveLength(0);
    expect(last.explicitAcks).toHaveLength(1);
    const [send] = await sendRows(issued.documentId);
    expect(send?.status).toBe("failed");
    expect(send?.error).toBe("送信が混み合っています（E_RATE_LIMIT_EXCEEDED）");
  });

  it("FAX などで手動で送ったことを記録できる", async () => {
    const user = await createEmployee(["purchasing"]);
    const partnerId = await createTestPartner({ email: null, defaultSendMethod: "none" });
    const issued = await readyDocument({ partnerId });
    const page = await (await as(user).get(`/documents/${issued.documentId}`)).text();
    expect(page).toMatch(/value="manual" checked/);
    const res = await as(user).hx(`/documents/${issued.documentId}/sends`, {
      method: "manual",
      note: "FAX で送付",
      _key: newKey(),
    });
    expect(await res.text()).toContain("手動で送付したことを記録しました");
    const [send] = await sendRows(issued.documentId);
    expect(send).toMatchObject({ method: "manual", status: "sent", note: "FAX で送付" });
  });

  it("宛先がなければエラーにする（取引先にメールアドレスがない場合）", async () => {
    const user = await createEmployee(["purchasing"]);
    const partnerId = await createTestPartner({ email: null, defaultSendMethod: "none" });
    const issued = await readyDocument({ partnerId });
    const res = await as(user).hx(`/documents/${issued.documentId}/sends`, {
      method: "email",
      recipient: "",
      _key: newKey(),
    });
    expect(await res.text()).toContain("宛先のメールアドレスを入力してください");
    const bad = await as(user).hx(`/documents/${issued.documentId}/sends`, {
      method: "email",
      recipient: "not-an-address",
      _key: newKey(),
    });
    expect(await bad.text()).toContain("メールアドレスの形式が正しくありません");
    expect(await sendRows(issued.documentId)).toHaveLength(0);
  });

  it("同じ受付番号で2回送信しても、送付は1回だけ", async () => {
    const user = await createEmployee(["purchasing"]);
    const partnerId = await createTestPartner();
    const issued = await readyDocument({ partnerId });
    const form = { method: "email", recipient: "twice@example.com", _key: newKey() };
    const first = await as(user).hx(`/documents/${issued.documentId}/sends`, form);
    const second = await as(user).hx(`/documents/${issued.documentId}/sends`, form);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await sendRows(issued.documentId)).toHaveLength(1);
  });

  it("取消済みの帳票は送付できない", async () => {
    const user = await createEmployee(["purchasing"]);
    const partnerId = await createTestPartner();
    const issued = await readyDocument({ partnerId });
    await cancelDocument(issued.documentId);
    const page = await (await as(user).get(`/documents/${issued.documentId}`)).text();
    expect(page).toContain("取消済みの帳票は送付できません");
    expect(page).not.toContain("送付する</button>");
    const res = await as(user).hx(`/documents/${issued.documentId}/sends`, {
      method: "email",
      recipient: "x@example.com",
      _key: newKey(),
    });
    expect(await res.text()).toContain("取消済みの帳票は送付できません");
  });

  describe("帳票の種類ごとの送付の権限", () => {
    const cases = [
      { type: "purchase_order", allowed: ["purchasing", "admin"], denied: ["sales", "accounting"] },
      { type: "delivery_note", allowed: ["sales", "admin"], denied: ["purchasing", "accounting"] },
      { type: "invoice", allowed: ["accounting", "admin"], denied: ["purchasing", "sales"] },
      { type: "credit_note", allowed: ["accounting"], denied: ["sales"] },
    ] as const;
    for (const c of cases) {
      it(`${c.type}：${c.allowed.join("・")}は送付でき、${c.denied.join("・")}はできない`, async () => {
        const partnerId = await createTestPartner();
        const issued = await readyDocument({ partnerId, documentType: c.type });
        for (const role of c.denied) {
          const user = await createEmployee([role]);
          const page = await (await as(user).get(`/documents/${issued.documentId}`)).text();
          expect(page).not.toContain("送付する</button>");
          const res = await as(user).hx(`/documents/${issued.documentId}/sends`, {
            method: "manual",
            note: "",
            _key: newKey(),
          });
          expect(await res.text()).toContain("この帳票を送付する権限がありません");
        }
        for (const role of c.allowed) {
          const user = await createEmployee([role]);
          const res = await as(user).hx(`/documents/${issued.documentId}/sends`, {
            method: "manual",
            note: role,
            _key: newKey(),
          });
          expect(await res.text()).toContain("手動で送付したことを記録しました");
        }
        expect(await sendRows(issued.documentId)).toHaveLength(c.allowed.length);
      });
    }
  });
});

describe("帳票のユースケースの業務エラー", () => {
  it("存在しない帳票・送付履歴には送付・再送・作り直しができない", async () => {
    const send = unwrapErr(await systemCommandResult("documents.send", { documentId: "missing" }));
    expect(send.code).toBe("not_found");
    const manual = unwrapErr(
      await systemCommandResult("documents.recordManualSend", { documentId: "missing" }),
    );
    expect(manual.code).toBe("not_found");
    const retry = unwrapErr(
      await systemCommandResult("documents.retrySend", { sendId: "missing" }),
    );
    expect(retry.message).toBe("送付履歴が見つかりません");
    const rerender = unwrapErr(
      await systemCommandResult("documents.rerender", { documentId: "missing" }),
    );
    expect(rerender.code).toBe("not_found");
    expect(await systemQuery("documents.get", { id: "missing" })).toBeNull();
  });

  it("取消済みになった帳票は再送できない", async () => {
    const partnerId = await createTestPartner();
    const issued = await readyDocument({ partnerId });
    const { sendId } = await systemCommand("documents.send", { documentId: issued.documentId });
    const [send] = await sendRows(issued.documentId);
    await runJobs([send?.jobId ?? ""], {
      env: { ...env, EMAIL: fakeEmail({ code: "E_DELIVERY_FAILED" }).binding },
    });
    await cancelDocument(issued.documentId);
    const retry = unwrapErr(await systemCommandResult("documents.retrySend", { sendId }));
    expect(retry.message).toBe("取消済みの帳票は送付できません");
  });

  it("取引先が見つからない帳票も表示できる（宛先の初期値なし）", async () => {
    const issued = await readyDocument({ partnerId: "deleted-partner" });
    const detail = await systemQuery("documents.get", { id: issued.documentId });
    expect(detail?.partner).toBeNull();
    expect(detail?.document.partnerName).toBeNull();
    const result = unwrapErr(
      await systemCommandResult("documents.send", { documentId: issued.documentId }),
    );
    expect(result.message).toBe("宛先のメールアドレスを入力してください");
  });

  it("一括 PDF は一度に500件まで", async () => {
    const ids = Array.from({ length: 300 }, (_, i) => `doc-${i}`);
    const result = unwrapErr(
      await systemCommandResult("jobs.bulkDocuments", {
        documentIds: ids,
        documentType: "invoice",
        entityIds: ids,
      }),
    );
    expect(result.code).toBe("validation");
    const noType = unwrapErr(
      await systemCommandResult("jobs.bulkDocuments", { entityIds: ["shipment-1"] }),
    );
    expect(noType.fields?.[0]?.message).toBe("伝票で指定する場合は帳票の種類を指定してください");
  });
});
