// Side column of the counter: the office and cashier of this shift, and the shift total by tender
// for the close-out. The office can change between customers, never in the middle of a payment.

import { useId } from 'react';
import type { Office, Tender } from '@chateaux/services';
import { api } from '../../../app/api';
import { useDemo } from '../../../app/demo';
import { useFormat } from '../../../app/format';
import { useAsync } from '../../../app/hooks';
import { ErrorState, SpinnerIcon } from '../../../components/ui';
import { useOT } from '../shared/i18n';
import { useMoney } from '../shared/money';
import { DEMO_CASHIER_ID } from '../shared/session';
import { Simulado } from '../shared/Simulado';

const TENDERS: Tender[] = ['cash', 'card'];

export function OfficePanel({ offices, office, onChoose, refreshKey, locked }: { offices: Office[]; office: Office | null; onChoose: (id: string) => void; refreshKey: number; locked: boolean }) {
  const ot = useOT();
  const selectId = useId();
  return (
    <>
      <section aria-labelledby={`${selectId}-h`} className="rounded-2xl border border-ink-200 bg-white p-4 shadow-sm">
        <h3 id={`${selectId}-h`} className="text-base font-semibold text-ink-900">
          {ot('mostrador.office.title')}
        </h3>
        <label htmlFor={selectId} className="mt-2 block text-sm font-medium text-ink-700">
          {ot('mostrador.office.label')}
        </label>
        <select
          id={selectId}
          data-testid="counter-office"
          value={office?.id ?? ''}
          disabled={locked}
          onChange={(e) => onChoose(e.target.value)}
          className="mt-1 min-h-14 w-full rounded-xl border-2 border-ink-300 bg-white px-3 text-base text-ink-900"
        >
          {offices.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
        {office && (
          <div className="mt-2 text-sm text-ink-700">
            <p>
              {office.address}, {office.city} {office.state}
            </p>
            <p>{office.hours}</p>
            {office.isLicensedAgency && <p className="mt-1 font-medium">{ot('mostrador.office.licensed')}</p>}
            {office.simulated && <Simulado className="mt-2" />}
          </div>
        )}
        <p className="mt-3 text-sm text-ink-700">{ot('mostrador.office.cashier', { id: DEMO_CASHIER_ID })}</p>
      </section>
      {office && <ShiftTotals office={office} refreshKey={refreshKey} />}
    </>
  );
}

export function ShiftTotals({ office, refreshKey }: { office: Office; refreshKey: number }) {
  const ot = useOT();
  const f = useFormat();
  const money = useMoney();
  const { version, state } = useDemo();
  const shift = useAsync(() => api.getShiftTotal({ officeId: office.id, cashierId: DEMO_CASHIER_ID }), [office.id, refreshKey, version]);
  const s = shift.data;
  return (
    <section data-testid="shift-total" aria-labelledby="shift-total-h" className="rounded-2xl border border-ink-200 bg-white p-4 shadow-sm">
      <h3 id="shift-total-h" className="flex items-center justify-between gap-2 text-base font-semibold text-ink-900">
        {ot('mostrador.shift.title')}
        {shift.loading && <SpinnerIcon className="h-4 w-4" />}
      </h3>
      {(s?.date ?? state?.today) && <p className="text-sm text-ink-700">{ot('mostrador.shift.date', { date: f.date((s?.date ?? state?.today)!) })}</p>}
      {shift.status === 'error' && <ErrorState error={shift.error} onRetry={shift.reload} compact />}
      {s && (
        <>
          <dl className="mt-3 space-y-2">
            {TENDERS.map((tv) => (
              <div key={tv} className="flex items-baseline justify-between gap-2">
                <dt className="text-base text-ink-700">{ot('mostrador.shift.byTender', { tender: ot(`mostrador.pay.tenders.${tv}`), count: s.byTender[tv].count })}</dt>
                <dd data-testid={`shift-${tv}`} className="tabular text-lg font-semibold text-ink-900">
                  {money.usd(s.byTender[tv].usd)}
                </dd>
              </div>
            ))}
            <div className="flex items-baseline justify-between gap-2 border-t border-ink-200 pt-2">
              <dt className="text-base font-semibold text-ink-900">{ot('mostrador.shift.total')}</dt>
              <dd data-testid="shift-total-usd" className="tabular text-2xl font-bold text-ink-900">
                {money.usd(s.totalUsd)}
              </dd>
            </div>
          </dl>
          {s.payments.length === 0 && <p className="mt-3 text-sm text-ink-700">{ot('mostrador.shift.empty')}</p>}
        </>
      )}
    </section>
  );
}
