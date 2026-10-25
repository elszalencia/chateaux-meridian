// WhatsApp outbox: every message the system would send (the channel is simulated), newest first,
// with time, plan, template, the rendered text and its one deep link. Filterable by plan; the plan
// drawer reuses the list for one plan's history.

import { useState } from 'react';
import type { OutboxMessage, PlanRow } from '@casa-puente/services';
import { api } from '../../../../app/api';
import { useDemo } from '../../../../app/demo';
import { useFormat } from '../../../../app/format';
import { useAsync } from '../../../../app/hooks';
import { Badge, Card, EmptyState, ErrorState, Spinner } from '../../../../components/ui';
import { useOT } from '../../shared/i18n';
import { Simulado } from '../../shared/Simulado';

export function OutboxTab({ rows, refreshKey, onOpenPlan }: { rows: PlanRow[]; refreshKey: number; onOpenPlan: (id: string) => void }) {
  const ot = useOT();
  const { version } = useDemo();
  const [planId, setPlanId] = useState('');
  const outbox = useAsync(() => api.listOutbox(planId || undefined), [planId, version, refreshKey]);
  const names = new Map(rows.map((r) => [r.plan.id, r.buyer.name]));

  return (
    <Card title={ot('outbox.title')} actions={<Simulado />}>
      <p className="-mt-2 mb-4 text-sm text-ink-700">{ot('outbox.intro')}</p>
      <div className="mb-4">
        <label htmlFor="outbox-plan" className="block text-xs font-medium uppercase tracking-wide text-ink-500">
          {ot('outbox.filter')}
        </label>
        <select id="outbox-plan" data-testid="outbox-plan" value={planId} onChange={(e) => setPlanId(e.target.value)} className="mt-1 min-h-11 rounded-lg border border-ink-300 bg-white px-2 text-sm">
          <option value="">{ot('outbox.allPlans')}</option>
          {rows.map((r) => (
            <option key={r.plan.id} value={r.plan.id}>
              {r.buyer.name} · {r.plan.encargoRef}
            </option>
          ))}
        </select>
      </div>
      {outbox.loading && !outbox.data && <Spinner />}
      {outbox.status === 'error' && <ErrorState error={outbox.error} onRetry={outbox.reload} />}
      {outbox.data && <OutboxList messages={outbox.data} showPlan names={names} onOpenPlan={onOpenPlan} emptyTitle={ot('outbox.empty')} />}
    </Card>
  );
}

export function OutboxList({
  messages,
  showPlan,
  names,
  onOpenPlan,
  emptyTitle,
}: {
  messages: OutboxMessage[];
  showPlan: boolean;
  names?: Map<string, string>;
  onOpenPlan?: (id: string) => void;
  emptyTitle: string;
}) {
  const ot = useOT();
  const f = useFormat();
  if (messages.length === 0) return <EmptyState title={emptyTitle} body={ot('outbox.emptyBody')} />;
  return (
    <ul data-testid="outbox-list" className="space-y-3">
      {messages.map((m) => (
        <li key={m.id} data-testid={`outbox-${m.id}`} data-template={m.template} className="rounded-lg border border-ink-200 px-4 py-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex flex-wrap items-center gap-2">
              <Badge tone="info">{ot(`outbox.template.${m.template}`)}</Badge>
              <span className="text-ink-700">{f.dateTime(m.createdAt)}</span>
              {showPlan &&
                (onOpenPlan ? (
                  <button type="button" className="min-h-9 font-semibold text-brand-800 hover:underline" onClick={() => onOpenPlan(m.planId)}>
                    {names?.get(m.planId) ?? m.planId}
                  </button>
                ) : (
                  <span className="font-semibold">{names?.get(m.planId) ?? m.planId}</span>
                ))}
            </span>
            <span className="flex items-center gap-2 text-ink-700">
              {ot('outbox.to', { to: m.to, locale: m.locale.toUpperCase() })}
              {m.simulated && <Simulado />}
            </span>
          </div>
          <p className="mt-2 whitespace-pre-line text-ink-900">{m.body}</p>
          <p className="mt-1">
            <a href={m.link} className="font-semibold text-brand-800 underline">
              {ot('outbox.link', { link: m.link })}
            </a>
          </p>
        </li>
      ))}
    </ul>
  );
}