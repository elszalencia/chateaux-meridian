// Oficina · Mostrador: the counter, built for a landscape tablet or POS screen (1024–1366 px) and
// touch only. One column walks the cashier through search → buyer card → payment → receipt →
// "Siguiente cliente"; the side column holds the office, the cashier and the shift total (the
// counter role is the only one that sees it). Nothing depends on hover. What the counter may take
// comes from the search result (the services list only what the plan's corridor lets the counter
// take); the office must serve the plan's corridor, compared by id, never by country name.

import { useCallback, useState } from 'react';
import type { CounterSearchResult, Payment, Receipt } from '@chateaux/services';
import { api } from '../../../app/api';
import { useDemo } from '../../../app/demo';
import { useAsync } from '../../../app/hooks';
import { ErrorState, Spinner } from '../../../components/ui';
import { useOT } from '../shared/i18n';
import { useCounterOffice } from '../shared/session';
import { BuyerCard, type DueItem } from './BuyerCard';
import { CounterReceipt } from './CounterReceipt';
import { OfficePanel } from './OfficePanel';
import { PayPanel } from './PayPanel';
import { SearchPanel } from './SearchPanel';

type Step =
  | { kind: 'search' }
  | { kind: 'card'; result: CounterSearchResult }
  | { kind: 'pay'; result: CounterSearchResult; item: DueItem }
  | { kind: 'receipt'; result: CounterSearchResult; item: DueItem; payment: Payment; receipt: Receipt };

export default function MostradorView() {
  const ot = useOT();
  const { version } = useDemo();
  const offices = useAsync(() => api.listOffices(), [version]);
  const [office, chooseOffice] = useCounterOffice(offices.data);
  const [step, setStep] = useState<Step>({ kind: 'search' });
  const [query, setQuery] = useState('');
  const [shiftKey, setShiftKey] = useState(0);

  const next = useCallback(() => {
    setQuery('');
    setStep({ kind: 'search' });
  }, []);

  return (
    <div data-testid="mostrador" className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(320px,26rem)]">
      <h2 className="sr-only">{ot('mostrador.heading')}</h2>
      <div className="min-w-0 space-y-4">
        {offices.status === 'error' && <ErrorState error={offices.error} onRetry={offices.reload} />}
        {step.kind === 'search' && <SearchPanel query={query} onQuery={setQuery} onPick={(result) => setStep({ kind: 'card', result })} />}
        {step.kind === 'card' && <BuyerCard result={step.result} office={office} onCharge={(item) => setStep({ kind: 'pay', result: step.result, item })} onBack={next} />}
        {step.kind === 'pay' && office && (
          <PayPanel
            result={step.result}
            item={step.item}
            office={office}
            onCancel={() => setStep({ kind: 'card', result: step.result })}
            onDone={({ payment, receipt }) => {
              setShiftKey((k) => k + 1);
              setStep({ kind: 'receipt', result: step.result, item: step.item, payment, receipt });
            }}
          />
        )}
        {step.kind === 'receipt' && office && <CounterReceipt result={step.result} item={step.item} payment={step.payment} receipt={step.receipt} office={office} onNext={next} />}
      </div>
      <aside aria-label={ot('mostrador.side')} className="space-y-4">
        {offices.loading && !offices.data ? <Spinner /> : <OfficePanel offices={offices.data ?? []} office={office} onChoose={chooseOffice} refreshKey={shiftKey} locked={step.kind === 'pay'} />}
      </aside>
    </div>
  );
}
