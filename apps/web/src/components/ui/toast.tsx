// Transient status messages in an aria-live region. toast('Saved') / toast(err, 'error').
import { X } from 'lucide-react';
import { create } from 'zustand';
import { errorText, useT } from '../../lib/i18n.ts';
import { cx } from './index.tsx';

interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error';
}

const useToasts = create<{ items: Toast[] }>(() => ({ items: [] }));
let seq = 0;

export function toast(msg: unknown, tone: Toast['tone'] = 'info') {
  const id = ++seq;
  const text = typeof msg === 'string' ? msg : errorText(msg);
  useToasts.setState((s) => ({ items: [...s.items.slice(-3), { id, text, tone }] }));
  setTimeout(() => dismiss(id), tone === 'error' ? 8000 : 4000);
}

const dismiss = (id: number) =>
  useToasts.setState((s) => ({ items: s.items.filter((t) => t.id !== id) }));

export function Toaster() {
  const t = useT();
  const items = useToasts((s) => s.items);
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed right-4 bottom-20 z-50 flex flex-col gap-2 md:bottom-4"
    >
      {items.map((item) => (
        <div
          key={item.id}
          role={item.tone === 'error' ? 'alert' : 'status'}
          className={cx(
            'pointer-events-auto flex max-w-sm items-start gap-2 rounded-md border bg-surface px-3 py-2 text-sm shadow-lg',
            item.tone === 'error' ? 'border-neg/50' : 'border-line',
          )}
        >
          <span className="flex-1">{item.text}</span>
          <button
            type="button"
            aria-label={t('sync.discard', 'Dismiss')}
            onClick={() => dismiss(item.id)}
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}
