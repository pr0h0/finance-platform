// Receipt scanning (feature 79): pick candidate values out of OCR lines. Nothing is applied
// automatically; the drawer shows each value for the user to correct and approve.

export interface OcrLine {
  text: string;
  confidence: number; // 0..1
}

export interface ReceiptValue {
  value: string;
  confidence: number;
  line: string;
}

export interface ReceiptGuess {
  total: ReceiptValue | null; // positive decimal string with 2 decimals
  date: ReceiptValue | null; // ISO yyyy-mm-dd
  merchant: ReceiptValue | null;
}

const TOTAL_WORDS = /\b(total|ukupno|za platiti|iznos|suma|sveukupno|gesamt|summe|amount due)\b/i;
// 1.234,56 | 1,234.56 | 1 234,56 | 12,50 | 12.50 — the last separator + 2 digits are the cents
const AMOUNT = /(?<![\d.,])(\d{1,3}(?:[ .,]\d{3})+|\d+)[.,](\d{2})(?![\d])/g;

const DATES = /\b(\d{1,2}[./]\d{1,2}[./]\d{2,4}|20\d{2}-\d{2}-\d{2})\b/g;

function amounts(text: string): string[] {
  return [...text.replace(DATES, ' ').matchAll(AMOUNT)].map((m) => {
    const int = (m[1] ?? '').replace(/[ .,]/g, '').replace(/^0+(?=\d)/, '');
    return `${int}.${m[2]}`;
  });
}

const cents = (d: string) => BigInt(d.replace('.', ''));

function isoDate(text: string): string | null {
  let m = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (m) return valid(m[1], m[2], m[3]);
  m = text.match(/\b(\d{1,2})[./](\d{1,2})[./](20\d{2}|\d{2})\b/);
  if (m) return valid(m[3]?.length === 2 ? `20${m[3]}` : m[3], m[2], m[1]);
  return null;
}

function valid(y?: string, mo?: string, d?: string): string | null {
  if (!y || !mo || !d) return null;
  const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  const t = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== iso ? null : iso;
}

export function extractReceipt(lines: OcrLine[]): ReceiptGuess {
  let total: ReceiptValue | null = null;
  let largest: ReceiptValue | null = null;
  let date: ReceiptValue | null = null;
  let merchant: ReceiptValue | null = null;
  for (const l of lines) {
    const text = l.text.trim();
    if (!text) continue;
    if (!merchant && /\p{L}{3,}/u.test(text) && amounts(text).length === 0 && !isoDate(text))
      merchant = { value: text.replace(/\s+/g, ' '), confidence: l.confidence, line: text };
    if (!date) {
      const d = isoDate(text);
      if (d) date = { value: d, confidence: l.confidence, line: text };
    }
    const found = amounts(text);
    const last = found[found.length - 1];
    if (!last) continue;
    // the last "TOTAL" line wins (subtotal lines come first on most receipts)
    if (TOTAL_WORDS.test(text) && !/sub\s*total|podzbir|pdv|vat|tax/i.test(text))
      total = { value: last, confidence: l.confidence, line: text };
    for (const a of found)
      if (!largest || cents(a) > cents(largest.value))
        largest = { value: a, confidence: l.confidence, line: text };
  }
  // without a labelled total the largest amount is only a guess: halve its confidence
  if (!total && largest) total = { ...largest, confidence: largest.confidence / 2 };
  return { total, date, merchant };
}
