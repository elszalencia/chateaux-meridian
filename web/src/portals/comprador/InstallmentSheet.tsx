// One calendar cell in detail for a corridor without rate locks: amount, due date, state, and the
// next step (pay it, or open its receipt). Nothing about rates: the installment is already in the
// currency the buyer pays.

import type { InstallmentView, PlanView } from '@chateaux/services';
import { useFormat } from '../../app/format';
import { useT } from '../../app/i18n';
import { Badge, Button, Modal } from '../../components/ui';
import { CELL_TONE, Row } from '../../views/comprador/shared';
import { usePortalT } from './copy';
import { corridorOfView, payOpensOn } from './corridorUi';

export function InstallmentSheet({
  view,
  installment: i,
  hasReceipt,
  onPay,
  onReceipt,
  onClose,
}: {
  view: PlanView;
  installment: InstallmentView;
  hasReceipt: boolean;
  onPay: () => void;
  onReceipt: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const tp = usePortalT();
  const f = useFormat();
  const c = corridorOfView(view);
  const unpaid = i.status !== 'released' && !i.fundedAt;
  return (
    <Modal title={t('comprador.card.title', { n: i.number })} onClose={onClose} labelClose={t('common.close')}>
      <div data-testid="cell-card">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Badge tone={CELL_TONE[i.cellState]}>{t('states.' + i.cellState)}</Badge>
          {i.isLate && unpaid && <Badge tone="warn">{t(i.inGrace || i.lateInGrace ? 'comprador.calendar.inGrace' : 'comprador.calendar.late')}</Badge>}
        </div>
        {i.cellState === 'recibido' && <p className="mb-3 text-sm text-ink-700">{tp('cell.received', { date: f.date(i.dueDate) })}</p>}
        {i.cellState === 'no_pagado' && <p className="mb-3 text-sm text-ink-700">{t('comprador.card.missed')}</p>}
        {i.cellState === 'condonado' && <p className="mb-3 text-sm text-ink-700">{t('comprador.card.waived')}</p>}
        <dl className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
          <Row label={tp('cell.amount')} value={f.usd(i.usdShown)} />
          <Row label={t('comprador.card.dueDate')} value={f.date(i.dueDate)} />
          {i.releasedAt && <Row label={tp('cell.deliveredOn')} value={f.date(i.releasedAt)} />}
          {i.fundedAt && <Row label={tp('cell.paidOn')} value={f.date(i.fundedAt)} />}
          {unpaid && !i.payable && i.status !== 'missed' && i.status !== 'waived' && <Row label={tp('cell.opensOn')} value={f.date(payOpensOn(i, c))} />}
        </dl>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button label={t('comprador.card.close')} variant="secondary" data-testid="cell-card-close" onClick={onClose}>
            {t('common.close')}
          </Button>
          {hasReceipt && (
            <Button label={tp('receipts.open', { n: i.number })} variant="secondary" data-testid="cell-card-receipt" onClick={onReceipt}>
              {tp('receipts.openShort')}
            </Button>
          )}
          {i.payable && (
            <Button label={tp('next.payHint', { n: i.number, usd: f.usd(i.usdShown) })} data-testid="cell-card-pay" onClick={onPay}>
              {tp('next.pay')}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
