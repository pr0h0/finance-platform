// Self-hosted tesseract.js assets (copied to /tesseract/ by vite.config.ts). OCR never contacts a
// third party; languages are the ones bundled there.
import type { OcrOptions } from '@finplat/bank-importers';

export function ocrAssets(origin = globalThis.location?.origin ?? ''): OcrOptions {
  return {
    languages: ['eng', 'bos', 'hrv'],
    workerPath: `${origin}/tesseract/worker.min.js`,
    corePath: `${origin}/tesseract`,
    langPath: `${origin}/tesseract/lang`,
  };
}
