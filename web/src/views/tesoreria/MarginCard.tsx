// Margin and break costs: three totals plus a net line, then the broken legs with their break cost
// so the "Andrés Q1" story is traceable from the totals down to one lock. Break costs are shown
// as a plain positive number labelled as a cost (not a negative margin) to match how the
// treasury team books them.

import type { HedgeBookView, HedgeLegView } from '@chateaux/services';
import { useFormat } from '../../app/format';
import { useT } from '../../app/i18n';
import { Card } from '../../components/ui';

export function MarginCard({ book }: { book: HedgeBookView }) {
  const t = useT();
  const f = useFormat();
  const broken: HedgeLegView[] = book.quarters.flatMap((q) => q.legs.filter((l) => l.breakCostCop > 0));
  const { marginSettledCop, marginBookedCop, breakCostCop } = book.totals;
  const net = marginSettledCop + marginBookedCop - breakCostCop;
  return (
    <Card title={t('tesoreria.margin.title')}>
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-sm">
        <dt className="text-ink-500">{t('tesoreria.margin.settled')}</dt>
        <dd className="tabular text-right font-semibold text-ink-900">{f.cop(marginSettledCop)}</dd>
        <dt className="text-ink-500">{t('tesoreria.margin.booked')}</dt>
        <dd className="tabular text-right font-semibold text-ink-900">{f.cop(marginBookedCop)}</dd>
        <dt className="text-ink-500">{t('tesoreria.margin.breakCosts')}</dt>
        <dd className={`tabular text-right font-semibold ${breakCostCop > 0 ? 'text-danger-700' : 'text-ink-900'}`}>{f.cop(breakCostCop)}</dd>
        <dt className="border-t border-ink-200 pt-2 font-semibold text-ink-900" title={t('tesoreria.margin.netHint')}>
          {t('tesoreria.margin.net')}
        </dt>
        <dd className="tabular border-t border-ink-200 pt-2 text-right text-lg font-semibold text-brand-800">{f.copSigned(net)}</dd>
      </dl>

      <h3 className="mt-4 text-sm font-semibold text-ink-900">{t('tesoreria.margin.breakdownTitle')}</h3>
      {broken.length === 0 ? (
        <p className="mt-1 text-sm text-ink-500">{t('tesoreria.margin.none')}</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <caption className="sr-only">{t('tesoreria.margin.breakdownCaption')}</caption>
            <thead className="uppercase tracking-wide text-ink-500">
              <tr>
                <th scope="col" className="px-2 py-1 text-left font-medium">{t('tesoreria.margin.cols.buyer')}</th>
                <th scope="col" className="px-2 py-1 text-left font-medium">{t('tesoreria.margin.cols.lock')}</th>
                <th scope="col" className="px-2 py-1 text-right font-medium">{t('tesoreria.margin.cols.cost')}</th>
              </tr>
            </thead>
            <tbody>
              {broken.map((l) => (
                <tr key={l.id} className="border-t border-ink-200">
                  <td className="whitespace-nowrap px-2 py-1.5 text-ink-900">{l.buyerName}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-ink-700" title={`${t('tesoreria.margin.cols.usd')}: ${f.usd(l.usdNotional)}`}>
                    <span className="block">{l.lockLabel}</span>
                    <span className="tabular block text-ink-500">{`${t('tesoreria.margin.cols.due')} ${f.date(l.dueDate)}`}</span>
                  </td>
                  <td className="tabular whitespace-nowrap px-2 py-1.5 text-right font-semibold text-danger-700">{f.cop(l.breakCostCop)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
