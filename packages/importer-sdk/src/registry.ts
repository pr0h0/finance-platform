// Importer registry (Feature 110). Only reviewed, bundled importers are registered; there is no
// mechanism to load importer code at runtime (PLAN §24 plugin security).
import { ImportError } from './input.ts';
import type { BankImporter, DetectionResult, ImporterManifest, ImportInput } from './types.ts';
import { IMPORTER_SDK_VERSION } from './types.ts';

export interface DetectionCandidate extends DetectionResult {
  importer: ImporterManifest;
}

export class ImporterRegistry {
  private readonly byId = new Map<string, BankImporter>();

  constructor(importers: readonly BankImporter[] = []) {
    for (const i of importers) this.register(i);
  }

  register(imp: BankImporter): void {
    const m = imp.manifest;
    if (m.sdkVersion !== IMPORTER_SDK_VERSION)
      throw new Error(
        `${m.id}: sdkVersion ${m.sdkVersion} not supported (expected ${IMPORTER_SDK_VERSION})`,
      );
    if (!/^\d+\.\d+\.\d+$/.test(m.version)) throw new Error(`${m.id}: version must be x.y.z`);
    if (this.byId.has(m.id)) throw new Error(`duplicate importer id ${m.id}`);
    this.byId.set(m.id, imp);
  }

  get(id: string): BankImporter | undefined {
    return this.byId.get(id);
  }

  require(id: string): BankImporter {
    const imp = this.byId.get(id);
    if (!imp) throw new ImportError('unknown_importer', `no importer ${id}`);
    if (imp.manifest.status === 'blocked_external')
      throw new ImportError('importer_blocked', `${imp.manifest.name} is not available yet`);
    return imp;
  }

  manifests(): ImporterManifest[] {
    return [...this.byId.values()].map((i) => i.manifest);
  }

  /** All importers that recognise the file, best first. Detector failures count as no match. */
  async detect(input: ImportInput): Promise<DetectionCandidate[]> {
    const out: DetectionCandidate[] = [];
    for (const imp of this.byId.values()) {
      if (imp.manifest.status === 'blocked_external') continue;
      const r = await imp.detect(input).catch(() => ({ confidence: 0 }));
      if (r.confidence > 0) out.push({ ...r, importer: imp.manifest });
    }
    return out.sort((a, b) => b.confidence - a.confidence);
  }
}
