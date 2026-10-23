// Base UI kit for every page. Native elements where they are accessible already (input,
// select, checkbox), Radix for dialog/tabs/menu. Tokens come from index.css (bg-surface,
// border-line, text-muted, text-pos/neg/warn, bg-accent).

import { X } from 'lucide-react';
import { Dialog as RD, DropdownMenu as RM, Tabs as RT } from 'radix-ui';
import {
  type ButtonHTMLAttributes,
  cloneElement,
  forwardRef,
  type InputHTMLAttributes,
  isValidElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useId,
} from 'react';
import { errorText, useT } from '../../lib/i18n.ts';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

// ------------------------------------------------------------ buttons

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
const variants: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:opacity-90',
  secondary: 'border border-line bg-surface hover:bg-surface-2',
  ghost: 'hover:bg-surface-2',
  danger: 'bg-neg text-white hover:opacity-90',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md';
  busy?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    busy,
    className,
    disabled,
    children,
    type = 'button',
    ...p
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-8 px-2.5 text-xs' : 'h-9 px-3.5 text-sm',
        variants[variant],
        className,
      )}
      {...p}
    >
      {children}
    </button>
  );
});

/** Icon-only button: `label` is required and becomes the accessible name. */
export const IconButton = forwardRef<HTMLButtonElement, ButtonProps & { label: string }>(
  function IconButton({ label, className, variant = 'ghost', ...p }, ref) {
    return (
      <Button
        ref={ref}
        variant={variant}
        aria-label={label}
        title={label}
        className={cx('!px-0 w-9', className)}
        {...p}
      />
    );
  },
);

// ------------------------------------------------------------ form

const control =
  'h-9 w-full rounded-md border border-line bg-surface px-2.5 text-sm placeholder:text-muted disabled:opacity-60 aria-[invalid=true]:border-neg';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...p }, ref) {
    return <input ref={ref} className={cx(control, className)} {...p} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, ...p }, ref) {
    return <select ref={ref} className={cx(control, 'pr-7', className)} {...p} />;
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...p }, ref) {
  return <textarea ref={ref} className={cx(control, 'h-auto min-h-20 py-2', className)} {...p} />;
});

/** Label + control + hint/error, wired with ids and aria-describedby. The child must be a
 * single form control element. */
export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  const desc = hint || error ? `${id}-d` : undefined;
  const child = isValidElement<Record<string, unknown>>(children)
    ? cloneElement(children, {
        id: (children.props.id as string | undefined) ?? id,
        'aria-describedby': desc,
        'aria-invalid': error ? true : undefined,
      })
    : children;
  return (
    <div className={cx('flex flex-col gap-1', className)}>
      <label
        htmlFor={isValidElement<{ id?: string }>(children) ? (children.props.id ?? id) : id}
        className="text-sm font-medium"
      >
        {label}
      </label>
      {child}
      {(hint || error) && (
        <p id={desc} className={cx('text-xs', error ? 'text-neg' : 'text-muted')}>
          {error || hint}
        </p>
      )}
    </div>
  );
}

export function Checkbox({
  label,
  hint,
  className,
  ...p
}: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; hint?: ReactNode }) {
  const id = useId();
  return (
    <div className={cx('flex items-start gap-2', className)}>
      <input id={id} type="checkbox" className="mt-0.5 size-4 accent-[var(--accent)]" {...p} />
      <label htmlFor={id} className="text-sm">
        {label}
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </label>
    </div>
  );
}

/** Accessible switch (a checkbox with role=switch). */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-line transition-colors disabled:opacity-50',
        checked ? 'bg-accent' : 'bg-surface-2',
      )}
    >
      <span
        className={cx(
          'inline-block size-4 rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

// ------------------------------------------------------------ layout & feedback

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}

export function Card({
  title,
  actions,
  children,
  className,
  as: As = 'section',
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  as?: 'section' | 'div';
}) {
  const id = useId();
  return (
    <As
      aria-labelledby={title ? id : undefined}
      className={cx('min-w-0 rounded-lg border border-line bg-surface p-3 sm:p-4', className)}
    >
      {(title || actions) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title && (
            <h2 id={id} className="text-sm font-semibold">
              {title}
            </h2>
          )}
          {actions && <div className="flex gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </As>
  );
}

type Tone = 'neutral' | 'pos' | 'neg' | 'warn' | 'accent';
const tones: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-muted',
  pos: 'bg-pos/10 text-pos',
  neg: 'bg-neg/10 text-neg',
  warn: 'bg-warn/10 text-warn',
  accent: 'bg-accent/10 text-accent',
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium',
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Notice({
  tone = 'neutral',
  title,
  children,
  role,
}: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  role?: 'alert' | 'status';
}) {
  const border: Record<Tone, string> = {
    neutral: 'border-line',
    pos: 'border-pos/40',
    neg: 'border-neg/40',
    warn: 'border-warn/40',
    accent: 'border-accent/40',
  };
  return (
    <div role={role} className={cx('rounded-md border bg-surface px-3 py-2 text-sm', border[tone])}>
      {title && (
        <p className={cx('font-medium', tone !== 'neutral' && tones[tone].split(' ')[1])}>
          {title}
        </p>
      )}
      {children && <div className="text-muted">{children}</div>}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  const t = useT();
  if (!error) return null;
  return (
    <Notice tone="neg" role="alert" title={errorText(error)}>
      {(error as { requestId?: string }).requestId && (
        <span className="text-xs">
          {t('ui.page.requestV', 'Request {{v}}', {
            v: (error as { requestId?: string }).requestId ?? '',
          })}
        </span>
      )}
    </Notice>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed border-line p-6 text-center">
      <p className="text-sm font-medium">{title}</p>
      {children && <p className="mt-1 text-sm text-muted">{children}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <p role="status" className="py-4 text-sm text-muted">
      {label}
    </p>
  );
}

/** Key/value rows (settings, diagnostics). */
export function DefinitionList({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-1.5 text-sm">
      {items.map(([k, v], i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static rows
        <div key={i} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export const tableClass =
  'w-full text-sm [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-medium [&_th]:text-muted [&_td]:px-2 [&_td]:py-1.5 [&_tbody_tr]:border-t [&_tbody_tr]:border-line';

// ------------------------------------------------------------ dialog

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const t = useT();
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <RD.Content
          className={cx(
            'fixed top-1/2 left-1/2 z-50 max-h-[90vh] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-line bg-surface p-5 shadow-xl',
            wide ? 'max-w-2xl' : 'max-w-md',
          )}
          aria-describedby={description ? undefined : undefined}
        >
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <RD.Title className="text-base font-semibold">{title}</RD.Title>
              {description ? (
                <RD.Description className="mt-1 text-sm text-muted">{description}</RD.Description>
              ) : (
                <RD.Description className="sr-only">{title}</RD.Description>
              )}
            </div>
            <RD.Close asChild>
              <IconButton label={t('common.close', 'Close')} size="sm">
                <X className="size-4" aria-hidden />
              </IconButton>
            </RD.Close>
          </div>
          {children}
          {footer && <div className="mt-4 flex justify-end gap-2">{footer}</div>}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

/** Confirmation for destructive or irreversible actions. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  children,
  confirmLabel = 'Confirm',
  danger,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: ReactNode;
  children?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
}) {
  const t = useT();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel', 'Cancel')}</Button>
          <Button variant={danger ? 'danger' : 'primary'} busy={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm text-muted">{children}</div>
    </Dialog>
  );
}

// ------------------------------------------------------------ tabs & menu

export function Tabs({
  value,
  onValueChange,
  tabs,
  label,
}: {
  value: string;
  onValueChange: (v: string) => void;
  tabs: { value: string; label: ReactNode; content: ReactNode }[];
  label: string;
}) {
  return (
    <RT.Root value={value} onValueChange={onValueChange}>
      <RT.List aria-label={label} className="mb-4 flex gap-1 overflow-x-auto border-b border-line">
        {tabs.map((t) => (
          <RT.Trigger
            key={t.value}
            value={t.value}
            className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm whitespace-nowrap text-muted data-[state=active]:border-accent data-[state=active]:text-fg"
          >
            {t.label}
          </RT.Trigger>
        ))}
      </RT.List>
      {tabs.map((t) => (
        <RT.Content key={t.value} value={t.value} className="focus-visible:outline-none">
          {t.content}
        </RT.Content>
      ))}
    </RT.Root>
  );
}

export const Menu = {
  Root: RM.Root,
  Trigger: RM.Trigger,
  Content: ({ children, align = 'end' }: { children: ReactNode; align?: 'start' | 'end' }) => (
    <RM.Portal>
      <RM.Content
        align={align}
        sideOffset={4}
        className="z-50 min-w-48 rounded-md border border-line bg-surface p-1 text-sm shadow-lg"
      >
        {children}
      </RM.Content>
    </RM.Portal>
  ),
  Item: ({
    children,
    onSelect,
    disabled,
  }: {
    children: ReactNode;
    onSelect?: () => void;
    disabled?: boolean;
  }) => (
    <RM.Item
      disabled={disabled}
      onSelect={onSelect}
      className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-2"
    >
      {children}
    </RM.Item>
  ),
  Label: ({ children }: { children: ReactNode }) => (
    <RM.Label className="px-2 py-1 text-xs text-muted">{children}</RM.Label>
  ),
  Separator: () => <RM.Separator className="my-1 h-px bg-line" />,
};
