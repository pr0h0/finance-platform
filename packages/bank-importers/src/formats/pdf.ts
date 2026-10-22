// Text-based PDF statements (pdfjs-dist text layer → table rows → mapping template) and optional
// OCR for scanned PDFs / photos (tesseract.js, lazy loaded). OCR output always needs user approval.
import {
  applyTemplate,
  type BankImporter,
  ImportError,
  type ImportInput,
  ResultBuilder,
  readAll,
  readHead,
  type TableRow,
} from '@finplat/importer-sdk';
import { requireTemplate } from './tabular.ts';
import { manifest } from './util.ts';

/** A positioned text fragment. `y` grows downwards (top of page = 0). */
export interface TextItem {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
  page: number;
  conf?: number; // OCR confidence 0..100
}

/**
 * Group fragments into rows (same baseline ± h/2) and cells (horizontal gap wider than ~one
 * character height starts a new cell). Works for both PDF text layers and OCR word boxes.
 */
export function itemsToRows(
  items: readonly TextItem[],
  startLine = 1,
): (TableRow & { conf?: number })[] {
  const sorted = items
    .filter((i) => i.str.trim() !== '')
    .sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
  const rows: TextItem[][] = [];
  for (const it of sorted) {
    const row = rows[rows.length - 1];
    const ref = row?.[0];
    if (row && ref && ref.page === it.page && Math.abs(ref.y - it.y) <= Math.max(2, ref.h / 2))
      row.push(it);
    else rows.push([it]);
  }
  return rows.map((r, i) => {
    r.sort((a, b) => a.x - b.x);
    const cells: string[] = [];
    let prevEnd = Number.NEGATIVE_INFINITY;
    for (const it of r) {
      const gap = it.x - prevEnd;
      if (cells.length === 0 || gap > Math.max(it.h, 4)) cells.push(it.str.trim());
      else cells[cells.length - 1] += (gap > 0.15 * it.h ? ' ' : '') + it.str.trim();
      prevEnd = it.x + it.w;
    }
    const confs = r.map((x) => x.conf).filter((c): c is number => c !== undefined);
    return { line: startLine + i, cells, ...(confs.length ? { conf: Math.min(...confs) } : {}) };
  });
}

type Pdfjs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjs: Promise<Pdfjs> | undefined;
/** Lazy pdfjs. In browsers, call setPdfWorkerSrc() with the bundled worker URL first. */
export function loadPdfjs(): Promise<Pdfjs> {
  pdfjs ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjs;
}
export async function setPdfWorkerSrc(src: string): Promise<void> {
  (await loadPdfjs()).GlobalWorkerOptions.workerSrc = src;
}

async function openPdf(bytes: Uint8Array) {
  const lib = await loadPdfjs();
  // pdfjs >= 4.2.67 no longer evals font programs (CVE-2024-4367); no font faces, no network.
  const task = lib.getDocument({
    data: bytes,
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    verbosity: 0,
  });
  return { doc: await task.promise, close: () => task.destroy() };
}

/** Extract positioned text from every page of a text PDF. */
export async function pdfTextItems(bytes: Uint8Array, maxPages = 500): Promise<TextItem[]> {
  const { doc, close } = await openPdf(bytes);
  try {
    if (doc.numPages > maxPages)
      throw new ImportError('too_many_pages', `PDF has ${doc.numPages} pages (max ${maxPages})`);
    const out: TextItem[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const height = page.getViewport({ scale: 1 }).height;
      const tc = await page.getTextContent();
      for (const it of tc.items) {
        if (!('str' in it)) continue;
        const [, , c = 0, d = 0, e = 0, f = 0] = it.transform as number[];
        const h = Math.hypot(c, d) || it.height || 10;
        out.push({ str: it.str, x: e, y: height - f, w: it.width, h, page: p });
      }
      page.cleanup();
    }
    return out;
  } finally {
    await close();
  }
}

const isPdf = (h: Uint8Array) => h[0] === 0x25 && h[1] === 0x50 && h[2] === 0x44 && h[3] === 0x46; // %PDF

async function* iter<T>(xs: Iterable<T>): AsyncGenerator<T> {
  yield* xs;
}

export function pdfTextImporter(): BankImporter {
  const m = manifest({
    id: 'generic-pdf-text',
    version: '1.0.0',
    name: 'PDF statement (text layer + mapping template)',
    formats: ['pdf'],
    status: 'beta',
    requiresTemplate: true,
    limits: { maxBytes: 30 * 1024 * 1024 },
    limitations: [
      'Only PDFs with a text layer; scanned statements need the OCR importer.',
      'Rows are rebuilt from text positions; multi-line descriptions become separate rows (skipped as non-date rows, so only the first line is kept).',
      'Table layouts vary per bank; each bank needs its own template, and results should be checked in the preview.',
    ],
  });
  return {
    manifest: m,
    async detect(input) {
      return isPdf(await readHead(input, 5))
        ? { confidence: 0.5, format: 'pdf', reason: '%PDF header' }
        : { confidence: 0 };
    },
    async parse(input, ctx) {
      const t = requireTemplate(ctx);
      const out = new ResultBuilder(m, 'pdf', ctx);
      const items = await pdfTextItems(
        await readAll(input, { ...ctx, maxBytes: ctx.maxBytes ?? m.limits?.maxBytes }),
      );
      if (items.length === 0)
        throw new ImportError(
          'no_text_layer',
          'this PDF has no text layer (scanned?); use the OCR importer',
        );
      await applyTemplate(t, iter(itemsToRows(items)), out, ctx.accountCurrency);
      for (const r of out.records) r.confidence = Math.min(r.confidence, 0.9);
      return out.finish();
    },
  };
}

// ---- OCR (optional) ----

export interface OcrOptions {
  /** tesseract language codes, e.g. 'eng', 'bos', 'hrv', 'srp_latn'. */
  languages?: string[];
  /** Self-hosted tesseract assets. Unset = tesseract.js defaults, which download from a CDN
   * (blocked by the web app's CSP and against the privacy rules), so the web app always sets them. */
  langPath?: string; // directory with <lang>.traineddata.gz (4.0.0_best_int)
  workerPath?: string; // tesseract.js dist/worker.min.js
  corePath?: string; // directory with the tesseract-core*-lstm.wasm.js builds
}

type OffscreenCanvasCtor = new (
  w: number,
  h: number,
) => { convertToBlob(o: { type: string }): Promise<Blob> };

/** Rasterise PDF pages (browser only: needs OffscreenCanvas) or pass an image through. */
async function ocrImages(input: ImportInput, bytes: Uint8Array): Promise<Blob[]> {
  if (!isPdf(bytes))
    return [new Blob([bytes as Uint8Array<ArrayBuffer>], { type: input.contentType ?? '' })];
  const Offscreen = (globalThis as { OffscreenCanvas?: OffscreenCanvasCtor }).OffscreenCanvas;
  if (!Offscreen)
    throw new ImportError(
      'ocr_unsupported_env',
      'rendering scanned PDFs for OCR needs a browser (OffscreenCanvas)',
    );
  const { doc, close } = await openPdf(bytes);
  try {
    const blobs: Blob[] = [];
    for (let p = 1; p <= Math.min(doc.numPages, 50); p++) {
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 2 });
      const canvas = new Offscreen(vp.width, vp.height);
      await page.render({ canvas: canvas as never, viewport: vp }).promise;
      blobs.push(await canvas.convertToBlob({ type: 'image/png' }));
    }
    return blobs;
  } finally {
    await close();
  }
}

/** Run OCR and return word boxes. tesseract.js is imported only when this is called. */
export async function ocrTextItems(
  input: ImportInput,
  bytes: Uint8Array,
  opts: OcrOptions = {},
): Promise<TextItem[]> {
  const { createWorker } = await import('tesseract.js');
  const { languages, ...paths } = opts;
  const worker = await createWorker(languages ?? ['eng'], undefined, {
    ...paths,
    ...(paths.workerPath ? { workerBlobURL: false } : {}),
  });
  try {
    const items: TextItem[] = [];
    const images = await ocrImages(input, bytes);
    for (const [i, img] of images.entries()) {
      const { data } = await worker.recognize(img, {}, { blocks: true, text: false });
      for (const b of data.blocks ?? [])
        for (const para of b.paragraphs)
          for (const line of para.lines)
            for (const w of line.words)
              items.push({
                str: w.text,
                x: w.bbox.x0,
                y: line.baseline.y0,
                w: w.bbox.x1 - w.bbox.x0,
                h: w.bbox.y1 - w.bbox.y0,
                page: i + 1,
                conf: w.confidence,
              });
    }
    return items;
  } finally {
    await worker.terminate();
  }
}

/** OCR lines (for receipt breakdowns): text plus confidence; the UI must let the user approve each value. */
export async function ocrLines(
  input: ImportInput,
  opts: OcrOptions = {},
): Promise<{ text: string; confidence: number }[]> {
  const items = await ocrTextItems(input, await readAll(input), opts);
  return itemsToRows(items).map((r) => ({
    text: r.cells.join('  '),
    confidence: (r.conf ?? 0) / 100,
  }));
}

export function ocrImporter(opts: OcrOptions = {}): BankImporter {
  const m = manifest({
    id: 'generic-ocr',
    version: '1.0.0',
    name: 'Scanned statement / photo (OCR + mapping template)',
    formats: ['pdf_ocr'],
    status: 'beta',
    requiresTemplate: true,
    limits: { maxBytes: 20 * 1024 * 1024, maxRows: 5000 },
    limitations: [
      'Optional and slow; tesseract.js and its language data must be self-hosted (OcrOptions paths; the web app serves them from /tesseract/) and load on first use.',
      'Scanned PDFs can only be rasterised in a browser; images work everywhere tesseract runs.',
      'OCR misreads digits: every record has low confidence and the batch requires explicit user approval.',
    ],
  });
  return {
    manifest: m,
    async detect(input) {
      const h = await readHead(input, 8);
      const img =
        (h[0] === 0xff && h[1] === 0xd8) ||
        (h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e && h[3] === 0x47);
      if (img) return { confidence: 0.4, format: 'pdf_ocr', reason: 'image' };
      if (isPdf(h)) return { confidence: 0.1, format: 'pdf_ocr', reason: 'PDF (only if scanned)' };
      return { confidence: 0 };
    },
    async parse(input, ctx) {
      const t = requireTemplate(ctx);
      const out = new ResultBuilder(m, 'pdf_ocr', ctx);
      out.requiresApproval = true;
      const bytes = await readAll(input, { ...ctx, maxBytes: ctx.maxBytes ?? m.limits?.maxBytes });
      const rows = itemsToRows(await ocrTextItems(input, bytes, opts));
      await applyTemplate(t, iter(rows), out, ctx.accountCurrency);
      const conf = new Map(rows.map((r) => [r.line, (r.conf ?? 0) / 100]));
      for (const r of out.records) {
        r.confidence = Math.min(0.6, conf.get(r.rowNumber) ?? 0);
        r.warnings.push({
          row: r.rowNumber,
          code: 'ocr_unverified',
          message: 'value read by OCR; confirm before saving',
        });
      }
      return out.finish();
    },
  };
}
