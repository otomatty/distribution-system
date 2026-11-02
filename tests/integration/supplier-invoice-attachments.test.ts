/**
 * 仕入先請求書の PDF の添付（要件定義書 3.7 Should、7章 電子帳簿保存法）。
 * PDF だけ・10 MB まで。保存した版は消さず、差し替えは新しい版として追加する。ダウンロードは権限を確かめて Worker 経由で行う。
 */
import { env, exports } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { Result } from "../../src/domain/result";
import * as schema from "../../src/infra/db/schema";
import { businessDb } from "../../src/infra/do/client";
import type { CommandInput, CommandName } from "../../src/usecases/registry";
import { unwrap, unwrapErr } from "../support/result";
import { createItem, createLocation, createSupplier } from "./fixtures";
import { as, createEmployee, newKey, ORIGIN, systemCommand, systemQuery } from "./helpers";
import { readDb } from "./platform-helpers";
import { createConfirmedOrder, receive } from "./purchasing-fixtures";

function commandAs<N extends CommandName>(
  email: string,
  name: N,
  input: CommandInput<N>,
  key: string | null = null,
): Promise<Result<unknown>> {
  return businessDb(env).command(name, input, { kind: "dev", email }, key);
}

async function invoiceSetup(): Promise<string> {
  const supplierId = await createSupplier();
  const locationId = await createLocation();
  const item = await createItem(supplierId);
  const po = await createConfirmedOrder({
    supplierId,
    locationId,
    lines: [{ itemId: item.id, quantity: 1 }],
  });
  const receipt = await receive(po.id, [1]);
  const invoice = await systemCommand("supplierInvoices.create", {
    supplierId,
    invoiceDate: "2026-10-31",
    receiptIds: [receipt.id],
    invoiceNumber: "B-2001",
    invoicedAmount: 1296,
  });
  return invoice.id;
}

function pdf(text: string): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.7\n${text}\n%%EOF\n`);
}

/** multipart のフォームで送る（htmx からの送信として） */
function upload(
  email: string,
  invoiceId: string,
  file: { body: Uint8Array | string; name: string; type?: string } | null,
  key = newKey(),
) {
  const form = new FormData();
  form.set("_key", key);
  if (file)
    form.set("file", new File([file.body], file.name, { type: file.type ?? "application/pdf" }));
  return exports.default.fetch(
    new Request(`${ORIGIN}/supplier-invoices/${invoiceId}/attachments`, {
      method: "POST",
      body: form,
      headers: {
        Cookie: `dev_actor=${encodeURIComponent(email)}`,
        Origin: ORIGIN,
        "HX-Request": "true",
      },
      redirect: "manual",
    }),
  );
}

async function storedKeys(invoiceId: string): Promise<string[]> {
  const listed = await env.FILES.list({ prefix: `supplier-invoices/${invoiceId}/` });
  return listed.objects.map((o) => o.key);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("仕入先請求書の PDF の添付", () => {
  it("経理担当は PDF を添付でき、差し替えは新しい版として追加する（前の版は消えない）", async () => {
    const invoiceId = await invoiceSetup();
    const user = await createEmployee(["accounting"], "経理 花子");
    const page = await (await as(user).get(`/supplier-invoices/${invoiceId}`)).text();
    expect(page).toContain("請求書の PDF");
    expect(page).toContain("まだ PDF を添付していません");
    expect(page).toContain('hx-encoding="multipart/form-data"');

    const first = pdf("first");
    const res = await upload(user, invoiceId, { body: first, name: "C:\\受信\\請求書_10月.pdf" });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("PDF を保存しました（1版）");
    expect(html).toContain("請求書_10月.pdf");

    const second = pdf("second version");
    const again = await (await upload(user, invoiceId, { body: second, name: "訂正.pdf" })).text();
    expect(again).toContain("PDF を保存しました（2版）");

    const view = await systemQuery("supplierInvoices.get", { id: invoiceId });
    expect(view?.attachments.map((a) => [a.versionNo, a.fileName])).toEqual([
      [2, "訂正.pdf"],
      [1, "請求書_10月.pdf"],
    ]);
    expect(view?.attachments[1]?.sha256).toBe(await sha256Hex(first));
    expect(view?.attachments[1]?.size).toBe(first.byteLength);
    expect(view?.attachments[0]?.createdByName).toBe("経理 花子");
    expect(await storedKeys(invoiceId)).toHaveLength(2);

    // どちらの版もダウンロードできる（社外のファイルなので sandbox、ダウンロードとして返す）
    for (const [a, bytes] of [
      [view?.attachments[0], second],
      [view?.attachments[1], first],
    ] as const) {
      const download = await as(user).get(`/supplier-invoices/${invoiceId}/attachments/${a?.id}`);
      expect(download.status).toBe(200);
      expect(download.headers.get("Content-Type")).toBe("application/pdf");
      expect(download.headers.get("Content-Disposition")).toMatch(/^attachment;/);
      expect(download.headers.get("Content-Security-Policy")).toBe("sandbox");
      expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
    }
    const object = await env.FILES.head(view?.attachments[0]?.r2Key ?? "");
    expect(object?.customMetadata?.["sha256"]).toBe(await sha256Hex(second));

    // 操作履歴
    const logs = await readDb((db) =>
      db
        .select()
        .from(schema.auditLogs)
        .where(
          and(eq(schema.auditLogs.entityId, invoiceId), eq(schema.auditLogs.action, "attach_pdf")),
        )
        .all(),
    );
    expect(logs).toHaveLength(2);
    expect(JSON.parse(logs[1]?.afterJson ?? "{}")).toMatchObject({
      versionNo: 2,
      fileName: "訂正.pdf",
    });
  });

  it("PDF でない・空・ファイルなしは保存しない。10 MB を超えるものは受け付けない", async () => {
    const invoiceId = await invoiceSetup();
    const user = await createEmployee(["accounting"]);
    const text = await upload(user, invoiceId, {
      body: "これは PDF ではありません",
      name: "偽物.pdf",
    });
    expect(text.status).toBe(422);
    expect(await text.text()).toContain("PDF のファイルを選んでください");
    const empty = await upload(user, invoiceId, { body: new Uint8Array(), name: "空.pdf" });
    expect(empty.status).toBe(422);
    const none = await upload(user, invoiceId, null);
    expect(none.status).toBe(422);
    const big = new Uint8Array(10 * 1024 * 1024 + 100 * 1024);
    big.set(pdf("big").subarray(0, 9));
    const tooBig = await upload(user, invoiceId, { body: big, name: "大きい.pdf" });
    expect(tooBig.status).toBe(413);
    expect(await tooBig.text()).toContain("10 MB");
    expect(await storedKeys(invoiceId)).toEqual([]);
    expect((await systemQuery("supplierInvoices.get", { id: invoiceId }))?.attachments).toEqual([]);
  });

  it("添付できるのは経理担当と管理者。取り消した請求書には添付できない", async () => {
    const invoiceId = await invoiceSetup();
    const purchasing = await createEmployee(["purchasing"]);
    const page = await (await as(purchasing).get(`/supplier-invoices/${invoiceId}`)).text();
    expect(page).toContain("請求書の PDF");
    expect(page).not.toContain('hx-encoding="multipart/form-data"');
    expect((await upload(purchasing, invoiceId, { body: pdf("x"), name: "a.pdf" })).status).toBe(
      403,
    );
    const input = {
      id: invoiceId,
      fileId: crypto.randomUUID(),
      fileName: "a.pdf",
      size: 10,
      sha256: "0".repeat(64),
    };
    expect(unwrapErr(await commandAs(purchasing, "supplierInvoices.attach", input)).code).toBe(
      "forbidden",
    );
    expect(
      unwrapErr(
        await commandAs(purchasing, "supplierInvoices.attach", {
          ...input,
          id: "01ZZZZZZZZZZZZZZZZZZZZZZZZ",
        }),
      ).code,
    ).toBe("forbidden");

    const accounting = await createEmployee(["accounting"]);
    expect(
      unwrapErr(
        await commandAs(accounting, "supplierInvoices.attach", {
          ...input,
          id: "01ZZZZZZZZZZZZZZZZZZZZZZZZ",
        }),
      ).code,
    ).toBe("not_found");
    expect(
      unwrapErr(await commandAs(accounting, "supplierInvoices.attach", { ...input, sha256: "x" }))
        .code,
    ).toBe("validation");

    await systemCommand("supplierInvoices.cancel", {
      id: invoiceId,
      version: 1,
      reason: "二重登録",
    });
    const cancelled = await upload(accounting, invoiceId, { body: pdf("x"), name: "a.pdf" });
    expect(cancelled.status).toBe(409);
    expect(await cancelled.text()).toContain("添付できません");
    expect(unwrapErr(await commandAs(accounting, "supplierInvoices.attach", input)).code).toBe(
      "invalid_state",
    );
    expect(await storedKeys(invoiceId)).toEqual([]);
  });

  it("同じ受付番号で2回送っても1版だけ記録し、2回目のファイルは残さない", async () => {
    const invoiceId = await invoiceSetup();
    const user = await createEmployee(["accounting"]);
    const key = newKey();
    expect((await upload(user, invoiceId, { body: pdf("a"), name: "a.pdf" }, key)).status).toBe(
      200,
    );
    expect((await upload(user, invoiceId, { body: pdf("a"), name: "a.pdf" }, key)).status).toBe(
      200,
    );
    const view = await systemQuery("supplierInvoices.get", { id: invoiceId });
    expect(view?.attachments).toHaveLength(1);
    expect(await storedKeys(invoiceId)).toEqual([view?.attachments[0]?.r2Key]);

    const direct = {
      id: invoiceId,
      fileId: crypto.randomUUID(),
      fileName: "b",
      size: 5,
      sha256: "a".repeat(64),
    };
    const directKey = newKey();
    const once = unwrap(await commandAs(user, "supplierInvoices.attach", direct, directKey));
    const twice = unwrap(
      await commandAs(
        user,
        "supplierInvoices.attach",
        { ...direct, fileId: crypto.randomUUID() },
        directKey,
      ),
    );
    expect(twice).toEqual(once);
    const after = await systemQuery("supplierInvoices.get", { id: invoiceId });
    expect(after?.attachments.map((a) => a.fileName)).toEqual(["b.pdf", "a.pdf"]);
  });

  it("ほかの請求書の版や、ない版はダウンロードできない", async () => {
    const invoiceId = await invoiceSetup();
    const other = await invoiceSetup();
    const user = await createEmployee(["accounting"]);
    await upload(user, invoiceId, { body: pdf("a"), name: "a.pdf" });
    const view = await systemQuery("supplierInvoices.get", { id: invoiceId });
    const attachmentId = view?.attachments[0]?.id ?? "";
    expect(
      (await as(user).get(`/supplier-invoices/${other}/attachments/${attachmentId}`)).status,
    ).toBe(404);
    expect(
      (await as(user).get(`/supplier-invoices/${invoiceId}/attachments/01ZZZZZZZZZZZZZZZZZZZZZZZZ`))
        .status,
    ).toBe(404);
    // 閲覧は全員ができる
    const sales = await createEmployee(["sales"]);
    expect(
      (await as(sales).get(`/supplier-invoices/${invoiceId}/attachments/${attachmentId}`)).status,
    ).toBe(200);
  });
});
