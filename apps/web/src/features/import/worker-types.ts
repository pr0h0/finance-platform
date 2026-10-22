import type { TablePreview } from '@finplat/bank-importers';
import {
  type CustomAdapter,
  DEFAULT_SANDBOX_LIMITS,
  type ImportResult,
  type TextEncodingName,
} from '@finplat/importer-sdk';

export type WorkerRequest =
  | {
      id: number;
      kind: 'parse';
      file: File;
      importerId?: string;
      template?: unknown;
      accountCurrency?: string;
      /** Granted custom adapter to run in the sandbox (importerId = custom-<id>). */
      adapter?: CustomAdapter;
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
    // Custom adapters: the sandbox enforces its CPU deadline, but native builtins can overrun it;
    // the worker is killed outright if it does not answer in time.
    const watchdog =
      req.kind === 'parse' && req.adapter
        ? setTimeout(
            () => {
              w.removeEventListener('message', onMsg);
              w.terminate();
              if (worker === w) worker = null;
              reject(
                Object.assign(new Error('custom adapter did not finish in time'), {
                  code: 'adapter_timeout',
                }),
              );
            },
            DEFAULT_SANDBOX_LIMITS.timeoutMs * 3 + 5000,
          )
        : undefined;
    const onMsg = (ev: MessageEvent<WorkerResponse>) => {
      const m = ev.data;
      if (m.id !== id) return;
      if (m.type === 'progress') return onProgress?.(m.bytes, m.total);
      clearTimeout(watchdog);
      w.removeEventListener('message', onMsg);
      if (m.type === 'error') reject(Object.assign(new Error(m.message), { code: m.code }));
      else resolve(m);
    };
    w.addEventListener('message', onMsg);
    w.postMessage({ ...req, id } as WorkerRequest);
  });
}
