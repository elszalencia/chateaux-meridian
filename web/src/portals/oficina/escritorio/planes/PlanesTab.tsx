// Planes: every plan the desk follows, filterable by corridor, seller, status and next due date
// ("vence hasta"). A row opens the plan drawer; each row's first cell is a real button so the table
// is keyboard reachable without hijacking row clicks.

import { useId, useMemo, useState, type ReactNode } from 'react';
import { CORRIDOR_IDS, CORRIDORS, compareISO, type CorridorId, type PlanDeskStatus, type PlanRow } from '@chateaux/services';
import { useFormat } from '../../../../app/format';
import { useT } from '../../../../app/i18n';
import type { AsyncState } from '../../../../app/hooks';
import { Badge, Card, EmptyState, ErrorState, Spinner } from '../../../../components/ui';
import { useOT } from '../../shared/i18n';
import { useMoney } from '../../shared/money';
import { PLAN_STATUSES, PlanStatusBadge } from '../badges';

export interface PlanFilters {
  corridor: CorridorId | '';
  seller: string;
  status: PlanDeskStatus | '';
  dueBy: string;
}

export const NO_FILTERS: PlanFilters = { corridor: '', seller: '', status: '', dueBy: '' };

export function filterPlans(rows: PlanRow[], f: PlanFilters): PlanRow[] {
  return rows.filter(
    (r) =>
      (!f.corridor || r.corridor === f.corridor) &&
      (!f.seller || (r.sellerName ?? '') === f.seller) &&
      (!f.status || r.status === f.status) &&
      (!f.dueBy || (r.nextDueDate != null && compareISO(r.nextDueDate, f.dueBy) <= 0)),
  );
}

export function PlanesTab({ rows, onOpen }: { rows: AsyncState<PlanRow[]>; onOpen: (planId: string) => void }) {
  const t = useT();
  const ot = useOT();
  const f = useFormat();
  const money = useMoney();
  const id = useId();
  const [filters, setFilters] = useState<PlanFilters>(NO_FILTERS);
  const all = rows.data ?? [];
  const sellers = useMemo(() => [...new Set(all.map((r) => r.sellerName).filter((s): s is string => !!s))].sort(), [all]);
  const shown = useMemo(() => filterPlans(all, filters), [all, filters]);
  const set = <K extends keyof PlanFilters>(k: K, v: PlanFilters[K]) => setFilters((x) => ({ ...x, [k]: v }));
  const filtered = Object.values(filters).some(Boolean);

  return (
    <Card title={ot('planes.title')} actions={<span className="text-sm text-ink-700">{ot('planes.count', { shown: shown.length, total: all.length })}</span>}>
      <form role="search" aria-label={ot('planes.filters')} className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5" onSubmit={(e) => e.preventDefault()}>
        <Select id={`${id}-c`} label={ot('planes.filter.corridor')} value={filters.corridor} onChange={(v) => set('corridor', v as CorridorId | '')} testId="filter-corridor">
          <option value="">{ot('planes.filter.all')}</option>
          {CORRIDOR_IDS.map((c) => (
            <option key={c} value={c}>
              {t(CORRIDORS[c].nameKey)}
            </option>
          ))}
        </Select>
        <Select id={`${id}-s`} label={ot('planes.filter.seller')} value={filters.seller} onChange={(v) => set('seller', v)} testId="filter-seller">
          <option value="">{ot('planes.filter.all')}</option>
          {sellers.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
        <Select id={`${id}-st`} label={ot('planes.filter.status')} value={filters.status} onChange={(v) => set('status', v as PlanDeskStatus | '')} testId="filter-status">
          <option value="">{ot('planes.filter.all')}</option>
          {PLAN_STATUSES.map((s) => (
            <option key={s} value={s}>
              {ot(`planStatus.${s}`)}
            </option>
          ))}
        </Select>
        <div>
          <label htmlFor={`${id}-d`} className="block text-xs font-medium uppercase tracking-wide text-ink-500">
            {ot('planes.filter.dueBy')}
          </label>
          <input id={`${id}-d`} type="date" data-testid="filter-due" value={filters.dueBy} onChange={(e) => set('dueBy', e.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-ink-300 bg-white px-2 text-sm" />
        </div>
        <div className="flex items-end">
          <button type="button" data-testid="filter-clear" disabled={!filtered} onClick={() => setFilters(NO_FILTERS)} className="min-h-11 rounded-lg px-3 text-sm font-semibold text-brand-800 hover:bg-brand-50 disabled:text-ink-500">
            {ot('planes.filter.clear')}
          </button>
        </div>
      </form>

      {rows.loading && !rows.data && <Spinner />}
      {rows.status === 'error' && <ErrorState error={rows.error} onRetry={rows.reload} />}
      {rows.data && shown.length === 0 && <EmptyState title={ot(filtered ? 'planes.emptyFiltered' : 'planes.empty')} body={ot(filtered ? 'planes.emptyFilteredBody' : 'planes.emptyBody')} />}
      {shown.length > 0 && (
        <div className="overflow-x-auto">
          <table data-testid="plans-table" className="w-full text-left text-sm">
            <caption className="sr-only">{ot('planes.caption')}</caption>
            <thead className="border-b border-ink-200 text-xs uppercase tracking-wide text-ink-500">
              <tr>
                <th scope="col" className="py-2 pr-3">{ot('planes.col.buyer')}</th>
                <th scope="col" className="py-2 pr-3">{ot('planes.col.unit')}</th>
                <th scope="col" className="py-2 pr-3">{ot('planes.col.corridor')}</th>
                <th scope="col" className="py-2 pr-3">{ot('planes.col.seller')}</th>
                <th scope="col" className="py-2 pr-3">{ot('planes.col.status')}</th>
                <th scope="col" className="py-2 pr-3">{ot('planes.col.paid')}</th>
                <th scope="col" className="py-2 pr-3">{ot('planes.col.nextDue')}</th>
                <th scope="col" className="py-2 text-right">{ot('planes.col.nextAmount')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.plan.id} data-testid={`plan-row-${r.plan.id}`} data-status={r.status} className="cursor-pointer border-b border-ink-100 hover:bg-ink-50" onClick={() => onOpen(r.plan.id)}>
                  <td className="py-2 pr-3">
                    <button
                      type="button"
                      data-testid={`plan-open-${r.plan.id}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpen(r.plan.id);
                      }}
                      className="min-h-9 rounded text-left font-semibold text-brand-800 underline-offset-2 hover:underline"
                    >
                      {r.buyer.name}
                    </button>
                    <span className="block text-xs text-ink-700">{r.plan.encargoRef}</span>
                  </td>
                  <td className="py-2 pr-3">
                    {r.unit.unitName} {r.unit.unitCode}
                    <span className="block text-xs text-ink-700">{r.unit.project}</span>
                  </td>
                  <td className="py-2 pr-3">
                    <Badge tone="neutral">{t(CORRIDORS[r.corridor].nameKey)}</Badge>
                  </td>
                  <td className="py-2 pr-3">{r.sellerName ?? <span className="text-ink-700">{t(CORRIDORS[r.corridor].payoutTargetKey)}</span>}</td>
                  <td className="py-2 pr-3">
                    <PlanStatusBadge status={r.status} />
                    {r.lateCount > 0 && <span className="block text-xs text-ink-700">{ot('planes.lateCount', { count: r.lateCount })}</span>}
                  </td>
                  <td className="tabular py-2 pr-3">
                    {r.paidCount}/{r.plan.installmentsCount}
                  </td>
                  <td className="py-2 pr-3">{r.nextDueDate ? f.date(r.nextDueDate) : '—'}</td>
                  <td className="tabular py-2 text-right">{r.nextUsd != null ? money.usd(r.nextUsd) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Select({ id, label, value, onChange, children, testId }: { id: string; label: string; value: string; onChange: (v: string) => void; children: ReactNode; testId: string }) {
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium uppercase tracking-wide text-ink-500">
        {label}
      </label>
      <select id={id} data-testid={testId} value={value} onChange={(e) => onChange(e.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-ink-300 bg-white px-2 text-sm">
        {children}
      </select>
    </div>
  );
}
