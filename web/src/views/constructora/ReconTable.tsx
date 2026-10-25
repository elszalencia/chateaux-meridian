// Reconciliation table: one row per paid installment with the full identity (anchor COP + hedge
// settlement − basis − margin = COP credited) visible as columns. Buyer, unit and encargo share one
// two-line cell and headers are short so the whole identity fits at 1440 px without scrolling; the
// long names live in `title` attributes and in a legend below. Numeric columns are right-aligned
// with tabular digits; below 1440 px the table scrolls horizontally inside its card.

import type { ReconRow, ReconStatus } from '@chateaux/services';
import { useFormat } from '../../app/format';
import { useT } from '../../app/i18n';
import { Badge, EmptyState, type Tone } from '../../components/ui';

const STATUS_TONE: Record<ReconStatus, Tone> = { conciliado: 'brand', pendiente: 'info', diferencia: 'warn' };

const LEGEND = ['buyer', 'unit', 'encargo', 'n', 'due', 'paid', 'usd', 'rate', 'anchor', 'ndf', 'basis', 'margin', 'credited', 'status'] as const;
const COLUMNS = ['buyer', 'n', 'due', 'paid', 'usd', 'rate', 'anchor', 'ndf', 'basis', 'margin', 'credited', 'status'] as const;
const NUMERIC = new Set<string>(['usd', 'rate', 'anchor', 'ndf', 'basis', 'margin', 'credited']);

export function ReconTable({ rows }: { rows: ReconRow[] }) {
  const t = useT();
  const f = useFormat();

  return (
    <div>
      {rows.length === 0 ? (
        <div data-testid="recon-empty">
          <EmptyState title={t('constructora.recon.empty')} />
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-ink-200">
          <table data-testid="recon-table" className="w-full border-collapse text-sm">
            <caption className="sr-only">{t('constructora.recon.caption')}</caption>
            <thead className="bg-ink-50 text-xs uppercase tracking-wide text-ink-500">
              <tr>
                {COLUMNS.map((c) => (
                  <th
                    key={c}
                    scope="col"
                    title={t('constructora.recon.titles.' + c)}
                    className={`whitespace-nowrap px-2 py-2 font-medium ${NUMERIC.has(c) ? 'text-right' : 'text-left'}`}
                  >
                    {t('constructora.recon.cols.' + c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const rate = r.rateKind === 'locked' && r.lockedRate != null ? r.lockedRate : r.anchorRate;
                const rateKind = r.rateKind === 'locked' ? t('constructora.recon.rateLocked') : t('constructora.recon.rateSpot');
                const statusLabel = t('states.recon.' + r.status);
                return (
                  <tr
                    key={r.id}
                    data-testid={`recon-row-${r.planId}-${r.number}`}
                    data-status={r.status}
                    aria-label={t('constructora.recon.rowAria', {
                      buyer: r.buyerName,
                      unit: r.unitLabel,
                      n: r.number,
                      usd: f.usd(r.usdPaid),
                      rate: `${rateKind} ${f.rate(rate)}`,
                      credited: f.cop(r.copCredited),
                      status: statusLabel,
                    })}
                    className="border-t border-ink-200 hover:bg-ink-50"
                  >
                    <td className="whitespace-nowrap px-2 py-1.5">
                      <span className="block text-ink-900">{r.buyerName}</span>
                      <span className="block text-xs text-ink-500">
                        {r.unitLabel} · <span className="font-mono">{r.encargoRef}</span>
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 font-semibold text-ink-900">{`M${r.number}`}</td>
                    <td className="tabular whitespace-nowrap px-2 py-1.5 text-xs text-ink-700">{f.date(r.dueDate)}</td>
                    <td className="tabular whitespace-nowrap px-2 py-1.5 text-xs text-ink-700" title={f.dateTime(r.paidAt)}>
                      {f.date(r.paidAt)}
                    </td>
                    <td className="tabular whitespace-nowrap px-2 py-1.5 text-right text-ink-900">{f.usd(r.usdPaid)}</td>
                    <td className="tabular whitespace-nowrap px-2 py-1.5 text-right text-ink-900">
                      <span className="block">{f.rate(rate)}</span>
                      <span className="block text-xs text-ink-500">{rateKind}</span>
                    </td>
                    <td className="tabular whitespace-nowrap px-2 py-1.5 text-right text-ink-900">{f.cop(r.anchorCop)}</td>
                    <td className="tabular whitespace-nowrap px-2 py-1.5 text-right text-ink-900">
                      {r.ndfSettlementCop == null ? <span title={t('constructora.recon.noSettlement')}>—</span> : f.copSigned(r.ndfSettlementCop)}
                    </td>
                    <td className={`tabular whitespace-nowrap px-2 py-1.5 text-right ${r.basisCop !== 0 ? 'font-semibold text-warn-700' : 'text-ink-900'}`}>{f.copSigned(r.basisCop)}</td>
                    <td className="tabular whitespace-nowrap px-2 py-1.5 text-right text-ink-900">{f.copSigned(r.marginCop)}</td>
                    <td className="tabular whitespace-nowrap px-2 py-1.5 text-right font-semibold text-ink-900">{f.cop(r.copCredited)}</td>
                    <td className="whitespace-nowrap px-2 py-1.5">
                      <Badge tone={STATUS_TONE[r.status]}>{statusLabel}</Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-ink-500">{t('constructora.recon.footnote')}</p>
      <details className="mt-2 text-xs text-ink-500">
        <summary className="cursor-pointer font-medium text-ink-700">{t('constructora.recon.legendTitle')}</summary>
        <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 md:grid-cols-2">
          {LEGEND.map((c) => (
            <div key={c} className="flex gap-2">
              <dt className="shrink-0 font-semibold text-ink-700">{t('constructora.recon.cols.' + c)}</dt>
              <dd>{t('constructora.recon.titles.' + c)}</dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}
