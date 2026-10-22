// Merchant templates (Feature 125): a merchant whose name or alias occurs as whole words in a bank
// description proposes itself, its default category and its most recent split template. Same matching
// as Go imports.loadSuggestions (shared vectors: test-fixtures/imports/merchant-templates.json).
// Suggestions only: the caller applies them after the user approves (import preview, inbox).

/**
 * NFKC-lowercased runs of letters or of digits with diacritics folded ("KONZUM123 d.o.o." -> konzum 123
 * d o o; "Čaršija" -> carsija): banks such as Raiffeisen BiH print plain ASCII descriptions.
 */
export function descriptionWords(s: string): string[] {
  return (
    s
      .normalize('NFKC')
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Mn}/gu, '')
      .replaceAll('đ', 'd')
      .match(/\p{L}+|\p{N}+/gu) ?? []
  );
}

const containsWords = (desc: string[], words: string[]) => {
  for (let i = 0; i + words.length <= desc.length; i++)
    if (words.every((w, j) => desc[i + j] === w)) return true;
  return false;
};

export interface TemplateMerchant {
  id: string;
  normalizedName: string;
  aliases?: readonly string[];
  defaultCategoryId: string | null;
  deletedAt?: string | null;
}

export interface TemplateSplit {
  id: string;
  merchantId: string | null;
  updatedAt: string;
  deletedAt?: string | null;
}

export interface MerchantSuggestion {
  merchantId: string;
  categoryId: string | null;
  splitTemplateId: string | null;
}

export type MerchantMatcher = (description: string) => MerchantSuggestion | null;

export function merchantMatcher(
  merchants: readonly TemplateMerchant[],
  splitTemplates: readonly TemplateSplit[],
): MerchantMatcher {
  const latest = new Map<string, TemplateSplit>();
  for (const t of splitTemplates) {
    if (t.deletedAt || !t.merchantId) continue;
    const cur = latest.get(t.merchantId);
    if (!cur || t.updatedAt > cur.updatedAt || (t.updatedAt === cur.updatedAt && t.id < cur.id))
      latest.set(t.merchantId, t);
  }
  // At least 3 letters/digits; longest first ("shell oil" beats "shell"), counted in code points.
  const names: { words: string[]; size: number; m: TemplateMerchant }[] = [];
  for (const m of merchants) {
    if (m.deletedAt) continue;
    const all = [m.normalizedName, ...(m.aliases ?? [])];
    // "đ" is printed as "d" or "dj" in ASCII; descriptionWords folds it to "d".
    for (const n of [
      ...all,
      ...all.filter((x) => /đ/i.test(x)).map((x) => x.replace(/đ/gi, 'dj')),
    ]) {
      const words = descriptionWords(n);
      const size = [...words.join('')].length;
      if (size >= 3) names.push({ words, size, m });
    }
  }
  names.sort((a, b) => b.size - a.size || (a.m.id < b.m.id ? -1 : 1));
  return (description) => {
    const d = descriptionWords(description);
    if (!d.length) return null;
    const hit = names.find((n) => containsWords(d, n.words));
    if (!hit) return null;
    return {
      merchantId: hit.m.id,
      categoryId: hit.m.defaultCategoryId,
      splitTemplateId: latest.get(hit.m.id)?.id ?? null,
    };
  };
}
