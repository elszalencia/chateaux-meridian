// Taking the money: cash or card (the card terminal is simulated), the amount handed over (typed or
// one tap on a likely bill), the change due, and one confirm. Amounts travel to the services in
// cents. The counter has no cash ceiling: an amount above the cash network's limit is fine here.

import { useId, useState } from 'react';
import { CORRIDORS, type CounterSearchResult, type Office, type Payment, type Receipt, type Tender } from '@chateaux/services';
import { api } from '../../../app/api';
import { useFormat } from '../../../app/format';
import { useAction } from '../../../app/hooks';
import { ErrorState, SpinnerIcon } from '../../../components/ui';
import { useOT } from '../shared/i18n';
import { parseUsdToCents, quickAmounts, useMoney } from '../shared/money';
import { DEMO_CASHIER_ID } from '../shared/session';
import { Simulado } from '../shared/Simulado';
import type { DueItem } from './BuyerCard';

const TENDERS: Tender[] = ['cash', 'card'];

export function PayPanel({
  result,
  item,
  office,
  onCancel,
  onDone,
}: {
  result: CounterSearchResult;
  item: DueItem;
  office: Office;
  onCancel: () => void;
  onDone: (r: { payment: Payment; receipt: Receipt }) => void;
}) {
  const ot = useOT();
  const f = useFormat();
  const money = useMoney();
  const receivedId = useId();
  const changeId = useId();
  const [tender, setTender] = useState<Tender>('cash');
  const [text, setText] = useState('');
  const feeCents = Math.round(CORRIDORS[result.corridor].feesUsd.office_counter * 100);
  const dueCents = Math.round(item.usdDue * 100) + feeCents;
  const received = tender === 'card' ? dueCents : parseUsdToCents(text);
  const short = received != null && received < dueCents;
  const change = received != null && !short ? received - dueCents : null;
  const take = useAction((amountReceived: number) =>
    api.takeCounterPayment({ planId: result.plan.id, idx: item.idx, tender, amountReceived, officeId: office.id, cashierId: DEMO_CASHIER_ID }),
  );

  const confirm = async () => {
    if (received == null || short) return;
    const r = await take.run(received);
    if (r) onDone(r);
  };

  return (
    <section data-testid="pay-panel" aria-labelledby="pay-panel-title" className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="pay-panel-title" className="text-2xl font-semibold text-ink-900">
            {ot('mostrador.pay.title', { n: item.number })}
          </h3>
          <p className="mt-1 text-base text-ink-700">
            {result.buyer.name} · {ot('mostrador.pay.dueOn', { date: f.date(item.dueDate) })}
          </p>
        </div>
        <p className="text-right">
          <span className="block text-sm font-medium uppercase tracking-wide text-ink-700">{ot('mostrador.pay.toCharge')}</span>
          <span data-testid="pay-due" className="tabular block text-3xl font-bold text-ink-900">
            {money.cents(dueCents)}
          </span>
          {feeCents > 0 && <span className="block text-sm text-ink-700">{ot('mostrador.pay.feeIncluded', { fee: money.cents(feeCents) })}</span>}
        </p>
      </header>

      <fieldset className="mt-5">
        <legend className="text-lg font-semibold text-ink-900">{ot('mostrador.pay.tender')}</legend>
        <div className="mt-2 grid grid-cols-2 gap-3">
          {TENDERS.map((tv) => (
            <button
              key={tv}
              type="button"
              data-testid={`tender-${tv}`}
              aria-pressed={tender === tv}
              onClick={() => setTender(tv)}
              className={`flex min-h-14 items-center justify-center gap-2 rounded-xl border-2 px-4 text-xl font-semibold ${
                tender === tv ? 'border-brand-700 bg-brand-700 text-white' : 'border-ink-300 bg-white text-ink-900'
              }`}
            >
              {ot(`mostrador.pay.tenders.${tv}`)}
              {tv === 'card' && <Simulado />}
            </button>
          ))}
        </div>
      </fieldset>

      {tender === 'cash' ? (
        <div className="mt-5">
          <label htmlFor={receivedId} className="block text-lg font-semibold text-ink-900">
            {ot('mostrador.pay.received')}
          </label>
          <div className="mt-2 flex flex-wrap gap-3">
            <input
              id={receivedId}
              data-testid="pay-received"
              inputMode="decimal"
              autoComplete="off"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={ot('mostrador.pay.receivedPlaceholder')}
              aria-describedby={changeId}
              aria-invalid={short || (text !== '' && received == null) || undefined}
              className="tabular min-h-16 w-56 rounded-xl border-2 border-ink-300 px-4 text-2xl text-ink-900 placeholder:text-ink-500 focus:border-brand-700"
            />
            {quickAmounts(dueCents).map((c) => (
              <button
                key={c}
                type="button"
                data-testid={`quick-${c}`}
                aria-pressed={received === c}
                onClick={() => setText((c / 100).toFixed(2))}
                className={`min-h-16 rounded-xl border-2 px-4 text-lg font-semibold ${received === c ? 'border-brand-700 bg-brand-50 text-brand-800' : 'border-ink-300 bg-white text-ink-900'}`}
              >
                {c === dueCents ? ot('mostrador.pay.exact', { amount: money.cents(c) }) : money.cents(c)}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <p className="mt-5 rounded-xl border border-ink-200 bg-ink-50 px-4 py-3 text-base text-ink-700">{ot('mostrador.pay.cardHint')}</p>
      )}

      <div id={changeId} aria-live="polite" className="mt-5 rounded-xl bg-ink-50 px-4 py-4">
        {short ? (
          <p data-testid="pay-short" className="text-lg font-semibold text-danger-700">
            {ot('mostrador.pay.short', { missing: money.cents(dueCents - received!) })}
          </p>
        ) : text !== '' && received == null && tender === 'cash' ? (
          <p className="text-lg font-semibold text-danger-700">{ot('mostrador.pay.invalid')}</p>
        ) : (
          <p className="flex items-baseline justify-between gap-3">
            <span className="text-lg font-semibold text-ink-900">{ot('mostrador.pay.change')}</span>
            <span data-testid="pay-change" className="tabular text-3xl font-bold text-ink-900">
              {change == null ? '—' : money.cents(change)}
            </span>
          </p>
        )}
      </div>

      {take.status === 'error' && (
        <div className="mt-4">
          <ErrorState error={take.error} compact />
        </div>
      )}

      <div className="mt-5 flex flex-wrap justify-end gap-3">
        <button type="button" data-testid="pay-cancel" onClick={onCancel} disabled={take.busy} className="min-h-14 rounded-xl border-2 border-ink-300 bg-white px-6 text-lg font-semibold text-ink-700 disabled:opacity-60">
          {ot('mostrador.pay.cancel')}
        </button>
        <button
          type="button"
          data-testid="pay-confirm"
          onClick={() => void confirm()}
          disabled={received == null || short || take.busy}
          aria-busy={take.busy || undefined}
          className="flex min-h-14 items-center gap-2 rounded-xl bg-brand-700 px-8 text-xl font-bold text-white active:bg-brand-800 disabled:cursor-not-allowed disabled:bg-ink-300 disabled:text-ink-700"
        >
          {take.busy && <SpinnerIcon className="h-5 w-5" />}
          {take.busy ? ot('mostrador.pay.confirming') : ot('mostrador.pay.confirm', { amount: money.cents(dueCents) })}
        </button>
      </div>
    </section>
  );
}
