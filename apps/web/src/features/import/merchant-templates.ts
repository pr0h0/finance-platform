// Feature 125: after an import commit, give each approved row's transaction its merchant and split
// template. Works on FinanceOps, so local and connected mode behave the same.
import type * as D from '@finplat/domain';
import type { FinanceOps } from '@finplat/storage';

export interface TemplatedRow {
  rawRecordId: string;
  merchantId: string | null;
  splitTemplateId: string | null;
}

// ponytail: one update per templated row after the commit (not inside the commit's write); fine
// for statement-sized batches, move into commitImport if batches grow to thousands of such rows.
export async function applyMerchantTemplates(
  ops: FinanceOps,
  rows: readonly TemplatedRow[],
): Promise<number> {
  const want = new Map(rows.map((r) => [r.rawRecordId, r]));
  let n = 0;
  for (const t of (await ops.ledger()) as unknown as D.Transaction[]) {
    const r = t.importRecordId ? want.get(t.importRecordId) : undefined;
    if (!r || t.deletedAt) continue;
    let cur = t;
    if (r.splitTemplateId)
      cur = await ops.replaceSplits(cur.id, {
        version: cur.version,
        splitTemplateId: r.splitTemplateId,
      });
    if (r.merchantId && cur.merchantId !== r.merchantId)
      await ops.updateTransaction(cur.id, { version: cur.version, merchantId: r.merchantId });
    n++;
  }
  return n;
}
