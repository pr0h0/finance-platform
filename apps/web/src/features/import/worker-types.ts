import type { TablePreview } from '@finplat/bank-importers';
import type { ImportResult, TextEncodingName } from '@finplat/importer-sdk';

export type WorkerRequest =
  | {
      id: number;
      kind: 'parse';
      file: File;
      importerId?: string;
      template?: unknown;
      accountCurrency?: string;
    }
  | {
      id: number;
      kind: 'preview';
      file: File;
      format: string;
      delimiter?: string;
      encoding?: TextEncodingName | 'auto';
      sheet?: string | number;
      max?: number;
    };

export interface Candidate {
  id: string;
  name: string;
  confidence: number;
  format?: string;
}

export type WorkerResponse =
  | { id: number; type: 'progress'; bytes: number; total: number }
  | {
      id: number;
      type: 'parsed';
      result: ImportResult;
      candidates: Candidate[];
      importerId: string;
      sha256: string;
    }
  | { id: number; type: 'preview'; preview: TablePreview }
  | { id: number; type: 'error'; code: string; message: string };

let worker: Worker | null = null;
let seq = 0;

/** One shared worker; each call gets its own id. onProgress receives bytes read so far. */
export function callWorker(
  req:
    | Omit<Extract<WorkerRequest, { kind: 'parse' }>, 'id'>
    | Omit<Extract<WorkerRequest, { kind: 'preview' }>, 'id'>,
  onProgress?: (bytes: number, total: number) => void,
): Promise<Exclude<WorkerResponse, { type: 'progress' | 'error' }>> {
  worker ??= new Worker(new URL('./parse.worker.ts', import.meta.url), { type: 'module' });
  const w = worker;
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const onMsg = (ev: MessageEvent<WorkerResponse>) => {
      const m = ev.data;
      if (m.id !== id) return;
      if (m.type === 'progress') return onProgress?.(m.bytes, m.total);
      w.removeEventListener('message', onMsg);
      if (m.type === 'error') reject(Object.assign(new Error(m.message), { code: m.code }));
      else resolve(m);
    };
    w.addEventListener('message', onMsg);
    w.postMessage({ ...req, id } as WorkerRequest);
  });
}
