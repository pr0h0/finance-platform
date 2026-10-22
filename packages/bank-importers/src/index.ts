import { type BankImporter, type ImporterManifest, ImporterRegistry } from '@finplat/importer-sdk';
import { raiffeisenBih } from './banks/raiffeisen-bih/index.ts';
import { camtImporter } from './formats/camt.ts';
import { jsonImporter } from './formats/json.ts';
import { mt940Importer } from './formats/mt940.ts';
import { ofxImporter } from './formats/ofx.ts';
import { type OcrOptions, ocrImporter, pdfTextImporter } from './formats/pdf.ts';
import { qifImporter } from './formats/qif.ts';
import { delimitedImporter, spreadsheetImporter } from './formats/tabular.ts';

export { raiffeisenBih } from './banks/raiffeisen-bih/index.ts';
export { camtImporter } from './formats/camt.ts';
export { jsonImporter } from './formats/json.ts';
export { decodeEntities, parseMarkup } from './formats/markup.ts';
export { mt940Importer } from './formats/mt940.ts';
export { ofxImporter } from './formats/ofx.ts';
export {
  itemsToRows,
  type OcrOptions,
  ocrImporter,
  ocrLines,
  pdfTextImporter,
  pdfTextItems,
  setPdfWorkerSrc,
  type TextItem,
} from './formats/pdf.ts';
export { qifImporter } from './formats/qif.ts';
export {
  delimitedImporter,
  excelNumberText,
  readTablePreview,
  spreadsheetImporter,
  suggestTemplate,
  type TablePreview,
  type TemplateSuggestion,
} from './formats/tabular.ts';

/** Bundled, reviewed importers (PLAN §24: no runtime-loaded code). */
export const importers: BankImporter[] = [
  delimitedImporter('csv'),
  delimitedImporter('tsv'),
  spreadsheetImporter('xlsx'),
  spreadsheetImporter('xls'),
  ofxImporter(false),
  ofxImporter(true),
  qifImporter(),
  camtImporter('053'),
  camtImporter('054'),
  mt940Importer(),
  jsonImporter(),
  pdfTextImporter(),
  ocrImporter(),
  raiffeisenBih,
];

/** Importers whose real format is unknown (Raiffeisen BiH, Feature 121). */
export const blockedImporters: ImporterManifest[] = importers
  .map((i) => i.manifest)
  .filter((m) => m.status === 'blocked_external');

/** ocr: self-hosted tesseract paths for the OCR importer (see OcrOptions). */
export function createRegistry(o: { ocr?: OcrOptions } = {}): ImporterRegistry {
  const ocr = o.ocr;
  return new ImporterRegistry(
    ocr
      ? importers.map((i) => (i.manifest.id === 'generic-ocr' ? ocrImporter(ocr) : i))
      : importers,
  );
}
