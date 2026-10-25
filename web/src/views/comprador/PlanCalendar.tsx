// Plan calendar: 24 installments in 8 quarter bands of three. Each cell is a real <button> with a
// spoken label (number, due date, state, USD), the state is both visual (colour, border, icon) and
// a data attribute, and late/grace tags sit inside the cell so a glance shows what needs attention.
// Four bands per row on wide screens, two on tablets, one on phones. The adverse states (no pagada,
// condonada) join the legend only when the plan has one, so a plan in good standing reads as before.

import type { InstallmentView } from '@casa-puente/services';
import { useFormat } from '../../app/format';
import { useT } from '../../app/i18n';
import { Card } from '../../components/ui';
import { CELL_CLASS, CheckIcon } from './shared';

const STATES = ['pagado', 'bloqueado', 'ofrecido', 'abierto', 'roto'] as const;
const ADVERSE_STATES = ['no_pagado', 'condonado'] as const;
// The muted date grey only passes contrast on white cells; tinted cells keep their own text colour.
const DATE_CLASS: Partial<Record<InstallmentView['cellState'], string>> = { bloqueado: 'text-white', abierto: 'text-ink-500', ofrecido: 'text-ink-500' };

export function PlanCalendar({ installments, installmentCop, onSelect }: { installments: InstallmentView[]; installmentCop: number; onSelect: (i: InstallmentView) => void }) {
  const t = useT();
  const f = useFormat();
  const quarters = new Map<number, InstallmentView[]>();
  for (const i of installments) {
    if (!quarters.has(i.quarter)) quarters.set(i.quarter, []);
    quarters.get(i.quarter)!.push(i);
  }

  return (
    <Card
      title={t('comprador.calendar.title')}
      actions={<p className="text-sm text-ink-500">{t('comprador.calendar.subtitle', { count: installments.length, cop: f.cop(installmentCop) })}</p>}
    >
      <div data-testid="calendar" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[...quarters.entries()].map(([q, rows]) => (
          <section key={q} aria-label={t('comprador.calendar.quarter', { n: q })} className="rounded-lg border border-ink-200 bg-ink-50 p-3">
            <header className="mb-2 flex items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold text-ink-900">{t('comprador.calendar.quarter', { n: q })}</h3>
              <p className="truncate text-xs text-ink-500">
                {t('comprador.calendar.quarterRange', { from: f.monthYear(rows[0]!.dueDate), to: f.monthYear(rows[rows.length - 1]!.dueDate) })}
              </p>
            </header>
            <div className="grid grid-cols-3 gap-2">
              {rows.map((i) => (
                <button
                  key={i.idx}
                  type="button"
                  data-testid={`calendar-cell-${i.number}`}
                  data-state={i.cellState}
                  onClick={() => onSelect(i)}
                  className={`flex min-h-[96px] min-w-0 flex-col items-start justify-between rounded-lg px-1.5 py-2 text-left transition-shadow hover:shadow-md ${CELL_CLASS[i.cellState]}`}
                >
                  {/* The accessible name is the visible text ("M4 nov 2026 USD 1.188,33"), read in order
                      thanks to the explicit spaces, followed by the due date and state for the screen
                      reader only. */}
                  <span className="flex w-full items-center justify-between">
                    <span className="text-sm font-semibold">{t('comprador.calendar.cell', { n: i.number })}</span>
                    {i.cellState === 'pagado' && <CheckIcon className="h-4 w-4 text-brand-600" />}
                  </span>{' '}
                  {/* Full white on the solid green cell: white at 80 % drops below 4.5:1 for small text. */}
                  <span className={`text-xs ${DATE_CLASS[i.cellState] ?? ''}`}>{f.monthYear(i.dueDate)}</span>{' '}
                  <span className="tabular whitespace-nowrap text-xs font-medium">{f.usd(i.usdShown)}</span>
                  {i.isLate && (
                    <>
                      {' '}
                      <span className={`rounded px-1 text-[10px] font-semibold uppercase ${i.cellState === 'bloqueado' ? 'bg-white text-brand-800' : 'bg-warn-100 text-warn-700'}`}>
                        {t(i.inGrace ? 'comprador.calendar.inGrace' : 'comprador.calendar.late')}
                      </span>
                    </>
                  )}
                  <span className="sr-only">, {t('comprador.calendar.cellDetail', { due: f.date(i.dueDate), state: t('states.' + i.cellState) })}</span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
      <ul aria-label={t('comprador.calendar.legend')} className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs text-ink-700">
        {[...STATES, ...ADVERSE_STATES.filter((s) => installments.some((i) => i.cellState === s))].map((s) => (
          <li key={s} className="flex items-center gap-2">
            <span aria-hidden="true" className={`inline-block h-4 w-6 rounded ${CELL_CLASS[s]}`} />
            {t(`comprador.calendar.legend${s.charAt(0).toUpperCase()}${s.slice(1)}`)}
          </li>
        ))}
      </ul>
    </Card>
  );
}
