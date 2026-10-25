// Detail drawer for the desk: a side panel over the list. Focus moves into the panel when it opens
// and returns to the opener when it closes; Esc closes it (the desk's keyboard rule) and Tab stays
// inside. Drawers hold everything that is not irreversible; irreversible confirmations use Modal.

import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from '../../../components/ui';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Drawer({ title, subtitle, onClose, labelClose, children, testId }: { title: string; subtitle?: ReactNode; onClose: () => void; labelClose: string; children: ReactNode; testId?: string }) {
  const panel = useRef<HTMLDivElement>(null);
  const headingId = useId();

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !panel.current) return;
    const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-ink-900/40" role="presentation" onClick={onClose}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        data-testid={testId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-[780px] flex-col overflow-y-auto bg-white shadow-2xl"
      >
        <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-ink-200 bg-white px-6 py-4">
          <div className="min-w-0">
            <h2 id={headingId} className="text-xl font-semibold text-ink-900">
              {title}
            </h2>
            {subtitle && <div className="mt-1 text-sm text-ink-700">{subtitle}</div>}
          </div>
          <Button label={labelClose} variant="ghost" size="sm" onClick={onClose} data-testid="drawer-close">
            ✕
          </Button>
        </header>
        <div className="space-y-6 px-6 py-5">{children}</div>
      </div>
    </div>
  );
}

/** A titled block inside a drawer. */
export function DrawerSection({ title, children, actions, testId }: { title: string; children: ReactNode; actions?: ReactNode; testId?: string }) {
  const id = useId();
  return (
    <section data-testid={testId} aria-labelledby={id}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <h3 id={id} className="text-base font-semibold text-ink-900">
          {title}
        </h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** Key/value grid used by drawers and cards. */
export function Facts({ items, cols = 2 }: { items: { label: string; value: ReactNode; mono?: boolean; testId?: string }[]; cols?: 1 | 2 | 3 }) {
  const grid = cols === 1 ? 'grid-cols-1' : cols === 3 ? 'grid-cols-1 sm:grid-cols-3' : 'grid-cols-1 sm:grid-cols-2';
  return (
    <dl className={`grid gap-x-6 gap-y-2 ${grid}`}>
      {items.map((i) => (
        <div key={i.label} className="min-w-0">
          <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">{i.label}</dt>
          <dd data-testid={i.testId} className={`text-sm text-ink-900 ${i.mono ? 'break-all font-mono text-xs' : ''}`}>
            {i.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
