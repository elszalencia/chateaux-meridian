// Receipt: the proof the buyer keeps. It leads with what was paid and the two rates (secured vs
// the rate of the day) so the saving is obvious, then the pesos delivered to the trust, the fee and
// the FX declaration reference. Technical identifiers live behind a toggle and use plain words:
// "Referencia de transacción" and the securing identifier. One component serves the post-payment
// modal (full) and the receipts list (row), differing only in emphasis and which test ids it carries.

import { useId, useState } from 'react';
import type { Receipt } from '@casa-puente/services';
import { useFormat } from '../../app/format';
import { useT } from '../../app/i18n';
import { Badge } from '../../components/ui';
import { Row, txReferenceOf } from './shared';

export function ReceiptView({ receipt: r, trust, variant, withTestIds }: { receipt: Receipt; trust: string; variant: 'full' | 'row'; withTestIds?: boolean }) {
  const t = useT();
  const f = useFormat();
  const [open, setOpen] = useState(false);
  const techId = useId();
  const n = r.installmentIdx + 1;
  const locked = r.rateKind === 'locked' && r.lockedRate != null;
  const usdAtToday = r.copDelivered / r.spotAtPayment;
  const saving = usdAtToday - r.usdPaid;
  const full = variant === 'full';
  const ids = withTestIds ? { lockedRate: 'receipt-locked-rate', todayRate: 'receipt-today-rate', cop: 'receipt-cop', toggle: 'receipt-tech-toggle' } : {};

  return (
    <article data-testid={withTestIds ? 'receipt' : undefined} aria-label={t('comprador.receipts.rowLabel', { n })} className={full ? '' : 'text-sm'}>
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className={`font-semibold text-ink-900 ${full ? 'text-lg' : ''}`}>{t(full ? 'comprador.receipt.title' : 'comprador.receipts.row', { n })}</h3>
        <span className="text-xs text-ink-500">
          {t('comprador.receipt.paidAt')}: {f.dateTime(r.paidAt)}
        </span>
      </header>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <span className={`tabular font-semibold text-ink-900 ${full ? 'text-3xl' : 'text-xl'}`}>{f.usd(r.usdPaid)}</span>
        <Badge tone={locked ? 'brand' : 'neutral'}>{locked ? t('comprador.receipts.lockedRate', { rate: f.rate(r.lockedRate!) }) : t('comprador.receipts.spotRate')}</Badge>
      </div>
      <dl className={`mt-2 grid grid-cols-2 gap-x-6 ${full ? 'sm:grid-cols-3' : 'sm:grid-cols-4'}`}>
        <Row label={t('comprador.receipt.lockedRate')} value={<span data-testid={ids.lockedRate}>{locked ? f.rate(r.lockedRate!) : t('comprador.receipt.notLocked')}</span>} />
        <Row label={t('comprador.receipt.todayRate')} value={<span data-testid={ids.todayRate}>{f.rate(r.spotAtPayment)}</span>} />
        {locked && (
          <Row
            label={t('comprador.receipt.usdAtToday')}
            value={f.usd(usdAtToday)}
            hint={
              <span className={saving >= 0 ? 'font-semibold text-brand-700' : 'font-semibold text-warn-700'}>
                {t(saving >= 0 ? 'comprador.receipt.saving' : 'comprador.receipt.extra')}: {f.usd(Math.abs(saving))}
              </span>
            }
          />
        )}
        <Row label={t('comprador.receipt.copDelivered', { trust })} value={<span data-testid={ids.cop}>{f.cop(r.copDelivered)}</span>} />
        <Row label={t('comprador.receipt.fee')} value={f.usd(r.feeUsd)} />
        <Row label={t('comprador.receipt.fxRef')} value={r.fxDeclarationRef} mono />
      </dl>
      <button
        type="button"
        data-testid={ids.toggle}
        aria-expanded={open}
        aria-controls={techId}
        aria-label={withTestIds ? t(open ? 'comprador.receipt.techHide' : 'comprador.receipt.techShow') : t(open ? 'comprador.receipts.techHide' : 'comprador.receipts.techShow', { n })}
        onClick={() => setOpen((o) => !o)}
        className="mt-2 inline-flex min-h-9 items-center gap-1 rounded-md px-2 text-sm font-semibold text-brand-800 hover:bg-brand-50"
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        {t('comprador.receipt.tech')}
      </button>
      {open && (
        <dl id={techId} className="mt-1 grid grid-cols-1 gap-x-6 rounded-lg bg-ink-50 px-3 sm:grid-cols-2">
          <Row label={t('comprador.receipt.txRef')} value={txReferenceOf(r)} mono />
          <Row label={t('comprador.receipt.lockId')} value={r.lockId ?? t('comprador.receipt.noLock')} mono />
        </dl>
      )}
    </article>
  );
}
