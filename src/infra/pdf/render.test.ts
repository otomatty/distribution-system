import { env } from "cloudflare:workers";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { InfraError } from "../errors";
import { pdfMerger } from "./merge";
import { isPdf, renderPdf } from "./render";

async function pdfWithPages(n: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i += 1) doc.addPage([595, 842]);
  return doc.save();
}

function browser(response: () => Response, calls: unknown[] = []): BrowserRun {
  return {
    quickAction: (action: string, options: unknown) => {
      calls.push({ action, options });
      return Promise.resolve(response());
    },
  } as unknown as BrowserRun;
}

describe("PDF 化", () => {
  it("BROWSER がない環境では HTML のまま返す", async () => {
    const file = await renderPdf(env, "<p>帳票</p>");
    expect(file.extension).toBe("html");
    expect(file.contentType).toBe("text/html; charset=utf-8");
    expect(new TextDecoder().decode(file.bytes)).toBe("<p>帳票</p>");
  });

  it("Browser Rendering で A4 の PDF にする（横向きも指定できる）", async () => {
    const pdf = await pdfWithPages(1);
    const calls: unknown[] = [];
    const file = await renderPdf(
      { ...env, BROWSER: browser(() => new Response(pdf), calls) },
      "<p>x</p>",
      { orientation: "landscape" },
    );
    expect(file.extension).toBe("pdf");
    expect(file.contentType).toBe("application/pdf");
    expect(isPdf(file.bytes)).toBe(true);
    expect(calls[0]).toMatchObject({
      action: "pdf",
      options: {
        html: "<p>x</p>",
        rejectRequestPattern: ["^https?://"],
        pdfOptions: { format: "a4", landscape: true, preferCSSPageSize: true },
      },
    });
  });

  it("混み合っているときは再試行し、HTML の誤りなどは再試行しない", async () => {
    const busy = renderPdf(
      { ...env, BROWSER: browser(() => new Response("busy", { status: 429 })) },
      "<p>x</p>",
    );
    await expect(busy).rejects.toMatchObject({ permanent: false });
    const bad = renderPdf(
      { ...env, BROWSER: browser(() => new Response("bad", { status: 422 })) },
      "<p>x</p>",
    );
    await expect(bad).rejects.toBeInstanceOf(InfraError);
    await expect(bad).rejects.toMatchObject({ permanent: true });
    const notPdf = renderPdf(
      { ...env, BROWSER: browser(() => new Response("<html>")) },
      "<p>x</p>",
    );
    await expect(notPdf).rejects.toMatchObject({ permanent: false });
  });

  it("複数の PDF を1つにまとめる", async () => {
    const merger = await pdfMerger();
    await merger.add(await pdfWithPages(2));
    await merger.add(await pdfWithPages(1));
    const merged = await PDFDocument.load(await merger.save());
    expect(merged.getPageCount()).toBe(3);
    expect(isPdf(new TextEncoder().encode("%PDF"))).toBe(false);
  });
});
