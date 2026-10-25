// Tesorería: the hedge book is the single source for the whole page (totals, quarters, curve,
// pass-through), so one `useAsync` keyed on the demo version refreshes everything at once. The
// "Reservar cobertura" action is the step-4 moment of the demo: it reloads the book on success so
// unhedged legs turn hedged in place. Layout: stats row, the book at full width (its legs table
// needs the room at 1440 px) and the curve / pass-through / margin cards in a row below it.

import { api } from '../../app/api';
import { useDemo } from '../../app/demo';
import { useFormat } from '../../app/format';
import { useAsync } from '../../app/hooks';
import { useT } from '../../app/i18n';
import { ErrorState, Spinner, Stat } from '../../components/ui';
import { HedgeBook } from './HedgeBook';
import { CurveCard } from './CurveCard';
import { PassThroughSlider } from './PassThroughSlider';
import { MarginCard } from './MarginCard';

export default function TesoreriaView() {
  const t = useT();
  const f = useFormat();
  const { version } = useDemo();
  const book = useAsync(() => api.getHedgeBook(), [version]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-ink-900">{t('tesoreria.title')}</h1>
          <p className="mt-1 max-w-3xl text-sm text-ink-500">{t('tesoreria.subtitle')}</p>
        </div>
        {book.data && <p className="tabular text-sm text-ink-500">{t('tesoreria.asOf', { date: f.date(book.data.today) })}</p>}
      </header>

      {book.loading && !book.data && <Spinner />}
      {book.status === 'error' && <ErrorState error={book.error} onRetry={book.reload} />}

      {book.data && book.status !== 'error' && (
        <>
          <section aria-label={t('tesoreria.stats.region')} className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <div data-testid="locked-total">
              <Stat label={t('tesoreria.stats.locked')} value={f.usd(book.data.totals.lockedUsd)} hint={t('tesoreria.stats.lockedHint')} />
            </div>
            <div data-testid="hedged-total">
              <Stat label={t('tesoreria.stats.hedged')} value={f.usd(book.data.totals.hedgedUsd)} hint={t('tesoreria.stats.hedgedHint')} />
            </div>
            <div data-testid="unhedged-total">
              <Stat
                label={t('tesoreria.stats.unhedged')}
                value={f.usd(book.data.totals.unhedgedUsd)}
                hint={t('tesoreria.stats.unhedgedHint')}
                className={book.data.totals.unhedgedUsd > 0 ? 'bg-warn-100 ring-1 ring-warn-500' : ''}
              />
            </div>
            <div data-testid="margin-settled">
              <Stat label={t('tesoreria.stats.marginSettled')} value={f.cop(book.data.totals.marginSettledCop)} hint={t('tesoreria.stats.marginSettledHint')} />
            </div>
            <div data-testid="margin-booked">
              <Stat label={t('tesoreria.stats.marginBooked')} value={f.cop(book.data.totals.marginBookedCop)} hint={t('tesoreria.stats.marginBookedHint')} />
            </div>
            <div data-testid="break-costs">
              <Stat label={t('tesoreria.stats.breakCosts')} value={f.cop(book.data.totals.breakCostCop)} hint={t('tesoreria.stats.breakCostsHint')} />
            </div>
          </section>

          <HedgeBook book={book.data} reloading={book.loading} onBooked={book.reload} />
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
            <CurveCard curve={book.data.curve} />
            <PassThroughSlider book={book.data} />
            <MarginCard book={book.data} />
          </div>
        </>
      )}
    </div>
  );
}
