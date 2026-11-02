import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  backupDateOf,
  backupKey,
  contentDisposition,
  documentKey,
  fileExists,
  fileResponse,
  jobResultKey,
  putFile,
  readFile,
} from "./files";

describe("R2 のファイル", () => {
  it("保存先の決まり", () => {
    expect(documentKey("invoice", "2026-11-02", "INV-2026-000001", "01ABC", "pdf")).toBe(
      "documents/invoice/2026/INV-2026-000001-01ABC.pdf",
    );
    expect(documentKey("purchase_order", "2025-01-01", "PO/1\u0000", "X", "html")).toBe(
      "documents/purchase_order/2025/PO_1_-X.html",
    );
    expect(jobResultKey("01JOB", "納品書.pdf")).toBe("jobs/01JOB/納品書.pdf");
    expect(backupKey("2026-11-02")).toBe("backups/2026-11-02.json.gz");
    expect(backupDateOf("backups/2026-11-02.json.gz")).toBe("2026-11-02");
    expect(backupDateOf("backups/other.txt")).toBeUndefined();
  });

  it("Content-Disposition は ASCII の filename と、UTF-8 の filename* を付ける", () => {
    expect(contentDisposition("report.csv")).toBe(
      `attachment; filename="report.csv"; filename*=UTF-8''report.csv`,
    );
    expect(contentDisposition(`見積(1)'s "x".pdf`, "inline")).toBe(
      `inline; filename="__(1)'s _x_.pdf"; filename*=UTF-8''%E8%A6%8B%E7%A9%8D%281%29%27s%20%22x%22.pdf`,
    );
  });

  it("保存して読み、ダウンロードの応答を作る", async () => {
    const key = "jobs/test/sample.txt";
    expect(await fileExists(env.FILES, key)).toBe(false);
    expect(await readFile(env.FILES, key)).toBeNull();
    expect(await fileResponse(env.FILES, key, "x.txt")).toBeNull();
    await putFile(env.FILES, key, "こんにちは", {
      contentType: "text/plain",
      fileName: "挨拶.txt",
    });
    expect(await fileExists(env.FILES, key)).toBe(true);
    expect(new TextDecoder().decode((await readFile(env.FILES, key)) ?? new Uint8Array())).toBe(
      "こんにちは",
    );
    const res = await fileResponse(env.FILES, key, "挨拶.txt", { "X-Test": "1" });
    expect(res?.headers.get("Content-Type")).toBe("text/plain");
    expect(res?.headers.get("Content-Length")).toBe("15");
    expect(res?.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res?.headers.get("X-Test")).toBe("1");
    expect(res?.headers.get("Content-Disposition")).toContain(encodeURIComponent("挨拶.txt"));
    expect(await res?.text()).toBe("こんにちは");
  });
});
