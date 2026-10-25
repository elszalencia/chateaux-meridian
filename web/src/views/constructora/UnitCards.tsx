// Unit cards: one card per payment plan with the facts sales and the trust company ask for first
// (who, which unit, which encargo) and a segmented schedule bar that reuses the calendar colours
// (pagado = emerald, bloqueado = solid brand, roto = amber, abierto = neutral). Counts sit under the
// bar in a fixed grid so the three cards line up and can be compared at a glance. Adverse events:
// the header badge shows the plan state when it is not "al día", a short block gives the reason in
// plain language and any money held or refunded, and "Novedades" lists the last three policy events
// (every rule is still "política pendiente"; record-only events are marked as such).

import type { PlanState, UnitSummary } from '@casa-puente/services';
import { useFormat } from '../../app/format';
import { useT } from '../../app/i18n';
import { Badge, EmptyState, type Tone } from '../../components/ui';

const STATE_TONE: Record<PlanState, Tone> = {
  active: 'brand',
  delinquent: 'warn',
  defaulted: 'danger',
  on_hold: 'info',
  cancelled: 'neutral',
  completed: 'brand',
};

export function UnitCards({ units }: { units: UnitSummary[] }) {
  const t = useT();
  if (units.length === 0) return <EmptyState title={t('constructora.units.empty')} />;
  return (
    <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {units.map((u) => (
        <UnitCard key={u.plan.id} summary={u} />
      ))}
    </ul>
  );
}

function UnitCard({ summary: s }: { summary: UnitSummary }) {
  const t = useT();
  const f = useFormat();
  const total = s.plan.installmentsCount;
  const noLocks = s.lockedCount === 0 && s.brokenCount === 0;
  const g = s.governance;
  const adverse = g.state !== 'active';
  const unitLabel = `${s.unit.unitName} ${s.unit.unitCode}`;
  const segments: { key: string; count: number; className: string; label: string }[] = [
    { key: 'paid', count: s.paidCount, className: 'bg-brand-500', label: t('constructora.units.paid') },
    { key: 'locked', count: s.lockedCount, className: 'bg-brand-800', label: t('constructora.units.locked') },
    { key: 'broken', count: s.brokenCount, className: 'bg-warn-500', label: t('constructora.units.broken') },
    { key: 'missed', count: s.missedCount, className: 'bg-danger-600', label: t('constructora.units.missed') },
    { key: 'waived', count: s.waivedCount, className: 'bg-ink-500', label: t('constructora.units.waived') },
    { key: 'open', count: s.openCount, className: 'bg-ink-200', label: t('constructora.units.open') },
  ];
  const scheduleAria = t('constructora.units.scheduleAria', {
    paid: s.paidCount,
    locked: s.lockedCount,
    broken: s.brokenCount,
    missed: s.missedCount,
    waived: s.waivedCount,
    open: s.openCount,
    total,
  });

  return (
    <li
      data-testid={`unit-card-${s.plan.id}`}
      aria-label={t('constructora.units.cardAria', { unit: unitLabel, project: s.unit.project, buyer: s.buyer.name })}
      className="flex flex-col gap-4 rounded-xl border border-ink-200 bg-ink-50 p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-lg font-semibold text-ink-900">{unitLabel}</p>
          <p className="text-sm text-ink-700">
            {s.unit.project} · {s.unit.city}
          </p>
        </div>
        {adverse ? (
          <span data-testid={`plan-state-${s.plan.id}`} data-state={g.state}>
            <Badge tone={STATE_TONE[g.state]}>{t('states.plan.' + g.state)}</Badge>
          </span>
        ) : noLocks ? (
          <span title={t('constructora.units.noLocksHint')}>
            <Badge tone="neutral">{t('constructora.units.noLocks')}</Badge>
          </span>
        ) : s.brokenCount > 0 ? (
          <Badge tone="warn">{t('states.roto')}</Badge>
        ) : (
          <Badge tone="brand">{t('states.bloqueado')}</Badge>
        )}
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-ink-500">{t('constructora.units.buyer')}</dt>
        <dd className="text-ink-900">
          {s.buyer.name} · {s.buyer.city}
        </dd>
        <dt className="text-ink-500">{t('constructora.units.encargo')}</dt>
        <dd className="font-mono text-ink-900">
          {s.plan.encargoRef} · {s.plan.trustCompany}
        </dd>
        <dt className="text-ink-500">{t('constructora.units.price')}</dt>
        <dd className="tabular text-ink-900">{f.cop(s.unit.priceCop)}</dd>
        {adverse && (
          <>
            <dt className="text-ink-500">{t('constructora.units.planState')}</dt>
            <dd className="text-ink-900">
              {t('states.plan.' + g.state)}
              {g.since && <span className="text-ink-700"> · {t('constructora.units.since', { date: f.date(g.since) })}</span>}
            </dd>
            <dt className="text-ink-500">{t('constructora.units.reason')}</dt>
            <dd data-testid={`plan-reason-${s.plan.id}`} className="text-ink-900">
              {t('reasons.' + g.reasonKey)}
            </dd>
          </>
        )}
        {g.heldUsd > 0 && (
          <>
            <dt className="text-ink-500">{t('constructora.units.held')}</dt>
            <dd className="tabular text-ink-900">{f.usd(g.heldUsd)}</dd>
          </>
        )}
        {g.refundedUsd > 0 && (
          <>
            <dt className="text-ink-500">{t('constructora.units.refunded')}</dt>
            <dd className="tabular text-ink-900">{f.usd(g.refundedUsd)}</dd>
          </>
        )}
      </dl>

      <div>
        <p className="mb-1 flex items-center justify-between text-xs font-medium uppercase tracking-wide text-ink-500">
          <span>{t('constructora.units.schedule', { total })}</span>
          {s.lateCount > 0 && <Badge tone="danger">{`${t('constructora.units.late')}: ${s.lateCount}`}</Badge>}
        </p>
        <div role="img" aria-label={scheduleAria} title={scheduleAria} className="flex h-3 w-full overflow-hidden rounded-full bg-ink-200">
          {segments
            .filter((seg) => seg.count > 0)
            .map((seg) => (
              <span key={seg.key} className={`h-full ${seg.className}`} style={{ width: `${(seg.count / total) * 100}%` }} />
            ))}
        </div>
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-700">
          {segments
            .filter((seg) => seg.count > 0 || !['missed', 'waived'].includes(seg.key))
            .map((seg) => (
              <li key={seg.key} className="flex items-center gap-1.5">
                <span aria-hidden="true" className={`inline-block h-2.5 w-2.5 rounded-sm ${seg.className}`} />
                {seg.label} <span className="tabular font-semibold text-ink-900">{seg.count}</span>
              </li>
            ))}
        </ul>
      </div>

      <dl className="grid grid-cols-3 gap-3 border-t border-ink-200 pt-3 text-sm">
        <div>
          <dt className="text-xs text-ink-500">{t('constructora.units.paid')}</dt>
          <dd className="tabular font-semibold text-ink-900">{t('constructora.units.countOf', { n: s.paidCount, total })}</dd>
          <dd className="tabular text-xs text-ink-700">{f.cop(s.paidCop)}</dd>
        </div>
        <div title={t('constructora.units.dueHint')}>
          <dt className="text-xs text-ink-500">{t('constructora.units.due')}</dt>
          <dd className="tabular font-semibold text-ink-900">{t('constructora.units.countOf', { n: s.dueCount, total })}</dd>
          <dd className="tabular text-xs text-ink-700">{f.cop(s.dueCop)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-500">{t('constructora.units.nextDue')}</dt>
          <dd className="tabular font-semibold text-ink-900">{s.nextDueDate ? f.date(s.nextDueDate) : t('constructora.units.noNextDue')}</dd>
        </div>
      </dl>

      {g.events.length > 0 && (
        <div className="border-t border-ink-200 pt-3">
          <p className="mb-1 flex items-center justify-between text-xs font-medium uppercase tracking-wide text-ink-500">
            <span>{t('constructora.units.events')}</span>
            <span className="normal-case tracking-normal">{t('constructora.units.policyPending')}</span>
          </p>
          <ul data-testid={`plan-events-${s.plan.id}`} className="space-y-1 text-sm">
            {g.events.slice(0, 3).map((e) => (
              <li key={e.id} data-kind={e.kind} className="flex flex-wrap items-baseline gap-x-2">
                <span className="tabular text-xs text-ink-500">{f.date(e.at)}</span>
                <span className="font-medium text-ink-900">
                  {e.installmentNumber != null ? t('constructora.units.eventLine', { event: t('constructora.events.' + e.kind), n: e.installmentNumber }) : t('constructora.events.' + e.kind)}
                </span>
                <span className="text-xs text-ink-700">{t('reasons.' + e.reasonKey)}</span>
                {!e.executed && <span className="text-xs text-ink-500">({t('constructora.units.recordOnly')})</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}
