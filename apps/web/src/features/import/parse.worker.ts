// Statement parsing off the main thread (Feature 113). Importers stream CSV/TSV/QIF/MT940 and
// report bytes read; whole-file formats (XLSX, PDF, XML) are capped by their manifest limits.
/// <reference lib="webworker" />
import { createRegistry, readTablePreview, setPdfWorkerSrc } from '@finplat/bank-importers';
import { type ImportContext, inputFromBlob, type SourceFormat } from '@finplat/importer-sdk';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import { ocrAssets } from '../../lib/ocr.ts';
import type { WorkerRequest, WorkerResponse } from './worker-types.ts';

const registry = createRegistry({ ocr: ocrAssets() });
let pdfReady: Promise<void> | null = null;
const post = (m: WorkerResponse) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);

async function sha256(file: Blob): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  try {
    pdfReady ??= setPdfWorkerSrc(pdfWorkerUrl);
    await pdfReady;
    const input = inputFromBlob(req.file, req.file.name);
    if (req.kind === 'preview') {
      const p = await readTablePreview(
        input,
        {
          format: req.format as SourceFormat,
          delimiter: req.delimiter,
          encoding: req.encoding,
          sheet: req.sheet,
        },
        req.max ?? 30,
      );
      post({ id: req.id, type: 'preview', preview: p });
      return;
    }
    const candidates = (await registry.detect(input)).map((c) => ({
      id: c.importer.id,
      name: c.importer.name,
      confidence: c.confidence,
      format: c.format,
    }));
    const importerId = req.importerId || candidates[0]?.id;
    if (!importerId)
      throw Object.assign(
        new Error('No importer recognises this file. Choose one, or build a mapping template.'),
        { code: 'not_detected' },
      );
    const imp = registry.require(importerId);
    if (imp.manifest.requiresTemplate && req.template === undefined)
      throw Object.assign(
        new Error(
          `${imp.manifest.name} needs a mapping template. Pick a saved one or create it in the Mapping editor tab.`,
        ),
        { code: 'template_required' },
      );
    const ctx: ImportContext = {
      accountCurrency: req.accountCurrency,
      template: req.template,
      onProgress: (bytes) => post({ id: req.id, type: 'progress', bytes, total: req.file.size }),
    };
    const result = await imp.parse(input, ctx);
    post({
      id: req.id,
      type: 'parsed',
      result,
      candidates,
      importerId,
      sha256: await sha256(req.file),
    });
  } catch (e) {
    post({
      id: req.id,
      type: 'error',
      code: (e as { code?: string }).code ?? 'parse_failed',
      message: e instanceof Error ? e.message : String(e),
    });
  }
};
