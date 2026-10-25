// Hedge book by quarter. The primary action sits in the card header next to a count of pending
// legs so treasury sees at once whether there is anything to book; unhedged legs get an amber row
// tint and an amber badge, hedged legs stay calm. Each quarter has a header strip with its totals,
// then the legs table (trade id and BanRep reference share one cell so ten columns fit the full
// width at 1440 px) and the booked trades list, so a quarter can be read top to bottom.

import { useMemo, useState } from 'react';
import { HEDGE_PROVIDER_LABEL, type HedgeBookView, type HedgeLegState, type HedgeQuarterView, type HedgeTrade } from '@casa-puente/services';
import { api } from '../../app/api';
import { useFormat } from '../../app/format';
import { useAction } from '../../app/hooks';
import { useT } from '../../app/i18n';
import { Badge, Button, Card, EmptyState, ErrorState, type Tone } from '../../components/ui';

const LEG_TONE: Record<HedgeLegState, Tone> = { pendiente: 'warn', reservada: 'brand', liquidada: 'neutral', rota: 'danger' };

export function HedgeBook({ book, reloading, onBooked }: { book: HedgeBookView; reloading: boolean; onBooked: () => void }) {
  const t = useT();
  const f = useFormat();
  const [booked, setBooked] = useState<HedgeTrade[] | null>(null);
  const bookStrip = useAction(async () => {
    const trades = await api.bookStrip();
    setBooked(trades);
    onBooked();
    return trades;
  });
  const pending = book.pendingLegCount;
  const pendingUsd = useMemo(() => book.quarters.reduce((a, q) => a + q.unhedgedUsd, 0), [book]);
  const hint = pending === 0 ? t('tesoreria.book.noPendingHint') : t('tesoreria.book.pendingHint', { n: pending, usd: f.usd(pendingUsd), provider: HEDGE_PROVIDER_LABEL });

  return (
    <Card
      title={t('tesoreria.book.title')}
      className="min-w-0"
      actions={
        <div className="flex flex-col items-end gap-1">
          <Button
            data-testid="book-strip"
            label={pending === 0 ? t('tesoreria.book.noPending') : t('tesoreria.book.bookStripAria', { n: pending, provider: HEDGE_PROVIDER_LABEL })}
            title={hint}
            disabled={pending === 0 || reloading}
            busy={bookStrip.busy}
            onClick={() => void bookStrip.run()}
          >
            {pending === 0 ? t('tesoreria.book.bookStrip') : t('tesoreria.book.bookStripN', { n: pending })}
          </Button>
          <span className="max-w-xs text-right text-xs text-ink-500">{pending === 0 ? t('tesoreria.book.noPending') : hint}</span>
        </div>
      }
    >
      <div data-testid="hedge-book" className="space-y-6">
        {bookStrip.status === 'error' && <ErrorState error={bookStrip.error} compact onRetry={() => void bookStrip.run()} />}
        {booked && bookStrip.status === 'success' && (
          <div data-testid="book-strip-success" role="status" className="rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-900">
            <div className="flex items-start justify-between gap-3">
              <p className="font-semibold">{t('tesoreria.book.successTitle', { n: booked.length })}</p>
              <Button
                label={t('tesoreria.book.dismiss')}
                variant="ghost"
                size="sm"
                onClick={() => {
                  setBooked(null);
                  bookStrip.resetAction();
                }}
              >
                ✕
              </Button>
            </div>
            <ul className="mt-1 space-y-0.5 font-mono text-xs">
              {booked.map((tr) => (
                <li key={tr.id}>{t('tesoreria.book.successTrade', { id: tr.id, date: f.date(tr.dueDate), usd: f.usd(tr.usdNotional), rate: f.rate(tr.rate), ref: tr.banrepRef || '—' })}</li>
              ))}
            </ul>
          </div>
        )}
        {book.quarters.length === 0 && <EmptyState title={t('tesoreria.book.empty')} />}
        {book.quarters.map((q) => (
          <Quarter key={q.key} quarter={q} />
        ))}
      </div>
    </Card>
  );
}

/** Localised quarter label from the key (`2027-T1`); the API's `label` is Spanish-only. */
function quarterLabel(t: ReturnType<typeof useT>, key: string, fallback: string): string {
  const m = /^(\d{4})-T([1-4])$/.exec(key);
  if (!m) return fallback;
  return t('tesoreria.book.quarter.label', { year: m[1]!, q: m[2]!, months: t('tesoreria.book.quarter.months.' + m[2]) });
}

function Quarter({ quarter: q }: { quarter: HedgeQuarterView }) {
  const t = useT();
  const f = useFormat();
  const label = quarterLabel(t, q.key, q.label);
  const cols = ['due', 'buyer', 'lock', 'usd', 'lockedRate', 'fwdRate', 'trade', 'state', 'margin', 'settled'] as const;
  const numeric = new Set<string>(['usd', 'lockedRate', 'fwdRate', 'margin', 'settled']);
  const titled = new Set<string>(['lockedRate', 'fwdRate', 'trade', 'margin', 'settled']);
  const tradeOf = (id: string | null) => (id ? q.trades.find((tr) => tr.id === id) : undefined);

  return (
    <section data-testid={`quarter-${q.key}`} aria-label={t('tesoreria.book.quarter.aria', { label })} className="rounded-lg border border-ink-200">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-ink-200 bg-ink-50 px-4 py-3">
        <h3 className="text-base font-semibold text-ink-900">{label}</h3>
        <span className="text-xs text-ink-500">{t('tesoreria.book.quarter.legs', { n: q.legs.length })}</span>
        <dl className="ml-auto flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <QuarterStat label={t('tesoreria.book.quarter.locked')} value={f.usd(q.lockedUsd)} />
          <QuarterStat label={t('tesoreria.book.quarter.hedged')} value={f.usd(q.hedgedUsd)} />
          <QuarterStat label={t('tesoreria.book.quarter.unhedged')} value={f.usd(q.unhedgedUsd)} warn={q.unhedgedUsd > 0} />
          <QuarterStat
            label={t('tesoreria.book.quarter.margin')}
            value={f.copSigned(q.marginSettledCop + q.marginBookedCop)}
            hint={t('tesoreria.book.quarter.marginDetail', { settled: f.cop(q.marginSettledCop), booked: f.cop(q.marginBookedCop) })}
          />
          <QuarterStat label={t('tesoreria.book.quarter.breakCost')} value={f.cop(q.breakCostCop)} danger={q.breakCostCop > 0} />
        </dl>
      </header>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">{t('tesoreria.book.legsCaption', { label })}</caption>
          <thead className="text-xs uppercase tracking-wide text-ink-500">
            <tr>
              {cols.map((c) => (
                <th
                  key={c}
                  scope="col"
                  title={titled.has(c) ? t('tesoreria.book.titles.' + c) : undefined}
                  className={`whitespace-nowrap px-2 py-2 font-medium ${numeric.has(c) ? 'text-right' : 'text-left'}`}
                >
                  {c === 'trade' ? `${t('tesoreria.book.cols.trade')} · ${t('tesoreria.book.cols.banrep')}` : t('tesoreria.book.cols.' + c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {q.legs.map((leg) => {
              const trade = tradeOf(leg.tradeId);
              const unhedged = leg.state === 'pendiente';
              const stateLabel = t('states.leg.' + leg.state);
              return (
                <tr
                  key={leg.id}
                  data-testid={`leg-${leg.id}`}
                  data-state={leg.state}
                  aria-label={t('tesoreria.book.legAria', { buyer: leg.buyerName, date: f.date(leg.dueDate), usd: f.usd(leg.usdNotional), rate: f.rate(leg.lockedRate), state: stateLabel })}
                  className={`border-t border-ink-200 ${unhedged ? 'bg-warn-100/70 font-medium' : leg.state === 'rota' ? 'bg-danger-100/40' : 'hover:bg-ink-50'}`}
                >
                  <td className="tabular whitespace-nowrap px-2 py-1.5 text-ink-900">{f.date(leg.dueDate)}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-ink-900">{leg.buyerName}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-ink-700">{leg.lockLabel}</td>
                  <td className="tabular whitespace-nowrap px-2 py-1.5 text-right text-ink-900">{f.usd(leg.usdNotional)}</td>
                  <td className="tabular whitespace-nowrap px-2 py-1.5 text-right text-ink-900">{f.rate(leg.lockedRate)}</td>
                  <td className="tabular whitespace-nowrap px-2 py-1.5 text-right text-ink-900">{f.rate(leg.fwdRate)}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 font-mono text-xs text-ink-700">
                    <span className="block">{leg.tradeId ?? '—'}</span>
                    {/* ink-700, not ink-500: the amber and red row tints leave ink-500 under 4.5:1. */}
                    <span className="block text-ink-700" title={t('tesoreria.book.titles.banrep')}>
                      {trade?.banrepRef || '—'}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5">
                    <Badge tone={LEG_TONE[leg.state]}>{stateLabel}</Badge>
                  </td>
                  <td className="tabular whitespace-nowrap px-2 py-1.5 text-right text-ink-900">{f.copSigned(leg.marginCop)}</td>
                  <td className="tabular whitespace-nowrap px-2 py-1.5 text-right text-ink-900">{leg.settledCop == null ? '—' : f.copSigned(leg.settledCop)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <TradesList quarter={q} />
    </section>
  );
}

function QuarterStat({ label, value, hint, warn, danger }: { label: string; value: string; hint?: string; warn?: boolean; danger?: boolean }) {
  return (
    <div title={hint} className="flex flex-col">
      <dt className="text-xs text-ink-500">{label}</dt>
      <dd className={`tabular font-semibold ${warn ? 'text-warn-700' : danger ? 'text-danger-700' : 'text-ink-900'}`}>{value}</dd>
    </div>
  );
}

function TradesList({ quarter: q }: { quarter: HedgeQuarterView }) {
  const t = useT();
  const f = useFormat();
  const cols = ['id', 'due', 'usd', 'rate', 'banrep', 'settlement'] as const;
  return (
    <div className="border-t border-ink-200 px-4 py-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-semibold text-ink-900">{t('tesoreria.book.trades.title')}</h4>
        <span className="text-xs text-ink-500">{t('tesoreria.book.trades.provider', { provider: HEDGE_PROVIDER_LABEL })}</span>
      </div>
      {q.trades.length === 0 ? (
        <p className="text-sm text-ink-500">{t('tesoreria.book.trades.none')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-xs">
            <caption className="sr-only">{t('tesoreria.book.trades.caption', { label: quarterLabel(t, q.key, q.label), provider: HEDGE_PROVIDER_LABEL })}</caption>
            <thead className="uppercase tracking-wide text-ink-500">
              <tr>
                {cols.map((c) => (
                  <th key={c} scope="col" className={`whitespace-nowrap px-2 py-1 font-medium ${c === 'usd' || c === 'rate' ? 'text-right' : 'text-left'}`}>
                    {t('tesoreria.book.trades.cols.' + c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...q.trades]
                .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id))
                .map((tr) => (
                  <tr key={tr.id} className="border-t border-ink-100">
                    <td className="whitespace-nowrap px-2 py-1 font-mono text-ink-900">{tr.id}</td>
                    <td className="tabular whitespace-nowrap px-2 py-1 text-ink-700">{f.date(tr.dueDate)}</td>
                    <td className="tabular whitespace-nowrap px-2 py-1 text-right text-ink-900">{f.usd(tr.usdNotional)}</td>
                    <td className="tabular whitespace-nowrap px-2 py-1 text-right text-ink-900">{f.rate(tr.rate)}</td>
                    <td className="whitespace-nowrap px-2 py-1 font-mono text-ink-700">{tr.banrepRef || '—'}</td>
                    <td className="tabular whitespace-nowrap px-2 py-1 text-ink-700">
                      {tr.settledCop != null && tr.fixing != null ? t('tesoreria.book.trades.settled', { cop: f.copSigned(tr.settledCop), fixing: f.rate(tr.fixing) }) : t('tesoreria.book.trades.open')}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
