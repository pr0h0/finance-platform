// Client-side report export: CSV (RFC 4180, spreadsheet formula injection guarded), PNG of a
// rendered chart SVG, and PDF through the browser's print dialog (print stylesheet in the page).
import { tNow } from '../../lib/i18n.ts';

/** Quote a CSV cell; cells starting with = + - @ tab or CR get a leading ' unless numeric. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: readonly (readonly unknown[])[]): string {
  return `${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export function download(name: string, data: Blob): void {
  const url = URL.createObjectURL(data);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** UTF-8 CSV; the byte order mark (default on) makes Excel read č ć đ š ž instead of mojibake. */
export function csvBlob(rows: readonly (readonly unknown[])[], bom = true): Blob {
  return new Blob([bom ? '\uFEFF' : '', toCsv(rows)], { type: 'text/csv;charset=utf-8' });
}

export function downloadCsv(name: string, rows: readonly (readonly unknown[])[], bom = true): void {
  download(name, csvBlob(rows, bom));
}

/** Render the first <svg> inside `container` to a PNG (2x scale, page background) and save it. */
export async function downloadChartPng(container: HTMLElement, name: string): Promise<void> {
  const svg = container.querySelector('svg');
  if (!svg) throw new Error('no chart to export');
  const { width, height } = svg.getBoundingClientRect();
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  // Inline computed colors so CSS variables survive outside the page.
  const src = svg.querySelectorAll('*');
  clone.querySelectorAll('*').forEach((el, i) => {
    const cs = getComputedStyle(src[i] as Element);
    (el as SVGElement).style.fill = cs.fill;
    (el as SVGElement).style.stroke = cs.stroke;
    (el as SVGElement).style.font = cs.font;
  });
  const xml = new XMLSerializer().serializeToString(clone);
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * 2);
  canvas.height = Math.ceil(height * 2);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  ctx.fillStyle = getComputedStyle(document.body).backgroundColor || '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(2, 2);
  ctx.drawImage(img, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  if (!blob) throw new Error(tNow('reports.err.png', 'PNG export failed'));
  download(name, blob);
}
