// Shared UI primitives. Decisions: every Button takes a `label`; the visible text is the accessible
// name (WCAG 2.5.3, label in name, so voice users can say what they see) and `label` names icon-only
// buttons or, when it says more than the visible text, becomes the description (title). Primary
// buttons are at least 44 px tall (min-h-11), and the three async states have one component each
// (Spinner / ErrorState / EmptyState) so every list and action looks the same.

import { useEffect, useRef, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode } from 'react';
import { useT } from '../app/i18n';
import { errorKey } from '../app/hooks';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const VARIANT: Record<Variant, string> = {
  primary: 'bg-brand-700 text-white hover:bg-brand-800 disabled:bg-ink-300',
  secondary: 'bg-white text-brand-800 border border-brand-700 hover:bg-brand-50 disabled:text-ink-500 disabled:border-ink-300',
  ghost: 'bg-transparent text-ink-700 hover:bg-ink-100 disabled:text-ink-300',
  danger: 'bg-danger-600 text-white hover:bg-danger-700 disabled:bg-ink-300',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string; // visible text when children is omitted; accessible name for icon-only children; otherwise the description
  variant?: Variant;
  size?: 'md' | 'sm';
  busy?: boolean;
}

export function Button({ label, variant = 'primary', size = 'md', busy, children, className = '', disabled, title, ...rest }: ButtonProps) {
  const sizing = size === 'md' ? 'min-h-11 px-5 text-base' : 'min-h-9 px-3 text-sm';
  const text = typeof children === 'string' ? children.trim() : children == null ? label : null;
  const iconOnly = text != null && !/[\p{L}\p{N}]/u.test(text);
  return (
    <button
      type="button"
      aria-label={iconOnly ? label : undefined}
      title={title ?? (!iconOnly && text !== label ? label : undefined)}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      className={`inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-colors disabled:cursor-not-allowed ${sizing} ${VARIANT[variant]} ${className}`}
      {...rest}
    >
      {busy && <SpinnerIcon className="h-4 w-4" />}
      {children ?? label}
    </button>
  );
}

export function SpinnerIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

export function Spinner({ label }: { label?: string }) {
  const t = useT();
  const text = label ?? t('common.loading');
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-3 py-8 text-ink-500">
      <SpinnerIcon />
      <span>{text}</span>
    </div>
  );
}

export function ErrorState({ error, onRetry, compact }: { error: unknown; onRetry?: () => void; compact?: boolean }) {
  const t = useT();
  return (
    <div role="alert" className={`rounded-lg border border-danger-600/30 bg-danger-100 text-danger-700 ${compact ? 'px-3 py-2 text-sm' : 'px-4 py-4'}`}>
      <p className="font-semibold">{t('common.errorTitle')}</p>
      <p className="mt-1">{t(errorKey(error))}</p>
      {onRetry && (
        <Button label={t('common.retry')} variant="secondary" size="sm" className="mt-3" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      )}
    </div>
  );
}

export function EmptyState({ title, body }: { title: string; body?: string }) {
  return (
    <div className="rounded-lg border border-dashed border-ink-300 bg-white px-4 py-8 text-center text-ink-500">
      <p className="font-medium text-ink-700">{title}</p>
      {body && <p className="mt-1 text-sm">{body}</p>}
    </div>
  );
}

export function Card({ title, children, className = '', actions, as = 'section' }: { title?: ReactNode; children: ReactNode; className?: string; actions?: ReactNode; as?: 'section' | 'div' }) {
  const Tag = as;
  return (
    <Tag className={`rounded-xl border border-ink-200 bg-white p-5 shadow-sm ${className}`}>
      {(title || actions) && (
        <header className="mb-4 flex items-start justify-between gap-4">
          {title && <h2 className="text-lg font-semibold text-ink-900">{title}</h2>}
          {actions}
        </header>
      )}
      {children}
    </Tag>
  );
}

export type Tone = 'brand' | 'neutral' | 'warn' | 'danger' | 'info';

const TONE: Record<Tone, string> = {
  brand: 'bg-brand-100 text-brand-800',
  neutral: 'bg-ink-100 text-ink-700',
  warn: 'bg-warn-100 text-warn-700',
  danger: 'bg-danger-100 text-danger-700',
  info: 'bg-sky-100 text-sky-800',
};

export function Badge({ tone = 'neutral', children, className = '' }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONE[tone]} ${className}`}>{children}</span>;
}

export function Stat({ label, value, hint, className = '' }: { label: string; value: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg bg-ink-50 px-4 py-3 ${className}`}>
      <p className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</p>
      <p className="tabular mt-1 text-xl font-semibold text-ink-900">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Accessible modal dialog. Focus moves to the panel once, when it opens (never on a re-render, so
 *  progress updates inside the dialog do not pull focus back), Tab cycles inside the panel, Escape
 *  closes, and focus returns to the element that opened the dialog when it unmounts. The one case
 *  where the panel is focused again: the focused control was removed by a re-render (a confirm
 *  button that unmounts when the action starts), which would otherwise drop focus to the body. */
export function Modal({ title, onClose, children, labelClose, wide }: { title: string; onClose: () => void; children: ReactNode; labelClose: string; wide?: boolean }) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    const active = document.activeElement;
    if (panel.current && (!active || active === document.body)) panel.current.focus();
  });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !panel.current) return;
    const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
    if (items.length === 0) {
      e.preventDefault();
      panel.current.focus();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === panel.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-ink-900/50 p-4 sm:items-center" onClick={onClose} role="presentation">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`max-h-[90vh] w-full overflow-y-auto rounded-xl bg-white p-6 shadow-xl ${wide ? 'max-w-3xl' : 'max-w-lg'}`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        tabIndex={-1}
      >
        <header className="mb-4 flex items-start justify-between gap-4">
          <h2 className="text-xl font-semibold">{title}</h2>
          <Button label={labelClose} variant="ghost" size="sm" onClick={onClose}>
            ✕
          </Button>
        </header>
        {children}
      </div>
    </div>
  );
}
