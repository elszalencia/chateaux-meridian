// Counter search: one big field for a phone number or a name. It searches as the cashier types
// (250 ms pause), so the on-screen keyboard's "Buscar" key is optional. A phone number of seven or
// more digits that matches exactly one plan opens the buyer card straight away: the usual queue
// case costs no tap. Names always list, since a partial name often matches several people.

import { useEffect, useId, useRef, useState } from 'react';
import { CORRIDORS, digitsOf, type CounterSearchResult } from '@casa-puente/services';
import { api } from '../../../app/api';
import { useDemo } from '../../../app/demo';
import { useT } from '../../../app/i18n';
import { useAsync } from '../../../app/hooks';
import { ErrorState, SpinnerIcon } from '../../../components/ui';
import { useOT } from '../shared/i18n';
import { useMoney } from '../shared/money';

const DEBOUNCE_MS = 250;
const AUTO_OPEN_DIGITS = 7;

export function isPhoneQuery(q: string): boolean {
  const digits = digitsOf(q);
  return digits.length > 0 && digits.length === q.replace(/[\s()+-]/g, '').length;
}

export function SearchPanel({ query, onQuery, onPick }: { query: string; onQuery: (q: string) => void; onPick: (r: CounterSearchResult) => void }) {
  const t = useT();
  const ot = useOT();
  const money = useMoney();
  const { version } = useDemo();
  const inputId = useId();
  const hintId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [debounced, setDebounced] = useState(query.trim());

  useEffect(() => {
    input.current?.focus();
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [query]);

  const search = useAsync(() => (debounced ? api.searchBuyers(debounced) : Promise.resolve(null)), [debounced, version]);
  const results = search.data;

  useEffect(() => {
    if (search.status !== 'success' || !results || results.length !== 1) return;
    if (isPhoneQuery(debounced) && digitsOf(debounced).length >= AUTO_OPEN_DIGITS) onPick(results[0]!);
  }, [search.status, results, debounced, onPick]);

  const pending = query.trim() !== debounced || (search.loading && debounced !== '');

  return (
    <section aria-labelledby={inputId} className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setDebounced(query.trim());
        }}
      >
        <label htmlFor={inputId} className="block text-lg font-semibold text-ink-900">
          {ot('mostrador.search.label')}
        </label>
        <p id={hintId} className="mt-1 text-sm text-ink-700">
          {ot('mostrador.search.hint')}
        </p>
        <div className="mt-3 flex gap-3">
          <input
            ref={input}
            id={inputId}
            data-testid="counter-search"
            type="search"
            inputMode="search"
            autoComplete="off"
            aria-describedby={hintId}
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder={ot('mostrador.search.placeholder')}
            className="min-h-16 w-full min-w-0 rounded-xl border-2 border-ink-300 px-4 text-2xl text-ink-900 placeholder:text-ink-500 focus:border-brand-700"
          />
          {query && (
            <button
              type="button"
              data-testid="counter-search-clear"
              onClick={() => {
                onQuery('');
                input.current?.focus();
              }}
              className="min-h-16 min-w-16 rounded-xl border-2 border-ink-300 bg-white px-4 text-lg font-semibold text-ink-700"
            >
              {ot('mostrador.search.clear')}
            </button>
          )}
        </div>
      </form>

      <div className="mt-4" aria-live="polite" data-testid="counter-results">
        {pending && (
          <p role="status" className="flex items-center gap-2 text-ink-700">
            <SpinnerIcon className="h-5 w-5" />
            {ot('mostrador.search.searching')}
          </p>
        )}
        {!pending && search.status === 'error' && <ErrorState error={search.error} onRetry={search.reload} />}
        {!pending && !debounced && <p className="text-ink-700">{ot('mostrador.search.idle')}</p>}
        {!pending && search.status === 'success' && results && results.length === 0 && (
          <div data-testid="counter-empty" className="rounded-xl border border-dashed border-ink-300 bg-ink-50 px-5 py-6 text-center">
            <p className="text-lg font-semibold text-ink-900">{ot('mostrador.search.emptyTitle', { query: debounced })}</p>
            <p className="mt-1 text-ink-700">{ot('mostrador.search.emptyBody')}</p>
          </div>
        )}
        {!pending && results && results.length > 0 && (
          <ul className="space-y-3">
            {results.map((r) => {
              const first = r.due[0];
              return (
                <li key={r.plan.id}>
                  <button
                    type="button"
                    data-testid={`counter-result-${r.plan.id}`}
                    onClick={() => onPick(r)}
                    className="flex min-h-16 w-full flex-wrap items-center justify-between gap-3 rounded-xl border-2 border-ink-200 bg-white px-4 py-3 text-left active:border-brand-700 active:bg-brand-50"
                  >
                    <span className="min-w-0">
                      <span className="block text-lg font-semibold text-ink-900">{r.buyer.name}</span>
                      <span className="block text-sm text-ink-700">
                        {r.buyer.phone} · {r.unitLabel} · {t(CORRIDORS[r.corridor].nameKey)}
                      </span>
                    </span>
                    <span className="text-right text-base font-semibold text-ink-900">
                      {r.fundsBlocked
                        ? ot('mostrador.search.blocked')
                        : first
                          ? ot('mostrador.search.dueCount', { count: r.due.length, amount: money.usd(first.usdDue) })
                          : ot('mostrador.search.nothingDue')}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
