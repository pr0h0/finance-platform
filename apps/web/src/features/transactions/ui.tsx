// Small, accessible building blocks for the ledger pages. Native elements first (<dialog>,
// <select>, <input type="date">): keyboard handling and focus trapping come from the browser.
import type * as D from '@finplat/domain';
import { money } from '@finplat/finance-engine';
import { formatMoney, parseDecimalInput } from '@finplat/localization';
import { X } from 'lucide-react';
import { type ButtonHTMLAttributes, type ReactNode, useEffect, useId, useRef } from 'react';
import { useT } from '../../lib/i18n.ts';

export const inputCls =
  'h-9 min-w-0 rounded-md border border-line bg-surface px-2 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60';

const variants = {
  primary: 'bg-accent text-accent-fg hover:opacity-90 disabled:opacity-60',
  secondary: 'border border-line bg-surface text-fg hover:bg-surface-2',
  ghost: 'text-muted hover:bg-surface-2',
  danger: 'bg-neg text-white hover:opacity-90 disabled:opacity-60',
} as const;

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  ...p
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof variants;
  size?: 'sm' | 'md';
}) {
  return (
    <button
      type="button"
      {...p}
      className={`inline-flex items-center justify-center gap-1.5 rounded-md font-medium outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed ${size === 'sm' ? 'h-7 px-2 text-xs' : 'h-9 px-3 text-sm'} ${variants[variant]} ${className}`}
    />
  );
}

/** Label + control + optional hint/error, wired with ids for screen readers. */
export function Field({
  label,
  hint,
  error,
  children,
  className = '',
}: {
  label: string;
  hint?: string;
  error?: string;
  children: (id: string, describedBy?: string) => ReactNode;
  className?: string;
}) {
  const id = useId();
  const desc = hint || error ? `${id}-d` : undefined;
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <label htmlFor={id} className="text-xs font-medium text-muted">
        {label}
      </label>
      {children(id, desc)}
      {(hint || error) && (
        <p id={desc} className={`text-xs ${error ? 'text-neg' : 'text-muted'}`}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

/** Modal dialog on the native <dialog> element (Esc or a backdrop click closes, focus is trapped). */
export function Dialog({
  open,
  onClose,
  title,
  children,
  side = false,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  side?: boolean; // right-hand drawer
  wide?: boolean;
}) {
  const t = useT();
  const ref = useRef<HTMLDialogElement>(null);
  // The backdrop is the <dialog> itself (the content fills it). Both press and release must be on it,
  // so selecting text inside and releasing outside does not close.
  const downOnBackdrop = useRef(false);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal?.();
    if (!open && d.open) d.close();
  }, [open]);
  const pos = side
    ? 'ml-auto mr-0 h-dvh max-h-dvh w-full max-w-2xl rounded-none'
    : `m-auto w-[calc(100%-2rem)] rounded-lg ${wide ? 'max-w-4xl' : 'max-w-lg'} max-h-[90dvh]`;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the backdrop click mirrors Esc, which the native dialog already handles
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
      onMouseDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (downOnBackdrop.current && e.target === e.currentTarget) onClose();
        downOnBackdrop.current = false;
      }}
      aria-label={title}
      className={`${pos} border border-line bg-surface p-0 text-fg shadow-xl backdrop:bg-black/40`}
    >
      {open && (
        <div className="flex h-full max-h-[inherit] flex-col">
          <header className="flex items-center justify-between border-b border-line px-4 py-3">
            <h2 className="text-base font-semibold">{title}</h2>
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              aria-label={t('common.close', 'Close')}
            >
              <X size={16} aria-hidden />
            </Button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        </div>
      )}
    </dialog>
  );
}

export function MoneyText({
  value,
  locale = 'en',
  signed = false,
  className = '',
}: {
  value: D.Money | null | undefined;
  locale?: string;
  signed?: boolean;
  className?: string;
}) {
  if (!value) return <span className="text-muted">—</span>;
  const neg = value.amount.startsWith('-');
  return (
    <span className={`tabular-nums ${signed ? (neg ? 'text-neg' : 'text-pos') : ''} ${className}`}>
      {formatMoney(value, locale, signed ? { signDisplay: 'exceptZero' } : {})}
    </span>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'blue' | 'amber' | 'red' | 'green';
}) {
  const t = {
    neutral: 'bg-surface-2 text-muted',
    blue: 'bg-accent/10 text-accent',
    amber: 'bg-warn/10 text-warn',
    red: 'bg-neg/10 text-neg',
    green: 'bg-pos/10 text-pos',
  }[tone];
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${t}`}>
      {children}
    </span>
  );
}

export function ErrorText({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return (
    <p
      role="alert"
      className="rounded-md border border-neg/40 bg-neg/10 px-3 py-2 text-sm text-neg"
    >
      {error}
    </p>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line p-8 text-center">
      <p className="font-medium">{title}</p>
      {children && <div className="mt-2 text-sm text-muted">{children}</div>}
    </div>
  );
}

export function PageHeader({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="mb-4 flex flex-wrap items-center justify-between gap-2">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {children && <p className="text-sm text-muted">{children}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}

/** Simple tab bar (role=tablist, arrow keys move between tabs). */
export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  tabs: readonly { id: T; label: string }[];
  label: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="mb-4 flex gap-1 overflow-x-auto border-b border-line"
    >
      {tabs.map((t, i) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={value === t.id}
          tabIndex={value === t.id ? 0 : -1}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => {
            const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
            if (!d) return;
            const next = tabs[(i + d + tabs.length) % tabs.length];
            if (next) onChange(next.id);
          }}
          className={`-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-accent ${value === t.id ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-fg'}`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Trigger a browser download of generated content. */
export function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** What the user typed (locale-aware) → Money at the currency scale, or null if invalid. */
export function toMoney(input: string, currency: string, locale = 'en'): D.Money | null {
  const d = parseDecimalInput(input, locale) ?? parseDecimalInput(input, 'en');
  if (d === null || !currency) return null;
  try {
    return money(d, currency);
  } catch {
    return null; // more decimals than the currency allows
  }
}
