// Merchant templates (Feature 125): a merchant whose name or alias occurs in a bank description
// proposes itself, its default category and its most recent split template. Same matching as Go
// imports.loadSuggestions (canonical fp1 description, longest name first). Suggestions only: the
// caller applies them after the user approves (import preview, uncategorized inbox).
import { canonicalDescription } from './fingerprint.ts';

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
  const names: { key: string; m: TemplateMerchant }[] = [];
  for (const m of merchants) {
    if (m.deletedAt) continue;
    for (const n of [m.normalizedName, ...(m.aliases ?? [])]) {
      const key = canonicalDescription(n);
      if (key.length >= 3) names.push({ key, m });
    }
  }
  names.sort((a, b) => b.key.length - a.key.length || (a.m.id < b.m.id ? -1 : 1));
  return (description) => {
    const d = canonicalDescription(description);
    if (!d) return null;
    const hit = names.find((n) => d.includes(n.key));
    if (!hit) return null;
    return {
      merchantId: hit.m.id,
      categoryId: hit.m.defaultCategoryId,
      splitTemplateId: latest.get(hit.m.id)?.id ?? null,
    };
  };
}
