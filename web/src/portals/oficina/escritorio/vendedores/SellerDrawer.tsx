// Seller drawer: verification state and what it means for releases (the gate, explained), company
// data, legal representative, the title check per unit (CNR registry number, certificate date and
// hash, lien alert), the payout option and account, the payout-account change with its 72 h
// cooling-off ("Cambio en espera"), and the seller's plans. Rejecting a seller is final and confirms
// in a modal; every other action runs from the drawer.

import { useId, useState, type FormEvent } from 'react';
import { CORRIDORS, PAYOUT_CHANGE_COOLING_OFF_HOURS, type PayoutAccount, type PlanRow, type SellerView } from '@chateaux/services';
import { api } from '../../../../app/api';
import { useDemo } from '../../../../app/demo';
import { useFormat } from '../../../../app/format';
import { useT } from '../../../../app/i18n';
import { useAction, useAsync } from '../../../../app/hooks';
import { Badge, Button, EmptyState, ErrorState, Spinner } from '../../../../components/ui';
import { ConfirmModal } from '../../shared/ConfirmModal';
import { Drawer, DrawerSection, Facts } from '../../shared/Drawer';
import { useOT } from '../../shared/i18n';
import { useSessionNow } from '../../shared/session';
import { Simulado } from '../../shared/Simulado';
import { GateNote, PlanStatusBadge, SellerStatusBadge } from '../badges';

type Verification = 'verified' | 'paused' | 'rejected';

/** Verification moves the desk offers from each state; rejected is final. */
export function verificationMoves(s: SellerView['verificationStatus']): Verification[] {
  if (s === 'pending') return ['verified', 'rejected'];
  if (s === 'verified') return ['paused'];
  if (s === 'paused') return ['verified', 'rejected'];
  return [];
}

export function SellerDrawer({
  sellerId,
  rows,
  onClose,
  onChanged,
  onOpenPlan,
  refreshKey,
}: {
  sellerId: string;
  rows: PlanRow[];
  onClose: () => void;
  onChanged: () => void;
  onOpenPlan: (id: string) => void;
  refreshKey: number;
}) {
  const t = useT();
  const ot = useOT();
  const f = useFormat();
  const { version, state } = useDemo();
  const seller = useAsync(() => api.getSeller(sellerId), [sellerId, version, refreshKey]);
  const s = seller.data;
  const [confirmReject, setConfirmReject] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const verify = useAction((status: Verification) => api.setSellerVerification(sellerId, status, ot('vendedores.verifyNote')));
  const alert = useAction((unitId: string) => api.raiseCnrAlert(sellerId, unitId, ot('vendedores.cnr.alertDetail')));
  const plans = rows.filter((r) => r.plan.sellerId === sellerId);

  const after = (msg: string) => {
    setNotice(msg);
    seller.reload();
    onChanged();
  };

  const runVerify = async (status: Verification) => {
    setNotice(null);
    const r = await verify.run(status);
    if (r) {
      setConfirmReject(false);
      after(ot(`vendedores.done.${status}`));
    }
  };

  return (
    <Drawer
      title={s ? s.tradeName : ot('vendedores.drawer.loading')}
      subtitle={
        s ? (
          <span className="flex flex-wrap items-center gap-2">
            <span>{s.legalName}</span>
            <Badge tone="neutral">{ot(`vendedores.tier.${s.tier}`)}</Badge>
            <SellerStatusBadge status={s.verificationStatus} />
            {s.simulated && <Simulado />}
          </span>
        ) : undefined
      }
      onClose={onClose}
      labelClose={ot('drawer.close')}
      testId="seller-drawer"
    >
      {seller.loading && !s && <Spinner />}
      {seller.status === 'error' && <ErrorState error={seller.error} onRetry={seller.reload} />}
      {s && (
        <>
          <DrawerSection title={ot('vendedores.drawer.verification')} testId="seller-verification">
            <div className="space-y-3">
              {s.gate ? <GateNote reason={s.gate} testId="seller-gate" /> : <p data-testid="seller-gate-clear" className="rounded-lg bg-brand-50 px-3 py-2 text-sm font-semibold text-brand-800">{ot('vendedores.drawer.flowing')}</p>}
              <Facts
                items={[
                  { label: ot('vendedores.drawer.status'), value: ot(`sellerStatus.${s.verificationStatus}`) },
                  { label: ot('vendedores.drawer.verifiedAt'), value: s.verifiedAt ? f.dateTime(s.verifiedAt) : '—' },
                  { label: ot('vendedores.drawer.kyb'), value: s.kybRef ?? '—', mono: true },
                  { label: ot('vendedores.drawer.tierCheck'), value: ot(`vendedores.tierCheck.${s.tier}`, { bank: s.bank }) },
                ]}
              />
              {s.verificationStatus === 'rejected' ? (
                <p data-testid="seller-rejected-final" className="text-sm font-semibold text-danger-700">{ot('vendedores.drawer.rejectedFinal')}</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {verificationMoves(s.verificationStatus).map((m) =>
                    m === 'rejected' ? (
                      <Button key={m} label={ot('vendedores.move.rejected')} variant="danger" size="sm" data-testid="seller-reject" onClick={() => setConfirmReject(true)} />
                    ) : (
                      <Button key={m} label={ot(`vendedores.move.${m}${s.verificationStatus === 'paused' ? 'Again' : ''}`)} variant="secondary" size="sm" busy={verify.busy} data-testid={`seller-${m}`} onClick={() => void runVerify(m)} />
                    ),
                  )}
                </div>
              )}
              {verify.status === 'error' && !confirmReject && <ErrorState error={verify.error} compact />}
              {notice && (
                <p role="status" data-testid="seller-notice" className="rounded-lg bg-brand-50 px-3 py-2 text-sm font-semibold text-brand-800">
                  {notice}
                </p>
              )}
            </div>
          </DrawerSection>

          <DrawerSection title={ot('vendedores.drawer.company')}>
            <Facts
              items={[
                { label: ot('vendedores.drawer.legalName'), value: s.legalName },
                { label: ot('vendedores.drawer.tradeName'), value: s.tradeName },
                { label: ot('vendedores.drawer.taxId'), value: s.taxId, mono: true },
                { label: ot('vendedores.drawer.bank'), value: s.bank },
                { label: ot('vendedores.drawer.corridor'), value: t(CORRIDORS[s.corridor].nameKey) },
                { label: ot('vendedores.drawer.legalRep'), value: s.legalRepresentative, testId: 'seller-legal-rep' },
              ]}
            />
            {s.notes && <p className="mt-2 whitespace-pre-line text-sm text-ink-700">{s.notes}</p>}
          </DrawerSection>

          <DrawerSection title={ot('vendedores.cnr.title')} testId="seller-units" actions={<Simulado />}>
            {s.units.length === 0 ? (
              <EmptyState title={ot('vendedores.cnr.empty')} body={ot('vendedores.cnr.emptyBody')} />
            ) : (
              <ul className="space-y-3">
                {s.units.map((u) => (
                  <li key={u.id} data-testid={`seller-unit-${u.unitId}`} data-alert={u.alertStatus} className="rounded-lg border border-ink-200 px-3 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold text-ink-900">
                        {u.unitLabel} · {u.project}
                      </span>
                      <Badge tone={u.alertStatus === 'lien_registered' ? 'danger' : u.alertStatus === 'cleared' ? 'neutral' : 'brand'}>{ot(`vendedores.cnr.alert.${u.alertStatus}`)}</Badge>
                    </div>
                    <div className="mt-2">
                      <Facts
                        cols={3}
                        items={[
                          { label: ot('vendedores.cnr.registryNo'), value: u.cnrRegistryNo, mono: true },
                          { label: ot('vendedores.cnr.certDate'), value: f.date(u.cnrCertDate) },
                          { label: ot('vendedores.cnr.certHash'), value: u.cnrCertHash, mono: true },
                        ]}
                      />
                    </div>
                    {u.alertStatus === 'lien_registered' && (
                      <p data-testid="cnr-alert" role="note" className="mt-2 rounded-lg border border-danger-600/30 bg-danger-100 px-3 py-2 text-sm text-danger-700">
                        <span className="font-semibold">{ot('vendedores.cnr.alertTitle')}</span>
                        {u.alertAt && ` · ${f.dateTime(u.alertAt)}`}
                        {u.alertDetail && <span className="block">{u.alertDetail}</span>}
                        <span className="block">{ot('vendedores.cnr.alertEffect')}</span>
                      </p>
                    )}
                    {u.alertStatus === 'none' && s.verificationStatus !== 'rejected' && (
                      <Button
                        label={ot('vendedores.cnr.raise')}
                        variant="secondary"
                        size="sm"
                        className="mt-2"
                        busy={alert.busy}
                        data-testid={`cnr-raise-${u.unitId}`}
                        onClick={async () => {
                          setNotice(null);
                          const r = await alert.run(u.unitId);
                          if (r) after(ot('vendedores.cnr.raised', { count: plans.length }));
                        }}
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}
            {alert.status === 'error' && <ErrorState error={alert.error} compact />}
          </DrawerSection>

          <PayoutSection seller={s} today={state?.today} onChanged={after} />

          <DrawerSection title={ot('vendedores.drawer.plans')} testId="seller-plans">
            {plans.length === 0 ? (
              <EmptyState title={ot('vendedores.drawer.noPlans')} body={ot('vendedores.drawer.noPlansBody')} />
            ) : (
              <ul className="space-y-2">
                {plans.map((r) => (
                  <li key={r.plan.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <button type="button" className="min-h-9 font-semibold text-brand-800 hover:underline" onClick={() => onOpenPlan(r.plan.id)} data-testid={`seller-plan-${r.plan.id}`}>
                      {r.buyer.name} · {r.unit.unitName} {r.unit.unitCode}
                    </button>
                    <PlanStatusBadge status={r.status} />
                  </li>
                ))}
              </ul>
            )}
          </DrawerSection>

          {confirmReject && (
            <ConfirmModal
              title={ot('vendedores.reject.title', { name: s.tradeName })}
              body={ot('vendedores.reject.body')}
              confirmLabel={ot('vendedores.move.rejected')}
              busy={verify.busy}
              error={verify.status === 'error' ? verify.error : null}
              onClose={() => {
                setConfirmReject(false);
                verify.resetAction();
              }}
              onConfirm={() => void runVerify('rejected')}
            />
          )}
        </>
      )}
    </Drawer>
  );
}

function AccountLines({ a }: { a: PayoutAccount }) {
  return (
    <span>
      {a.institution} · {a.holder} · <span className="font-mono">{a.ref}</span>
    </span>
  );
}

function PayoutSection({ seller: s, today, onChanged }: { seller: SellerView; today: string | undefined; onChanged: (msg: string) => void }) {
  const ot = useOT();
  const f = useFormat();
  const id = useId();
  const now = useSessionNow(today);
  const [open, setOpen] = useState(false);
  const kind: PayoutAccount['kind'] = s.payoutOption === 'A' ? 'provider_address' : 'bank';
  const [form, setForm] = useState({ institution: '', holder: s.legalName.toUpperCase(), ref: '' });
  const change = useAction((a: PayoutAccount) => api.changeSellerPayoutAccount(s.id, a));
  const until = s.payoutChangePendingUntil;
  const hoursLeft = until && now != null ? Math.max(0, Math.ceil((Date.parse(until) - now) / 3_600_000)) : null;
  const valid = form.institution.trim() && form.holder.trim() && form.ref.trim();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const r = await change.run({ kind, institution: form.institution.trim(), holder: form.holder.trim(), ref: form.ref.trim() });
    if (r) {
      setOpen(false);
      onChanged(r.payoutChangePendingUntil ? ot('vendedores.payout.changePending', { date: f.dateTime(r.payoutChangePendingUntil) }) : ot('vendedores.payout.changeSaved'));
    }
  };

  return (
    <DrawerSection title={ot('vendedores.payout.title')} testId="seller-payout">
      <div className="space-y-3">
        <Facts
          items={[
            { label: ot('vendedores.payout.option'), value: ot(`vendedores.option.${s.payoutOption}`), testId: 'seller-option' },
            { label: ot('vendedores.payout.account'), value: s.payoutAccount ? <AccountLines a={s.payoutAccount} /> : ot('vendedores.payout.noAccount'), testId: 'seller-account' },
          ]}
        />
        {s.pendingPayoutAccount && (
          <div data-testid="seller-cooling-off" className="rounded-lg border border-warn-500/60 bg-warn-100 px-3 py-2 text-sm text-warn-700">
            <p className="font-semibold">{until ? ot('vendedores.payout.pendingTitle') : ot('vendedores.payout.waitingVerification')}</p>
            <p className="mt-0.5">
              {ot('vendedores.payout.newAccount')}: <AccountLines a={s.pendingPayoutAccount} />
            </p>
            {until && <p className="mt-0.5">{ot('vendedores.payout.until', { date: f.dateTime(until), hours: hoursLeft ?? PAYOUT_CHANGE_COOLING_OFF_HOURS })}</p>}
          </div>
        )}
        {s.verificationStatus !== 'rejected' && !open && (
          <Button label={ot('vendedores.payout.change')} variant="secondary" size="sm" data-testid="payout-change-open" onClick={() => setOpen(true)} />
        )}
        {open && (
          <form onSubmit={(e) => void submit(e)} data-testid="payout-change-form" aria-label={ot('vendedores.payout.change')} className="space-y-3 rounded-lg border border-ink-200 bg-ink-50 p-3">
            <p className="text-sm text-ink-700">{ot('vendedores.payout.changeHint', { hours: PAYOUT_CHANGE_COOLING_OFF_HOURS })}</p>
            {(['institution', 'holder', 'ref'] as const).map((k) => (
              <div key={k}>
                <label htmlFor={`${id}-${k}`} className="block text-sm font-medium text-ink-700">
                  {ot(`vendedores.payout.field.${kind}.${k}`)}
                </label>
                <input
                  id={`${id}-${k}`}
                  data-testid={`payout-field-${k}`}
                  value={form[k]}
                  onChange={(e) => setForm((x) => ({ ...x, [k]: e.target.value }))}
                  className="mt-1 min-h-11 w-full rounded-lg border border-ink-300 bg-white px-3 text-sm"
                />
              </div>
            ))}
            {change.status === 'error' && <ErrorState error={change.error} compact />}
            <div className="flex gap-2">
              <Button label={ot('vendedores.payout.submit')} type="submit" busy={change.busy} disabled={!valid} data-testid="payout-change-submit" />
              <Button label={ot('vendedores.payout.cancel')} variant="ghost" onClick={() => setOpen(false)} />
            </div>
          </form>
        )}
      </div>
    </DrawerSection>
  );
}