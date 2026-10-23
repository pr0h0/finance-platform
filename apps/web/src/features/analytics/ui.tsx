// Small presentational pieces shared by the insight pages (dashboard, planning, budgets,
// analytics, goals, subscriptions, reports, notifications). Theme tokens from index.css.
import { type MissingRate, type Money, money, type Notice } from '@finplat/finance-engine';
import { AlertTriangle, Info } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { Dialog as UiDialog } from '../../components/ui/index.tsx';
import { useFormat } from '../../lib/format.ts';
import { errorText, useT } from '../../lib/i18n.ts';
import './charts.css';

export const SERIES = Array.from({ length: 8 }, (_, i) => `var(--series-${i + 1})`);
export const SERIES_OTHER = 'var(--series-other)';

export function Page({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="print-full mx-auto w-full max-w-7xl space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">{title}</h1>
        {actions && <div className="no-print flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

export function Card({
  title,
  actions,
  children,
  className = '',
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={title ? id : undefined}
      className={`min-w-0 rounded-lg border border-line bg-surface p-3 sm:p-4 ${className}`}
    >
      {(title || actions) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title && (
            <h2 id={id} className="text-sm font-medium text-muted">
              {title}
            </h2>
          )}
          {actions && <div className="no-print flex items-center gap-1">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** Formatted money; tone colors positive/negative amounts when asked. */
export function Amount({
  value,
  tone = false,
  className = '',
}: {
  value: Money | null | undefined;
  tone?: boolean;
  className?: string;
}) {
  const f = useFormat();
  if (!value) return <span className={`text-muted ${className}`}>—</span>;
  const neg = value.amount.startsWith('-');
  const zero = /^-?0(\.0+)?$/.test(value.amount);
  const color = tone && !zero ? (neg ? 'text-neg' : 'text-pos') : '';
  return (
    <span className={`whitespace-nowrap tabular-nums ${color} ${className}`}>{f.money(value)}</span>
  );
}

export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted">{label}</div>
      {/* Two stats side by side on a phone: smaller, and an amount may wrap after its currency. */}
      <div className="text-base font-semibold leading-tight sm:text-xl [&_span]:whitespace-normal">
        {value}
      </div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </div>
  );
}

/**
 * Incomplete-data banner: missing exchange rates and other gaps, never hidden. Warnings are text the
 * caller already translated, or engine Notices (translated here, ISO dates in vars formatted).
 */
export function DataBanner({
  missingRates = [],
  warnings = [],
}: {
  missingRates?: readonly MissingRate[];
  warnings?: readonly (string | Notice)[];
}) {
  const t = useT();
  const fmt = useFormat();
  const text = (w: string | Notice) =>
    typeof w === 'string'
      ? w
      : t(
          w.key,
          w.en,
          w.vars &&
            Object.fromEntries(
              Object.entries(w.vars).map(([k, v]) => [
                k,
                typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? fmt.date(v) : v,
              ]),
            ),
        );
  const pairs = [...new Set(missingRates.map((m) => `${m.from}/${m.to}`))];
  if (!pairs.length && !warnings.length) return null;
  return (
    <div
      role="status"
      className="flex gap-2 rounded-md border border-warn/40 bg-warn/10 p-3 text-sm text-fg"
    >
      <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />
      <div>
        <p className="font-medium">{t('analytics.ui.incompleteData', 'Incomplete data')}</p>
        {pairs.length > 0 && (
          <p>
            {t(
              'analytics.ui.noRateForPairs',
              'No exchange rate for {{pairs}} on {{count}} date(s); those amounts are left out, not guessed. Add a rate in Accounts → Converter.',
              { pairs: pairs.join(', '), count: missingRates.length },
            )}
          </p>
        )}
        {warnings.map(text).map((w) => (
          <p key={w}>{w}</p>
        ))}
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 py-6 text-sm text-muted">
      <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/** Shell UI kit controls (one look across the app); Dialog adapted to an onClose callback. */
export { Button, Field, Input, Select } from '../../components/ui/index.tsx';

export function Dialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <UiDialog open={open} onOpenChange={(o) => !o && onClose()} title={title} wide>
      {children}
    </UiDialog>
  );
}

/** Horizontal bar with actual / committed / remaining segments (budgets, goals). */
export function ProgressBar({
  parts,
  label,
}: {
  parts: { value: number; className: string; title: string; color?: string }[];
  label: string;
}) {
  const total = Math.max(
    1,
    parts.reduce((a, p) => a + Math.max(0, p.value), 0),
  );
  return (
    <div
      role="img"
      aria-label={label}
      className="flex h-2 w-full gap-0.5 overflow-hidden rounded bg-surface-2"
    >
      {parts.map((p) =>
        p.value > 0 ? (
          <div
            key={p.title}
            title={p.title}
            className={`h-full ${p.className}`}
            style={{
              width: `${(Math.max(0, p.value) / total) * 100}%`,
              ...(p.color ? { background: p.color } : {}),
            }}
          />
        ) : null,
      )}
    </div>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-sm text-neg">
      {errorText(error)}
    </p>
  );
}

export const Loading = () => {
  const t = useT();
  return (
    <p role="status" className="p-4 text-sm text-muted">
      {t('common.loading', 'Loading…')}
    </p>
  );
};

/** Parse a typed amount (locale-aware) into exact Money; null when empty or invalid. */
export function parseMoneyInput(
  text: string,
  currency: string,
  parse: (s: string) => string | null,
): Money | null {
  const d = parse(text.trim());
  if (!d) return null;
  try {
    return money(d, currency);
  } catch {
    return null;
  }
}
