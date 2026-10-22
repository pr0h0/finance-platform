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

export interface MarkupOptions {
  /** OFX 1.x: an element followed directly by text is a leaf that needs no closing tag, and
   * unmatched closing tags are ignored. */
  sgml?: boolean;
  /** Upper-case element names (SGML OFX tags are case-insensitive). */
  upperNames?: boolean;
  /** Called when an element closes, with the still-open ancestors (parent last). Return true to
   * drop the element from its parent: streaming consumers handle entries one by one this way. */
  onClose?: (node: Node, ancestors: readonly Node[]) => boolean;
}

/**
 * Incremental (SAX-style) markup parser: feed text chunks with write(), then end() returns the
 * tree of everything not dropped by onClose. Tokens split across chunks are buffered.
 */
export class MarkupStream {
  private readonly root: Node = { name: '#root', attrs: {}, children: [], text: '' };
  private readonly stack: Node[] = [this.root];
  private leaf: Node | undefined; // SGML element waiting for its text
  private buf = '';

  constructor(private readonly opts: MarkupOptions = {}) {}

  write(chunk: string): void {
    this.buf += chunk;
    this.run(false);
  }

  end(): Node {
    this.run(true);
    if (!this.opts.sgml && this.stack.length > 1)
      throw new ImportError('invalid_markup', `unclosed <${this.top().name}>`);
    return this.root;
  }

  private top(): Node {
    return this.stack[this.stack.length - 1] as Node;
  }

  /** Pop the innermost element and report it closed. */
  private pop(): void {
    const n = this.stack.pop() as Node;
    if (this.opts.onClose?.(n, this.stack)) {
      const kids = this.top().children;
      if (kids[kids.length - 1] === n) kids.pop();
      else kids.splice(kids.indexOf(n), 1);
    }
  }

  private run(final: boolean): void {
    const src = this.buf;
    let i = 0;
    const sgml = this.opts.sgml;
    while (i < src.length) {
      const lt = src.indexOf('<', i);
      if (lt < 0 && !final) break; // text may continue in the next chunk
      const textEnd = lt < 0 ? src.length : lt;
      if (textEnd > i) {
        const t = decodeEntities(src.slice(i, textEnd));
        if (this.leaf && t.trim() !== '') {
          this.leaf.text += t.trim();
          this.pop();
          this.leaf = undefined;
        } else if (!this.leaf) this.top().text += t;
        i = textEnd;
      }
      if (lt < 0) break;
      // Wait for enough characters to classify the token and for its terminator.
      const need = (end: string, from: number): number | null => {
        const e = src.indexOf(end, from);
        return e < 0 ? (final ? -1 : null) : e;
      };
      if (!final && src.length - lt < 9 && src.startsWith('<!', lt)) break;
      if (src.startsWith('<!--', lt)) {
        const e = need('-->', lt);
        if (e === null) break;
        i = e < 0 ? src.length : e + 3;
        continue;
      }
      if (src.startsWith('<![CDATA[', lt)) {
        const e = need(']]>', lt);
        if (e === null) break;
        if (e < 0) throw new ImportError('invalid_markup', 'unterminated CDATA');
        this.top().text += src.slice(lt + 9, e);
        i = e + 3;
        continue;
      }
      if (src.startsWith('<!', lt))
        throw new ImportError('invalid_markup', 'DOCTYPE/DTD is not allowed');
      if (src.startsWith('<?', lt)) {
        const e = need('?>', lt);
        if (e === null) break;
        i = e < 0 ? src.length : e + 2;
        continue;
      }
      const gt = need('>', lt);
      if (gt === null) break;
      if (gt < 0) throw new ImportError('invalid_markup', 'unterminated tag');
      const tag = src.slice(lt + 1, gt);
      i = gt + 1;
      const norm = (n: string) => (this.opts.upperNames ? n.toUpperCase() : n);
      if (tag.startsWith('/')) {
        const name = norm(localName(tag.slice(1).trim()));
        const pendingLeaf = this.leaf;
        this.leaf = undefined;
        if (this.top().name === name) {
          this.pop(); // normal close, or an SGML element with no text (<TAG></TAG>)
          continue;
        }
        if (!sgml) throw new ImportError('invalid_markup', `unexpected </${name}>`);
        if (pendingLeaf) this.pop(); // pending element was empty; re-check against its parent
        if (this.top().name === name) {
          this.pop();
          continue;
        }
        // An explicitly closed SGML leaf (<NAME>x</NAME>) was already popped when its text arrived.
        const last = this.top().children[this.top().children.length - 1];
        if (last?.name === name) continue;
        for (let at = this.stack.length - 1; at > 0; at--) {
          if (this.stack[at]?.name !== name) continue;
          while (this.stack.length > at) this.pop();
          break;
        }
        continue;
      }
      const selfClose = tag.endsWith('/');
      const body = selfClose ? tag.slice(0, -1) : tag;
      const m = /^([^\s/>]+)/.exec(body);
      if (!m) throw new ImportError('invalid_markup', 'empty tag');
      const node: Node = {
        name: norm(localName(m[1] as string)),
        attrs: {},
        children: [],
        text: '',
      };
      for (const a of body.slice(m[0].length).matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g))
        node.attrs[localName(a[1] as string)] = decodeEntities(a[3] ?? a[4] ?? '');
      this.leaf = undefined; // a pending SGML element followed by a tag is a container
      this.top().children.push(node);
      if (selfClose) {
        this.stack.push(node);
        this.pop();
      } else {
        this.stack.push(node);
        if (sgml) this.leaf = node;
      }
    }
    this.buf = src.slice(i);
  }
}

/** Parse a whole document into a tree (see MarkupStream for the streaming form). */
export function parseMarkup(src: string, opts: MarkupOptions = {}): Node {
  const p = new MarkupStream(opts);
  p.write(src);
  return p.end();
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
