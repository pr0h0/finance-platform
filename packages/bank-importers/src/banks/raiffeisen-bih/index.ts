// Raiffeisen Bank d.d. Bosna i Hercegovina — BLOCKED_EXTERNAL (PLAN Feature 121).
// The statement format is unknown until a sanitized real sample is supplied. Do NOT guess columns,
// encodings or identifiers here. See README.md for what is needed to implement it.
import { type BankImporter, ImportError } from '@finplat/importer-sdk';
import { manifest } from '../../formats/util.ts';

export const raiffeisenBihManifest = manifest({
  id: 'raiffeisen-bih',
  version: '0.0.0',
  name: 'Raiffeisen Bank BiH',
  bank: { name: 'Raiffeisen Bank d.d. Bosna i Hercegovina', country: 'BA' },
  formats: [],
  status: 'blocked_external',
  limitations: [
    'Waiting for a sanitized sample statement; use a generic importer with a mapping template meanwhile.',
  ],
});

export const raiffeisenBih: BankImporter = {
  manifest: raiffeisenBihManifest,
  async detect() {
    return { confidence: 0, reason: 'format not yet known (BLOCKED_EXTERNAL)' };
  },
  async parse() {
    throw new ImportError(
      'importer_blocked',
      'Raiffeisen Bank BiH import is not available yet (BLOCKED_EXTERNAL)',
    );
  },
};
