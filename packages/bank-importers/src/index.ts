import type { BankImporter, ImporterManifest } from '@finplat/importer-sdk';

/** Bundled, reviewed importers. Imports agent registers parsers here. */
export const importers: BankImporter[] = [];

/**
 * Importers whose real format is unknown. Raiffeisen Bank BiH (Feature 121) is BLOCKED_EXTERNAL
 * until a sanitized sample statement is provided; do not guess its format.
 */
export const blockedImporters: ImporterManifest[] = [
  {
    id: 'raiffeisen-bih',
    version: '0.0.0',
    sdkVersion: 1,
    name: 'Raiffeisen Bank BiH',
    bank: { name: 'Raiffeisen Bank d.d. Bosna i Hercegovina', country: 'BA' },
    formats: [],
    status: 'blocked_external',
  },
];
