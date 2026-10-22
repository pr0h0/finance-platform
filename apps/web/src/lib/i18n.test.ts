// Catalog completeness and "no hardcoded English" checks over the web sources (TypeScript AST).
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createRegistry } from '@finplat/bank-importers';
import {
  ACCOUNT_TYPES,
  BUDGET_PERIOD_TYPES,
  CONFIDENCE_LEVELS,
  GOAL_KINDS,
  GOAL_STATUSES,
  OCCURRENCE_STATUSES,
  PRIORITIES,
  ROLLOVER_POLICIES,
  TRANSACTION_KINDS,
  TRANSACTION_SOURCES,
  TRANSACTION_STATUSES,
} from '@finplat/domain';
import { bs as pkgBs } from '@finplat/localization';
import ts from 'typescript';
import { WIDGETS } from '../features/dashboard/layout.ts';
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

// Literal parts of `Edit ${name}` (placeholders dropped), so template strings are checked too.
const templateText = (e: ts.TemplateExpression) =>
  [e.head.text, ...e.templateSpans.map((s) => s.literal.text)].join(' ');

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
        else if (ts.isJsxExpression(i) && i.expression && ts.isTemplateExpression(i.expression))
          flag(rel, sf, n, templateText(i.expression));
      } else if (isStr(n) && uiLiteral(n)) flag(rel, sf, n, n.text);
      else if (ts.isTemplateExpression(n) && uiLiteral(n)) flag(rel, sf, n, templateText(n));
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

// Words-only English ("Import batch", "Total balance"): what labels look like, unlike keys, ids or css.
const PROSE = /^[A-Z][a-z]+(?:[\s,.;:()'’/-]+[A-Za-z][a-z]*)*[\s.…:!?)]*$/;
// Callees whose string arguments are never shown to the user.
const NON_UI_CALLS = new Set([
  't',
  'translate',
  'tNow',
  'Error',
  'get',
  'getItem',
  'setItem',
  'startsWith',
  'includes',
  'book_append_sheet',
]);

// A string inside an array literal passed to a JSX attribute: warnings={[`No rate for ${x}`]}.
function arrayPropLiteral(n: ts.Node): boolean {
  let p = n.parent;
  while (ts.isParenthesizedExpression(p) || ts.isConditionalExpression(p)) p = p.parent;
  if (!ts.isArrayLiteralExpression(p)) return false;
  while (
    ts.isArrayLiteralExpression(p) ||
    ts.isParenthesizedExpression(p) ||
    ts.isConditionalExpression(p)
  )
    p = p.parent;
  return ts.isJsxExpression(p) && ts.isJsxAttribute(p.parent);
}

test('no English text in array literals passed as JSX props', () => {
  const found: string[] = [];
  for (const { rel, sf } of sources)
    walk(sf, (n) => {
      const v = isStr(n) ? n.text : ts.isTemplateExpression(n) ? templateText(n) : '';
      if (v && arrayPropLiteral(n) && PROSE.test(v.trim()) && !ALLOWED.test(v))
        found.push(`${rel}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} ${v}`);
    });
  expect(found).toEqual([]);
});

test('no English labels passed as plain arguments or label/title properties', () => {
  const found: string[] = [];
  const at = (rel: string, sf: ts.SourceFile, n: ts.Node, v: string) =>
    found.push(`${rel}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} ${v}`);
  for (const { rel, sf } of sources) {
    walk(sf, (n) => {
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        const callee = n.expression;
        const name = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee)
            ? callee.name.text
            : '';
        if (NON_UI_CALLS.has(name)) return;
        for (const a of n.arguments ?? []) {
          const v = isStr(a) ? a.text : ts.isTemplateExpression(a) ? templateText(a) : '';
          if (PROSE.test(v.trim()) && !ALLOWED.test(v)) at(rel, sf, a, v);
        }
      } else if (
        ts.isPropertyAssignment(n) &&
        /^(title|label|body|description|text|message|heading)$/.test(n.name.getText()) &&
        // { labelKey: 'nav.goals', label: 'Savings goals' }: the English fallback of a t() key
        !n.parent.properties.some((p) => p.name?.getText().endsWith('Key'))
      ) {
        const i = n.initializer;
        const v = isStr(i) ? i.text : ts.isTemplateExpression(i) ? templateText(i) : '';
        if ((PROSE.test(v) || /[A-Za-z]{2,} [A-Za-z]{2,}/.test(v)) && !ALLOWED.test(v))
          at(rel, sf, n, v);
      }
    });
  }
  expect(found).toEqual([]);
});

// Keys built at runtime: t(`transaction.kind.${k}`, k), t(w.titleKey, w.title), importer limitations.
test('runtime-built keys have Bosnian translations', () => {
  const has = (k: string) => !!(bs[k] ?? (pkgBs as Record<string, string>)[k]);
  const keys = [
    ...TRANSACTION_KINDS.map((k) => `transaction.kind.${k}`),
    ...TRANSACTION_STATUSES.map((k) => `transaction.status.${k}`),
    ...TRANSACTION_SOURCES.map((k) => `transaction.source.${k}`),
    ...ACCOUNT_TYPES.map((k) => `accountType.${k}`),
    ...BUDGET_PERIOD_TYPES.map((k) => `budget.period.${k}`),
    ...ROLLOVER_POLICIES.map((k) => `budget.rollover.${k}`),
    ...CONFIDENCE_LEVELS.map((k) => `planning.confidence.${k}`),
    ...PRIORITIES.map((k) => `planning.priority.${k}`),
    ...OCCURRENCE_STATUSES.map((k) => `planning.occurrenceStatus.${k}`),
    ...GOAL_KINDS.map((k) => `goal.kind.${k}`),
    ...GOAL_STATUSES.map((k) => `goal.status.${k}`),
    ...['complete', 'plan', 'history', 'none'].map((k) => `goal.basis.${k}`),
    ...['monthly', 'quarterly', 'annual', 'custom'].map((k) => `reports.title.${k}`),
    ...['month', '3m', '6m', '12m', 'ytd', 'custom'].map((k) => `analytics.preset.${k}`),
    ...WIDGETS.map((w) => w.titleKey),
    ...createRegistry()
      .manifests()
      .flatMap((m) => (m.limitations ?? []).map((l) => `importer.limitation:${l}`)),
  ];
  expect(keys.filter((k) => !has(k))).toEqual([]);
});

// Engine Notices ({ key, en, vars }) are translated by key in the UI: every one needs Bosnian with the
// same placeholders.
test('engine notices have Bosnian translations', () => {
  const dirs = ['finance-engine', 'forecasting'].map((d) =>
    join(SRC, '../../../packages', d, 'src'),
  );
  const notices = dirs
    .flatMap(files)
    .flatMap((p) => [...readFileSync(p, 'utf8').matchAll(/key: '([\w.]+)',\s*en: '([^']+)'/g)]);
  expect(notices.length).toBeGreaterThanOrEqual(9);
  const vars = (s: string) => (s.match(/\{\{\w+\}\}/g) ?? []).sort().join();
  const bad = notices
    .filter(([, k = '', en = '']) => !bs[k] || vars(bs[k]) !== vars(en))
    .map(([, k]) => k);
  expect(bad).toEqual([]);
});
