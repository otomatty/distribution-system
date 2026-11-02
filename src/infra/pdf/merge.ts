/** 複数の PDF を1つにまとめる（一括 PDF、要件定義書 3.9）。 */
import { PDFDocument } from "pdf-lib";

export interface PdfMerger {
  /** PDF を末尾に足す（読み込んだ PDF はすぐ手放せるよう、1件ずつ足す） */
  add(file: Uint8Array): Promise<void>;
  save(): Promise<Uint8Array>;
}

export async function pdfMerger(): Promise<PdfMerger> {
  const merged = await PDFDocument.create();
  return {
    async add(file) {
      const source = await PDFDocument.load(file);
      const pages = await merged.copyPages(source, source.getPageIndices());
      for (const page of pages) merged.addPage(page);
    },
    save() {
      return merged.save();
    },
  };
}
