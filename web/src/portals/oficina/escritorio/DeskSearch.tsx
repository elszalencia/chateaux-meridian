// Desk search (Ctrl+K): one combobox over plans (buyer, plan reference, phone) and sellers. Arrow
// keys move through the matches, Enter opens the drawer, Esc clears the field.

import { useId, useMemo, useState, type KeyboardEvent, type RefObject } from 'react';
import { digitsOf, normalizeName, type PlanRow, type SellerView } from '@casa-puente/services';
import { useOT } from '../shared/i18n';

type Hit = { kind: 'plan'; id: string; title: string; detail: string } | { kind: 'seller'; id: string; title: string; detail: string };

const MAX_HITS = 8;

export function deskMatches(query: string, rows: PlanRow[], sellers: SellerView[]): Hit[] {
  const q = normalizeName(query);
  if (!q) return [];
  const digits = digitsOf(query);
  const phoneLike = digits.length >= 3 && digits.length === query.replace(/[\s()+-]/g, '').length;
  const plans: Hit[] = rows
    .filter((r) => (phoneLike ? digitsOf(r.buyer.phone).includes(digits) : normalizeName(`${r.buyer.name} ${r.plan.encargoRef} ${r.plan.id}`).includes(q)))
    .map((r) => ({ kind: 'plan', id: r.plan.id, title: r.buyer.name, detail: `${r.plan.encargoRef} · ${r.unit.unitName} ${r.unit.unitCode}` }));
  const sellerHits: Hit[] = phoneLike
    ? []
    : sellers.filter((s) => normalizeName(`${s.tradeName} ${s.legalName}`).includes(q)).map((s) => ({ kind: 'seller', id: s.id, title: s.tradeName, detail: s.legalName }));
  return [...plans, ...sellerHits].slice(0, MAX_HITS);
}

export function DeskSearch({
  inputRef,
  rows,
  sellers,
  onPlan,
  onSeller,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  rows: PlanRow[];
  sellers: SellerView[];
  onPlan: (id: string) => void;
  onSeller: (id: string) => void;
}) {
  const ot = useOT();
  const id = useId();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const hits = useMemo(() => deskMatches(query, rows, sellers), [query, rows, sellers]);
  const open = query.trim() !== '';

  const choose = (h: Hit) => {
    setQuery('');
    if (h.kind === 'plan') onPlan(h.id);
    else onSeller(h.id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && hits.length) {
      e.preventDefault();
      setActive((a) => (a + 1) % hits.length);
    } else if (e.key === 'ArrowUp' && hits.length) {
      e.preventDefault();
      setActive((a) => (a - 1 + hits.length) % hits.length);
    } else if (e.key === 'Enter' && hits[active]) {
      e.preventDefault();
      choose(hits[active]!);
    } else if (e.key === 'Escape') {
      setQuery('');
    }
  };

  return (
    <div className="relative w-full max-w-md">
      <label htmlFor={`${id}-input`} className="block text-xs font-medium uppercase tracking-wide text-ink-500">
        {ot('escritorio.search.label')}
      </label>
      <input
        ref={inputRef}
        id={`${id}-input`}
        data-testid="desk-search"
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={open && hits[active] ? `${id}-opt-${active}` : undefined}
        autoComplete="off"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        placeholder={ot('escritorio.search.placeholder')}
        className="mt-1 min-h-11 w-full rounded-lg border border-ink-300 bg-white px-3 text-sm text-ink-900 placeholder:text-ink-500"
      />
      {open && (
        <ul id={`${id}-list`} role="listbox" aria-label={ot('escritorio.search.results')} className="absolute right-0 z-20 mt-1 max-h-96 w-full overflow-y-auto rounded-lg border border-ink-200 bg-white py-1 shadow-lg">
          {hits.length === 0 && (
            <li role="option" aria-selected={false} aria-disabled="true" className="px-3 py-2 text-sm text-ink-700">
              {ot('escritorio.search.none', { query: query.trim() })}
            </li>
          )}
          {hits.map((h, i) => (
            <li
              key={`${h.kind}-${h.id}`}
              id={`${id}-opt-${i}`}
              role="option"
              aria-selected={i === active}
              data-testid={`desk-hit-${h.kind}-${h.id}`}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(h);
              }}
              className={`cursor-pointer px-3 py-2 text-sm ${i === active ? 'bg-brand-50' : ''}`}
            >
              <span className="font-semibold text-ink-900">{h.title}</span>
              <span className="ml-2 text-xs text-ink-700">{ot(`escritorio.search.kind.${h.kind}`)}</span>
              <span className="block text-xs text-ink-700">{h.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
