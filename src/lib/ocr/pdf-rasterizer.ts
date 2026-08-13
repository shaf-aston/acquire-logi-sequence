/**
 * Renders PDF pages to PNG images using mupdf (WASM — no native build, no
 * system binaries). Tesseract needs raster images; this is the bridge.
 * Isolated so any image-based OCR engine can reuse it.
 */
import * as mupdf from "mupdf";

export interface RasterPage {
  readonly index: number;
  readonly png: Uint8Array;
}

/**
 * @param scale upscale factor — higher = sharper glyphs = better OCR, slower.
 *              2 is a good default for 150→300dpi-equivalent quotation scans.
 */
export function rasterizePdf(bytes: Uint8Array, scale: number): RasterPage[] {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  try {
    const matrix = mupdf.Matrix.scale(scale, scale);
    const pageCount = doc.countPages();
    const pages: RasterPage[] = [];

    for (let i = 0; i < pageCount; i++) {
      const page = doc.loadPage(i);
      const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false);
      try {
        pages.push({ index: i, png: pixmap.asPNG() });
      } finally {
        pixmap.destroy();
        page.destroy?.();
      }
    }
    return pages;
  } finally {
    doc.destroy();
  }
}
