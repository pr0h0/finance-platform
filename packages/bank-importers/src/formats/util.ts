import {
  decodeBytes,
  IMPORTER_SDK_VERSION,
  type ImporterManifest,
  type ImportInput,
  readHead,
} from '@finplat/importer-sdk';

export const ext = (input: ImportInput): string => {
  const m = /\.([a-z0-9]+)$/i.exec(input.fileName);
  return m ? (m[1] as string).toLowerCase() : '';
};

/** Decoded leading text for detection (encoding auto-detected). */
export async function headText(input: ImportInput, n = 8192): Promise<string> {
  return decodeBytes(await readHead(input, n));
}

export function manifest(m: Omit<ImporterManifest, 'sdkVersion'>): ImporterManifest {
  return { sdkVersion: IMPORTER_SDK_VERSION, ...m };
}

/** YYYYMMDD[...] (OFX) or YYYY-MM-DD[...] (ISO) → YYYY-MM-DD as printed (no TZ shift). */
export function compactDate(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(s.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : undefined;
}
