// Catalog completeness and "no hardcoded English" checks over the web sources (TypeScript AST).
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { bs as pkgBs } from '@finplat/localization';
import ts from 'typescript';
import { bs } from './messages.bs.ts';

const SRC = join(import.meta.dir, '..');
const PENDING: string[] = [];
// JSX attributes that carry user-visible text.
const TEXT_ATTRS = new Set([
  'aria-label',
  'alt',
  'confirmLabel',
  'description',
  'emptyText',
  'heading',
  'hint',
  'label',
  'placeholder',
  'subtitle',
  'title',
]);
// Not translatable: units, codes, product names, symbols.
const ALLOWED =
  /^(E2EE|Aa|Ctrl K|auth\.login|CSV|PDF|PNG|JSON|XLSX|OFX|QIF|MCP|PIN|IBAN|ID|URL|KM|BAM|EUR|USD|OK|English|Bosanski|Finance Platform|[\W\d_]*)$/;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return files(p);
    return /\.tsx?$/.test(e.name) && !/\.test(-util)?\.tsx?$/.test(e.name) ? [p] : [];
  });
}

const sources = files(SRC).map((p) => {
  const text = readFileSync(p, 'utf8');
  return {
    rel: relative(SRC, p),
    sf: ts.createSourceFile(p, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
  };
});

function walk(n: ts.Node, f: (n: ts.Node) => void) {
  f(n);
  n.forEachChild((c) => walk(c, f));
}

const isStr = (n: ts.Node | undefined): n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
  !!n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n));

// A string literal used as a ?: branch or the right side of && || ?? inside a JSX child/text attribute.
function uiLiteral(n: ts.Node): boolean {
  let c: ts.Node = n;
  let p = n.parent;
  let hops = 0;
  const ops = [
    ts.SyntaxKind.AmpersandAmpersandToken,
    ts.SyntaxKind.BarBarToken,
    ts.SyntaxKind.QuestionQuestionToken,
  ];
  while (
    ts.isParenthesizedExpression(p) ||
    (ts.isConditionalExpression(p) && (p.whenTrue === c || p.whenFalse === c)) ||
    (ts.isBinaryExpression(p) && p.right === c && ops.includes(p.operatorToken.kind))
  ) {
    hops++;
    c = p;
    p = p.parent;
  }
  if (!hops || !ts.isJsxExpression(p)) return false;
  const q = p.parent;
  return (
    ts.isJsxElement(q) ||
    ts.isJsxFragment(q) ||
    (ts.isJsxAttribute(q) && TEXT_ATTRS.has(q.name.getText()))
  );
}

test('every t(key, english) used by the web app has a Bosnian translation', () => {
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const { rel, sf } of sources) {
    walk(sf, (n) => {
      if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression) || n.expression.text !== 't')
        return;
      const [k, en] = n.arguments;
      if (!isStr(k) || !isStr(en) || seen.has(k.text)) return;
      seen.add(k.text);
      const tr = bs[k.text] ?? (pkgBs as Record<string, string>)[k.text];
      if (!tr) missing.push(`${rel}: ${k.text} = ${en.text}`);
    });
  }
  expect(missing).toEqual([]);
  expect(seen.size).toBeGreaterThan(400);
});

test('Bosnian keeps every {{placeholder}} of the English text', () => {
  const bad: string[] = [];
  for (const { sf } of sources)
    walk(sf, (n) => {
      if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression) || n.expression.text !== 't')
        return;
      const [k, en] = n.arguments;
      if (!isStr(k) || !isStr(en)) return;
      const tr = bs[k.text] ?? (pkgBs as Record<string, string>)[k.text] ?? '';
      const vars = (s: string) => (s.match(/\{\{\w+\}\}/g) ?? []).sort().join();
      if (vars(tr) !== vars(en.text)) bad.push(`${k.text}: ${tr}`);
    });
  expect(bad).toEqual([]);
});

test('no hardcoded English UI text outside the catalogs', () => {
  const found: string[] = [];
  const flag = (rel: string, sf: ts.SourceFile, n: ts.Node, s: string) => {
    const v = s.replace(/\s+/g, ' ').trim();
    if (/[A-Za-z]{2,}/.test(v) && !ALLOWED.test(v)) {
      const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
      found.push(`${rel}:${line} ${v}`);
    }
  };
  for (const { rel, sf } of sources) {
    if (!rel.endsWith('.tsx') || PENDING.some((p) => rel.startsWith(p))) continue;
    walk(sf, (n) => {
      if (ts.isJsxText(n)) flag(rel, sf, n, n.text);
      else if (ts.isJsxAttribute(n) && TEXT_ATTRS.has(n.name.getText()) && n.initializer) {
        const i = n.initializer;
        if (isStr(i)) flag(rel, sf, n, i.text);
        else if (ts.isJsxExpression(i) && isStr(i.expression)) flag(rel, sf, n, i.expression.text);
      } else if (isStr(n) && uiLiteral(n)) flag(rel, sf, n, n.text);
      else if (
        ts.isJsxExpression(n) &&
        isStr(n.expression) &&
        (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent))
      )
        flag(rel, sf, n, n.expression.text);
    });
  }
  expect(found).toEqual([]);
});
