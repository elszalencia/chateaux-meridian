// Curve card: the four points treasury prices against (spot, 1M, 2M, 3M) as a small table with
// forward points relative to spot, plus the source and as-of line so the presenter can say where
// the numbers come from. Order follows the tenor ladder, not the order the API returns.

import type { CurvePoint } from '@casa-puente/services';
import { useFormat } from '../../app/format';
import { useT } from '../../app/i18n';
import { Card } from '../../components/ui';

const ORDER: CurvePoint['tenor'][] = ['spot', '1M', '2M', '3M'];

export function CurveCard({ curve }: { curve: CurvePoint[] }) {
  const t = useT();
  const f = useFormat();
  const points = ORDER.map((tenor) => curve.find((p) => p.tenor === tenor)).filter((p): p is CurvePoint => Boolean(p));
  const spot = points.find((p) => p.tenor === 'spot')?.rate;
  const first = curve[0];
  return (
    <Card title={t('tesoreria.curve.title')}>
      <table data-testid="curve-table" className="w-full border-collapse text-sm">
        <caption className="sr-only">{t('tesoreria.curve.caption')}</caption>
        <thead className="text-xs uppercase tracking-wide text-ink-500">
          <tr>
            <th scope="col" className="px-2 py-1 text-left font-medium">{t('tesoreria.curve.tenor')}</th>
            <th scope="col" className="px-2 py-1 text-left font-medium">{t('tesoreria.curve.date')}</th>
            <th scope="col" className="px-2 py-1 text-right font-medium">{t('tesoreria.curve.rate')}</th>
            <th scope="col" className="px-2 py-1 text-right font-medium">{t('tesoreria.curve.points')}</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.tenor} className="border-t border-ink-200">
              <th scope="row" className="whitespace-nowrap px-2 py-1.5 text-left font-semibold text-ink-900">{t('tesoreria.curve.tenors.' + p.tenor)}</th>
              <td className="tabular whitespace-nowrap px-2 py-1.5 text-ink-700">{f.date(p.date)}</td>
              <td className="tabular px-2 py-1.5 text-right text-ink-900">{f.rate(p.rate)}</td>
              <td className="tabular px-2 py-1.5 text-right text-ink-700">{spot == null || p.tenor === 'spot' ? '—' : `+${f.rate(p.rate - spot)}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {first && <p className="mt-3 text-xs text-ink-500">{t('tesoreria.curve.source', { source: first.source, asOf: f.date(first.asOf) })}</p>}
    </Card>
  );
}
