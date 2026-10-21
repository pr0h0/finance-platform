export interface CsvRow {
  /** 1-based source line where the row starts. */
  line: number;
  cells: string[];
}

export interface CsvOptions {
  delimiter: string;
  quote?: string; // default '"'; '' disables quoting
}

/**
 * Incremental RFC 4180 parser over streamed text: quoted fields may contain delimiters, doubled
 * quotes and newlines. Memory is bounded by the longest row, not the file.
 */
export async function* parseCsv(
  text: AsyncIterable<string>,
  opts: CsvOptions,
): AsyncGenerator<CsvRow> {
  const d = opts.delimiter;
  const q = opts.quote ?? '"';
  let cells: string[] = [];
  let field = '';
  let inQuotes = false;
  let quoteMaybeEnd = false; // saw a quote inside quotes; next char decides
  let afterCr = false;
  let line = 1;
  let rowLine = 1;
  let rowHasData = false;
  const endRow = (): CsvRow | undefined => {
    cells.push(field);
    const row =
      rowHasData || cells.length > 1 || field !== '' ? { line: rowLine, cells } : undefined;
    cells = [];
    field = '';
    rowHasData = false;
    return row;
  };
  for await (const chunk of text) {
    for (const c of chunk) {
      if (afterCr) {
        afterCr = false;
        if (c === '\n') continue;
      }
      if (inQuotes) {
        if (quoteMaybeEnd) {
          quoteMaybeEnd = false;
          if (c === q) {
            field += q;
            continue;
          }
          inQuotes = false; // fall through: c is processed as an unquoted char
        } else if (c === q) {
          quoteMaybeEnd = true;
          continue;
        } else {
          if (c === '\n' || c === '\r') line++;
          if (c === '\r') afterCr = true;
          field += c;
          continue;
        }
      }
      if (c === d) {
        cells.push(field);
        field = '';
        rowHasData = true;
      } else if (c === '\n' || c === '\r') {
        if (c === '\r') afterCr = true;
        const row = endRow();
        if (row) yield row;
        line++;
        rowLine = line;
      } else if (c === q && q !== '' && field === '') {
        inQuotes = true;
        rowHasData = true;
      } else {
        field += c;
      }
    }
  }
  const row = endRow();
  if (row) yield row;
}

const CANDIDATES = [';', ',', '\t', '|'];

/** Pick the delimiter whose count is non-zero and most consistent over the first lines. */
export function sniffDelimiter(sample: string): string {
  const ls = sample
    .split(/\r\n|\n|\r/)
    .filter((l) => l.trim() !== '')
    .slice(0, 20);
  let best = ',';
  let bestScore = -1;
  for (const d of CANDIDATES) {
    const counts = ls.map((l) => countOutsideQuotes(l, d));
    const nonZero = counts.filter((n) => n > 0);
    if (nonZero.length === 0) continue;
    const mode = mostCommon(nonZero);
    const score = counts.filter((n) => n === mode).length * 100 + mode;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

function countOutsideQuotes(line: string, d: string): number {
  let n = 0;
  let inQ = false;
  for (const c of line) {
    if (c === '"') inQ = !inQ;
    else if (c === d && !inQ) n++;
  }
  return n;
}

function mostCommon(xs: number[]): number {
  const m = new Map<number, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 0;
}
