import type { ImportContext, ImportInput } from './types.ts';

export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024; // whole-file formats (XML, XLSX, PDF, JSON)
export const DEFAULT_MAX_ROWS = 200_000;

export class ImportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Wraps a browser File/Blob (or Bun.file) without reading it. */
export function inputFromBlob(blob: Blob, fileName?: string): ImportInput {
  const name = fileName ?? (blob as Blob & { name?: string }).name ?? 'upload';
  return {
    fileName: name,
    size: blob.size,
    contentType: blob.type || undefined,
    stream: () => blob.stream() as ReadableStream<Uint8Array>,
  };
}

export function inputFromBytes(
  fileName: string,
  bytes: Uint8Array,
  contentType?: string,
): ImportInput {
  return inputFromBlob(
    new Blob([bytes as Uint8Array<ArrayBuffer>], { type: contentType ?? '' }),
    fileName,
  );
}

/** Up to `n` leading bytes, cancelling the stream afterwards. */
export async function readHead(input: ImportInput, n = 64 * 1024): Promise<Uint8Array> {
  const reader = input.stream().getReader();
  const parts: Uint8Array[] = [];
  let len = 0;
  try {
    while (len < n) {
      const { value, done } = await reader.read();
      if (done) break;
      parts.push(value);
      len += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return concat(parts).subarray(0, n);
}

/** Whole file, refusing anything over the byte limit (for formats that cannot be streamed). */
export async function readAll(input: ImportInput, ctx: ImportContext = {}): Promise<Uint8Array> {
  const max = ctx.maxBytes ?? DEFAULT_MAX_BYTES;
  if (input.size > max) throw tooLarge(input.size, max);
  const parts: Uint8Array[] = [];
  let len = 0;
  for await (const chunk of chunks(input, ctx)) {
    len += chunk.length;
    if (len > max) throw tooLarge(len, max);
    parts.push(chunk);
  }
  return concat(parts);
}

/** Byte chunks with progress + abort support. */
export async function* chunks(
  input: ImportInput,
  ctx: ImportContext = {},
): AsyncGenerator<Uint8Array> {
  const reader = input.stream().getReader();
  let read = 0;
  try {
    for (;;) {
      if (ctx.signal?.aborted) throw new ImportError('aborted', 'import aborted');
      const { value, done } = await reader.read();
      if (done) return;
      read += value.length;
      ctx.onProgress?.(read);
      yield value;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function tooLarge(size: number, max: number): ImportError {
  return new ImportError(
    'file_too_large',
    `file is ${size} bytes; this format is limited to ${max}`,
  );
}

export function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1 && parts[0]) return parts[0];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
