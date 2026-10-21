// Minimal, safe markup parser for CAMT (XML) and OFX (XML v2 or SGML v1). Non-validating:
// no DTDs (rejected: XXE / entity expansion), no external resources, only the five predefined
// entities plus numeric references. Namespace prefixes are dropped from element names.
import { ImportError } from '@finplat/importer-sdk';

export interface Node {
  name: string;
  attrs: Record<string, string>;
  children: Node[];
  text: string;
}

const ENT: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e: string) => {
    if (e.startsWith('#x')) return String.fromCodePoint(Number.parseInt(e.slice(2), 16));
    if (e.startsWith('#')) return String.fromCodePoint(Number.parseInt(e.slice(1), 10));
    return ENT[e] ?? m;
  });
}

const localName = (n: string) => n.slice(n.indexOf(':') + 1);

/**
 * Parse markup into a tree. With `sgml: true` (OFX 1.x), an element followed directly by text is a
 * leaf that needs no closing tag, and unmatched closing tags are ignored.
 */
export function parseMarkup(src: string, opts: { sgml?: boolean } = {}): Node {
  const root: Node = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: Node[] = [root];
  const top = () => stack[stack.length - 1] as Node;
  let i = 0;
  let leaf: Node | undefined; // SGML element waiting for its text
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    const textEnd = lt < 0 ? src.length : lt;
    if (textEnd > i) {
      const t = decodeEntities(src.slice(i, textEnd));
      if (leaf && t.trim() !== '') {
        leaf.text += t.trim();
        stack.pop();
        leaf = undefined;
      } else if (!leaf) top().text += t;
    }
    if (lt < 0) break;
    if (src.startsWith('<!--', lt)) {
      const e = src.indexOf('-->', lt);
      i = e < 0 ? src.length : e + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt);
      if (e < 0) throw new ImportError('invalid_markup', 'unterminated CDATA');
      top().text += src.slice(lt + 9, e);
      i = e + 3;
      continue;
    }
    if (src.startsWith('<!', lt))
      throw new ImportError('invalid_markup', 'DOCTYPE/DTD is not allowed');
    if (src.startsWith('<?', lt)) {
      const e = src.indexOf('?>', lt);
      i = e < 0 ? src.length : e + 2;
      continue;
    }
    const gt = src.indexOf('>', lt);
    if (gt < 0) throw new ImportError('invalid_markup', 'unterminated tag');
    const tag = src.slice(lt + 1, gt);
    i = gt + 1;
    if (tag.startsWith('/')) {
      const name = localName(tag.slice(1).trim());
      const pendingLeaf = leaf;
      leaf = undefined;
      if (top().name === name) {
        stack.pop(); // normal close, or an SGML element with no text (<TAG></TAG>)
        continue;
      }
      if (!opts.sgml) throw new ImportError('invalid_markup', `unexpected </${name}>`);
      if (pendingLeaf) stack.pop(); // pending element was empty; re-check against its parent
      if (top().name === name) {
        stack.pop();
        continue;
      }
      // An explicitly closed SGML leaf (<NAME>x</NAME>) was already popped when its text arrived.
      const last = top().children[top().children.length - 1];
      if (last?.name === name) continue;
      for (let at = stack.length - 1; at > 0; at--) {
        if (stack[at]?.name !== name) continue;
        stack.length = at;
        break;
      }
      continue;
    }
    const selfClose = tag.endsWith('/');
    const body = selfClose ? tag.slice(0, -1) : tag;
    const m = /^([^\s/>]+)/.exec(body);
    if (!m) throw new ImportError('invalid_markup', 'empty tag');
    const node: Node = { name: localName(m[1] as string), attrs: {}, children: [], text: '' };
    for (const a of body.slice(m[0].length).matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g))
      node.attrs[localName(a[1] as string)] = decodeEntities(a[3] ?? a[4] ?? '');
    leaf = undefined; // a pending SGML element followed by a tag is a container
    top().children.push(node);
    if (!selfClose) {
      stack.push(node);
      if (opts.sgml) leaf = node;
    }
  }
  if (!opts.sgml && stack.length > 1)
    throw new ImportError('invalid_markup', `unclosed <${top().name}>`);
  return root;
}

/** First descendant matching a path like 'Acct/Id/IBAN' (direct-child steps). */
export function find(n: Node | undefined, path: string): Node | undefined {
  let cur = n;
  for (const step of path.split('/')) {
    cur = cur?.children.find((c) => c.name === step);
    if (!cur) return undefined;
  }
  return cur;
}

export const textAt = (n: Node | undefined, path: string): string | undefined => {
  const t = find(n, path)?.text.trim();
  return t ? t : undefined;
};

export function findAll(n: Node, name: string): Node[] {
  const out: Node[] = [];
  const walk = (x: Node) => {
    for (const c of x.children) {
      if (c.name === name) out.push(c);
      else walk(c);
    }
  };
  walk(n);
  return out;
}

export const children = (n: Node | undefined, name: string): Node[] =>
  n ? n.children.filter((c) => c.name === name) : [];
