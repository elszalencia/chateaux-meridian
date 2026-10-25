// Pagos al vendedor: every release to a seller with its option (A: USDC held at the seller's
// provider, B: USD to the seller's bank through the simulated partner), its status and the
// reconciliation line, USD paid − fee = USD to seller, checked to the cent. A payout in error or held
// by the seller gate can be retried; when the gate still holds it, the typed reason is explained.

import { useState } from 'react';
import { CORRIDORS, type PayoutOption, type PayoutStatus, type PayoutView } from '@chateaux/services';
import { api } from '../../../../app/api';
import { useDemo } from '../../../../app/demo';
import { useFormat } from '../../../../app/format';
import { useAction, useAsync } from '../../../../app/hooks';
import { Badge, Button, Card, EmptyState, ErrorState, Spinner, Stat } from '../../../../components/ui';
import { useOT } from '../../shared/i18n';
import { useMoney } from '../../shared/money';
import { Simulado } from '../../shared/Simulado';
import { GateNote, PAYOUT_STATUSES, PayoutStatusBadge, gateReasonOf } from '../badges';

const RETRYABLE: PayoutStatus[] = ['error', 'retenido'];

export function PagosTab({ refreshKey, onChanged, onOpenPlan, onOpenSeller }: { refreshKey: number; onChanged: () => void; onOpenPlan: (id: string) => void; onOpenSeller: (id: string) => void }) {
  const ot = useOT();
  const money = useMoney();
  const { version } = useDemo();
  const payouts = useAsync(() => api.listPayouts(), [version, refreshKey]);
  const [status, setStatus] = useState<PayoutStatus | ''>('');
  const [option, setOption] = useState<PayoutOption | ''>('');
  const all = payouts.data ?? [];
  const shown = all.filter((p) => (!status || p.status === status) && (!option || p.option === option));
  const sum = (s: PayoutStatus[]) => all.filter((p) => s.includes(p.status)).length;

  return (
    <Card title={ot('pagos.title')} actions={<Simulado />}>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={ot('pagos.stat.total')} value={all.length} />
        <Stat label={ot('pagos.stat.inFlight')} value={sum(['enviado', 'en_transito'])} />
        <Stat label={ot('pagos.stat.attention')} value={sum(['error', 'retenido'])} />
        <Stat label={ot('pagos.stat.toSeller')} value={money.usd(all.filter((p) => p.status === 'acreditado' || p.status === 'transferido').reduce((a, p) => a + Math.round(p.usdToSeller * 100), 0) / 100)} />
      </div>
      <div className="mb-4 flex flex-wrap gap-3">
        <div>
          <label htmlFor="pagos-status" className="block text-xs font-medium uppercase tracking-wide text-ink-500">
            {ot('pagos.filter.status')}
          </label>
          <select id="pagos-status" data-testid="pagos-status" value={status} onChange={(e) => setStatus(e.target.value as PayoutStatus | '')} className="mt-1 min-h-11 rounded-lg border border-ink-300 bg-white px-2 text-sm">
            <option value="">{ot('planes.filter.all')}</option>
            {PAYOUT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {ot(`payoutStatus.${s}`)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="pagos-option" className="block text-xs font-medium uppercase tracking-wide text-ink-500">
            {ot('pagos.filter.option')}
          </label>
          <select id="pagos-option" data-testid="pagos-option" value={option} onChange={(e) => setOption(e.target.value as PayoutOption | '')} className="mt-1 min-h-11 rounded-lg border border-ink-300 bg-white px-2 text-sm">
            <option value="">{ot('planes.filter.all')}</option>
            {(['A', 'B'] as const).map((o) => (
              <option key={o} value={o}>
                {ot(`pagos.option.${o}`)}
              </option>
            ))}
          </select>
        </div>
      </div>
      {payouts.loading && !payouts.data && <Spinner />}
      {payouts.status === 'error' && <ErrorState error={payouts.error} onRetry={payouts.reload} />}
      {payouts.data && shown.length === 0 && <EmptyState title={ot(all.length ? 'pagos.emptyFiltered' : 'pagos.empty')} body={ot('pagos.emptyBody')} />}
      {shown.length > 0 && (
        <ul data-testid="payouts-list" className="divide-y divide-ink-100">
          {shown.map((p) => (
            <PayoutRow key={p.id} p={p} onChanged={onChanged} onOpenPlan={onOpenPlan} onOpenSeller={onOpenSeller} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function PayoutRow({ p, onChanged, onOpenPlan, onOpenSeller }: { p: PayoutView; onChanged: () => void; onOpenPlan: (id: string) => void; onOpenSeller: (id: string) => void }) {
  const ot = useOT();
  const f = useFormat();
  const money = useMoney();
  const retry = useAction(() => api.retryPayout(p.id));
  const gate = retry.status === 'error' ? gateReasonOf(retry.error) : null;
  const partner = CORRIDORS[p.corridor].partners.payoutPartner;

  return (
    <li data-testid={`payout-${p.id}`} data-status={p.status} className="grid gap-3 py-3 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1.6fr)_auto]">
      <div className="min-w-0 text-sm">
        <button type="button" className="min-h-9 text-left font-semibold text-brand-800 hover:underline" onClick={() => onOpenPlan(p.planId)}>
          {p.buyerName} · M{p.number}
        </button>
        <span className="block text-ink-700">{p.unitLabel}</span>
        <button type="button" className="min-h-9 text-left text-ink-700 underline-offset-2 hover:underline" onClick={() => onOpenSeller(p.sellerId)}>
          {p.sellerName}
        </button>
      </div>
      <div className="min-w-0 text-sm">
        <p data-testid="recon-line" data-reconciles={p.reconciles} className="tabular font-semibold text-ink-900">
          {ot('recon.line', { paid: money.usd(p.usdPaid), fee: money.usd(p.feeUsd), seller: money.usd(p.usdToSeller) })}{' '}
          <Badge tone={p.reconciles ? 'brand' : 'danger'}>{ot(p.reconciles ? 'recon.ok' : 'recon.mismatch')}</Badge>
        </p>
        <p className="mt-1 text-ink-700">
          {ot(`pagos.option.${p.option}`)}
          {p.option === 'B' && ` · ${ot('pagos.partner', { partner })}`}
          {p.partnerRef && ` · ${ot('pagos.ref', { ref: p.partnerRef })}`}
        </p>
        <p className="text-ink-700">
          {p.sentAt && ot('pagos.sentAt', { at: f.dateTime(p.sentAt) })}
          {p.expectedCreditDate && p.status !== 'acreditado' && ` · ${ot('pagos.expected', { date: f.date(p.expectedCreditDate) })}`}
          {p.creditedAt && ` · ${ot('pagos.creditedAt', { at: f.dateTime(p.creditedAt) })}`}
        </p>
        {p.status === 'error' && p.errorDetail && (
          <p data-testid="payout-error-detail" className="mt-1 text-danger-700">
            {ot('pagos.errorDetail', { detail: p.errorDetail })}
          </p>
        )}
        {p.status === 'retenido' && p.holdReason && (
          <div className="mt-2">
            <GateNote reason={p.holdReason} />
          </div>
        )}
      </div>
      <div className="flex flex-col items-start gap-2 lg:items-end">
        <PayoutStatusBadge status={p.status} />
        {RETRYABLE.includes(p.status) && (
          <Button
            label={ot('pagos.retry')}
            variant="secondary"
            size="sm"
            busy={retry.busy}
            data-testid={`payout-retry-${p.id}`}
            onClick={async () => {
              const r = await retry.run();
              if (r) onChanged();
            }}
          />
        )}
        {retry.status === 'success' && retry.result && (
          <p role="status" className="text-sm font-semibold text-brand-800">
            {ot('pagos.retried', { status: ot(`payoutStatus.${retry.result.status}`) })}
          </p>
        )}
      </div>
      {retry.status === 'error' && (
        <div className="lg:col-span-3" data-testid="payout-retry-error">
          {gate ? <GateNote reason={gate} testId="payout-retry-gate" /> : <ErrorState error={retry.error} compact />}
        </div>
      )}
    </li>
  );
}