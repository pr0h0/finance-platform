import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CONFORMANCE_DIR = join(import.meta.dir, '..', 'conformance');

/** Load a shared conformance fixture file (e.g. "rounding") as parsed JSON. */
export function loadConformance<T>(name: string): T {
  return JSON.parse(readFileSync(join(CONFORMANCE_DIR, `${name}.json`), 'utf8')) as T;
}

/** Synthetic import fixtures (never real statements). */
export const IMPORTS_DIR = join(import.meta.dir, '..', 'imports');

export function importFixture(path: string): Uint8Array {
  return new Uint8Array(readFileSync(join(IMPORTS_DIR, path)));
}
