/**
 * 帳票の HTML を PDF にする（Browser Rendering の Quick Action「pdf」をバインディングから呼ぶ）。
 * BROWSER のバインディングがない開発・テストの環境では、HTML をそのまま返す（仕組みの流れは同じに保つ）。
 */
import type { Orientation } from "../../domain/documents";
import { InfraError } from "../errors";

export interface RenderedFile {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly extension: "pdf" | "html";
}

export interface RenderOptions {
  /** 用紙の向き（A4）。初期値は縦 */
  readonly orientation?: Orientation;
}

export const HTML_CONTENT_TYPE = "text/html; charset=utf-8";
export const PDF_CONTENT_TYPE = "application/pdf";

/** Browser Rendering の応答から、利用者向けの失敗の文言と、再試行するかを決める */
function renderError(status: number, body: string): InfraError {
  // 429（混雑）と 5xx は時間をおけば直ることがあるので再試行する。それ以外は HTML や設定の誤り
  const transient = status === 429 || status >= 500;
  return new InfraError(
    transient
      ? "PDF の作成が混み合っています。しばらくしてから自動でやり直します"
      : "PDF を作成できませんでした（帳票の内容を確認してください）",
    !transient,
    { status, body: body.slice(0, 500) },
  );
}

export async function renderPdf(
  env: Env,
  html: string,
  options: RenderOptions = {},
): Promise<RenderedFile> {
  if (!env.BROWSER) {
    return {
      bytes: new TextEncoder().encode(html),
      contentType: HTML_CONTENT_TYPE,
      extension: "html",
    };
  }
  const response = await env.BROWSER.quickAction("pdf", {
    html,
    // 帳票は自分の中で完結させる（スクリプトを動かさず、外部のファイルも読みに行かない）
    setJavaScriptEnabled: false,
    rejectRequestPattern: ["^https?://"],
    emulateMediaType: "print",
    gotoOptions: { waitUntil: "load", timeout: 30_000 },
    cacheTTL: 0,
    pdfOptions: {
      format: "a4",
      landscape: options.orientation === "landscape",
      printBackground: true,
      preferCSSPageSize: true,
      timeout: 60_000,
    },
  });
  if (!response.ok) throw renderError(response.status, await response.text());
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!isPdf(bytes)) throw renderError(502, "response is not a PDF");
  return { bytes, contentType: PDF_CONTENT_TYPE, extension: "pdf" };
}

/** PDF のファイルか（先頭が %PDF-） */
export function isPdf(bytes: Uint8Array): boolean {
  return (
    bytes.length > 4 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  );
}
