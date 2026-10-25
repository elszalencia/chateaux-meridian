// Plan drawer: the plan at a glance (buyer, unit, corridor, seller and its gate), the schedule, the
// payment attempts (cash references pending, expired or blocked included), the releases to the
// seller, the adverse-event actions and the WhatsApp history of this plan. The Colombia views open
// from here only when the plan's corridor has them (config `views`).

import { CORRIDORS, type InstallmentView, type OutboxMessage, type Payment, type PayoutView, type PlanView } from '@casa-puente/services';
import { api } from '../../../../app/api';
import { useDemo } from '../../../../app/demo';
import { useFormat } from '../../../../app/format';
import { useT } from '../../../../app/i18n';
import { useAsync } from '../../../../app/hooks';
import { Badge, Button, EmptyState, ErrorState, Spinner } from '../../../../components/ui';
import { Drawer, DrawerSection, Facts } from '../../shared/Drawer';
import { useOT } from '../../shared/i18n';
import { useMoney } from '../../shared/money';
import { minutesSince, useSessionNow } from '../../shared/session';
import { Simulado } from '../../shared/Simulado';
import { GateNote, PayoutStatusBadge, PlanStatusBadge } from '../badges';
import type { DeskTab } from '../EscritorioView';
import { OutboxList } from '../outbox/OutboxTab';
import { AdverseActions } from './AdverseActions';

interface PlanDetail {
  view: PlanView;
  status: Awaited<ReturnType<typeof api.listPlanRows>>[number]['status'] | null;
  payments: Payment[];
  payouts: PayoutView[];
  outbox: OutboxMessage[];
}

async function loadPlan(planId: string): Promise<PlanDetail> {
  const [view, rows, payments, payouts, outbox] = await Promise.all([api.getPlan(planId), api.listPlanRows(), api.listPayments({ planId }), api.listPayouts({ planId }), api.listOutbox(planId)]);
  return { view, status: rows.find((r) => r.plan.id === planId)?.status ?? null, payments, payouts, outbox };
}

export function PlanDrawer({
  planId,
  onClose,
  onChanged,
  onOpenSeller,
  onOpenTab,
  refreshKey,
}: {
  planId: string;
  onClose: () => void;
  onChanged: () => void;
  onOpenSeller: (id: string) => void;
  onOpenTab: (t: DeskTab) => void;
  refreshKey: number;
}) {
  const t = useT();
  const ot = useOT();
  const { version } = useDemo();
  const detail = useAsync(() => loadPlan(planId), [planId, version, refreshKey]);
  const d = detail.data;
  const pv = d?.view;
  const c = pv ? CORRIDORS[pv.corridor] : null;

  return (
    <Drawer
      title={pv ? pv.buyer.name : ot('planes.drawer.loading')}
      subtitle={
        pv && c ? (
          <span className="flex flex-wrap items-center gap-2">
            <span>
              {pv.plan.encargoRef} · {pv.unit.unitName} {pv.unit.unitCode} · {pv.unit.project}
            </span>
            <Badge tone="neutral">{t(c.nameKey)}</Badge>
            {d?.status && <PlanStatusBadge status={d.status} />}
          </span>
        ) : undefined
      }
      onClose={onClose}
      labelClose={ot('drawer.close')}
      testId="plan-drawer"
    >
      {detail.loading && !d && <Spinner />}
      {detail.status === 'error' && <ErrorState error={detail.error} onRetry={detail.reload} />}
      {pv && c && d && (
        <>
          <DrawerSection title={ot('planes.drawer.summary')}>
            <Facts
              items={[
                { label: ot('planes.drawer.buyerContact'), value: `${pv.buyer.phone} · ${pv.buyer.city}, ${pv.buyer.state}` },
                { label: ot('planes.drawer.paid'), value: ot('planes.drawer.paidValue', { paid: pv.summary.paidCount, total: pv.plan.installmentsCount }) },
                { label: ot('planes.drawer.installment'), value: <PlanMoney minor={pv.plan.installmentCop} pv={pv} /> },
                { label: ot('planes.drawer.downPayment'), value: <PlanMoney minor={pv.plan.downPaymentCop} pv={pv} /> },
                { label: ot('planes.drawer.governance'), value: `${ot(`governance.${pv.governance.state}`)}${pv.governance.reasonKey !== 'none' ? ` · ${t(`reasons.${pv.governance.reasonKey}`)}` : ''}` },
                { label: t(c.payoutTargetKey), value: pv.plan.trustCompany },
              ]}
            />
            {pv.seller && (
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <Button label={ot('planes.drawer.openSeller', { name: pv.seller.tradeName })} variant="secondary" size="sm" onClick={() => onOpenSeller(pv.seller!.id)} data-testid="plan-open-seller" />
              </div>
            )}
            {pv.seller?.gate && (
              <div className="mt-3">
                <GateNote reason={pv.seller.gate} testId="plan-gate" />
              </div>
            )}
            {(c.views.constructora || c.views.tesoreria) && (
              <div className="mt-3 flex flex-wrap gap-2" data-testid="plan-corridor-views">
                {c.views.constructora && <Button label={ot('planes.drawer.openConstructora')} variant="secondary" size="sm" onClick={() => onOpenTab('constructora')} />}
                {c.views.tesoreria && <Button label={ot('planes.drawer.openTesoreria')} variant="secondary" size="sm" onClick={() => onOpenTab('tesoreria')} />}
              </div>
            )}
          </DrawerSection>

          <AdverseActions pv={pv} onDone={() => { detail.reload(); onChanged(); }} />

          <DrawerSection title={ot('planes.drawer.schedule')} testId="plan-schedule">
            <Schedule pv={pv} />
          </DrawerSection>

          <DrawerSection title={ot('planes.drawer.payments')} testId="plan-payments">
            <PaymentsList payments={d.payments} pv={pv} />
          </DrawerSection>

          {c.payoutProviders.some((p) => p !== 'sep31-receiver') && (
            <DrawerSection title={ot('planes.drawer.payouts')} testId="plan-payouts">
              <PlanPayouts payouts={d.payouts} />
            </DrawerSection>
          )}

          <DrawerSection title={ot('planes.drawer.whatsapp')} testId="plan-whatsapp" actions={<Simulado />}>
            <OutboxList messages={d.outbox} showPlan={false} emptyTitle={ot('outbox.emptyPlan')} />
          </DrawerSection>
        </>
      )}
    </Drawer>
  );
}

function PlanMoney({ minor, pv }: { minor: number; pv: PlanView }) {
  const money = useMoney();
  return <>{money.planMinor(minor, pv.corridor)}</>;
}

function Schedule({ pv }: { pv: PlanView }) {
  const ot = useOT();
  const f = useFormat();
  const money = useMoney();
  const flag = (i: InstallmentView) =>
    i.lateInGrace ? <Badge tone="warn">{ot('planes.drawer.lateInGrace')}</Badge> : i.isLate && i.status !== 'missed' ? <Badge tone="danger">{ot('planes.drawer.late', { days: i.businessDaysLate })}</Badge> : null;
  return (
    <div className="max-h-80 overflow-y-auto rounded-lg border border-ink-200">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{ot('planes.drawer.schedule')}</caption>
        <thead className="sticky top-0 bg-ink-50 text-xs uppercase tracking-wide text-ink-500">
          <tr>
            <th scope="col" className="px-3 py-2">{ot('planes.drawer.col.n')}</th>
            <th scope="col" className="px-3 py-2">{ot('planes.drawer.col.due')}</th>
            <th scope="col" className="px-3 py-2 text-right">{ot('planes.drawer.col.amount')}</th>
            <th scope="col" className="px-3 py-2">{ot('planes.drawer.col.state')}</th>
          </tr>
        </thead>
        <tbody>
          {pv.installments.map((i) => (
            <tr key={i.idx} data-testid={`schedule-row-${i.idx}`} data-state={i.cellState} className="border-t border-ink-100">
              <td className="px-3 py-1.5 font-semibold">M{i.number}</td>
              <td className="px-3 py-1.5">{f.date(i.dueDate)}</td>
              <td className="tabular px-3 py-1.5 text-right">{money.planMinor(i.copDue, pv.corridor)}</td>
              <td className="px-3 py-1.5">
                <span className="mr-2">{ot(`cell.${i.cellState}`)}</span>
                {flag(i)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PaymentsList({ payments, pv }: { payments: Payment[]; pv: PlanView }) {
  const ot = useOT();
  const f = useFormat();
  const money = useMoney();
  const { state } = useDemo();
  const now = useSessionNow(state?.today);
  const mg = CORRIDORS[pv.corridor].moneyGram;
  if (payments.length === 0) return <EmptyState title={ot('planes.drawer.noPayments')} body={ot('planes.drawer.noPaymentsBody')} />;
  return (
    <ul className="space-y-2">
      {payments.map((p) => {
        const pendingMin = p.status === 'pending' && now != null ? minutesSince(p.createdAt, now) : null;
        return (
          <li key={p.id} data-testid={`payment-${p.id}`} data-status={p.status} className="rounded-lg border border-ink-200 px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold text-ink-900">
                M{p.idx + 1} · {ot(`method.${p.method}`)} {p.method === 'moneygram_cash' && <Simulado className="ml-1" />}
              </span>
              <Badge tone={p.status === 'completed' ? 'brand' : p.status === 'pending' ? 'info' : p.status === 'blocked' || p.status === 'error' ? 'danger' : 'neutral'}>{ot(`paymentStatus.${p.status}`)}</Badge>
            </div>
            <p className="mt-1 text-ink-700">
              {money.planMinor(p.amount + p.fee, pv.corridor)}
              {p.fee > 0 && ` (${ot('planes.drawer.feeIncl', { fee: money.planMinor(p.fee, pv.corridor) })})`} · {f.dateTime(p.receivedAt ?? p.createdAt)}
              {p.externalRef && ` · ${ot('planes.drawer.ref', { ref: p.externalRef })}`}
            </p>
            {p.blockedReason && <p className="mt-1 text-danger-700">{ot(`blockReason.${p.blockedReason}`, { max: mg ? money.usd(mg.maxUsd) : '' })}</p>}
            {p.status === 'quote_expired' && p.expiresAt && <p className="mt-1 text-ink-700">{ot('planes.drawer.expiredAt', { at: f.dateTime(p.expiresAt) })}</p>}
            {pendingMin != null && mg && (
              <p className={`mt-1 ${pendingMin >= mg.pendingAlertMinutes ? 'font-semibold text-warn-700' : 'text-ink-700'}`} data-testid={pendingMin >= mg.pendingAlertMinutes ? 'payment-pending-long' : undefined}>
                {ot(pendingMin >= mg.pendingAlertMinutes ? 'planes.drawer.pendingLong' : 'planes.drawer.pendingShort', { minutes: pendingMin })}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function PlanPayouts({ payouts }: { payouts: PayoutView[] }) {
  const ot = useOT();
  const money = useMoney();
  if (payouts.length === 0) return <EmptyState title={ot('planes.drawer.noPayouts')} />;
  return (
    <ul className="space-y-2">
      {payouts.map((p) => (
        <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-ink-200 px-3 py-2 text-sm">
          <span className="font-semibold">M{p.number}</span>
          <span className="tabular text-ink-700">{ot('recon.line', { paid: money.usd(p.usdPaid), fee: money.usd(p.feeUsd), seller: money.usd(p.usdToSeller) })}</span>
          <PayoutStatusBadge status={p.status} />
        </li>
      ))}
    </ul>
  );
}
