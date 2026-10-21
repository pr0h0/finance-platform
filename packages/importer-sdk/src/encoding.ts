import { chunks, concat } from './input.ts';
import type { ImportContext, ImportInput, TextEncodingName } from './types.ts';

export interface EncodingGuess {
  encoding: TextEncodingName;
  bomLength: number;
  confidence: number;
}

/**
 * BOM → that encoding. Valid UTF-8 → utf-8. Otherwise a single-byte Central European code page:
 * bytes 0x80–0x9F are letters (š ž Š Ž ś ź …) in Windows-1250 but C1 controls in ISO-8859-2, so any of
 * them means windows-1250; else 0xA9/0xAE/0xB9/0xBE (Š Ž š ž in ISO-8859-2, © ® ą ľ in 1250) mean
 * iso-8859-2. With neither the two agree on č ć đ etc., and windows-1250 is returned with lower confidence.
 */
export function detectEncoding(head: Uint8Array): EncodingGuess {
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf)
    return { encoding: 'utf-8', bomLength: 3, confidence: 1 };
  if (head[0] === 0xff && head[1] === 0xfe)
    return { encoding: 'utf-16le', bomLength: 2, confidence: 1 };
  if (head[0] === 0xfe && head[1] === 0xff)
    return { encoding: 'utf-16be', bomLength: 2, confidence: 1 };
  let high = false;
  for (const b of head) if (b >= 0x80) high = true;
  if (!high) return { encoding: 'utf-8', bomLength: 0, confidence: 1 };
  try {
    // stream:true tolerates a multi-byte sequence cut at the end of the sample.
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true });
    return { encoding: 'utf-8', bomLength: 0, confidence: 0.95 };
  } catch {
    // not UTF-8
  }
  let c1 = 0;
  let latin2 = 0;
  for (const b of head) {
    if (b >= 0x80 && b <= 0x9f) c1++;
    if (b === 0xa9 || b === 0xae || b === 0xb9 || b === 0xbe) latin2++;
  }
  if (c1 > 0) return { encoding: 'windows-1250', bomLength: 0, confidence: 0.9 };
  if (latin2 > 0) return { encoding: 'iso-8859-2', bomLength: 0, confidence: 0.8 };
  return { encoding: 'windows-1250', bomLength: 0, confidence: 0.6 };
}

/** Decode a whole buffer (BOM stripped). */
export function decodeBytes(
  bytes: Uint8Array,
  encoding: TextEncodingName | 'auto' = 'auto',
): string {
  const guess = resolve(bytes, encoding);
  return new TextDecoder(guess.encoding).decode(bytes.subarray(guess.bomLength));
}

function resolve(head: Uint8Array, encoding: TextEncodingName | 'auto'): EncodingGuess {
  const g = detectEncoding(head);
  if (encoding === 'auto') return g;
  // An explicit encoding still drops a matching BOM.
  return { encoding, bomLength: g.encoding === encoding ? g.bomLength : 0, confidence: 1 };
}

/**
 * Streams decoded text. The encoding is decided from the first chunk(s) (≥64 KiB when available) and
 * exposed via `encoding` once the first string has been yielded.
 */
export async function* decodeStream(
  input: ImportInput,
  ctx: ImportContext = {},
  out: { encoding?: TextEncodingName } = {},
): AsyncGenerator<string> {
  let decoder: TextDecoder | undefined;
  let pending: Uint8Array[] = [];
  let pendingLen = 0;
  const start = (buf: Uint8Array): string => {
    const g = resolve(buf, ctx.encoding ?? 'auto');
    out.encoding = g.encoding;
    decoder = new TextDecoder(g.encoding);
    return decoder.decode(buf.subarray(g.bomLength), { stream: true });
  };
  for await (const chunk of chunks(input, ctx)) {
    if (decoder) {
      yield decoder.decode(chunk, { stream: true });
      continue;
    }
    pending.push(chunk);
    pendingLen += chunk.length;
    if (pendingLen >= 64 * 1024) {
      yield start(concat(pending));
      pending = [];
    }
  }
  if (!decoder) yield start(concat(pending));
  yield (decoder as TextDecoder).decode();
}

/** Split streamed text into lines (\n, \r\n or \r), without the terminator. */
export async function* lines(text: AsyncIterable<string>): AsyncGenerator<string> {
  let buf = '';
  const eol = /\r\n|\n|\r/g;
  for await (const t of text) {
    buf += t;
    let i = 0;
    eol.lastIndex = 0;
    for (let m = eol.exec(buf); m; m = eol.exec(buf)) {
      // A lone \r at the very end may be the first half of \r\n: wait for more text.
      if (m[0] === '\r' && m.index === buf.length - 1) break;
      yield buf.slice(i, m.index);
      i = m.index + m[0].length;
    }
    buf = buf.slice(i);
  }
  if (buf.length > 0) yield buf.endsWith('\r') ? buf.slice(0, -1) : buf;
}
