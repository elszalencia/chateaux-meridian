// Buyer card at the counter: who the buyer is, the unit, the installments payable now and one
// "Cobrar USD X" action per installment (56 px tall, the first one primary). The card also says why
// nothing can be taken (plan on hold, nothing due yet, an office of another corridor), flags a cash
// reference still pending at the cash network, and tells the cashier when the delivery to the seller
// will wait for the seller's verification (the money is still taken and receipted).

import { CORRIDORS, addDays, type CounterSearchResult, type Office } from '@chateaux/services';
import { api } from '../../../app/api';
import { useDemo, useFollowPlanCorridor } from '../../../app/demo';
import { useFormat } from '../../../app/format';
import { useT } from '../../../app/i18n';
import { useAsync } from '../../../app/hooks';
import { pendingMinutesAt, useServiceClock } from '../../../app/serviceClock';
import { Badge, ErrorState, SpinnerIcon } from '../../../components/ui';
import { useOT } from '../shared/i18n';
import { useMoney } from '../shared/money';
import { Simulado } from '../shared/Simulado';

export type DueItem = CounterSearchResult['due'][number];

/** USD the buyer hands over for one installment at the counter: the installment plus the counter fee. */
export function counterTotalUsd(result: CounterSearchResult, item: DueItem): number {
  return Math.round(item.usdDue * 100 + CORRIDORS[result.corridor].feesUsd.office_counter * 100) / 100;
}

export function BuyerCard({ result, office, onCharge, onBack }: { result: CounterSearchResult; office: Office | null; onCharge: (item: DueItem) => void; onBack: () => void }) {
  const t = useT();
  const ot = useOT();
  const f = useFormat();
  const money = useMoney();
  const { version } = useDemo();
  const plan = useAsync(() => api.getPlan(result.plan.id), [result.plan.id, version]);
  useFollowPlanCorridor(result.corridor);
  const c = CORRIDORS[result.corridor];
  const wrongOffice = office != null && office.corridor !== result.corridor;
  const pv = plan.data;
  const pendingRef = pv?.payments.find((p) => p.method === 'moneygram_cash' && p.status === 'pending') ?? null;
  const clock = useServiceClock(pendingRef?.now, { tickMs: 30_000 });
  const pendingMinutes = pendingRef ? pendingMinutesAt(pendingRef, clock) : null;
  const next = pv?.summary.nextInstallment ?? null;
  const gate = pv?.seller?.gate ?? null;
  const canCharge = !result.fundsBlocked && !wrongOffice && office != null;

  return (
    <section data-testid="buyer-card" aria-labelledby="buyer-card-name" className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id="buyer-card-name" className="text-2xl font-semibold text-ink-900">
            {result.buyer.name}
          </h3>
          <p className="mt-1 text-base text-ink-700">
            {result.buyer.phone} · {result.buyer.city}, {result.buyer.state}
          </p>
          <p className="mt-1 text-base text-ink-700">{result.unitLabel}</p>
          <p className="mt-1 text-sm text-ink-700">
            {ot('mostrador.card.planRef', { ref: result.plan.encargoRef })} · {t(c.payoutTargetKey)}: {result.plan.trustCompany}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <Badge tone="info">{t(c.nameKey)}</Badge>
          <button type="button" data-testid="buyer-card-back" onClick={onBack} className="min-h-14 rounded-xl border-2 border-ink-300 bg-white px-5 text-base font-semibold text-ink-700">
            {ot('mostrador.card.back')}
          </button>
        </div>
      </header>

      <div className="mt-4 space-y-3">
        {plan.loading && !pv && (
          <p role="status" className="flex items-center gap-2 text-ink-700">
            <SpinnerIcon className="h-5 w-5" />
            {ot('mostrador.card.loading')}
          </p>
        )}
        {plan.status === 'error' && <ErrorState error={plan.error} onRetry={plan.reload} compact />}
        {result.fundsBlocked && (
          <p role="status" data-testid="buyer-card-blocked" className="rounded-xl border border-danger-600/30 bg-danger-100 px-4 py-3 text-base font-semibold text-danger-700">
            {ot('mostrador.card.blocked')}
          </p>
        )}
        {wrongOffice && office && (
          <p role="status" data-testid="buyer-card-wrong-office" className="rounded-xl border border-warn-500 bg-warn-100 px-4 py-3 text-base text-warn-700">
            {ot('mostrador.card.wrongOffice', { corridor: t(c.nameKey), office: office.name })}
          </p>
        )}
        {pendingRef && (
          <div data-testid="buyer-card-pending-ref" role="status" className="rounded-xl border border-warn-500 bg-warn-100 px-4 py-3 text-base text-warn-700">
            <p className="font-semibold">
              {ot('mostrador.card.pendingRef', { ref: pendingRef.externalRef ?? '', n: pendingRef.idx + 1 })} <Simulado />
            </p>
            {pendingMinutes != null && (
              <p className="mt-1">
                {c.moneyGram && pendingMinutes >= c.moneyGram.pendingAlertMinutes
                  ? ot('mostrador.card.pendingLong', { minutes: pendingMinutes })
                  : ot('mostrador.card.pendingShort', { minutes: pendingMinutes })}
              </p>
            )}
          </div>
        )}
        {gate && (
          <p data-testid="buyer-card-gate" className="rounded-xl border border-ink-200 bg-ink-50 px-4 py-3 text-base text-ink-700">
            {ot(`mostrador.card.gate.${gate}`)}
          </p>
        )}
      </div>

      <h4 className="mt-5 text-lg font-semibold text-ink-900">{ot('mostrador.card.dueTitle')}</h4>
      {result.due.length === 0 ? (
        <div data-testid="buyer-card-nothing-due" className="mt-2 rounded-xl border border-dashed border-ink-300 bg-ink-50 px-5 py-5 text-base text-ink-700">
          <p className="font-semibold text-ink-900">{ot('mostrador.card.nothingDueTitle')}</p>
          {next && !result.fundsBlocked && (
            <p className="mt-1">
              {ot('mostrador.card.nextDue', { n: next.number, date: f.date(next.dueDate), opens: f.date(addDays(next.dueDate, -c.payWindowDays)), amount: money.usd(next.usdShown) })}
            </p>
          )}
          {pv && pv.summary.paidCount === 0 && <p className="mt-1">{ot('mostrador.card.firstPayment')}</p>}
        </div>
      ) : (
        <ul className="mt-2 space-y-3">
          {result.due.map((item, i) => {
            const total = counterTotalUsd(result, item);
            return (
              <li key={item.idx} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ink-200 px-4 py-3">
                <div>
                  <p className="text-lg font-semibold text-ink-900">{ot('mostrador.card.installment', { n: item.number, date: f.date(item.dueDate) })}</p>
                  <p className="text-base text-ink-700">
                    {money.usd(item.usdDue)}
                    {item.lateInGrace && (
                      <Badge tone="warn" className="ml-2">
                        {ot('mostrador.card.lateInGrace')}
                      </Badge>
                    )}
                    {item.isLate && !item.lateInGrace && (
                      <Badge tone="danger" className="ml-2">
                        {ot('mostrador.card.late')}
                      </Badge>
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  data-testid={`charge-${item.idx}`}
                  disabled={!canCharge}
                  onClick={() => onCharge(item)}
                  className={`min-h-14 rounded-xl px-6 text-xl font-bold disabled:cursor-not-allowed disabled:border-ink-300 disabled:bg-ink-300 disabled:text-ink-700 ${
                    i === 0 ? 'bg-brand-700 text-white active:bg-brand-800' : 'border-2 border-brand-700 bg-white text-brand-800 active:bg-brand-50'
                  }`}
                >
                  {ot('mostrador.card.charge', { amount: money.usd(total) })}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
